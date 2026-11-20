'use strict';
// Koppeling met het Digitaal Stelsel Omgevingswet (DSO):
//  - Ruimtelijke plannen opvragen v4 (Informatiehuis Ruimte, eigen sleutel): bestemmingsplannen met
//    bestemmingsvlakken, bouwvlakken en maatvoering (goot-/bouwhoogte, bebouwingspercentage), en
//    plannen die in ontwikkeling zijn.
//  - Omgevingsdocumenten presenteren v8 (DSO-sleutel): omgevingsplan-onderwerpen op een locatie
//    (activiteiten, gebiedsaanwijzingen, omgevingsnormen), omgevingsvergunningen en ontwerpregelingen.
// Sleutels staan alleen in de browser van de gebruiker (localStorage), of in een eigen proxy (zie proxy/).

const DSO = {
  rp: 'https://ruimte.omgevingswet.overheid.nl/ruimtelijke-plannen/api/opvragen/v4',
  pres: 'https://service.omgevingswet.overheid.nl/publiek/omgevingsdocumenten/api/presenteren/v8',
  presPre: 'https://service.pre.omgevingswet.overheid.nl/publiek/omgevingsdocumenten/api/presenteren/v8',
  rdCrs: 'http://www.opengis.net/def/crs/EPSG/0/28992',
};
const dsoCfg = () => store.get('dso', { rpKey: '', dsoKey: '', proxy: '' });
const dsoEnabled = () => { const c = dsoCfg(); return !!(c.proxy || c.rpKey || c.dsoKey); };
const rpEnabled = () => { const c = dsoCfg(); return !!(c.proxy || c.rpKey); };
const presEnabled = () => { const c = dsoCfg(); return !!(c.proxy || c.dsoKey); };

// WGS84 -> RD New (EPSG:28992), benaderingsformule van Schreutelaar; nauwkeurig tot circa 0,5 m.
function wgsToRd(lat, lon) {
  const dp = 0.36 * (lat - 52.15517440), dl = 0.36 * (lon - 5.38720621);
  const R = [[0, 1, 190094.945], [1, 1, -11832.228], [2, 1, -114.221], [0, 3, -32.391], [1, 0, -0.705], [3, 1, -2.340], [1, 3, -0.608], [0, 2, -0.008], [2, 3, 0.148]];
  const S = [[1, 0, 309056.544], [0, 2, 3638.893], [2, 0, 73.077], [1, 2, -157.984], [3, 0, 59.788], [0, 1, 0.433], [2, 2, -6.439], [1, 1, -0.032], [0, 4, 0.092], [1, 4, -0.054]];
  const f = (T) => T.reduce((s, [p, q, c]) => s + c * dp ** p * dl ** q, 0);
  return [Math.round((155000 + f(R)) * 100) / 100, Math.round((463000 + f(S)) * 100) / 100];
}
function geomToRd(geom) {
  const conv = (ring) => ring.map(([x, y]) => wgsToRd(y, x));
  if (geom.type === 'Point') return { type: 'Point', coordinates: wgsToRd(geom.coordinates[1], geom.coordinates[0]) };
  if (geom.type === 'Polygon') return { type: 'Polygon', coordinates: geom.coordinates.map(conv) };
  if (geom.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: geom.coordinates.map((p) => p.map(conv)) };
  return geom;
}

