'use strict';

// ---------- Bronnen (PDOK open data, geen API-sleutel nodig) ----------
const PDOK = {
  locatie: 'https://api.pdok.nl/bzk/locatieserver/search/v3_1',
  brk: 'https://api.pdok.nl/kadaster/brk-kadastrale-kaart/ogc/v1/collections',
  bag: 'https://api.pdok.nl/kadaster/bag/ogc/v2/collections',
  wmsKadaster: 'https://service.pdok.nl/kadaster/kadastralekaart/wms/v5_0',
  wmsPlannen: 'https://service.pdok.nl/kadaster/ruimtelijke-plannen/wms/v1_0',
  wmsAhn: 'https://service.pdok.nl/rws/ahn/wms/v1_0',
  wmsCultuur: 'https://service.pdok.nl/rce/beschermde-gebieden-cultuurhistorie/wms/v1_0',
};
const ATTR = 'Kaartgegevens &copy; <a href="https://www.pdok.nl">PDOK</a> / Kadaster';

// ---------- Hulpfuncties ----------
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n, d = 0) => Number(n).toLocaleString('nl-NL', { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtLen = (m) => (m >= 1000 ? `${fmtNum(m / 1000, 2)} km` : `${fmtNum(m, 1)} m`);
const fmtArea = (m2) => (m2 >= 10000 ? `${fmtNum(m2, 0)} m² (${fmtNum(m2 / 10000, 2)} ha)` : `${fmtNum(m2, 1)} m²`);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* opslag niet beschikbaar */ } },
};

async function getJSON(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} bij ${new URL(url).hostname}`);
  return r.json();
}
function parsePoint(wkt) {
  const m = /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(wkt || '');
  return m ? [parseFloat(m[2]), parseFloat(m[1])] : null; // [lat, lon]
}

// Geometrie (GeoJSON in lon/lat)
function rings(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}
function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pointInGeom(pt, geom) {
  return rings(geom).some((poly) => inRing(pt, poly[0]) && !poly.slice(1).some((h) => inRing(pt, h)));
}
function bboxOf(geom) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  rings(geom).forEach((p) => p[0].forEach(([x, y]) => { b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)]; }));
  return b;
}
// Geodetische oppervlakte (sferisch, zelfde methode als Leaflet.draw)
function ringArea(latlngs) {
  const R = 6378137, d2r = Math.PI / 180;
  let a = 0;
  for (let i = 0; i < latlngs.length; i++) {
    const p1 = latlngs[i], p2 = latlngs[(i + 1) % latlngs.length];
    a += (p2.lng - p1.lng) * d2r * (2 + Math.sin(p1.lat * d2r) + Math.sin(p2.lat * d2r));
  }
  return Math.abs((a * R * R) / 2);
}
function pathLength(latlngs, closed) {
  let l = 0;
  for (let i = 1; i < latlngs.length; i++) l += latlngs[i - 1].distanceTo(latlngs[i]);
  if (closed && latlngs.length > 2) l += latlngs[latlngs.length - 1].distanceTo(latlngs[0]);
  return l;
}
function geomStats(geom) {
  let area = 0, perim = 0;
  rings(geom).forEach((poly) => poly.forEach((ring, i) => {
    const ll = ring.map(([x, y]) => L.latLng(y, x));
    area += (i === 0 ? 1 : -1) * ringArea(ll);
    if (i === 0) perim += pathLength(ll, false);
  }));
  return { area, perim };
}

// ---------- Kaart ----------
const start = (() => {
  const m = /#(-?[\d.]+),(-?[\d.]+),(\d+)/.exec(location.hash);
  return m ? { c: [+m[1], +m[2]], z: +m[3] } : store.get('view', { c: [52.15, 5.3], z: 8 });
})();
const map = L.map('map', { zoomControl: false, maxZoom: 21 }).setView(start.c, start.z);

L.control.zoom({ position: 'bottomright' }).addTo(map);

const wmts = (layer, ext = 'png') =>
  `https://service.pdok.nl/${layer}/EPSG:3857/{z}/{x}/{y}.${ext}`;
const bases = {
  brt: L.tileLayer(wmts('brt/achtergrondkaart/wmts/v2_0/standaard'), { maxNativeZoom: 19, maxZoom: 21, attribution: ATTR }),
  grijs: L.tileLayer(wmts('brt/achtergrondkaart/wmts/v2_0/grijs'), { maxNativeZoom: 19, maxZoom: 21, attribution: ATTR }),
  lucht: L.tileLayer(wmts('hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR', 'jpeg'), { maxNativeZoom: 21, maxZoom: 21, attribution: ATTR }),
};
const wms = (url, layers, opts = {}) =>
  L.tileLayer.wms(url, { layers, format: 'image/png', transparent: true, version: '1.3.0', maxZoom: 21, ...opts });
