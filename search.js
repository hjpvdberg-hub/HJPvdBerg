'use strict';
// Gebiedsanalyse: alle percelen in een gebied ophalen, koppelen aan BAG-panden en -verblijfsobjecten,
// filteren en scoren op (her)ontwikkelpotentie. Gebruikt helpers en de kaart uit app.js.

const GEBRUIKSDOELEN = ['woonfunctie', 'winkelfunctie', 'kantoorfunctie', 'industriefunctie', 'bijeenkomstfunctie',
  'logiesfunctie', 'onderwijsfunctie', 'gezondheidszorgfunctie', 'sportfunctie', 'celfunctie', 'overige gebruiksfunctie'];
const SIGNAAL_STATUS = {
  'Pand buiten gebruik': 'pand buiten gebruik',
  'Sloopvergunning verleend': 'sloopvergunning verleend',
  'Verbouwing pand': 'verbouwing pand',
  'Bouwvergunning verleend': 'bouwvergunning verleend',
  'Bouw gestart': 'bouw gestart',
  'Verblijfsobject buiten gebruik': 'verblijfsobject buiten gebruik',
  'Verbouwing verblijfsobject': 'verbouwing verblijfsobject',
  'Verblijfsobject gevormd': 'verblijfsobject in voorbereiding',
};
const VERVALLEN = /gesloopt|ingetrokken|niet gerealiseerd|ten onrechte/i;
const MAX_PAGES = 8; // x 1000 objecten per bron
const AN = { results: [], layer: L.layerGroup().addTo(map), area: null, drawPts: [], drawLayer: L.layerGroup().addTo(map) };