// ---------- HTTP ----------
class DsoError extends Error {}
async function dsoPost(api, path, body, headers = {}, baseOverride = null) {
  const c = dsoCfg();
  const base = baseOverride || (c.proxy ? `${c.proxy.replace(/\/$/, '')}/${api}` : DSO[api]);
  const key = api === 'rp' ? c.rpKey : c.dsoKey;
  const h = { 'Content-Type': 'application/json', Accept: 'application/hal+json, application/json', ...headers };
  if (!c.proxy) {
    if (!key) throw new DsoError(api === 'rp' ? 'Geen sleutel voor Ruimtelijke plannen' : 'Geen DSO-sleutel');
    h['x-api-key'] = key;
  }
  let r;
  try {
    r = await fetch(base + path, { method: 'POST', headers: h, body: JSON.stringify(body) });
  } catch {
    // Netwerkfout of geblokkeerd antwoord zonder CORS-header (bijv. door de firewall van de API).
    throw new DsoError(c.proxy ? 'Proxy niet bereikbaar' : 'Geen verbinding met de DSO-API vanuit de browser. Probeer het later opnieuw of gebruik een proxy (zie proxy/README.md).');
  }
  if (r.status === 401 || r.status === 403) throw new DsoError('API-sleutel geweigerd (ongeldig of nog niet actief)');
  if (r.status === 429) throw new DsoError('Te veel verzoeken, probeer het zo opnieuw');
  if (!r.ok) throw new DsoError(`DSO-fout ${r.status}`);
  return r.json();
}
const rpPost = (path, geom) => dsoPost('rp', path, { _geo: { intersects: geom } }, { 'Content-Crs': 'epsg:4258', 'Accept-Crs': 'epsg:4258' });
const presPost = (path, body) => dsoPost('pres', path, body, { 'Content-Crs': DSO.rdCrs });

// ---------- Ophalen per locatie ----------
const BESTEMMINGSPLAN_TYPES = /bestemmingsplan|wijzigingsplan|uitwerkingsplan|inpassingsplan|beheersverordening|omgevingsplan|projectbesluit|omgevingsvergunning/i;

async function rpSummary(point) {
  // point: GeoJSON Point in lon/lat
  const [geldend, ontw] = await Promise.all([
    rpPost('/plannen/_zoek?regelStatus=geldend&pageSize=50', point),
    rpPost('/plannen/_zoek?regelStatus=in%20ontwikkeling&pageSize=50', point).catch(() => null),
  ]);
  const plannen = (geldend?._embedded?.plannen || []).filter((p) => !p.isHistorisch && BESTEMMINGSPLAN_TYPES.test(p.type || ''));
  // Meest recente plannen eerst; parapluplannen achteraan.
  plannen.sort((a, b) => (a.isParapluplan - b.isParapluplan) || (b.planstatusInfo?.datum || '').localeCompare(a.planstatusInfo?.datum || ''));
  const details = await Promise.all(plannen.slice(0, 6).map(async (p) => {
    const id = encodeURIComponent(p.id);
    const [bv, mv, bouw] = await Promise.all([
      rpPost(`/plannen/${id}/bestemmingsvlakken/_zoek`, point).catch(() => null),
      rpPost(`/plannen/${id}/maatvoeringen/_zoek`, point).catch(() => null),
      rpPost(`/plannen/${id}/bouwvlakken/_zoek`, point).catch(() => null),
    ]);
    return {
      plan: p,
      bestemmingen: (bv?._embedded?.bestemmingsvlakken || []).map((b) => ({
        naam: b.naam, type: b.type, groep: b.bestemmingshoofdgroep, tekst: (b.verwijzingNaarTekst || [])[0] || null,
      })),
      maatvoering: (mv?._embedded?.maatvoeringen || []).flatMap((m) => (m.omvang || []).map((o) => ({ naam: o.naam, waarde: o.waarde }))),
      bouwvlak: (bouw?._embedded?.bouwvlakken || []).length > 0,
    };
  }));
  const inOntwikkeling = (ontw?._embedded?.plannen || []).filter((p) => !p.isHistorisch).map((p) => ({
    id: p.id, naam: p.naam, type: p.type, status: p.planstatusInfo?.planstatus, datum: p.planstatusInfo?.datum,
  }));
  return { details, inOntwikkeling };
}