const overlays = {
  kadaster: wms(PDOK.wmsKadaster, 'Kadastralekaart', { minZoom: 16, zIndex: 50 }),
  bestemming: wms(PDOK.wmsPlannen, 'enkelbestemming', { opacity: 0.55, zIndex: 20 }),
  bouwvlak: wms(PDOK.wmsPlannen, 'bouwvlak', { zIndex: 30 }),
  ahn_dsm: wms(PDOK.wmsAhn, 'dsm_05m', { opacity: 0.7, zIndex: 10 }),
  ahn_dtm: wms(PDOK.wmsAhn, 'dtm_05m', { opacity: 0.7, zIndex: 10 }),
  cultuur: wms(PDOK.wmsCultuur, 'PS.ProtectedSite', { opacity: 0.6, zIndex: 25 }),
};

const prefs = store.get('layers', { base: 'brt', on: ['kadaster'] });
let currentBase = bases[prefs.base] ? prefs.base : 'brt';
bases[currentBase].addTo(map);
document.querySelector(`input[name=base][value=${currentBase}]`).checked = true;
document.querySelectorAll('[data-layer]').forEach((cb) => {
  cb.checked = prefs.on.includes(cb.dataset.layer);
  if (cb.checked) overlays[cb.dataset.layer].addTo(map);
  cb.addEventListener('change', () => {
    const l = overlays[cb.dataset.layer];
    cb.checked ? l.addTo(map) : map.removeLayer(l);
    saveLayerPrefs();
  });
});
document.querySelectorAll('input[name=base]').forEach((r) => r.addEventListener('change', () => {
  map.removeLayer(bases[currentBase]);
  currentBase = r.value;
  bases[currentBase].addTo(map).bringToBack();
  saveLayerPrefs();
}));
function saveLayerPrefs() {
  store.set('layers', { base: currentBase, on: [...document.querySelectorAll('[data-layer]:checked')].map((c) => c.dataset.layer) });
}
map.on('moveend', () => {
  const c = map.getCenter(), z = map.getZoom();
  store.set('view', { c: [c.lat, c.lng], z });
  history.replaceState(null, '', `#${c.lat.toFixed(6)},${c.lng.toFixed(6)},${z}`);
});

const highlight = L.layerGroup().addTo(map);
const favLayer = L.layerGroup().addTo(map);

// ---------- Panelen ----------
function togglePanel(id) {
  ['#layers', '#favs'].forEach((p) => { if (p !== id) $(p).hidden = true; });
  $(id).hidden = !$(id).hidden;
}
$('#btn-layers').onclick = () => togglePanel('#layers');
$('#btn-favs').onclick = () => { renderFavs(); togglePanel('#favs'); };
$('#info-close').onclick = () => { $('#info').hidden = true; highlight.clearLayers(); };

// ---------- Zoeken ----------
let sugTimer, sugItems = [], sugIdx = -1;
const TYPE_LABEL = { adres: 'adres', perceel: 'perceel', postcode: 'postcode', weg: 'straat', woonplaats: 'plaats', gemeente: 'gemeente', provincie: 'provincie' };
$('#q').addEventListener('input', (e) => {
  clearTimeout(sugTimer);
  const q = e.target.value.trim();
  if (q.length < 2) return hideSuggest();
  sugTimer = setTimeout(() => suggest(q), 200);
});
$('#q').addEventListener('keydown', (e) => {
  const lis = [...$('#suggest').children];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    sugIdx = (sugIdx + (e.key === 'ArrowDown' ? 1 : -1) + lis.length) % lis.length;
    lis.forEach((li, i) => li.classList.toggle('active', i === sugIdx));
  } else if (e.key === 'Enter') {
    const item = sugItems[sugIdx >= 0 ? sugIdx : 0];
    if (item) pick(item);
  } else if (e.key === 'Escape') hideSuggest();
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) hideSuggest(); });
function hideSuggest() { $('#suggest').hidden = true; sugIdx = -1; }