// ---------- UI opbouwen ----------
(function buildUI() {
  const el = document.createElement('aside');
  el.id = 'analyse';
  el.className = 'panel wide';
  el.hidden = true;
  el.innerHTML = `
    <h3>Gebied</h3>
    <div class="row">
      <button id="an-area-view" class="on">Kaartbeeld</button>
      <button id="an-area-draw">Teken gebied</button>
      <button id="an-area-clear" hidden>Wis gebied</button>
    </div>
    <p id="an-area-info" class="muted">Zoom in tot minimaal niveau 15. Grote gebieden worden afgekapt.</p>

    <h3>Perceel</h3>
    <div class="grid2">
      <label>Opp. min (m²)<input id="f-opp-min" type="number" min="0" placeholder="bijv. 500"></label>
      <label>Opp. max (m²)<input id="f-opp-max" type="number" min="0"></label>
    </div>
    <label><input id="f-elong" type="checkbox" checked> Langgerekte percelen uitsluiten (wegen, sloten, spoor)</label>

    <h3>Bebouwing</h3>
    <label>Bebouwing
      <select id="f-bebouwd"><option value="">alle</option><option value="leeg">alleen onbebouwd</option><option value="bebouwd">alleen bebouwd</option></select>
    </label>
    <div class="grid2">
      <label>Bebouwingsgraad max (%)<input id="f-graad-max" type="number" min="0" max="100"></label>
      <label>Grond per adres min (m²)<input id="f-gpa-min" type="number" min="0"></label>
      <label>Oudste pand vóór (jaar)<input id="f-bj-max" type="number" placeholder="bijv. 1980"></label>
      <label>Oudste pand na (jaar)<input id="f-bj-min" type="number"></label>
      <label>Adressen min<input id="f-adr-min" type="number" min="0"></label>
      <label>Adressen max<input id="f-adr-max" type="number" min="0"></label>
    </div>

    <h3>Gebruiksdoel</h3>
    <label>Voorwaarde
      <select id="f-doel-mode">
        <option value="any">bevat een van de aangevinkte</option>
        <option value="only">alleen aangevinkte (geen andere)</option>
        <option value="none">bevat geen van de aangevinkte</option>
      </select>
    </label>
    <div class="checks">${GEBRUIKSDOELEN.map((d) => `<label><input type="checkbox" class="f-doel" value="${d}"> ${d.replace('functie', '').replace(' gebruiks', '')}</label>`).join('')}</div>
    <label><input id="f-signaal" type="checkbox"> Alleen met BAG-signaal (buiten gebruik, sloop-/bouwvergunning, verbouwing)</label>

    <h3>Score</h3>
    <label>Minimale ontwikkelscore <output id="f-score-out">0</output>
      <input id="f-score" type="range" min="0" max="100" step="5" value="0">
    </label>
    <p class="muted">Filters werken direct op de opgehaalde percelen. Opnieuw analyseren is alleen nodig voor een ander gebied.</p><label hidden>
    </label>

    <div class="row">
      <button id="an-run" class="primary">Analyseer</button>
      <button id="an-reset">Filters wissen</button>
    </div>
    <p id="an-status" class="muted"></p>

    <div id="an-result-tools" class="row" hidden>
      <button id="an-plan">Bestemming ophalen (top 100)</button>
      <input id="f-bestemming" type="search" placeholder="filter bestemming, bijv. bedrijf" hidden>
      <button id="an-csv">CSV</button>
      <button id="an-geojson">GeoJSON</button>
    </div>
    <ol id="an-list" class="results"></ol>
    <details class="muted"><summary>Hoe werkt de score?</summary>
      <p>Indicatief, 0–100. Punten voor: groot perceel, lage bebouwingsgraad, onbebouwd, oud pand,
      alleen niet-woonfuncties (transformatiekans), veel grond per adres, en BAG-signalen
      (buiten gebruik, sloopvergunning). Geen rekening gehouden met eigendom, monumentstatus, milieu of
      bestemming (die laatste kun je apart ophalen). Gebruik het als zeef, niet als oordeel.</p>
    </details>`;
  document.body.appendChild(el);

  const btn = document.createElement('button');
  btn.id = 'btn-analyse';
  btn.title = 'Gebiedsanalyse / ontwikkelkansen';
  btn.textContent = '🏗';
  $('.tools').insertBefore(btn, $('#btn-layers'));
  btn.onclick = () => togglePanel('#analyse');

  const saved = store.get('filters', null);
  if (saved) applyFilterState(saved);
  $('#f-score').oninput = () => { $('#f-score-out').textContent = $('#f-score').value; };
  $('#f-score-out').textContent = $('#f-score').value;
  $('#an-run').onclick = runAnalysis;
  $('#an-reset').onclick = () => { applyFilterState({}); store.set('filters', null); };
  $('#an-area-view').onclick = () => { clearDraw(); setAreaMode('view'); };
  $('#an-area-draw').onclick = startDraw;
  $('#an-area-clear').onclick = () => { clearDraw(); setAreaMode('view'); };
  $('#an-csv').onclick = exportCSV;
  $('#an-geojson').onclick = exportGeoJSON;
  $('#an-plan').onclick = fetchPlans;
  $('#f-bestemming').oninput = () => renderResults();
  // Filters direct toepassen op de al opgehaalde gegevens.
  let t;
  el.querySelectorAll('input, select').forEach((inp) => {
    if (inp.id === 'f-bestemming') return;
    inp.addEventListener(inp.type === 'number' ? 'input' : 'change', () => {
      clearTimeout(t);
      t = setTimeout(() => { if (AN.all) { AN.filters = filterState(); store.set('filters', AN.filters); renderResults(); } }, 250);
    });
  });
})();

// ---------- Filters ----------
const FIELDS = ['f-opp-min', 'f-opp-max', 'f-graad-max', 'f-gpa-min', 'f-bj-max', 'f-bj-min', 'f-adr-min', 'f-adr-max', 'f-bebouwd', 'f-doel-mode', 'f-score'];
function filterState() {
  const s = {};
  FIELDS.forEach((id) => { s[id] = $('#' + id).value; });
  s.elong = $('#f-elong').checked;
  s.signaal = $('#f-signaal').checked;
  s.doelen = [...document.querySelectorAll('.f-doel:checked')].map((c) => c.value);
  return s;
}
function applyFilterState(s) {
  FIELDS.forEach((id) => { $('#' + id).value = s[id] ?? (id === 'f-doel-mode' ? 'any' : id === 'f-score' ? '0' : ''); });
  $('#f-elong').checked = s.elong ?? true;
  $('#f-signaal').checked = !!s.signaal;
  document.querySelectorAll('.f-doel').forEach((c) => { c.checked = (s.doelen || []).includes(c.value); });
  $('#f-score-out').textContent = $('#f-score').value;
}
const num = (v) => (v === '' || v == null ? null : Number(v));

