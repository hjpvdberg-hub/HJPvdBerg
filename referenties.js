'use strict';
// Referentieprojecten: kleinschalige woningbouw (2–20 woningen) die in de afgelopen ±5 jaar is gerealiseerd
// binnen 20 km van Gemert-Bakel, afgeleid uit de BAG (zie tools/referenties.md). Gebruikt als:
//  - kaartlaag met gerealiseerde projecten;
//  - precedent in de beoordeling (vergelijkbare projecten dichtbij = gemeente staat dit toe, er is vraag);
//  - kentallen: woninggrootte en bouwlagen in de regio.

const REF = { data: null, list: [], layer: L.layerGroup(), loading: null };
const REF_KLEUR = { 'transformatie': '#e8590c', 'woningsplitsing': '#f59f00', 'nieuwbouw appartementen': '#1c7ed6', 'nieuwbouw grondgebonden': '#2f9e44' };
const REF_STRAT = { transf: ['transformatie', 'woningsplitsing'], optop: ['nieuwbouw appartementen'], inbr: ['nieuwbouw appartementen', 'nieuwbouw grondgebonden'] };

function loadReferenties() {
  if (!REF.loading) {
    REF.loading = fetch('referenties.json').then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!d) return null;
      REF.data = d;
      REF.list = d.p.map(([t, j, n, gbo, lon, lat, adres, lagen, h, gm]) => ({ t, j, n, gbo, c: [lon, lat], adres, lagen, h, gm }));
      return d;
    }).catch(() => null);
  }
  return REF.loading;
}
const inRefGebied = (c) => REF.data && distM(c, REF.data.meta.centrum) <= REF.data.meta.straal_m + 2000;
function refNear(c, radius, types) {
  return REF.list.filter((p) => (!types || types.includes(p.t))).map((p) => ({ ...p, d: distM(c, p.c) }))
    .filter((p) => p.d <= radius).sort((a, b) => a.d - b.d);
}
function refMediaan(arr) { const xs = arr.filter((x) => x != null).sort((a, b) => a - b); return xs.length ? xs[Math.floor(xs.length / 2)] : null; }

// Regionaal kental woninggrootte (GBO) voor een strategie, uit projecten binnen 5 km (min. 5 projecten), anders hele regio.
function refGbo(c, kind) {
  if (!inRefGebied(c)) return null;
  const types = kind === 'transf' ? REF_STRAT.transf : ['nieuwbouw appartementen'];
  let near = refNear(c, 5000, types);
  if (near.length < 5) near = REF.list.filter((p) => types.includes(p.t));
  const m = refMediaan(near.map((p) => p.gbo));
  return m && m >= 30 && m <= 150 ? m : null;
}

// Precedent: aantal vergelijkbare projecten dichtbij. Geeft punten terug voor juridisch en markt.
function refPrecedent(r, why) {
  if (!inRefGebied(r.c)) return { jur: 0, markt: 0 };
  const strat = AN.filters?.strat || { transf: true, optop: true, inbr: true };
  const types = [...new Set(Object.entries(strat).filter(([, on]) => on).flatMap(([k]) => REF_STRAT[k]))];
  const n1 = refNear(r.c, 1000, types).length;
  const n2 = refNear(r.c, 2000, types).length;
  r.refN1 = n1; r.refN2 = n2;
  if (n1) why.push(`${n1} vergelijkbaar project(en) gerealiseerd ≤ 1 km`);
  else if (n2) why.push(`${n2} vergelijkbaar project(en) ≤ 2 km`);
  else why.push('geen vergelijkbare projecten ≤ 2 km gerealiseerd');
  return { jur: Math.min(15, n1 * 5) - (n2 ? 0 : 5), markt: Math.min(10, n2 * 2) };
}

// ---------- Kaartlaag ----------
(function refLayerUI() {
  const lbl = document.createElement('label');
  lbl.innerHTML = '<input type="checkbox" id="ref-layer"> Gerealiseerde projecten 2–20 won. (regio Gemert-Bakel)';
  const h3 = [...$('#layers').querySelectorAll('h3')].find((h) => h.textContent === 'Lagen');
  const after = h3.parentNode.querySelector('.muted');
  h3.parentNode.insertBefore(lbl, after);
  $('#ref-layer').onchange = async (e) => {
    if (!e.target.checked) { map.removeLayer(REF.layer); return; }
    await loadReferenties();
    if (!REF.data) { alert('Referentiedata niet gevonden (referenties.json).'); e.target.checked = false; return; }
    REF.layer.clearLayers();
    REF.list.forEach((p) => L.circleMarker([p.c[1], p.c[0]], { radius: 4 + Math.min(6, p.n / 3), color: '#fff', weight: 1, fillColor: REF_KLEUR[p.t] || '#868e96', fillOpacity: 0.9 })
      .bindPopup(`<strong>${esc(p.t)}</strong><br>${esc(p.adres)}<br>${p.n} woningen${p.gbo ? ` · gem. ${p.gbo} m²` : ''}${p.lagen ? ` · ${p.lagen} lagen` : ''}<br><span class="muted">${p.j ? (p.t.startsWith('nieuwbouw') ? 'bouwjaar ' : 'pand uit ') + p.j : ''} · ${esc(p.gm || '')}</span>`)
      .addTo(REF.layer));
    REF.layer.addTo(map);
    if (!inRefGebied([map.getCenter().lng, map.getCenter().lat])) map.setView([REF.data.meta.centrum[1], REF.data.meta.centrum[0]], 11);
  };
})();

// ---------- Toets: sectie met referentieprojecten ----------
function refToetsHtml(r) {
  if (!inRefGebied(r.c)) return '<h4>Referentieprojecten</h4><p class="muted">Alleen beschikbaar binnen 20 km van Gemert-Bakel.</p>';
  const near = refNear(r.c, 3000).slice(0, 10);
  const s = REF.data.meta.stats;
  const regio = Object.entries(s).map(([t, v]) => `<tr><td>${esc(t)}</td><td>${v.aantal}</td><td>${v.woningen_mediaan}</td><td>${v.gbo_mediaan ?? '–'} m²</td><td>${v.lagen_mediaan ?? '–'}</td></tr>`).join('');
  return `<h4>Referentieprojecten (gerealiseerd, 2–20 woningen)</h4>
    ${near.length ? `<table class="compact"><tr><td>Afstand</td><td>Type</td><td>Won.</td><td>m² gem.</td><td>Adres</td></tr>
      ${near.map((p) => `<tr><td>${p.d < 1000 ? Math.round(p.d) + ' m' : fmtNum(p.d / 1000, 1) + ' km'}</td><td>${esc(p.t)}</td><td>${p.n}</td><td>${p.gbo ?? '–'}</td><td>${esc(p.adres)}</td></tr>`).join('')}</table>`
      : '<p class="muted">Geen gerealiseerde projecten binnen 3 km.</p>'}
    <details class="card"><summary><strong>Kentallen regio (${esc(REF.data.meta.gebied)})</strong></summary>
      <table class="compact"><tr><td>Type</td><td>Projecten</td><td>Won. (mediaan)</td><td>m² per woning</td><td>Lagen</td></tr>${regio}</table>
    </details>`;
}
loadReferenties();