async function presSummary(pointRd, areaRd) {
  const [onderwerpen, regelingen, vergunningen, ontwerpen] = await Promise.all([
    presPost('/onderwerpen/_zoek', { geometrie: pointRd }).catch((e) => ({ error: e })),
    presPost('/regelingen/_zoek?size=50', { geometrie: pointRd }).catch(() => null),
    presPost('/omgevingsvergunningen/_zoek?size=50&_sort=-geldigVanaf', { geometrie: areaRd || pointRd }).catch(() => null),
    presPost('/ontwerpregelingen/_zoek?size=50', { geometrie: pointRd }).catch(() => null),
  ]);
  if (onderwerpen?.error) throw onderwerpen.error;
  const titels = new Map((regelingen?._embedded?.regelingen || []).map((r) => [r.identificatie, r.officieleTitel || r.citeerTitel]));
  const regs = (onderwerpen?.regelingen || []).map((r) => ({
    titel: titels.get(r.identificatie) || r.identificatie,
    gemeentelijk: /\/gm\d{4}\//.test(r.identificatie),
    activiteiten: [...new Set((r.activiteiten || []).map((a) => a.naam))],
    gebiedsaanwijzingen: [...new Set((r.gebiedsaanwijzingen || []).map((a) => a.naam))],
    omgevingsnormen: [...new Set((r.omgevingsnormen || []).map((a) => a.naam))],
    omgevingswaarden: [...new Set((r.omgevingswaarden || []).map((a) => a.naam))],
  }));
  regs.sort((a, b) => b.gemeentelijk - a.gemeentelijk);
  return {
    regelingen: regs,
    vergunningen: (vergunningen?._embedded?.omgevingsvergunningen || []).map((v) => ({
      titel: v.officieleTitel, soort: v.type?.waarde, datum: v.geregistreerdMet?.beginGeldigheid, ref: v.referentienummer,
    })),
    ontwerpen: (ontwerpen?._embedded?.ontwerpregelingen || []).map((o) => ({ titel: o.officieleTitel, door: o.aangeleverdDoorEen?.naam })),
  };
}

// Kerngetallen uit maatvoering, voor gebruik in de gebiedsanalyse.
function maatKerngetallen(details) {
  const out = {};
  details.forEach((d) => d.maatvoering.forEach((m) => {
    const v = parseFloat(String(m.waarde).replace(',', '.'));
    if (Number.isNaN(v)) return;
    const n = m.naam.toLowerCase();
    if (n.includes('bouwhoogte')) out.bouwhoogte = Math.max(out.bouwhoogte || 0, v);
    else if (n.includes('goothoogte')) out.goothoogte = Math.max(out.goothoogte || 0, v);
    else if (n.includes('bebouwingspercentage')) out.bebouwingspct = Math.max(out.bebouwingspct || 0, v);
    else if (n.includes('bouwlagen')) out.bouwlagen = Math.max(out.bouwlagen || 0, v);
    else if (n.includes('woningen') || n.includes('wooneenheden')) out.woningen = Math.max(out.woningen || 0, v);
  }));
  return out;
}