function passes(r, s) {
  if (num(s['f-opp-min']) != null && r.opp < num(s['f-opp-min'])) return false;
  if (num(s['f-opp-max']) != null && r.opp > num(s['f-opp-max'])) return false;
  if (s.elong && r.compact < 0.12 && r.opp > 300) return false;
  if (s['f-bebouwd'] === 'leeg' && r.panden.length) return false;
  if (s['f-bebouwd'] === 'bebouwd' && !r.panden.length) return false;
  if (num(s['f-graad-max']) != null && r.graad * 100 > num(s['f-graad-max'])) return false;
  if (num(s['f-gpa-min']) != null && r.adressen && r.opp / r.adressen < num(s['f-gpa-min'])) return false;
  if (num(s['f-bj-max']) != null && !(r.bouwjaarMin && r.bouwjaarMin < num(s['f-bj-max']))) return false;
  if (num(s['f-bj-min']) != null && !(r.bouwjaarMin && r.bouwjaarMin > num(s['f-bj-min']))) return false;
  if (num(s['f-adr-min']) != null && r.adressen < num(s['f-adr-min'])) return false;
  if (num(s['f-adr-max']) != null && r.adressen > num(s['f-adr-max'])) return false;
  if (s.doelen.length) {
    const has = s.doelen.filter((d) => r.doelen.has(d)).length;
    if (s['f-doel-mode'] === 'any' && !has) return false;
    if (s['f-doel-mode'] === 'none' && has) return false;
    if (s['f-doel-mode'] === 'only' && (!r.doelen.size || [...r.doelen].some((d) => !s.doelen.includes(d)))) return false;
  }
  if (s.signaal && !r.signalen.size) return false;
  if (r.score < Number(s['f-score'] || 0)) return false;
  return true;
}

// ---------- Gebied ----------
function setAreaMode(m) {
  $('#an-area-view').classList.toggle('on', m === 'view');
  $('#an-area-draw').classList.toggle('on', m === 'draw' || m === 'poly');
  $('#an-area-clear').hidden = m === 'view';
}
function startDraw() {
  clearDraw();
  setAreaMode('draw');
  mode = 'draw';
  map.getContainer().style.cursor = 'crosshair';
  $('#an-area-info').textContent = 'Klik punten op de kaart; klik op het eerste punt (of dubbelklik) om af te sluiten.';
  map.doubleClickZoom.disable();
}
function addDrawPoint(ll) {
  if (AN.drawPts.length > 2 && map.latLngToContainerPoint(ll).distanceTo(map.latLngToContainerPoint(AN.drawPts[0])) < 12) return finishDraw();
  AN.drawPts.push(ll);
  AN.drawLayer.clearLayers();
  L.polyline(AN.drawPts, { color: '#7048e8', dashArray: '5 4' }).addTo(AN.drawLayer);
  AN.drawPts.forEach((p) => L.circleMarker(p, { radius: 4, color: '#7048e8', fillOpacity: 1 }).addTo(AN.drawLayer));
}
map.on('dblclick', () => { if (mode === 'draw' && AN.drawPts.length > 2) finishDraw(); });
function finishDraw() {
  mode = null;
  map.getContainer().style.cursor = '';
  setTimeout(() => map.doubleClickZoom.enable(), 300);
  AN.drawLayer.clearLayers();
  AN.area = AN.drawPts.slice();
  L.polygon(AN.area, { color: '#7048e8', weight: 2, fillOpacity: 0.05, interactive: false }).addTo(AN.drawLayer);
  $('#an-area-info').textContent = `Getekend gebied: ${fmtArea(ringArea(AN.area))}`;
  setAreaMode('poly');
}
function clearDraw() {
  if (mode === 'draw') { mode = null; map.getContainer().style.cursor = ''; map.doubleClickZoom.enable(); }
  AN.drawPts = []; AN.area = null; AN.drawLayer.clearLayers();
  $('#an-area-info').textContent = 'Zoom in tot minimaal niveau 15. Grote gebieden worden afgekapt.';
}

// ---------- Ophalen ----------
async function fetchAll(url, label, onPage) {
  const out = [];
  let next = url, page = 0;
  while (next && page < MAX_PAGES) {
    const d = await getJSON(next);
    out.push(...d.features);
    page++;
    onPage(label, out.length);
    next = d.links?.find((l) => l.rel === 'next')?.href || null;
  }
  return { features: out, truncated: !!next };
}

