# HEB Store Match — R port

An R re-implementation of the web tool's logic, in two forms that share one core
module (`store_match.R`):

- **`run_match.R`** — a batch script: read a cohort file → write a results `.xlsx`.
- **`app.R`** — a Shiny app: the interactive tool (PIN, upload, table, carpools, download).

Geocoding uses the **U.S. Census** (`tidygeocoder`, with OpenStreetMap as a
fallback) and drive time uses **OSRM** (`osrm`) — **no API key required**, matching
the original "no key" preference. (The live web tool uses a browser Google key
because GitHub Pages has no server; that key is referrer-restricted and would not
work from R, which calls services server-side.)

## Install

```r
install.packages(c("jsonlite", "tidygeocoder", "osrm", "readxl", "openxlsx", "shiny", "DT"))
```

## Batch script

```bash
# from the repo's r/ directory (or pass a path to store_match.R's stores.json)
Rscript run_match.R ../path/to/SORL_26B_Cohort.xlsx store-matches.xlsx 15
#        <cohort .xlsx|.csv>                          <output .xlsx>     ^carpool minutes (default 15)
```

It auto-detects the name / area / home-address columns, geocodes each address,
finds the 3 closest stores with drive time, groups carpools within each Area, and
writes an Excel file with a **Carpool Group** column — the same output shape as the
web tool's export.

## Shiny app

```bash
# from the repo root
R -e "shiny::runApp('r', port = 3700)"
# then open http://localhost:3700  (PIN: 1905)
```

## Files

| File | Purpose |
|------|---------|
| `store_match.R` | Shared core: geocode, distance, drive time, matching, carpools, export |
| `run_match.R` | Command-line batch runner |
| `app.R` | Shiny UI |

## Notes & differences from the web app

- **Store data** is read from the repo's `../data/stores.json`, so it stays in sync
  with the web tool (same 45 stores). Update that file and both stay current.
- **OSRM server**: uses the public `router.project-osrm.org` (fine for cohort-sized
  runs). For heavy use, point `options(osrm.server=)` at a self-hosted instance.
- **Census coverage** is US street addresses; anything it misses falls back to
  OpenStreetMap. Unresolved addresses are flagged "Address not found," same as the
  web tool.
- This port was syntax- and logic-checked, but run it once on your machine to
  confirm the geocoding/routing packages are set up (those calls need network the
  build sandbox doesn't have).
