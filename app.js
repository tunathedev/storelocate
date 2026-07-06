/* HEB Store Match — manager placement tool
 * Flow: unlock (PIN 1905) → upload cohort → detect columns → geocode home
 *       addresses → rank stores by straight-line → drive time for nearest
 *       candidates → closest-store table + carpool groups → export.
 *
 * Geocoding / drive time uses one of two engines:
 *   • Google Maps JS SDK  — when a key is set in config.js. Works fully in the
 *     browser (CORS-safe), so it runs on a static host like GitHub Pages.
 *   • US Census + OSRM     — via the same-origin proxy in server.js (Render /
 *     local), with a direct-call fallback. No key needed.
 *
 * Privacy: runs client-side. Addresses go only to the chosen mapping service;
 * routing between homes uses coordinates only. Nothing is written to disk — the
 * unlock flag and a geocode cache live in sessionStorage (cleared on tab close).
 */
'use strict';

const $ = (id) => document.getElementById(id);
const MASTER_PIN = '1905';
const NEAREST_CANDIDATES = 8;   // straight-line shortlist sent to the router
const TOP_N = 3;                // stores shown per partner

const CFG = window.STORELOCATE_CONFIG || {};
const GKEY = (CFG.googleMapsKey || '').trim();
const USE_GOOGLE = !!GKEY;

const PROXY = { geocode: '/api/geocode', table: '/api/table' };
const CENSUS = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const OSRM = 'https://router.project-osrm.org/table/v1/driving/';

let STORES = [];
let parsed = null;    // { headers, rows }
let results = [];     // computed matches
let CARPOOL = [];     // per-area carpool data

/* ------------------------------------------------------------------ *
 * PIN lock
 * ------------------------------------------------------------------ */
let pin = '';
function renderDots() {
  [...$('lockDots').children].forEach((d, i) => d.classList.toggle('on', i < pin.length));
}
function pinError(msg) {
  $('lockError').textContent = msg;
  $('lockScreen').classList.add('shake');
  setTimeout(() => { $('lockScreen').classList.remove('shake'); pin = ''; renderDots(); }, 450);
}
function unlock() {
  sessionStorage.setItem('hsm_unlocked', '1');
  $('lockScreen').style.display = 'none';
  $('app').hidden = false;
  $('engineNote').textContent = USE_GOOGLE
    ? 'Google Maps geocoding + drive time'
    : 'Census geocoding + OSRM drive time';
  loadStores();
}
function lock() {
  sessionStorage.removeItem('hsm_unlocked');
  location.reload();
}
$('lockKeys').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const k = b.dataset.k;
  if (k === 'del') { pin = pin.slice(0, -1); $('lockError').textContent = ''; renderDots(); return; }
  if (!/^[0-9]$/.test(k) || pin.length >= 4) return;
  pin += k; renderDots();
  if (pin.length === 4) {
    if (pin === MASTER_PIN) unlock();
    else pinError('Incorrect PIN');
  }
});
$('lockBtn').addEventListener('click', lock);
if (sessionStorage.getItem('hsm_unlocked') === '1') unlock();

/* ------------------------------------------------------------------ *
 * Store data
 * ------------------------------------------------------------------ */
async function loadStores() {
  try {
    const r = await fetch('data/stores.json', { cache: 'no-store' });
    const d = await r.json();
    STORES = (d.stores || []).filter((s) => isFinite(s.lat) && isFinite(s.lon));
    $('storeCount').textContent = `${STORES.length} stores loaded`;
  } catch (e) {
    $('storeCount').textContent = 'store list failed to load';
    console.error(e);
  }
}

/* ------------------------------------------------------------------ *
 * File upload + parsing (SheetJS for xlsx, native for csv)
 * ------------------------------------------------------------------ */
const dz = $('dropzone');
$('browseBtn').addEventListener('click', () => $('fileInput').click());
dz.addEventListener('click', (e) => { if (e.target.id !== 'browseBtn') $('fileInput').click(); });
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
dz.addEventListener('drop', (e) => {
  e.preventDefault(); dz.classList.remove('drag');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
$('fileInput').addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });

function handleFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
      if (!aoa.length) throw new Error('empty sheet');
      const headers = aoa[0].map((h) => String(h == null ? '' : h).trim());
      const rows = aoa.slice(1)
        .filter((r) => r.some((c) => c != null && String(c).trim() !== ''))
        .map((r) => headers.map((_, i) => (r[i] == null ? '' : String(r[i]).replace(/ /g, ' ').trim())));
      parsed = { headers, rows };
      buildMapping();
    } catch (err) {
      alert('Could not read that file: ' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

function guess(headers, keywords) {
  const idx = headers.findIndex((h) => keywords.some((k) => h.toLowerCase().includes(k)));
  return idx < 0 ? '' : String(idx);
}
function buildMapping() {
  const { headers, rows } = parsed;
  const fill = (sel, guessIdx) => {
    sel.innerHTML = headers.map((h, i) => `<option value="${i}">${escapeHtml(h || '(column ' + (i + 1) + ')')}</option>`).join('');
    if (guessIdx !== '') sel.value = guessIdx;
  };
  fill($('colName'), guess(headers, ['name', 'partner', 'employee']));
  fill($('colArea'), guess(headers, ['area', 'region', 'district']));
  fill($('colAddr'), guess(headers, ['location', 'address', 'home', 'residence']));
  $('rowCount').textContent = `${rows.length} partner${rows.length === 1 ? '' : 's'} detected`;
  $('mapping').hidden = false;
}

/* ------------------------------------------------------------------ *
 * Geo engines — a common interface: Geo.init(), Geo.geocode(addr),
 * Geo.matrix(origins, dests) → { minutes[][], miles[][] }.
 * ------------------------------------------------------------------ */
function haversineMi(lat1, lon1, lat2, lon2) {
  const R = 3958.7613, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}
function haversineMatrix(origins, dests) {  // ~35 mph estimate when routing is unavailable
  const miles = origins.map((o) => dests.map((d) => haversineMi(o.lat, o.lon, d.lat, d.lon)));
  const minutes = miles.map((row) => row.map((mi) => mi / 35 * 60));
  return { minutes, miles, approx: true };
}

async function fetchJSON(proxyUrl, directUrl) {
  try {
    const r = await fetch(proxyUrl, { cache: 'no-store' });
    if (r.ok && (r.headers.get('content-type') || '').includes('json')) return await r.json();
  } catch (_) { /* proxy absent (static hosting) — fall through */ }
  const r = await fetch(directUrl, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.json();
}

/* --- Google Maps JS SDK engine --- */
let _gmaps = null;
function loadGoogle() {
  if (_gmaps) return _gmaps;
  _gmaps = new Promise((res, rej) => {
    if (window.google && window.google.maps) return res();
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GKEY)}`;
    s.async = true;
    s.onload = () => (window.google && window.google.maps) ? res() : rej(new Error('Google Maps did not initialize'));
    s.onerror = () => rej(new Error('Google Maps failed to load — check the API key / referrer restriction'));
    document.head.appendChild(s);
  });
  return _gmaps;
}
function gGeocode(address) {
  return new Promise((res, rej) => {
    new google.maps.Geocoder().geocode({ address }, (r, status) => {
      if (status === 'OK' && r[0]) {
        const l = r[0].geometry.location;
        res({ lat: l.lat(), lon: l.lng(), matched: r[0].formatted_address });
      } else if (status === 'ZERO_RESULTS') {
        res(null);                                   // genuinely no match for this address
      } else {
        // REQUEST_DENIED (API not enabled / bad key), OVER_QUERY_LIMIT, etc.
        rej(new Error('Google geocoder: ' + status));
      }
    });
  });
}
function gMatrix(origins, dests) {
  return new Promise((res, rej) => {
    new google.maps.DistanceMatrixService().getDistanceMatrix({
      origins: origins.map((p) => ({ lat: p.lat, lng: p.lon })),
      destinations: dests.map((p) => ({ lat: p.lat, lng: p.lon })),
      travelMode: google.maps.TravelMode.DRIVING,
      unitSystem: google.maps.UnitSystem.IMPERIAL,
    }, (resp, status) => {
      if (status !== 'OK') return rej(new Error('DistanceMatrix ' + status));
      const minutes = resp.rows.map((row) => row.elements.map((e) => e.status === 'OK' ? e.duration.value / 60 : null));
      const miles = resp.rows.map((row) => row.elements.map((e) => e.status === 'OK' ? e.distance.value / 1609.34 : null));
      res({ minutes, miles });
    });
  });
}

/* --- US Census + OSRM engine (via proxy, direct fallback) --- */
async function censusGeocode(address) {
  const q = encodeURIComponent(address);
  const d = await fetchJSON(`${PROXY.geocode}?address=${q}`,
    `${CENSUS}?address=${q}&benchmark=Public_AR_Current&format=json`);
  const m = d && d.result && d.result.addressMatches && d.result.addressMatches[0];
  return m ? { lat: m.coordinates.y, lon: m.coordinates.x, matched: m.matchedAddress } : null;
}
async function osrmMatrix(origins, dests) {
  const pts = [...origins, ...dests];
  const coords = pts.map((p) => `${p.lon},${p.lat}`).join(';');
  const sources = origins.map((_, i) => i).join(';');
  const destinations = dests.map((_, i) => origins.length + i).join(';');
  const d = await fetchJSON(
    `${PROXY.table}?coords=${encodeURIComponent(coords)}&sources=${sources}&destinations=${destinations}`,
    `${OSRM}${coords}?sources=${sources}&destinations=${destinations}&annotations=duration,distance`);
  if (!d || d.code !== 'Ok') throw new Error('routing failed');
  const minutes = d.durations.map((row) => row.map((s) => s == null ? null : s / 60));
  const miles = d.distances ? d.distances.map((row) => row.map((s) => s == null ? null : s / 1609.34))
    : minutes.map((row) => row.map(() => null));
  return { minutes, miles };
}

const Geo = {
  init: () => USE_GOOGLE ? loadGoogle() : Promise.resolve(),
  rawGeocode: USE_GOOGLE ? gGeocode : censusGeocode,
  matrix: USE_GOOGLE ? gMatrix : osrmMatrix,
};
function cleanAddress(a) {
  return String(a || '')
    .replace(/\s+/g, ' ')                    // collapse runs of whitespace
    .replace(/,(?=\S)/g, ', ')               // ensure a space after commas
    .trim();
}
async function geocode(address) {
  const clean = cleanAddress(address);
  const key = 'geo:' + clean.toLowerCase();
  const cached = sessionStorage.getItem(key);
  if (cached) return JSON.parse(cached);
  const out = await Geo.rawGeocode(clean);
  if (out) sessionStorage.setItem(key, JSON.stringify(out));
  return out;
}

/* ------------------------------------------------------------------ *
 * Run — closest stores per partner
 * ------------------------------------------------------------------ */
$('runBtn').addEventListener('click', run);

async function run() {
  const ni = +$('colName').value, ai = +$('colArea').value, di = +$('colAddr').value;
  const useDrive = $('optDriveTime').checked;
  const people = parsed.rows.map((r) => ({ name: r[ni] || '(no name)', area: r[ai] || '', address: r[di] || '' }));

  $('uploadPanel').hidden = true;
  $('progressPanel').hidden = false;
  $('resultsPanel').hidden = true;
  $('carpoolPanel').hidden = true;
  results = [];

  try {
    setProgress(0, 'Loading map service…');
    await Geo.init();
  } catch (err) {
    setProgress(0, '');
    $('progressText').innerHTML = `<span class="err">Map service failed to load: ${escapeHtml(err.message)}</span>`;
    return;
  }

  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    setProgress(i / people.length, `Matching ${i + 1} of ${people.length}: ${p.name}`);
    try {
      const geo = p.address ? await geocode(p.address) : null;
      if (!geo) { results.push({ ...p, error: 'Address not found' }); continue; }

      const ranked = STORES
        .map((s) => ({ store: s, straightMi: haversineMi(geo.lat, geo.lon, s.lat, s.lon) }))
        .sort((a, b) => a.straightMi - b.straightMi);
      const shortlist = ranked.slice(0, NEAREST_CANDIDATES);

      let matches;
      if (useDrive) {
        try {
          const mx = await Geo.matrix([geo], shortlist.map((c) => c.store));
          matches = shortlist.map((c, j) => ({ ...c, minutes: mx.minutes[0][j], miles: mx.miles[0][j] }))
            .sort((a, b) => (a.minutes ?? 1e9) - (b.minutes ?? 1e9));
        } catch (_) {
          matches = shortlist.map((c) => ({ ...c, minutes: null, miles: null }));
        }
      } else {
        matches = shortlist;
      }
      results.push({ ...p, geo, top: matches.slice(0, TOP_N) });
    } catch (err) {
      results.push({ ...p, error: 'Lookup failed: ' + err.message });
    }
  }

  setProgress(1, 'Grouping carpools…');
  renderResults();
  await computeCarpools();
  $('progressPanel').hidden = true;
}

function setProgress(frac, text) {
  $('progressBar').style.width = Math.round(frac * 100) + '%';
  $('progressText').textContent = text;
}

/* ------------------------------------------------------------------ *
 * Carpools — group partners within the same Area whose homes are within
 * the chosen drive-time threshold of each other.
 * ------------------------------------------------------------------ */
async function computeCarpools() {
  const byArea = {};
  results.forEach((r) => { if (r.geo) (byArea[(r.area || '(no area)').trim()] ||= []).push(r); });
  CARPOOL = [];
  const areas = Object.entries(byArea);
  for (let a = 0; a < areas.length; a++) {
    const [area, members] = areas[a];
    const entry = { area, members, mins: null, approx: false };
    if (members.length >= 2) {
      const pts = members.map((m) => m.geo);
      try {
        if (USE_GOOGLE && pts.length * pts.length > 100) throw new Error('matrix too large');
        entry.mins = (await Geo.matrix(pts, pts)).minutes;
      } catch (_) {
        entry.mins = haversineMatrix(pts, pts).minutes;
        entry.approx = true;
      }
    }
    CARPOOL.push(entry);
  }
  renderCarpools();
}

$('carpoolThreshold').addEventListener('change', renderCarpools);

function renderCarpools() {
  const thr = +$('carpoolThreshold').value;
  results.forEach((r) => { r._carpool = ''; });
  let groupCount = 0, pairedCount = 0, soloCount = 0;

  const blocks = CARPOOL.map((entry) => {
    const { area, members, mins, approx } = entry;
    let groups = [], singles = members.slice();

    if (members.length >= 2 && mins) {
      const n = members.length, parent = [...Array(n).keys()];
      const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const t = Math.min(mins[i][j] ?? 1e9, mins[j][i] ?? 1e9);
        if (t <= thr) parent[find(i)] = find(j);
      }
      const comp = {};
      for (let i = 0; i < n; i++) (comp[find(i)] ||= []).push(i);
      const parts = Object.values(comp);
      groups = parts.filter((g) => g.length >= 2).map((g) => {
        let maxLeg = 0;
        for (const x of g) for (const y of g) if (x !== y) {
          const t = Math.min(mins[x][y] ?? 1e9, mins[y][x] ?? 1e9);
          if (t < 1e9) maxLeg = Math.max(maxLeg, t);
        }
        return { idxs: g, members: g.map((i) => members[i]), maxLeg };
      });
      singles = parts.filter((g) => g.length === 1).map((g) => members[g[0]]);
    }

    groups.forEach((g, gi) => {
      const label = `${area} · Group ${String.fromCharCode(65 + gi)}`;
      g.members.forEach((m) => { m._carpool = label; });
      groupCount++; pairedCount += g.members.length;
    });
    singles.forEach((m) => { m._carpool = 'Solo'; });
    soloCount += singles.length;
    return areaBlock(area, groups, singles, approx);
  }).join('');

  $('carpoolContainer').innerHTML = blocks || '<p class="muted">No geocoded partners to group.</p>';
  $('carpoolSummary').textContent =
    `${groupCount} carpool${groupCount === 1 ? '' : 's'} · ${pairedCount} paired · ${soloCount} solo`;
  $('carpoolPanel').hidden = false;
}

function areaBlock(area, groups, singles, approx) {
  const gHtml = groups.map((g, gi) => `
    <div class="cp-group">
      <div class="cp-group-head"><span class="cp-badge">${String.fromCharCode(65 + gi)}</span>
        ${g.members.length} partners · <span class="muted">within ${fmtMin(g.maxLeg)}${approx ? ' (est.)' : ''}</span></div>
      <ul class="cp-members">${g.members.map((m) =>
        `<li><span class="cp-dot"></span>${escapeHtml(m.name)} <span class="muted">— ${escapeHtml(m.address)}</span></li>`).join('')}</ul>
    </div>`).join('');
  const sHtml = singles.length
    ? `<div class="cp-solo"><span class="muted">Solo (no nearby match):</span> ${singles.map((m) => escapeHtml(m.name)).join(', ')}</div>`
    : '';
  return `<div class="cp-area"><h3>${escapeHtml(area)}</h3>${gHtml || '<p class="muted">No pairs within range.</p>'}${sHtml}</div>`;
}

/* ------------------------------------------------------------------ *
 * Results table + export
 * ------------------------------------------------------------------ */
function fmtMi(mi) { return mi == null ? '—' : (mi < 10 ? mi.toFixed(1) : Math.round(mi)) + ' mi'; }
function fmtMin(m) { return m == null ? '—' : Math.round(m) + ' min'; }

function storeCell(m) {
  if (!m) return '<td class="store-cell muted">—</td>';
  const s = m.store;
  const drive = m.minutes != null ? `<span class="pill drive">🚗 ${fmtMin(m.minutes)}</span>` : '';
  const dist = `<span class="pill dist">${fmtMi(m.miles != null ? m.miles : m.straightMi)}${m.miles == null ? ' (direct)' : ''}</span>`;
  return `<td class="store-cell">
    <div class="store-name">${escapeHtml(titleCase(s.name))} <span class="store-id">#${s.id}</span></div>
    <div class="muted">${escapeHtml(titleCase(s.address))}</div>
    <div class="store-metrics">${drive}${dist}</div></td>`;
}

function renderResults() {
  const body = $('resultsBody');
  body.innerHTML = results.map((r) => {
    const info = `<td><div class="p-name">${escapeHtml(r.name)}</div></td>
      <td>${escapeHtml(r.area)}</td>
      <td class="p-addr">${escapeHtml(r.address)}</td>`;
    if (r.error) return `<tr>${info}<td colspan="3" class="err">⚠︎ ${escapeHtml(r.error)}</td></tr>`;
    const cells = [0, 1, 2].map((i) => {
      const m = r.top[i];
      if (!m) return '<td class="store-cell muted">—</td>';
      return storeCell(m).replace('<td class="store-cell">', `<td class="store-cell"><span class="rank">${i + 1}</span>`);
    }).join('');
    return `<tr>${info}${cells}</tr>`;
  }).join('');

  const ok = results.filter((r) => !r.error).length;
  $('resultsSummary').textContent = `${ok}/${results.length} matched`;
  $('resultsPanel').hidden = false;
}

function exportRows() {
  const head = ['Partner Name', 'Area', 'Carpool Group', 'Home Address'];
  for (let i = 1; i <= TOP_N; i++) head.push(`Store ${i}`, `Store ${i} ID`, `Store ${i} Drive (min)`, `Store ${i} Miles`);
  const rows = [head];
  for (const r of results) {
    const row = [r.name, r.area, r._carpool || '', r.address];
    for (let i = 0; i < TOP_N; i++) {
      const m = r.top && r.top[i];
      if (m) row.push(titleCase(m.store.name), m.store.id,
        m.minutes != null ? Math.round(m.minutes) : '',
        (m.miles != null ? m.miles : m.straightMi).toFixed(1));
      else row.push(r.error || '', '', '', '');
    }
    rows.push(row);
  }
  return rows;
}
$('exportCsvBtn').addEventListener('click', () => {
  const csv = exportRows().map((r) => r.map((c) => {
    const s = String(c ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
  download(new Blob([csv], { type: 'text/csv' }), 'store-matches.csv');
});
$('exportXlsxBtn').addEventListener('click', () => {
  const ws = XLSX.utils.aoa_to_sheet(exportRows());
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Store Matches');
  XLSX.writeFile(wb, 'store-matches.xlsx');
});
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ------------------------------------------------------------------ *
 * util
 * ------------------------------------------------------------------ */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function titleCase(s) {
  return String(s ?? '').toLowerCase().replace(/\b([a-z])/g, (m, c) => c.toUpperCase())
    .replace(/\b(Ih|Us|Fm|Sh|Nw|Se|Ne|Sw|Rd|Dr|St|Blvd|Hwy|Ln|Pkwy)\b/gi, (m) => m.toUpperCase());
}
