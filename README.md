# HEB Store Match — Manager Placement

A corporate-HR tool for assigning new managers to stores. Upload a cohort
spreadsheet (Excel or CSV) of partners with their **home addresses**, and for
each person it returns the **3 closest HEB stores by drive time**.

![type: web app](https://img.shields.io/badge/type-web%20app-ee3124)
![access: PIN 1905](https://img.shields.io/badge/access-PIN-333)

> **Confidential.** This tool handles partner home addresses. It runs entirely
> in the browser behind a PIN. Home addresses are only ever sent to the U.S.
> Census geocoder; the routing service receives **coordinates only, never
> names**. Nothing is written to disk — the unlock flag and a short-lived
> geocode cache live in `sessionStorage` and clear when the tab closes.

## What it does

1. **Unlock** with the shared access PIN (`1905`).
2. **Upload** a `.xlsx` / `.xls` / `.csv` cohort. Columns for name, area, and
   home address are auto-detected (and can be corrected in a dropdown).
3. For each partner it:
   - geocodes the home address (**U.S. Census** — free, no key),
   - ranks all stores by straight-line distance,
   - measures **drive time + drive distance** to the nearest candidates
     (**OSRM** — free, no key), and
   - shows the **3 closest** stores, sorted by drive time.
4. **Export** the results as CSV or Excel.

The input matches the `SORL_26B_Cohort` layout: `Partner Name`, `Area`,
`Home Location`.

## Run it

```bash
node server.js        # then open http://localhost:3600
```

`server.js` is zero-dependency (Node built-ins only). It serves the app and
provides two proxy endpoints so partner addresses stay on your machine:

| Endpoint | Proxies to | Sent |
|----------|-----------|------|
| `/api/geocode?address=…` | U.S. Census geocoder | the address |
| `/api/table?coords=…`    | OSRM routing         | coordinates only |

The app calls these first and **falls back to the public APIs** if the server
isn't running (so it also works as a static site, e.g. GitHub Pages, wherever
the browser can reach those APIs directly).

## Store data

`data/stores.json` holds the store list with coordinates:

```jsonc
{
  "stores": [
    { "id": 794, "name": "MCKINNEY EL DORADO/CUSTER",
      "address": "8700 ELDORADO PARKWAY", "lat": 33.17604, "lon": -96.72815 }
  ]
}
```

Current data (46 stores) was imported from `Store_Location_Table_1.xlsx`, which
already included coordinates — so no store geocoding was needed. To refresh the
list from a new export:

```bash
# save the store table as CSV, then:
node tools/build-stores.js path/to/stores.csv   # writes data/stores.json
```

Rows that already have `LAT_K` / `LON_K` are used as-is; any without
coordinates are geocoded via Census (run it where `census.gov` is reachable).

## Files

| File | Purpose |
|------|---------|
| `index.html` | App shell + PIN lock |
| `styles.css` | Desktop-class HEB-red theme |
| `app.js` | Parsing, geocoding, ranking, drive time, export |
| `server.js` | Static server + Census/OSRM proxy |
| `data/stores.json` | Store list with coordinates |
| `tools/build-stores.js` | Rebuild `stores.json` from a store table |
| `vendor/xlsx.full.min.js` | SheetJS (vendored — no CDN, works offline) |

## Notes & limits

- **Drive time** uses the public OSRM demo server. It's fine for a cohort of
  this size; for heavy/repeated runs, point `server.js` at a self-hosted OSRM.
- **Straight-line fallback** — if routing is unavailable for a partner, the tool
  still shows the nearest stores by direct distance (marked *"direct"*).
- **Address not found** — partners whose address can't be geocoded are flagged
  in the results so HR can correct the address and re-run.