// ---------- Infopaneel ----------
const dsoSection = () => {
  const box = document.createElement('div');
  box.id = 'dso-section';
  return box;
};
async function renderDsoInfo(latlng, perceel) {
  const body = $('#info-body');
  if (!body) return;
  const box = dsoSection();
  const anchor = [...body.querySelectorAll('h4')].find((h) => h.textContent === 'Meer informatie');
  body.insertBefore(box, anchor || null);
  if (!dsoEnabled()) {
    box.innerHTML = '<h4>Omgevingsplan (DSO)</h4><p class="muted">Voeg je DSO-API-sleutels toe onder ☰ Kaartlagen → API-sleutels voor regels, maatvoering, vergunningen en plannen in ontwikkeling.</p>';
    return;
  }
  box.innerHTML = '<h4>Omgevingsplan en bestemmingsplan (DSO)</h4><p class="loading">Ophalen…</p>';
  const point = { type: 'Point', coordinates: [latlng.lng, latlng.lat] };
  const pointRd = geomToRd(point);
  const areaRd = perceel?.geometry ? geomToRd(perceel.geometry) : null;
  const [rp, pres] = await Promise.all([
    rpEnabled() ? rpSummary(point).catch((e) => ({ error: e })) : null,
    presEnabled() ? presSummary(pointRd, areaRd).catch((e) => ({ error: e })) : null,
  ]);
  if (!document.body.contains(box)) return; // ondertussen ander perceel aangeklikt
  let html = '';

  if (rp?.error) html += `<h4>Bestemmingsplan</h4><p class="muted">${esc(rp.error.message)}</p>`;
  else if (rp) {
    html += '<h4>Bestemmingsplan (Wro, detail)</h4>';
    if (!rp.details.length) html += '<p class="muted">Geen geldend bestemmingsplan gevonden.</p>';
    rp.details.forEach((d) => {
      const p = d.plan;
      if (!d.bestemmingen.length && !d.maatvoering.length && !d.bouwvlak) {
        html += `<div class="card"><strong>${esc(p.naam)}</strong> <span class="muted">${esc(p.type)}${p.isParapluplan ? ', paraplu' : ''} · ${esc(p.planstatusInfo?.planstatus)} ${esc(p.planstatusInfo?.datum)}</span></div>`;
        return;
      }
      html += `<div class="card"><strong>${esc(p.naam)}</strong> <span class="muted">${esc(p.type)} · ${esc(p.planstatusInfo?.planstatus)} ${esc(p.planstatusInfo?.datum)}</span>
        ${table([
          ['Bestemming', d.bestemmingen.map((b) => (b.tekst ? `<a href="${esc(b.tekst)}" target="_blank" rel="noopener">${esc(b.naam)}</a>` : esc(b.naam)) + ` <span class="muted">${esc(b.type)}</span>`).join('<br>')],
          ['Bouwvlak', d.bouwvlak ? 'ja, punt ligt in bouwvlak' : 'nee'],
          ...d.maatvoering.map((m) => [m.naam, esc(m.waarde)]),
        ])}</div>`;
    });
    if (rp.inOntwikkeling.length) {
      html += '<h4>Plannen in ontwikkeling</h4>' + rp.inOntwikkeling.map((p) =>
        `<div class="card"><strong>${esc(p.naam)}</strong><br><span class="muted">${esc(p.type)} · ${esc(p.status)} ${esc(p.datum)}</span></div>`).join('');
    }
  }

  if (pres?.error) html += `<h4>Omgevingsplan</h4><p class="muted">${esc(pres.error.message)}</p>`;
  else if (pres) {
    const relevant = pres.regelingen.filter((r) => r.activiteiten.length || r.gebiedsaanwijzingen.length || r.omgevingsnormen.length);
    html += '<h4>Omgevingsplan en overige regels (Omgevingswet)</h4>';
    if (!relevant.length) html += '<p class="muted">Geen locatiegebonden regels gevonden.</p>';
    relevant.slice(0, 6).forEach((r) => {
      html += `<details class="card"${r.gemeentelijk ? ' open' : ''}><summary><strong>${esc(r.titel)}</strong></summary>${table([
        ['Gebiedsaanwijzingen', esc(r.gebiedsaanwijzingen.slice(0, 25).join(', '))],
        ['Omgevingsnormen', esc(r.omgevingsnormen.slice(0, 25).join(', '))],
        ['Omgevingswaarden', esc(r.omgevingswaarden.slice(0, 25).join(', '))],
        ['Activiteiten', esc(r.activiteiten.slice(0, 25).join(', ')) + (r.activiteiten.length > 25 ? ` … (+${r.activiteiten.length - 25})` : '')],
      ])}</details>`;
    });
    if (pres.vergunningen.length) {
      html += `<h4>Omgevingsvergunningen (${pres.vergunningen.length})</h4>` + pres.vergunningen.slice(0, 10).map((v) =>
        `<div class="card"><strong>${esc(v.titel)}</strong><br><span class="muted">${esc(v.soort)} · ${esc(v.datum)}</span></div>`).join('');
    }
    if (pres.ontwerpen.length) {
      html += '<h4>Ontwerpregelingen (in voorbereiding)</h4>' + pres.ontwerpen.slice(0, 8).map((o) =>
        `<div class="card"><strong>${esc(o.titel)}</strong><br><span class="muted">${esc(o.door)}</span></div>`).join('');
    }
  }
  box.innerHTML = html;
}

// renderInfo uit app.js uitbreiden.
const _renderInfo = renderInfo;
renderInfo = function (args) { // eslint-disable-line no-global-assign
  _renderInfo(args);
  renderDsoInfo(args.latlng, args.perceel);
};