// Eenvoudige rasterindex op bbox, voor snelle punt-in-perceel-opzoekingen.
function buildIndex(items, cell = 0.002) {
  const grid = new Map();
  items.forEach((it) => {
    const [x0, y0, x1, y1] = it.bbox;
    for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++)
      for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) {
        const k = gx + ':' + gy;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(it);
      }
  });
  return (pt) => (grid.get(Math.floor(pt[0] / cell) + ':' + Math.floor(pt[1] / cell)) || [])
    .find((it) => pt[0] >= it.bbox[0] && pt[0] <= it.bbox[2] && pt[1] >= it.bbox[1] && pt[1] <= it.bbox[3] && pointInGeom(pt, it.geometry));
}
function centroid(geom) {
  // oppervlakte-gewogen zwaartepunt van de buitenring van het grootste deelvlak
  const polys = rings(geom);
  if (!polys.length) return null;
  let best = polys[0][0], bestA = 0;
  polys.forEach((p) => { const a = Math.abs(signedArea(p[0])); if (a > bestA) { bestA = a; best = p[0]; } });
  // Rekenen t.o.v. het eerste hoekpunt; met ruwe graden gaat precisie verloren.
  const [ox, oy] = best[0];
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < best.length - 1; i++) {
    const x0 = best[i][0] - ox, y0 = best[i][1] - oy, x1 = best[i + 1][0] - ox, y1 = best[i + 1][1] - oy;
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (!a) return best[0];
  const c = [ox + cx / (3 * a), oy + cy / (3 * a)];
  // Concave vormen: zwaartepunt kan buiten het vlak vallen. Neem dan het midden van het breedste
  // binnenstuk op een horizontale lijn door het zwaartepunt (point-on-surface).
  if (pointInGeom(c, geom)) return c;
  const xs = [];
  for (let i = 0; i < best.length - 1; i++) {
    const [x0, y0] = best[i], [x1, y1] = best[i + 1];
    if ((y0 > c[1]) !== (y1 > c[1])) xs.push(x0 + ((c[1] - y0) * (x1 - x0)) / (y1 - y0));
  }
  xs.sort((p, q) => p - q);
  let bestSeg = null;
  for (let i = 0; i + 1 < xs.length; i += 2) if (!bestSeg || xs[i + 1] - xs[i] > bestSeg[1] - bestSeg[0]) bestSeg = [xs[i], xs[i + 1]];
  return bestSeg ? [(bestSeg[0] + bestSeg[1]) / 2, c[1]] : c;
}
function signedArea(r) {
  const [ox, oy] = r[0];
  let a = 0;
  for (let i = 0; i < r.length - 1; i++) a += (r[i][0] - ox) * (r[i + 1][1] - oy) - (r[i + 1][0] - ox) * (r[i][1] - oy);
  return a / 2;
}

