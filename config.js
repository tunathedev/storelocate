/* HEB Store Match — runtime config.
 *
 * googleMapsKey: a Google Maps JavaScript API key. Set this when hosting on a
 * static site (e.g. GitHub Pages), which has no server to proxy geocoding.
 * With a key, geocoding + drive time run in the browser via the Google Maps
 * SDK (CORS-safe). Leave it blank to use the Census/OSRM proxy in server.js
 * instead (local dev / Render).
 *
 * SECURITY: this key is visible in the page source. Before using it, in the
 * Google Cloud console you MUST:
 *   1. Restrict it by "HTTP referrers (web sites)" to your domain, e.g.
 *      https://tunathedev.github.io/*
 *   2. Restrict "API restrictions" to only: Maps JavaScript API,
 *      Geocoding API, Distance Matrix API.
 *   3. Set a daily quota cap so a leaked key can't run up a bill.
 * A referrer-restricted key only works from your site, so publishing it is safe.
 */
window.STORELOCATE_CONFIG = {
  googleMapsKey: "AIzaSyB57FEnvM72GfGmbyxoL5dnJi7QfyKsjnk"
};