// ---------- Gebiedsanalyse: plandata voor de top-resultaten ----------
async function dsoEnrich(results, onProgress) {
  const todo = results.filter((r) => !r.dso);
  let done = 0;
  const worker = async () => {
    while (todo.length) {
      const r = todo.shift();
      const point = { type: 'Point', coordinates: r.c };
      try {
        const [rp, pres] = await Promise.all([
          rpEnabled() ? rpSummary(point) : null,
          presEnabled() ? presPost('/omgevingsvergunningen/_zoek?size=20', { geometrie: geomToRd(r.geometry) }).catch(() => null) : null,
        ]);
        const k = rp ? maatKerngetallen(rp.details) : {};
        r.dso = {
          ...k,
          bestemming: rp ? [...new Set(rp.details.flatMap((d) => d.bestemmingen.filter((b) => b.type === 'enkelbestemming').map((b) => b.naam)))].join(', ') : '',
          inBouwvlak: rp ? rp.details.some((d) => d.bouwvlak) : null,
          planInOntwikkeling: rp ? rp.inOntwikkeling.map((p) => `${p.naam} (${p.status})`).join('; ') : '',
          vergunningen: pres?._embedded?.omgevingsvergunningen?.length || 0,
        };
        if (r.dso.bestemming) r.bestemming = r.dso.bestemming;
      } catch (e) {
        r.dso = { fout: e.message };
        if (e instanceof DsoError && /geweigerd/.test(e.message)) { todo.length = 0; throw e; }
      }
      onProgress(++done);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
}

// ---------- Instellingen ----------
(function buildSettings() {
  const sec = document.createElement('div');
  sec.innerHTML = `
    <h3>API-sleutels (DSO)</h3>
    <p class="muted">Gratis aan te vragen via developer.omgevingswet.overheid.nl. Sleutels worden alleen in deze browser opgeslagen.</p>
    <label>Ruimtelijke plannen (Informatiehuis Ruimte)<input id="dso-rp" type="password" autocomplete="off"></label>
    <label>DSO-sleutel (omgevingsdocumenten)<input id="dso-key" type="password" autocomplete="off"></label>
    <details><summary class="muted">Eigen proxy (optioneel)</summary>
      <label>Proxy-URL<input id="dso-proxy" type="search" placeholder="https://…workers.dev"></label>
      <p class="muted">Met een proxy staan de sleutels op de server en niet in de browser. Zie proxy/README.md.</p>
    </details>
    <div class="row"><button id="dso-save">Opslaan en testen</button></div>
    <p id="dso-status" class="muted"></p>`;
  $('#layers').appendChild(sec);
  const c = dsoCfg();
  $('#dso-rp').value = c.rpKey;
  $('#dso-key').value = c.dsoKey;
  $('#dso-proxy').value = c.proxy;
  $('#dso-save').onclick = async () => {
    store.set('dso', { rpKey: $('#dso-rp').value.trim(), dsoKey: $('#dso-key').value.trim(), proxy: $('#dso-proxy').value.trim() });
    $('#dso-status').textContent = 'Testen…';
    const p = { type: 'Point', coordinates: [5.38763, 52.15616] }; // Amersfoort
    const res = [];
    if (rpEnabled()) res.push(await rpPost('/plannen/_zoek?pageSize=1', p).then(() => 'Ruimtelijke plannen: OK', (e) => `Ruimtelijke plannen: ${e.message}`));
    if (presEnabled()) {
      const body = { geometrie: geomToRd(p) };
      let msg = await presPost('/onderwerpen/_zoek', body).then(() => 'Omgevingsdocumenten: OK', () => null);
      if (!msg && !dsoCfg().proxy) {
        // Diagnose: de API geeft bij een geweigerde sleutel geen CORS-header, dus de browser ziet alleen
        // "geen verbinding". Werkt dezelfde sleutel op pre-productie, dan is het een pre-productiesleutel.
        const pre = await dsoPost('pres', '/onderwerpen/_zoek', body, { 'Content-Crs': DSO.rdCrs }, DSO.presPre).then(() => true, () => false);
        msg = pre
          ? 'Omgevingsdocumenten: je sleutel werkt alleen op de pre-productieomgeving (testdata). Vraag een sleutel voor productie aan.'
          : 'Omgevingsdocumenten: sleutel geweigerd of nog niet actief (de API meldt dat in de browser als "geen verbinding"). Controleer de sleutel en de e-mail van de aanvraag, of gebruik de proxy om de echte foutmelding te zien.';
      }
      res.push(msg || 'Omgevingsdocumenten: proxy gaf een fout');
    }
    $('#dso-status').textContent = res.join(' · ') || 'Geen sleutels ingevuld.';
  };
})();