async function runAnalysis() {
  if (mode === 'draw') return alert('Sluit eerst het getekende gebied af.');
  if (!AN.area && map.getZoom() < 15) return alert('Zoom verder in (minimaal niveau 15) of teken een gebied.');
  const s = filterState();
  store.set('filters', s);
  let bounds = AN.area ? L.latLngBounds(AN.area) : map.getBounds();
  const bb = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].map((v) => v.toFixed(6)).join(',');
  const areaPoly = AN.area ? { type: 'Polygon', coordinates: [[...AN.area, AN.area[0]].map((p) => [p.lng, p.lat])] } : null;

  $('#an-run').disabled = true;
  $('#f-bestemming').value = '';
  AN.layer.clearLayers();
  $('#an-list').innerHTML = '';
  $('#an-result-tools').hidden = true;
  const progress = {};
  const onPage = (label, n) => { progress[label] = n; $('#an-status').textContent = 'Ophalen… ' + Object.entries(progress).map(([k, v]) => `${k}: ${v}`).join(' · '); };

  try {
    const [prc, pnd, vbo] = await Promise.all([
      fetchAll(`${PDOK.brk}/perceel/items?f=json&limit=1000&bbox=${bb}`, 'percelen', onPage),
      fetchAll(`${PDOK.bag}/pand/items?f=json&limit=1000&bbox=${bb}`, 'panden', onPage),
      fetchAll(`${PDOK.bag}/verblijfsobject/items?f=json&limit=1000&bbox=${bb}`, 'adressen', onPage),
    ]);
    $('#an-status').textContent = 'Analyseren…';
    await new Promise((r) => setTimeout(r, 20));

    // Percelen voorbereiden
    const seen = new Set();
    const percelen = [];
    prc.features.forEach((f) => {
      const p = f.properties;
      if (seen.has(p.identificatie_lokaal_id)) return;
      seen.add(p.identificatie_lokaal_id);
      const c = centroid(f.geometry);
      if (!c) return;
      if (areaPoly ? !pointInGeom(c, areaPoly) : !bounds.contains([c[1], c[0]])) return;
      const st = geomStats(f.geometry);
      percelen.push({
        f, geometry: f.geometry, bbox: bboxOf(f.geometry), c,
        id: p.identificatie_lokaal_id,
        aanduiding: `${p.kadastrale_gemeente_waarde} ${p.sectie} ${p.perceelnummer}`,
        opp: p.kadastrale_grootte_waarde || st.area, oppGeo: st.area, omtrek: st.perim,
        compact: st.perim ? (4 * Math.PI * st.area) / (st.perim * st.perim) : 1,
        panden: [], footprint: 0, adressen: 0, vboOpp: 0, doelen: new Set(), signalen: new Set(), adresVoorbeeld: '',
      });
    });
    const lookup = buildIndex(percelen);

    pnd.features.forEach((f) => {
      const p = f.properties;
      if (VERVALLEN.test(p.status || '')) return;
      const c = centroid(f.geometry);
      const r = c && lookup(c);
      if (!r) return;
      r.panden.push(p);
      r.footprint += geomStats(f.geometry).area;
      if (SIGNAAL_STATUS[p.status]) r.signalen.add(SIGNAAL_STATUS[p.status]);
    });
    vbo.features.forEach((f) => {
      const p = f.properties;
      if (VERVALLEN.test(p.status || '') || f.geometry?.type !== 'Point') return;
      const r = lookup(f.geometry.coordinates);
      if (!r) return;
      r.adressen++;
      r.vboOpp += p.oppervlakte || 0;
      (p.gebruiksdoel || '').split(',').map((d) => d.trim()).filter(Boolean).forEach((d) => r.doelen.add(d));
      if (SIGNAAL_STATUS[p.status]) r.signalen.add(SIGNAAL_STATUS[p.status]);
      if (!r.adresVoorbeeld) r.adresVoorbeeld = adresVan(p);
    });

    percelen.forEach((r) => {
      const jaren = r.panden.map((p) => p.bouwjaar).filter((j) => j && j > 1000 && j < 2100);
      r.bouwjaarMin = jaren.length ? Math.min(...jaren) : null;
      r.bouwjaarMax = jaren.length ? Math.max(...jaren) : null;
      r.graad = Math.min(1, r.footprint / (r.oppGeo || r.opp));
      scoreParcel(r);
    });

    AN.all = percelen;
    AN.truncated = prc.truncated || pnd.truncated || vbo.truncated;
    AN.filters = s;
    AN.plans = new Map();
    renderResults();
  } catch (err) {
    console.error(err);
    $('#an-status').textContent = `Fout bij ophalen: ${err.message}`;
  } finally {
    $('#an-run').disabled = false;
  }
}

