# Deploying HEB Store Match

You want a link to send to HR. The app is a static front end **plus** a small
Node proxy (`server.js`) that forwards geocoding to the U.S. Census and routing
to OSRM. There are two ways to host it — pick one.

## Option A — Render (recommended: full, works reliably)

Runs `server.js`, so the Census/OSRM proxy is available and partner addresses
never touch a third-party CDN. No dependencies to install.

1. Go to <https://render.com> and sign in with GitHub.
2. **New → Blueprint**, pick the `storelocate` repo. It reads `render.yaml`.
3. Click **Apply**. In ~1 minute you get a URL like
   `https://heb-store-match.onrender.com`.
4. Send that URL to HR. They unlock with the PIN and go.

> Free-tier Render services sleep after inactivity and take ~30s to wake on the
> first hit — fine for occasional HR use.

## Option B — GitHub Pages + Google Maps key (static, no server)

GitHub Pages serves static files only — there's no proxy — and the **U.S. Census
geocoder blocks direct browser calls (CORS)**, so on Pages you'll see
"Lookup failed: Load failed" on every row unless you supply a **Google Maps key**.
Google's Maps JS SDK is built for browser use, so geocoding + drive time work
client-side with a key.

**1. Create a Google Maps API key (safely):**
   - In the [Google Cloud console](https://console.cloud.google.com), create a
     project and enable: **Maps JavaScript API**, **Geocoding API**,
     **Distance Matrix API**.
   - Create an **API key**, then **restrict** it:
     - *Application restrictions* → **HTTP referrers** →
       `https://tunathedev.github.io/*`
     - *API restrictions* → the three APIs above only.
     - Set a **daily quota cap** so a leaked key can't run up a bill.
   - A referrer-restricted key only works from your site, so it's safe to publish.

**2. Put the key in `config.js`:**
   ```js
   window.STORELOCATE_CONFIG = { googleMapsKey: "YOUR_KEY_HERE" };
   ```
   Commit it.

**3. Enable Pages:** Repo **Settings → Pages → Build from branch →** `main`,
   folder `/ (root)`. Save. In ~1 minute the URL is
   `https://tunathedev.github.io/storelocate/`.

Caveats:
- **Public:** free Pages is public, so the page + store list are reachable by
  anyone with the link (the PIN is a soft gate — see below).
- **Privacy:** with a Google key, home addresses are geocoded by **Google**
  rather than the U.S. Census. Option A (Render) keeps geocoding on Census.
- If `config.js` has **no** key, the app uses the Census/OSRM proxy — which only
  exists when `server.js` is running (Option A / local), not on Pages.

## About the PIN

`1905` is a convenience lock enforced in the browser, matching the other tool.
It keeps casual visitors out but is **not** real access control — anyone who
views source can read it. The genuinely sensitive data (partner home addresses)
is supplied at run time by whoever uploads the sheet and is never stored, so a
stranger hitting the link has nothing to see. If you need real gating (only
named HR users can open it), say so — that means a host with basic-auth or a
proper login, which Option A can support.