async function suggest(q) {
  try {
    const fq = 'type:(adres OR perceel OR postcode OR weg OR woonplaats OR gemeente)';
    const d = await getJSON(`${PDOK.locatie}/suggest?q=${encodeURIComponent(q)}&rows=10&fq=${encodeURIComponent(fq)}`);
    sugItems = d.response.docs;
    sugIdx = -1;
    $('#suggest').innerHTML = sugItems.map((s) =>
      `<li><span>${esc(s.weergavenaam)}</span><span class="type">${esc(TYPE_LABEL[s.type] || s.type)}</span></li>`).join('')
      || '<li><span class="muted">Geen resultaten</span></li>';
    [...$('#suggest').children].forEach((li, i) => { li.onclick = () => sugItems[i] && pick(sugItems[i]); });
    $('#suggest').hidden = false;
  } catch (err) { console.error(err); }
}
async function pick(item) {
  hideSuggest();
  $('#q').value = item.weergavenaam;
  const d = await getJSON(`${PDOK.locatie}/lookup?id=${encodeURIComponent(item.id)}&fl=*`);
  const doc = d.response.docs[0];
  const ll = parsePoint(doc?.centroide_ll);
  if (!ll) return;
  const zoom = { adres: 19, perceel: 19, postcode: 18, weg: 17, woonplaats: 13, gemeente: 12 }[doc.type] || 16;
  map.setView(ll, zoom);
  if (doc.type === 'adres' || doc.type === 'perceel') identify(L.latLng(ll));
}

// ---------- Identificeren (klik op kaart) ----------
let mode = null; // null | 'line' | 'area'
map.on('click', (e) => { if (mode) addMeasurePoint(e.latlng); else identify(e.latlng); });

let identifySeq = 0;
async function identify(latlng) {
  const seq = ++identifySeq;
  const pt = [latlng.lng, latlng.lat];
  highlight.clearLayers();
  L.circleMarker(latlng, { radius: 5, color: '#d6336c', fillOpacity: 1 }).addTo(highlight);
  $('#info').hidden = false;
  $('#info-title').textContent = 'Locatie';
  $('#info-body').innerHTML = '<p class="loading">Gegevens ophalen…</p>';

  const d = 0.00002;
  const bb = [pt[0] - d, pt[1] - d, pt[0] + d, pt[1] + d].join(',');
  let perceel = null;
  try {
    const fc = await getJSON(`${PDOK.brk}/perceel/items?f=json&bbox=${bb}&limit=10`);
    perceel = fc.features.find((f) => pointInGeom(pt, f.geometry)) || fc.features[0] || null;
  } catch (err) { console.error(err); }
  if (seq !== identifySeq) return;

  const [panden, vbos, plan] = await Promise.all([
    fetchPanden(perceel, pt).catch(() => null),
    fetchVbos(perceel, pt).catch(() => null),
    fetchBestemming(latlng).catch(() => null),
  ]);
  if (seq !== identifySeq) return;
  renderInfo({ latlng, perceel, panden, vbos, plan });
}

async function fetchPanden(perceel, pt) {
  const geom = perceel?.geometry;
  const bb = geom ? bboxOf(geom).join(',') : [pt[0] - 0.00002, pt[1] - 0.00002, pt[0] + 0.00002, pt[1] + 0.00002].join(',');
  const fc = await getJSON(`${PDOK.bag}/pand/items?f=json&bbox=${bb}&limit=100`);
  if (!geom) return fc.features.filter((f) => pointInGeom(pt, f.geometry));
  // Pand hoort bij perceel als een deel van het pand binnen het perceel ligt. Hoekpunten worden iets
  // naar het midden van het pand geschoven, zodat panden die alleen een grens delen niet meetellen.
  return fc.features.filter((f) => rings(f.geometry).some((p) => {
    const r = p[0];
    let cx = 0, cy = 0;
    r.forEach(([x, y]) => { cx += x; cy += y; });
    cx /= r.length; cy /= r.length;
    return pointInGeom([cx, cy], geom) || r.some(([x, y]) => pointInGeom([x + (cx - x) * 0.05, y + (cy - y) * 0.05], geom));
  }));
}
async function fetchVbos(perceel, pt) {
  const geom = perceel?.geometry;
  if (!geom) return [];
  const fc = await getJSON(`${PDOK.bag}/verblijfsobject/items?f=json&bbox=${bboxOf(geom).join(',')}&limit=200`);
  return fc.features.filter((f) => f.geometry?.type === 'Point' && pointInGeom(f.geometry.coordinates, geom));
}
async function fetchBestemming(latlng) {
  const p = map.options.crs.project(latlng), r = 5;
  const layers = 'enkelbestemming,dubbelbestemming,bouwvlak,maatvoering,functieaanduiding,bouwaanduiding,gebiedsaanduiding';
  const q = new URLSearchParams({
    service: 'WMS', version: '1.3.0', request: 'GetFeatureInfo', layers, query_layers: layers, styles: '',
    crs: 'EPSG:3857', bbox: [p.x - r, p.y - r, p.x + r, p.y + r].join(','), width: 11, height: 11, i: 5, j: 5,
    info_format: 'application/json', feature_count: 25,
  });
  const fc = await getJSON(`${PDOK.wmsPlannen}?${q}`);
  return fc.features.filter((f) => f.properties.historisch !== '1');
}

