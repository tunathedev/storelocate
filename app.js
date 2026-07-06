/* HEB Store Match — manager placement tool
 * Flow: unlock (PIN 1905) → upload cohort → detect columns →
 *       geocode home addresses (US Census) → rank stores by straight-line →
 *       drive time for the nearest candidates (OSRM) → table + export.
 *
 * Privacy: runs entirely client-side. Home addresses go only to the U.S. Census
 * geocoder; OSRM receives coordinates only. Nothing is persisted to disk; the
 * unlock flag and a geocode cache live in sessionStorage (cleared on tab close).
 */
'use strict';

const $ = (id) => document.getElementById(id);
const MASTER_PIN = '1905';
const NEAREST_CANDIDATES = 8;   // straight-line shortlist sent to the router
const TOP_N = 3;                // stores shown per partner

/* Try a same-origin proxy first (node server.js), then the public endpoint. */
const PROXY = { geocode: '/api/geocode', table: '/api/table' };
const CENSUS = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const OSRM = 'https://router.project-osrm.org/table/v1/driving/';

let STORES = [];
let parsed = null;   // { headers, rows }
let results = [];    // computed matches

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
 * Geo helpers
 * ------------------------------------------------------------------ */
function haversineMi(lat1, lon1, lat2, lon2) {
  const R = 3958.7613, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

/* fetch JSON, preferring the same-origin proxy, falling back to the public API */
async function fetchJSON(proxyUrl, directUrl) {
  try {
    const r = await fetch(proxyUrl, { cache: 'no-store' });
    if (r.ok) {
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('json')) return await r.json();
    }
  } catch (_) { /* proxy absent (e.g. static hosting) — fall through */ }
  const r = await fetch(directUrl, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.json();
}

async function geocode(address) {
  const key = 'geo:' + address.toLowerCase().replace(/\s+/g, ' ');
  const cached = sessionStorage.getItem(key);
  if (cached) return JSON.parse(cached);

  const q = encodeURIComponent(address);
  const proxyUrl = `${PROXY.geocode}?address=${q}`;
  const directUrl = `${CENSUS}?address=${q}&benchmark=Public_AR_Current&format=json`;
  const d = await fetchJSON(proxyUrl, directUrl);
  const m = d && d.result && d.result.addressMatches && d.result.addressMatches[0];
  const out = m ? { lat: m.coordinates.y, lon: m.coordinates.x, matched: m.matchedAddress } : null;
  if (out) sessionStorage.setItem(key, JSON.stringify(out));
  return out;
}

/* OSRM table: durations & distances from one origin to K store coords */
async function driveTimes(origin, stores) {
  const coords = [origin, ...stores].map((p) => `${p.lon},${p.lat}`).join(';');
  const dest = stores.map((_, i) => i + 1).join(';');
  const proxyUrl = `${PROXY.table}?coords=${encodeURIComponent(coords)}&sources=0&destinations=${dest}`;
  const directUrl = `${OSRM}${coords}?sources=0&destinations=${dest}&annotations=duration,distance`;
  const d = await fetchJSON(proxyUrl, directUrl);
  if (!d || d.code !== 'Ok') throw new Error('routing failed');
  return stores.map((_, i) => ({
    minutes: d.durations[0][i] != null ? d.durations[0][i] / 60 : null,
    miles: d.distances && d.distances[0][i] != null ? d.distances[0][i] / 1609.34 : null,
  }));
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */
$('runBtn').addEventListener('click', run);

async function run() {
  const ni = +$('colName').value, ai = +$('colArea').value, di = +$('colAddr').value;
  const useDrive = $('optDriveTime').checked;
  const people = parsed.rows.map((r) => ({ name: r[ni] || '(no name)', area: r[ai] || '', address: r[di] || '' }));

  $('uploadPanel').hidden = true;
  $('progressPanel').hidden = false;
  $('resultsPanel').hidden = true;
  results = [];

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
          const dt = await driveTimes(geo, shortlist.map((c) => c.store));
          matches = shortlist.map((c, j) => ({ ...c, ...dt[j] }))
            .sort((a, b) => (a.minutes ?? 1e9) - (b.minutes ?? 1e9));
        } catch (_) {
          matches = shortlist.map((c) => ({ ...c, minutes: null, miles: null, driveFailed: true }));
        }
      } else {
        matches = shortlist;
      }
      results.push({ ...p, geo, top: matches.slice(0, TOP_N) });
    } catch (err) {
      results.push({ ...p, error: 'Lookup failed: ' + err.message });
    }
  }

  setProgress(1, 'Done');
  renderResults();
}

function setProgress(frac, text) {
  $('progressBar').style.width = Math.round(frac * 100) + '%';
  $('progressText').textContent = text;
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
  $('progressPanel').hidden = true;
  $('resultsPanel').hidden = false;
}

function exportRows() {
  const rows = [['Partner Name', 'Area', 'Home Address']];
  for (let i = 1; i <= TOP_N; i++) rows[0].push(`Store ${i}`, `Store ${i} ID`, `Store ${i} Drive (min)`, `Store ${i} Miles`);
  for (const r of results) {
    const row = [r.name, r.area, r.address];
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