// ---------- Score ----------
function scoreParcel(r) {
  const why = [];
  let s = 0;
  const add = (p, t) => { s += p; why.push(t); };
  if (r.opp >= 5000) add(20, 'zeer groot perceel');
  else if (r.opp >= 1500) add(14, 'groot perceel');
  else if (r.opp >= 600) add(7, 'ruim perceel');

  if (!r.panden.length) {
    if (r.opp >= 200) add(18, 'onbebouwd');
  } else if (r.graad < 0.2) add(18, `lage bebouwingsgraad (${Math.round(r.graad * 100)}%)`);
  else if (r.graad < 0.4) add(10, `beperkte bebouwingsgraad (${Math.round(r.graad * 100)}%)`);

  if (r.bouwjaarMin) {
    if (r.bouwjaarMin < 1945) add(4, `oud pand (${r.bouwjaarMin}, let op monumentwaarde)`);
    else if (r.bouwjaarMin < 1980) add(12, `pand uit ${r.bouwjaarMin}`);
    else if (r.bouwjaarMin < 1995) add(6, `pand uit ${r.bouwjaarMin}`);
  }

  const nonRes = ['winkelfunctie', 'kantoorfunctie', 'industriefunctie', 'overige gebruiksfunctie'];
  if (r.doelen.size && !r.doelen.has('woonfunctie') && [...r.doelen].some((d) => nonRes.includes(d))) {
    add(16, `geen wonen (${[...r.doelen].join(', ')}): transformatiekans`);
  } else if (r.panden.length && !r.adressen) add(6, 'bebouwd zonder adres (schuur/loods?)');

  if (r.adressen && r.opp / r.adressen > 750) add(10, `veel grond per adres (${fmtNum(r.opp / r.adressen)} m²)`);

  if (r.signalen.size) add(r.signalen.has('sloopvergunning verleend') || r.signalen.has('pand buiten gebruik') ? 22 : 10, [...r.signalen].join(', '));

  if (r.compact < 0.12 && r.opp > 300) { s *= 0.3; why.push('langgerekt: mogelijk weg/water/spoor'); }
  if (r.opp > 50000) { s *= 0.6; why.push('>5 ha: vaak openbare ruimte of gemeentegrond'); }
  if (r.bestemming && /verkeer|water|groen|natuur|bos|spoor|agrarisch met waarden/i.test(r.bestemming.split(' (+')[0])) {
    s *= 0.3; why.push('bestemming beperkt ontwikkeling');
  }
  r.score = Math.min(100, Math.round(s));
  r.why = why;
  if (typeof dsoScore === 'function') dsoScore(r); // extra signalen uit DSO-plandata (dso.js)
}

// ---------- Resultaten ----------
const scoreColor = (s) => (s >= 60 ? '#c92a2a' : s >= 40 ? '#e8590c' : s >= 20 ? '#f59f00' : '#868e96');

function renderResults() {
  if (!AN.all) return;
  const s = AN.filters;
  const bq = $('#f-bestemming').value.trim().toLowerCase();
  let res = AN.all.filter((r) => passes(r, s));
  if (bq) res = res.filter((r) => (r.bestemming || '').toLowerCase().includes(bq));
  res.sort((a, b) => b.score - a.score || b.opp - a.opp);
  AN.results = res;

  AN.layer.clearLayers();
  res.forEach((r) => L.geoJSON(r.geometry, {
    style: { color: scoreColor(r.score), weight: 2, fillColor: scoreColor(r.score), fillOpacity: 0.35 },
  }).on('click', (e) => { L.DomEvent.stopPropagation(e); identify(L.latLng(r.c[1], r.c[0])); })
    .bindTooltip(`${esc(r.aanduiding)} · score ${r.score}`, { sticky: true }).addTo(AN.layer));

  $('#an-status').innerHTML = `${res.length} van ${AN.all.length} percelen voldoen.`
    + (AN.truncated ? ' <strong>Gebied te groot: niet alle objecten zijn opgehaald. Zoom in of teken een kleiner gebied.</strong>' : '');
  $('#an-result-tools').hidden = !res.length;
  $('#f-bestemming').hidden = !AN.plans?.size;

  const shown = res.slice(0, 300);
  $('#an-list').innerHTML = shown.map((r, i) => `
    <li data-i="${i}">
      <div class="res-head"><span class="badge" style="background:${scoreColor(r.score)}">${r.score}</span>
        <strong>${esc(r.aanduiding)}</strong> <span class="muted">${fmtNum(r.opp)} m²</span></div>
      <div class="muted">${esc(r.adresVoorbeeld || (r.panden.length ? 'bebouwd, geen adres' : 'onbebouwd'))}
        ${r.adressen > 1 ? ` (+${r.adressen - 1})` : ''}</div>
      <div class="muted">bebouwd ${Math.round(r.graad * 100)}%${r.bouwjaarMin ? ` · bouwjaar ${r.bouwjaarMin}${r.bouwjaarMax !== r.bouwjaarMin ? '–' + r.bouwjaarMax : ''}` : ''}
        ${r.doelen.size ? ' · ' + esc([...r.doelen].map((d) => d.replace('functie', '')).join(', ')) : ''}</div>
      ${r.bestemming ? `<div class="muted">bestemming: ${esc(r.bestemming)}</div>` : ''}
      ${r.dso && !r.dso.fout ? `<div class="muted">plan: ${[
        r.dso.bouwhoogte ? `bouwhoogte ${r.dso.bouwhoogte} m` : '', r.dso.goothoogte ? `goothoogte ${r.dso.goothoogte} m` : '',
        r.dso.bebouwingspct ? `bebouwing max ${r.dso.bebouwingspct}%` : '', r.dso.inBouwvlak === false ? 'buiten bouwvlak' : '',
        r.dso.planInOntwikkeling ? 'plan in ontwikkeling' : '', r.dso.vergunningen ? `${r.dso.vergunningen} vergunning(en)` : '',
      ].filter(Boolean).map(esc).join(' · ') || 'geen maatvoering gevonden'}</div>` : ''}
      ${r.dso?.fout ? `<div class="muted">plandata: ${esc(r.dso.fout)}</div>` : ''}
      <div class="why">${r.why.map(esc).join(' · ')}</div>
    </li>`).join('') + (res.length > 300 ? `<li class="muted">… ${res.length - 300} meer (zie export)</li>` : '');
  $('#an-list').querySelectorAll('li[data-i]').forEach((li) => {
    li.onclick = () => {
      const r = shown[+li.dataset.i];
      map.fitBounds([[r.bbox[1], r.bbox[0]], [r.bbox[3], r.bbox[2]]], { maxZoom: 19, padding: [40, 40] });
      identify(L.latLng(r.c[1], r.c[0]));
      if (window.innerWidth <= 640) $('#analyse').hidden = true;
    };
  });
}

