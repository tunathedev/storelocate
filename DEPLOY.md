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

## Option B — GitHub Pages (fastest link, but two caveats)

Serves the static files with no server, so the app falls back to calling Census
and OSRM **directly from the browser**.

1. Repo **Settings → Pages → Build from branch →** `main` (after this PR merges),
   folder `/ (root)`. Save.
2. Wait ~1 minute; the URL is `https://tunathedev.github.io/storelocate/`.

Caveats:
- **CORS:** the U.S. Census geocoder does not reliably send CORS headers, so
  browser-side geocoding may be blocked — in which case matches fail and Option A
  is the fix.
- **Public:** GitHub Pages on a free plan is public, so the page and the store
  list would be reachable by anyone with the link (the PIN is a soft gate, not
  real access control — see below).

## About the PIN

`1905` is a convenience lock enforced in the browser, matching the other tool.
It keeps casual visitors out but is **not** real access control — anyone who
views source can read it. The genuinely sensitive data (partner home addresses)
is supplied at run time by whoever uploads the sheet and is never stored, so a
stranger hitting the link has nothing to see. If you need real gating (only
named HR users can open it), say so — that means a host with basic-auth or a
proper login, which Option A can support.
