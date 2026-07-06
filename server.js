/* HEB Store Match — zero-dependency static server + geocode/route proxy.
 *
 *   node server.js            # then open http://localhost:3600
 *
 * Why a proxy: browsers can't always call the U.S. Census geocoder or the OSRM
 * router directly (CORS / bot protection). Running this server keeps partner
 * home addresses on your own machine — only the address is forwarded to Census,
 * and only coordinates go to OSRM. The app calls these endpoints first and
 * falls back to the public APIs if the server isn't running.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3600;
const ROOT = __dirname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'heb-store-match/1.0' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}
function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  // --- geocode proxy (US Census) ---
  if (u.pathname === '/api/geocode') {
    const address = u.searchParams.get('address') || '';
    if (!address) return sendJSON(res, 400, { error: 'address required' });
    const target = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress'
      + `?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;
    try { const r = await get(target); return sendJSON(res, r.status, r.body); }
    catch (e) { return sendJSON(res, 502, { error: String(e) }); }
  }

  // --- routing proxy (OSRM table) ---
  if (u.pathname === '/api/table') {
    const coords = u.searchParams.get('coords') || '';
    const sources = u.searchParams.get('sources') || '0';
    const destinations = u.searchParams.get('destinations') || '';
    if (!coords) return sendJSON(res, 400, { error: 'coords required' });
    let target = `https://router.project-osrm.org/table/v1/driving/${coords}`
      + `?sources=${sources}&annotations=duration,distance`;
    if (destinations) target += `&destinations=${destinations}`;
    try { const r = await get(target); return sendJSON(res, r.status, r.body); }
    catch (e) { return sendJSON(res, 502, { error: String(e) }); }
  }

  // --- static files ---
  let p = decodeURIComponent(u.pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`HEB Store Match → http://localhost:${PORT}`));