async function fetchPlans() {
  const todo = AN.results.slice(0, 100).filter((r) => !AN.plans.has(r.id));
  $('#an-plan').disabled = true;
  let done = 0;
  const worker = async () => {
    while (todo.length) {
      const r = todo.shift();
      try {
        const feats = await fetchBestemming(L.latLng(r.c[1], r.c[0]));
        const enkel = feats.filter((f) => f.id.startsWith('enkelbestemming')).map((f) => f.properties.naam);
        const dubbel = feats.filter((f) => f.id.startsWith('dubbelbestemming')).map((f) => f.properties.naam);
        r.bestemming = [...new Set(enkel)].join(', ') + (dubbel.length ? ` (+ ${[...new Set(dubbel)].join(', ')})` : '') || 'geen Wro-plan gevonden';
      } catch { r.bestemming = 'niet opgehaald'; }
      AN.plans.set(r.id, r.bestemming);
      $('#an-status').textContent = `Bestemming ophalen… ${++done}`;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  AN.all.forEach((r) => { if (r.bestemming) scoreParcel(r); });
  $('#an-plan').disabled = false;
  renderResults();
}

// ---------- Export ----------
function rowOf(r) {
  return {
    perceel: r.aanduiding, perceel_id: r.id, score: r.score, oppervlakte_m2: r.opp,
    bebouwd_m2: Math.round(r.footprint), bebouwingsgraad_pct: Math.round(r.graad * 100),
    panden: r.panden.length, bouwjaar_oudste: r.bouwjaarMin ?? '', bouwjaar_jongste: r.bouwjaarMax ?? '',
    adressen: r.adressen, vbo_oppervlakte_m2: r.vboOpp, gebruiksdoelen: [...r.doelen].join('; '),
    signalen: [...r.signalen].join('; '), bestemming: r.bestemming || '', voorbeeldadres: r.adresVoorbeeld,
    plan_bouwhoogte_m: r.dso?.bouwhoogte ?? '', plan_goothoogte_m: r.dso?.goothoogte ?? '',
    plan_bebouwingspct: r.dso?.bebouwingspct ?? '', plan_in_bouwvlak: r.dso?.inBouwvlak == null ? '' : (r.dso.inBouwvlak ? 'ja' : 'nee'),
    plan_in_ontwikkeling: r.dso?.planInOntwikkeling ?? '', omgevingsvergunningen: r.dso?.vergunningen ?? '',
    redenen: r.why.join('; '), lat: r.c[1].toFixed(6), lon: r.c[0].toFixed(6),
  };
}
function exportCSV() {
  const rows = AN.results.map(rowOf);
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = '﻿' + [cols.join(';'), ...rows.map((r) => cols.map((c) => q(r[c])).join(';'))].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'ontwikkelkansen.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function exportGeoJSON() {
  download('ontwikkelkansen.geojson', JSON.stringify({
    type: 'FeatureCollection',
    features: AN.results.map((r) => ({ type: 'Feature', geometry: r.geometry, properties: rowOf(r) })),
  }));
}