// ---------- Weergave ----------
function table(rows) {
  return `<table>${rows.filter((r) => r[1] !== undefined && r[1] !== null && r[1] !== '')
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('')}</table>`;
}
function adresVan(p) {
  return `${p.openbare_ruimte_naam} ${p.huisnummer}${p.huisletter || ''}${p.toevoeging ? '-' + p.toevoeging : ''}, ${p.postcode || ''} ${p.woonplaats_naam}`;
}

let lastInfo = null;
function renderInfo({ latlng, perceel, panden, vbos, plan }) {
  lastInfo = { latlng, perceel };
  let html = '';
  const ll = `${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`;

  if (perceel) {
    const p = perceel.properties;
    const aanduiding = `${p.kadastrale_gemeente_waarde} ${p.sectie} ${p.perceelnummer}`;
    const code = `${p.akr_kadastrale_gemeente_code_waarde} ${p.sectie} ${p.perceelnummer}`;
    const stats = geomStats(perceel.geometry);
    $('#info-title').textContent = `Perceel ${aanduiding}`;
    L.geoJSON(perceel.geometry, { style: { color: '#d6336c', weight: 3, fillOpacity: 0.12 } }).addTo(highlight);
    html += '<h4>Perceel</h4>' + table([
      ['Kadastrale aanduiding', esc(aanduiding)],
      ['Code', esc(code)],
      ['Kadastrale grootte', `${fmtNum(p.kadastrale_grootte_waarde)} m² <span class="muted">(${esc(p.soort_grootte_waarde?.toLowerCase())})</span>`],
      ['Berekende oppervlakte', `${fmtArea(stats.area)}`],
      ['Omtrek', fmtLen(stats.perim)],
      ['Status', esc(p.status_historie_waarde)],
      ['Geregistreerd sinds', esc(p.begin_geldigheid?.slice(0, 10))],
      ['Perceel-ID', esc(p.identificatie_lokaal_id)],
    ]);
  } else {
    html += '<p class="muted">Geen perceel gevonden op deze locatie.</p>';
  }

  if (vbos?.length) {
    html += `<h4>Adressen op perceel (${vbos.length})</h4>`;
    html += vbos.slice(0, 30).map((f) => {
      const p = f.properties;
      return `<div class="card"><strong>${esc(adresVan(p))}</strong>${table([
        ['Gebruiksdoel', esc(p.gebruiksdoel)],
        ['Oppervlakte', p.oppervlakte != null ? `${fmtNum(p.oppervlakte)} m²` : ''],
        ['Status', esc(p.status)],
        ['VBO-ID', esc(p.identificatie)],
      ])}</div>`;
    }).join('');
    if (vbos.length > 30) html += `<p class="muted">… en ${vbos.length - 30} meer.</p>`;
  }

  if (panden?.length) {
    html += `<h4>Gebouwen (${panden.length})</h4>`;
    panden.forEach((f) => L.geoJSON(f.geometry, { style: { color: '#1c7ed6', weight: 1.5, fillOpacity: 0.15 } }).addTo(highlight));
    html += panden.slice(0, 20).map((f) => {
      const p = f.properties, s = geomStats(f.geometry);
      return `<div class="card">${table([
        ['Bouwjaar', esc(p.bouwjaar)],
        ['Gebruiksdoel', esc(p.gebruiksdoel)],
        ['Status', esc(p.status)],
        ['Verblijfsobjecten', esc(p.aantal_verblijfsobjecten)],
        ['Footprint (berekend)', fmtArea(s.area)],
        ['Pand-ID', `<a href="https://bagviewer.kadaster.nl/lvbag/bag-viewer/?objectId=${esc(p.identificatie)}" target="_blank" rel="noopener">${esc(p.identificatie)}</a>`],
      ])}</div>`;
    }).join('');
  }

  if (plan?.length) {
    html += '<h4>Bestemmingsplan</h4>';
    const order = ['enkelbestemming', 'dubbelbestemming', 'bouwvlak', 'maatvoering', 'functieaanduiding', 'bouwaanduiding', 'gebiedsaanduiding'];
    plan.sort((a, b) => order.indexOf(a.id.split('.')[0]) - order.indexOf(b.id.split('.')[0]));
    const seen = new Set();
    html += plan.filter((f) => !seen.has(f.id) && seen.add(f.id)).map((f) => {
      const p = f.properties, soort = f.id.split('.')[0];
      const tekst = p.verwijzingnaartekst ? ` · <a href="${esc(p.verwijzingnaartekst)}" target="_blank" rel="noopener">regels</a>` : '';
      return `<div class="card"><strong>${esc(p.naam || soort)}</strong> <span class="muted">${esc(soort)}</span>${tekst}
        ${table([['Plan', esc(p.dossierid)], ['Status', esc(p.planstatus)], ['Datum', esc(p.datum)]])}</div>`;
    }).join('');
    html += '<p class="muted">Bron: ruimtelijkeplannen.nl (Wro-plannen). Sinds de Omgevingswet kunnen er aanvullende regels in het omgevingsplan staan — controleer via het Omgevingsloket.</p>';
  }

  const firstVbo = vbos?.[0]?.properties;
  const wozQ = firstVbo ? `${firstVbo.postcode} ${firstVbo.huisnummer}${firstVbo.huisletter || ''}` : '';
  html += '<h4>Meer informatie</h4><div class="links">'
    + `<a href="https://www.wozwaardeloket.nl/" target="_blank" rel="noopener" title="${esc(wozQ)}">WOZ-waarde${wozQ ? ' (' + esc(wozQ) + ')' : ''}</a>`
    + '<a href="https://www.kadaster.nl/producten/woning/eigendomsinformatie" target="_blank" rel="noopener">Eigenaar opvragen (Kadaster, betaald)</a>'
    + `<a href="https://omgevingswet.overheid.nl/regels-op-de-kaart/zoeken/locatie?locatie=${latlng.lat},${latlng.lng}" target="_blank" rel="noopener">Omgevingsloket</a>`
    + `<a href="https://www.ruimtelijkeplannen.nl/viewer?lat=${latlng.lat}&lon=${latlng.lng}" target="_blank" rel="noopener">Ruimtelijkeplannen</a>`
    + `<a href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${latlng.lat},${latlng.lng}" target="_blank" rel="noopener">Street View</a>`
    + '</div>';

  html += `<h4>Locatie</h4>${table([['WGS84', ll]])}<div class="row">`
    + '<button id="act-fav">★ Bewaar als favoriet</button>'
    + (perceel ? '<button id="act-geojson">Download perceel (GeoJSON)</button>' : '')
    + '<button id="act-share">Deel link</button></div>';

  $('#info-body').innerHTML = html;
  $('#act-fav').onclick = addFav;
  $('#act-share').onclick = share;
  if (perceel) $('#act-geojson').onclick = () => download(`perceel-${perceel.properties.identificatie_lokaal_id}.geojson`,
    JSON.stringify({ type: 'FeatureCollection', features: [perceel] }));
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/geo+json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function share() {
  const { latlng } = lastInfo;
  const url = `${location.origin}${location.pathname}#${latlng.lat.toFixed(6)},${latlng.lng.toFixed(6)},19`;
  try {
    if (navigator.share) await navigator.share({ title: $('#info-title').textContent, url });
    else { await navigator.clipboard.writeText(url); alert('Link gekopieerd'); }
  } catch { prompt('Kopieer deze link', url); }
}

// ---------- Favorieten ----------
function getFavs() { return store.get('favs', []); }
function addFav() {
  const { latlng, perceel } = lastInfo;
  const name = prompt('Naam / notitie', $('#info-title').textContent);
  if (name === null) return;
  const favs = getFavs();
  favs.push({ id: Date.now(), name, lat: latlng.lat, lng: latlng.lng, perceel: perceel?.properties?.identificatie_lokaal_id || null,
    geometry: perceel?.geometry || null, added: new Date().toISOString() });
  store.set('favs', favs);
  drawFavs();
}
function drawFavs() {
  favLayer.clearLayers();
  getFavs().forEach((f) => L.marker([f.lat, f.lng], { title: f.name }).bindTooltip(esc(f.name)).addTo(favLayer)
    .on('click', () => identify(L.latLng(f.lat, f.lng))));
}
function renderFavs() {
  const favs = getFavs();
  $('#fav-list').innerHTML = favs.length ? favs.map((f) =>
    `<li data-id="${f.id}"><span>${esc(f.name)}</span><button class="del" title="Verwijderen">✕</button></li>`).join('')
    : '<li class="muted">Nog geen favorieten. Klik op een perceel en kies "Bewaar als favoriet".</li>';
  $('#fav-list').querySelectorAll('li[data-id]').forEach((li) => {
    const f = favs.find((x) => String(x.id) === li.dataset.id);
    li.querySelector('span').onclick = () => { map.setView([f.lat, f.lng], 19); identify(L.latLng(f.lat, f.lng)); };
    li.querySelector('.del').onclick = () => { store.set('favs', getFavs().filter((x) => x.id !== f.id)); drawFavs(); renderFavs(); };
  });
}
$('#fav-export').onclick = () => download('favorieten.geojson', JSON.stringify({
  type: 'FeatureCollection',
  features: getFavs().map((f) => ({
    type: 'Feature',
    geometry: f.geometry || { type: 'Point', coordinates: [f.lng, f.lat] },
    properties: { naam: f.name, perceel: f.perceel, toegevoegd: f.added },
  })),
}, null, 1));
drawFavs();

// ---------- Meten ----------
let mPoints = [], mLayer = L.layerGroup().addTo(map);
function startMeasure(kind) {
  if (mode === kind) return stopMeasure();
  mode = kind; mPoints = []; mLayer.clearLayers();
  $('#btn-measure-line').classList.toggle('on', kind === 'line');
  $('#btn-measure-area').classList.toggle('on', kind === 'area');
  $('#measure-box').hidden = false;
  $('#measure-out').textContent = 'Klik op de kaart om te meten';
  map.getContainer().style.cursor = 'crosshair';
}
function stopMeasure() {
  mode = null;
  $('#btn-measure-line').classList.remove('on');
  $('#btn-measure-area').classList.remove('on');
  $('#measure-box').hidden = true;
  mLayer.clearLayers();
  map.getContainer().style.cursor = '';
}
function addMeasurePoint(ll) { mPoints.push(ll); drawMeasure(); }
function drawMeasure() {
  mLayer.clearLayers();
  const style = { color: '#f08c00', weight: 3, dashArray: '6 4' };
  if (mode === 'area' && mPoints.length > 2) L.polygon(mPoints, { ...style, fillOpacity: 0.15 }).addTo(mLayer);
  else if (mPoints.length > 1) L.polyline(mPoints, style).addTo(mLayer);
  mPoints.forEach((p) => L.circleMarker(p, { radius: 4, color: '#f08c00', fillOpacity: 1 }).addTo(mLayer));
  let out = 'Klik op de kaart om te meten';
  if (mode === 'line' && mPoints.length > 1) {
    const last = mPoints[mPoints.length - 1].distanceTo(mPoints[mPoints.length - 2]);
    out = `Totaal ${fmtLen(pathLength(mPoints))} · laatste ${fmtLen(last)}`;
  } else if (mode === 'area' && mPoints.length > 2) {
    out = `${fmtArea(ringArea(mPoints))} · omtrek ${fmtLen(pathLength(mPoints, true))}`;
  }
  $('#measure-out').textContent = out;
}
$('#btn-measure-line').onclick = () => startMeasure('line');
$('#btn-measure-area').onclick = () => startMeasure('area');
$('#measure-undo').onclick = () => { mPoints.pop(); drawMeasure(); };
$('#measure-stop').onclick = stopMeasure;

// ---------- Locatie ----------
let locMarker;
$('#btn-locate').onclick = () => map.locate({ setView: true, maxZoom: 18, enableHighAccuracy: true });
map.on('locationfound', (e) => {
  if (locMarker) map.removeLayer(locMarker);
  locMarker = L.layerGroup([
    L.circle(e.latlng, { radius: e.accuracy, weight: 1, fillOpacity: 0.1 }),
    L.circleMarker(e.latlng, { radius: 7, color: '#fff', weight: 2, fillColor: '#1c7ed6', fillOpacity: 1 }),
  ]).addTo(map);
});
map.on('locationerror', (e) => alert(`Locatie niet beschikbaar: ${e.message}`));
