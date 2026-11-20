'use strict';
// Beoordeling per kavel (klik op kaart) en haalbaarheidstoets voor een selectie van aangrenzende kavels.
// Bouwt een "site" uit één of meer percelen, verrijkt die met BAG, CBS, RCE, 3D BAG, bestemming, DSO en
// omgevingscriteria (fundering, stikstof, geluid, milieu, groen, parkeren, schaduw), en rekent scenario's door.

const TOETS = {
  fundering: 'https://api.pdok.nl/rvo/indicatieve-aandachtsgebieden-funderingsproblematiek/ogc/v1/collections/indgebfunderingsproblematiek/items',
  natura: 'https://api.pdok.nl/rvo/natura2000/ogc/v1/collections/natura2000/items',
  wegen: 'https://api.pdok.nl/rws/nationaal-wegenbestand-wegen/ogc/v1/collections/wegvakken/items',
  spoor: 'https://api.pdok.nl/lv/bgt/ogc/v1/collections/spoor/items',
  groen: 'https://api.pdok.nl/lv/bgt/ogc/v1/collections/begroeidterreindeel/items',
  industrie: 'https://api.pdok.nl/rws/productie-en-industrie-productiefaciliteiten/ogc/v1/collections',
};
const SEL = { ids: new Map(), layer: L.layerGroup().addTo(map), active: false, extraLayer: L.layerGroup().addTo(map) };
const mPerDeg = (lat) => ({ x: 111320 * Math.cos((lat * Math.PI) / 180), y: 110574 });
const bboxAround = (c, m) => { const k = mPerDeg(c[1]); return [c[0] - m / k.x, c[1] - m / k.y, c[0] + m / k.x, c[1] + m / k.y]; };
const distM = (a, b) => { const k = mPerDeg(a[1]); return Math.hypot((a[0] - b[0]) * k.x, (a[1] - b[1]) * k.y); };
function minDistToGeom(pt, geom) {
  let best = Infinity;
  const segs = (coords) => { for (let i = 1; i < coords.length; i++) best = Math.min(best, distToSeg(pt, coords[i - 1], coords[i])); };
  const walk = (g) => {
    if (!g) return;
    if (g.type === 'LineString') segs(g.coordinates);
    else if (g.type === 'MultiLineString') g.coordinates.forEach(segs);
    else if (g.type === 'Polygon') { if (pointInGeom(pt, g)) best = 0; else g.coordinates.forEach(segs); }
    else if (g.type === 'MultiPolygon') { if (pointInGeom(pt, g)) best = 0; else g.coordinates.forEach((p) => p.forEach(segs)); }
    else if (g.type === 'Point') best = Math.min(best, distM(pt, g.coordinates));
  };
  walk(geom);
  return best;
}
function distToSeg(p, a, b) {
  const k = mPerDeg(p[1]);
  const ax = (a[0] - p[0]) * k.x, ay = (a[1] - p[1]) * k.y, bx = (b[0] - p[0]) * k.x, by = (b[1] - p[1]) * k.y;
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

// ---------- Site opbouwen ----------
async function buildSite(perceelFeatures, opts = {}) {
  const geoms = perceelFeatures.map((f) => f.geometry);
  const geometry = { type: 'MultiPolygon', coordinates: geoms.flatMap((g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates)) };
  const st = geomStats(geometry);
  const props = perceelFeatures.map((f) => f.properties);
  const r = {
    geometry, bbox: bboxOf(geometry), c: centroid(geometry), percelen: perceelFeatures,
    id: props.map((p) => p.identificatie_lokaal_id).join('+'),
    aanduiding: props.map((p) => `${p.kadastrale_gemeente_waarde} ${p.sectie} ${p.perceelnummer}`).join(', '),
    opp: props.reduce((s, p) => s + (p.kadastrale_grootte_waarde || 0), 0) || st.area, oppGeo: st.area, omtrek: st.perim,
    compact: st.perim ? (4 * Math.PI * st.area) / (st.perim * st.perim) : 1,
    panden: [], pandInfo: [], pandGeoms: [], footprint: 0, adressen: 0, vboOpp: 0, nonResM2: 0, resM2: 0, maxVboPerPand: 0,
    doelen: new Set(), signalen: new Set(), adresVoorbeeld: '', adressenLijst: [],
  };
  // BAG per perceel
  const seenP = new Set(), seenV = new Set();
  await Promise.all(perceelFeatures.map(async (f) => {
    const c = centroid(f.geometry);
    const [panden, vbos] = await Promise.all([fetchPanden(f, c).catch(() => []), fetchVbos(f, c).catch(() => [])]);
    panden.forEach((pf) => {
      const p = pf.properties;
      if (seenP.has(p.identificatie) || VERVALLEN.test(p.status || '')) return;
      seenP.add(p.identificatie);
      const area = geomStats(pf.geometry).area;
      r.panden.push(p); r.pandGeoms.push(pf.geometry); r.pandInfo.push({ id: p.identificatie, area });
      r.footprint += area;
      r.maxVboPerPand = Math.max(r.maxVboPerPand, p.aantal_verblijfsobjecten || 0);
      if (SIGNAAL_STATUS[p.status]) r.signalen.add(SIGNAAL_STATUS[p.status]);
    });
    vbos.forEach((vf) => {
      const p = vf.properties;
      if (seenV.has(p.identificatie) || VERVALLEN.test(p.status || '')) return;
      seenV.add(p.identificatie);
      r.adressen++; r.vboOpp += p.oppervlakte || 0;
      if (/woonfunctie/.test(p.gebruiksdoel || '')) r.resM2 += p.oppervlakte || 0; else r.nonResM2 += p.oppervlakte || 0;
      (p.gebruiksdoel || '').split(',').map((d) => d.trim()).filter(Boolean).forEach((d) => r.doelen.add(d));
      if (SIGNAAL_STATUS[p.status]) r.signalen.add(SIGNAAL_STATUS[p.status]);
      r.adressenLijst.push({ adres: adresVan(p), doel: p.gebruiksdoel, opp: p.oppervlakte });
      if (!r.adresVoorbeeld) r.adresVoorbeeld = adresVan(p);
    });
  }));
  const jaren = r.panden.map((p) => p.bouwjaar).filter((j) => j > 1000 && j < 2100);
  r.bouwjaarMin = jaren.length ? Math.min(...jaren) : null;
  r.bouwjaarMax = jaren.length ? Math.max(...jaren) : null;
  r.graad = Math.min(1, r.footprint / (r.oppGeo || r.opp));

  // Context (CBS-buurt, monumenten) via dezelfde functie als de gebiedsanalyse
  const bb = bboxAround(r.c, 30).map((v) => v.toFixed(6)).join(',');
  const lookup = (pt) => (pointInGeom(pt, r.geometry) ? r : null);
  await fetchContext(bb, [r], lookup).catch(() => {});

  // Bestemming (PDOK, alle percelen) incl. dubbelbestemmingen
  const plans = await Promise.all(perceelFeatures.map((f) => { const c = centroid(f.geometry); return fetchBestemming(L.latLng(c[1], c[0])).catch(() => []); }));
  const enkel = [...new Set(plans.flat().filter((f) => f.id.startsWith('enkelbestemming')).map((f) => f.properties.naam))];
  const dubbel = [...new Set(plans.flat().filter((f) => f.id.startsWith('dubbelbestemming')).map((f) => f.properties.naam))];
  r.enkel = enkel; r.dubbel = dubbel;
  r.bestemming = enkel.join(', ') + (dubbel.length ? ` (+ ${dubbel.join(', ')})` : '') || (plans.flat().length ? '' : 'geen Wro-plan gevonden');

  // 3D BAG: grootste pand (snel) of hele omgeving (toets)
  if (opts.full) await fetchHeights(r).catch((e) => { r.hoogteFout = e.message; });
  else if (r.pandInfo.length) { await verdiepen([r], () => {}); }

  // DSO-plandata (met sleutels)
  if (typeof dsoEnabled === 'function' && dsoEnabled()) {
    await dsoEnrich([r], () => {}).catch((e) => { r.dso = { fout: e.message }; });
    if (r.dso?.bestemming && !r.bestemming) r.bestemming = r.dso.bestemming;
  }
  if (!AN.filters) AN.filters = filterState();
  scoreParcel(r);
  return r;
}

// 3D BAG voor site + omgeving (50 m) in één bbox-bevraging (RD)
async function fetchHeights(r) {
  const [x0, y0] = wgsToRd(r.bbox[1], r.bbox[0]), [x1, y1] = wgsToRd(r.bbox[3], r.bbox[2]);
  let url = `${KANS.d3}?bbox=${Math.floor(x0 - 50)},${Math.floor(y0 - 50)},${Math.ceil(x1 + 50)},${Math.ceil(y1 + 50)}&limit=50`;
  const heights = new Map();
  for (let page = 0; url && page < 4; page++) {
    const d = await getJSON(url);
    (d.features || []).forEach((f) => Object.entries(f.CityObjects || {}).forEach(([id, o]) => {
      const a = o.attributes;
      if (!a || a.b3_h_dak_70p == null) return;
      const h = a.b3_h_dak_70p - (a.b3_h_maaiveld || 0);
      heights.set(id.replace('NL.IMBAG.Pand.', ''), { h, lagen: a.b3_bouwlagen || Math.max(1, Math.round(h / KANS.laagHoogte)), plat: a.b3_dak_type === 'horizontal' });
    }));
    url = d.links?.find((l) => l.rel === 'next')?.href || null;
  }
  const eigen = r.pandInfo.map((p) => heights.get(p.id)).filter(Boolean);
  const buren = [...heights.entries()].filter(([id]) => !r.pandInfo.some((p) => p.id === id)).map(([, v]) => v.h).sort((a, b) => a - b);
  const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : null);
  r.hoogte = {
    eigenMax: eigen.length ? Math.max(...eigen.map((e) => e.h)) : null,
    eigenLagen: eigen.length ? Math.max(...eigen.map((e) => e.lagen)) : null,
    platDak: eigen.some((e) => e.plat),
    burenP50: q(buren, 0.5), burenP90: q(buren, 0.9), burenMax: buren.length ? buren[buren.length - 1] : null, burenN: buren.length,
  };
  const groot = r.pandInfo.slice().sort((a, b) => b.area - a.area)[0];
  const gh = groot && heights.get(groot.id);
  if (gh) r.d3 = { hoogte: Math.round(gh.h * 10) / 10, lagen: gh.lagen, platDak: gh.plat, footprint: groot.area };
}

// ---------- Omgevingscriteria (alleen in de toets) ----------
async function omgevingsCriteria(r) {
  const c = r.c;
  const bb = (m) => bboxAround(c, m).map((v) => v.toFixed(6)).join(',');
  const res = {};
  await Promise.all([
    getJSON(`${TOETS.fundering}?f=json&limit=5&bbox=${bb(5)}`).then((d) => {
      const f = d.features.find((x) => pointInGeom(c, x.geometry)) || d.features[0];
      res.fundering = f ? { legenda: f.properties.legenda, grond: f.properties.fgr, pctVoor1970: Math.round(+f.properties.percvoor1970 || 0) } : null;
    }).catch(() => {}),
    getJSON(`${TOETS.natura}?f=json&limit=50&bbox=${bb(15000)}`).then((d) => {
      let best = { d: Infinity };
      d.features.forEach((f) => { const dist = minDistToGeom(c, f.geometry); if (dist < best.d) best = { d: dist, naam: f.properties.naam_n2k }; });
      res.natura = best.d < Infinity ? best : null;
    }).catch(() => {}),
    getJSON(`${TOETS.wegen}?f=json&limit=1000&bbox=${bb(300)}`).then((d) => {
      const druk = d.features.filter((f) => ['R', 'P'].includes(f.properties.wegbehsrt) || +f.properties.frc <= 3);
      let best = { d: Infinity };
      druk.forEach((f) => { const dist = minDistToGeom(c, f.geometry); if (dist < best.d) best = { d: dist, naam: f.properties.stt_naam || f.properties.wegnummer, beheer: f.properties.wegbehsrt }; });
      res.weg = best.d < Infinity ? best : null;
    }).catch(() => {}),
    getJSON(`${TOETS.spoor}?f=json&limit=200&bbox=${bb(300)}`).then((d) => {
      const trein = d.features.filter((f) => /trein/i.test(JSON.stringify(f.properties)));
      const set = trein.length ? trein : d.features;
      let best = Infinity;
      set.forEach((f) => { best = Math.min(best, minDistToGeom(c, f.geometry)); });
      res.spoor = best < Infinity ? { d: best, soort: trein.length ? 'trein' : 'spoor (tram/metro/trein)' } : null;
    }).catch(() => {}),
    getJSON(`${TOETS.groen}?f=json&limit=1000&bbox=${bb(150)}`).then((d) => {
      const k = mPerDeg(c[1]);
      let groen = 0;
      d.features.forEach((f) => {
        const fc = centroid(f.geometry);
        if (fc && distM(c, fc) <= 150 && /gras|groen|bos|struik|houtwal|heide|park|bodembedekkers/i.test(JSON.stringify(f.properties))) groen += geomStats(f.geometry).area;
      });
      res.groen = { pct: Math.min(100, Math.round((groen / (Math.PI * 150 * 150)) * 100)), k };
    }).catch(() => {}),
    Promise.all(['production_facility_b', 'production_facility_c', 'production_facility_d', 'production_facility_e', 'production_facility_f', 'production_facility_h']
      .map((col) => getJSON(`${TOETS.industrie}/${col}/items?f=json&limit=50&bbox=${bb(1000)}`).then((d) => d.features).catch(() => [])))
      .then((all) => {
        const fs = all.flat();
        let best = { d: Infinity };
        fs.forEach((f) => { const dist = minDistToGeom(c, f.geometry); if (dist < best.d) best = { d: dist, naam: f.properties.name || f.properties.facility_name || f.properties.inspire_id || 'installatie' }; });
        res.industrie = best.d < Infinity ? { ...best, n: fs.length } : null;
      }),
  ]);
  // Bodem: indicatie uit (huidig) gebruik en bouwjaar
  const industrieel = r.doelen.has('industriefunctie') || (r.panden.length && !r.adressen);
  res.bodem = industrieel ? (r.bouwjaarMin && r.bouwjaarMin < 1990 ? 'verhoogd' : 'aandacht') : 'laag';
  // Archeologie: dubbelbestemming
  res.archeologie = (r.dubbel || []).filter((d) => /archeolog/i.test(d));
  res.karakteristiek = (r.dubbel || []).filter((d) => /karakterist|cultuurhist|monument/i.test(d));
  return res;
}

// ---------- Zonnestand en schaduw ----------
function sunPos(date, lat, lon) {
  const rad = Math.PI / 180, d = (date - Date.UTC(2000, 0, 1, 12)) / 86400000;
  const g = (357.529 + 0.98560028 * d) * rad, q = 280.459 + 0.98564736 * d;
  const Lr = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad, e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(Lr), Math.cos(Lr)), dec = Math.asin(Math.sin(e) * Math.sin(Lr));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const H = ((gmst * 15 + lon) * rad) - ra, la = lat * rad;
  const alt = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(H));
  return { alt: alt / rad, az: ((az / rad) + 360) % 360 };
}
function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  p.forEach((q) => { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); });
  p.slice().reverse().forEach((q) => { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); });
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
const SCHADUW_MOMENTEN = [
  { label: '21 mrt 09:00', t: Date.UTC(2026, 2, 21, 8) }, { label: '21 mrt 12:00', t: Date.UTC(2026, 2, 21, 11) },
  { label: '21 mrt 15:00', t: Date.UTC(2026, 2, 21, 14) }, { label: '21 jun 12:00', t: Date.UTC(2026, 5, 21, 10) },
  { label: '21 dec 12:00', t: Date.UTC(2026, 11, 21, 11) },
];
// Schaduw van een volume met hoogte h op het hele site-oppervlak (bovengrens: alsof het hele kavel bebouwd is
// tot de gekozen hoogte, of alleen de footprint bij optoppen).
function schaduwen(footGeom, h, neighbours) {
  const c = centroid(footGeom), k = mPerDeg(c[1]);
  const pts = rings(footGeom).flatMap((p) => p[0]);
  return SCHADUW_MOMENTEN.map((m) => {
    const s = sunPos(new Date(m.t), c[1], c[0]);
    if (s.alt <= 2) return { ...m, alt: s.alt, lengte: Infinity, geraakt: [] };
    const L = h / Math.tan((s.alt * Math.PI) / 180);
    const dir = ((s.az + 180) % 360) * (Math.PI / 180);
    const dx = (L * Math.sin(dir)) / k.x, dy = (L * Math.cos(dir)) / k.y;
    const poly = hull(pts.concat(pts.map(([x, y]) => [x + dx, y + dy])));
    const g = { type: 'Polygon', coordinates: [[...poly, poly[0]]] };
    const geraakt = neighbours.filter((n) => !pointInGeom(n.c, footGeom) && pointInGeom(n.c, g));
    return { ...m, alt: s.alt, lengte: L, geom: g, geraakt };
  });
}

// ---------- Rekensom ----------
const REKEN_DEFAULTS = {
  verkoopM2: null, gboPerWoning: 65, gboBvo: 0.8, aankoopNietWonenM2: 1200, aankoopGrondM2: 300, aankoopKostenPct: 10.4,
  bouwTransfM2: 1500, bouwOptopM2: 2100, bouwNieuwM2: 2100, sloopM2: 90, bijkomendPct: 10, onvoorzienPct: 5, btwPct: 21,
  parkeerPlek: 15000, margePct: 15,
};
const PARKEERNORM = { 1: 0.5, 2: 0.8, 3: 1.1, 4: 1.3, 5: 1.5 };
function rekenInput(r) {
  const d = { ...REKEN_DEFAULTS };
  // Woninggrootte: regionaal kental uit gerealiseerde projecten (referenties.js) als de gebruiker niets heeft ingesteld.
  const g = r && typeof refGbo === 'function' ? refGbo(r.c, r.nonResM2 >= 120 ? 'transf' : 'nieuw') : null;
  if (g) { d.gboPerWoning = g; d.gboBron = 'regio'; }
  return { ...d, ...store.get('reken', {}) };
}

function scenarios(r, inp) {
  const sted = r.buurt?.stedelijkheid ?? 3;
  const woningwaarde = (r.buurt?.woningwaarde || 300) * 1000;
  // Nieuwbouwprijs: gemiddelde buurtwaarde per m² (±95 m² per woning) plus 20% nieuwbouwpremie.
  const verkoopM2 = inp.verkoopM2 || Math.round((woningwaarde / 95) * 1.2 / 50) * 50;
  const woningenBestaand = r.adressenLijst.filter((a) => /woonfunctie/.test(a.doel || '')).length;
  const aankoop = r.nonResM2 * inp.aankoopNietWonenM2 + woningenBestaand * woningwaarde
    + (!r.panden.length ? r.opp * inp.aankoopGrondM2 : 0);
  const norm = PARKEERNORM[sted] ?? 1.1;
  const vrij = Math.max(0, (r.oppGeo || r.opp) - r.footprint);

  // Hoogte voor nieuwbouw/optoppen: plan > omgeving
  const planH = r.dso?.bouwhoogte || null;
  const omgevingH = r.hoogte?.burenP90 ? Math.max(r.hoogte.burenP90, r.hoogte.eigenMax || 0) : null;
  const maxH = planH || omgevingH || (sted <= 2 ? 12.5 : sted === 3 ? 9.5 : 7);
  const maxLagen = Math.max(1, Math.floor(maxH / KANS.laagHoogte));
  const bebPct = r.dso?.bebouwingspct ? r.dso.bebouwingspct / 100 : (sted <= 2 ? 0.6 : sted === 3 ? 0.45 : 0.35);

  const out = [];
  // Bestaande woningen die blijven staan, leveren hun waarde weer op (alleen niet bij sloop-nieuwbouw).
  const add = (naam, woningen, bvo, bouwM2, sloop, aankoopBedrag, toelichting, behoud = true, extraWaarde = 0) => {
    if (woningen < 1) return;
    // Verkoopprijs is VON incl. btw; de ontwikkelaar houdt de opbrengst excl. btw over. Bestaand vastgoed dat
    // blijft (woningen, niet-wonen) wordt zonder btw meegeteld.
    const vonIncl = woningen * inp.gboPerWoning * verkoopM2;
    const nieuwExcl = vonIncl / (1 + inp.btwPct / 100);
    const bestaand = (behoud && aankoopBedrag ? woningenBestaand * woningwaarde : 0) + extraWaarde;
    const opbrengst = nieuwExcl + bestaand;
    const plekken = Math.max(0, Math.ceil(woningen * norm) - Math.floor(vrij / 25));
    const bouw = bvo * bouwM2 + sloop;
    const bijkomend = bouw * (inp.bijkomendPct + inp.onvoorzienPct) / 100;
    const parkeren = plekken * inp.parkeerPlek;
    const kostenExcl = bouw + bijkomend + parkeren;
    const aankoopTot = aankoopBedrag * (1 + inp.aankoopKostenPct / 100);
    const kosten = kostenExcl + aankoopTot;
    const marge = opbrengst - kosten;
    const maxAankoop = (opbrengst / (1 + inp.margePct / 100) - kostenExcl) / (1 + inp.aankoopKostenPct / 100);
    out.push({ naam, woningen, bvo, opbrengst, vonIncl, bestaand, aankoop: aankoopTot, bouw, bijkomend, parkeren, plekken, kosten, marge, margePct: opbrengst ? (marge / kosten) * 100 : 0, maxAankoop, toelichting });
  };
  // Transformatie
  if (r.nonResM2 >= 120) {
    const w = Math.floor(r.nonResM2 / inp.gboPerWoning);
    add('Transformatie', w, r.nonResM2 / inp.gboBvo, inp.bouwTransfM2, 0, aankoop, `${fmtNum(r.nonResM2)} m² niet-wonen → wonen`);
  }
  // Optoppen
  if (r.d3 && r.d3.footprint > 60) {
    const extra = Math.floor((maxH - r.d3.hoogte) / KANS.laagHoogte);
    if (extra > 0) {
      const bvo = extra * r.footprint;
      add('Optoppen', Math.floor((bvo * inp.gboBvo) / inp.gboPerWoning), bvo, inp.bouwOptopM2, 0, aankoop,
        `+${extra} laag op ${fmtNum(r.footprint)} m² footprint (hoogte ${fmtNum(r.d3.hoogte, 1)} → max ${fmtNum(maxH, 1)} m); bestaand niet-wonen blijft (waarde = aankoopprijs)`,
        true, r.nonResM2 * inp.aankoopNietWonenM2);
    }
  }
  // Transformatie + optoppen
  if (out.length === 2) {
    const [t, o] = out;
    add('Transformatie + optoppen', t.woningen + o.woningen, t.bvo + o.bvo, (t.bouw + o.bouw) / (t.bvo + o.bvo), 0, aankoop, 'combinatie van beide');
  }
  // Inbreiding op vrije grond
  if (vrij >= 250) {
    const bvo = Math.min(vrij * bebPct, vrij * 0.5) * Math.min(maxLagen, 3);
    add('Inbreiding (vrije grond)', Math.floor((bvo * inp.gboBvo) / inp.gboPerWoning), bvo, inp.bouwNieuwM2, 0,
      r.panden.length ? vrij * inp.aankoopGrondM2 : aankoop, `${fmtNum(vrij)} m² vrij, ${Math.min(maxLagen, 3)} lagen, ${Math.round(bebPct * 100)}% bebouwd`, false);
  }
  // Sloop-nieuwbouw
  if (r.panden.length) {
    const bvo = (r.oppGeo || r.opp) * bebPct * maxLagen;
    add('Sloop-nieuwbouw', Math.floor((bvo * inp.gboBvo) / inp.gboPerWoning), bvo, inp.bouwNieuwM2, r.footprint * inp.sloopM2, aankoop,
      `${Math.round(bebPct * 100)}% bebouwd × ${maxLagen} lagen (max ${fmtNum(maxH, 1)} m)`, false);
  }
  return { list: out, verkoopM2, maxH, maxLagen, planH, omgevingH, bebPct, norm, aankoop };
}

// ---------- Beoordeling in het infopaneel (punt 1) ----------
function scoreCardHtml(r) {
  const d = r.deel;
  return `<div class="scorecard">
    <div class="res-head"><span class="badge" style="background:${scoreColor(r.score)}">${r.score}</span>
      <strong>Kansscore</strong><span class="pot">±${r.pot.totaal} won.${r.opbrengst ? ' · ' + fmtEuro(r.opbrengst) : ''}</span></div>
    <div class="deel">${[['Fysiek', d.fys], ['Juridisch', d.jur], ['Markt', d.markt], ['Verwerving', d.verw]]
      .map(([k, v]) => `<span title="${k}"><i style="width:${v}%;background:${scoreColor(v)}"></i>${k.slice(0, 4)} ${v}</span>`).join('')}</div>
    <div class="why">${r.why.map(esc).join(' · ')}</div>
  </div>`;
}
async function renderScoreInfo(perceel) {
  const body = $('#info-body');
  if (!perceel || !body) return;
  const box = document.createElement('div');
  box.id = 'score-section';
  const h4 = body.querySelector('h4');
  body.insertBefore(box, h4 || null);
  const actions = `<div class="row"><button id="act-sel">▣ Voeg toe aan selectie</button><button id="act-toets">Haalbaarheid toetsen</button></div>`;
  const known = AN.all?.find((x) => x.id === perceel.properties.identificatie_lokaal_id);
  if (known) { box.innerHTML = '<h4>Beoordeling</h4>' + scoreCardHtml(known) + actions; bindInfoActions(perceel); return; }
  box.innerHTML = '<h4>Beoordeling</h4><p class="loading">Beoordelen…</p>';
  try {
    const r = await buildSite([perceel]);
    if (!document.body.contains(box)) return;
    box.innerHTML = '<h4>Beoordeling</h4>' + scoreCardHtml(r) + actions;
  } catch (e) {
    box.innerHTML = `<h4>Beoordeling</h4><p class="muted">Niet gelukt: ${esc(e.message)}</p>` + actions;
  }
  bindInfoActions(perceel);
}
function bindInfoActions(perceel) {
  const s = $('#act-sel'), t = $('#act-toets');
  if (s) s.onclick = () => { toggleSelect(perceel); };
  if (t) t.onclick = () => { if (!SEL.ids.has(perceel.properties.identificatie_lokaal_id)) toggleSelect(perceel); runToets(); };
}
const _renderInfo2 = renderInfo;
renderInfo = function (args) { // eslint-disable-line no-global-assign
  _renderInfo2(args);
  renderScoreInfo(args.perceel);
};

// ---------- Selectie (punt 2) ----------
(function selectionUI() {
  const btn = document.createElement('button');
  btn.id = 'btn-select';
  btn.title = 'Kavels selecteren voor een haalbaarheidstoets';
  btn.textContent = '▣';
  $('.tools').insertBefore(btn, $('#btn-analyse'));
  btn.onclick = () => {
    SEL.active = !SEL.active;
    btn.classList.toggle('on', SEL.active);
    mode = SEL.active ? 'select' : (mode === 'select' ? null : mode);
    map.getContainer().style.cursor = SEL.active ? 'copy' : '';
    updateSelBar();
  };
  const bar = document.createElement('div');
  bar.id = 'sel-bar';
  bar.className = 'measure';
  bar.hidden = true;
  bar.innerHTML = '<span id="sel-out"></span><button id="sel-toets" class="primary">Haalbaarheid toetsen</button><button id="sel-clear">Wissen</button>';
  document.body.appendChild(bar);
  $('#sel-toets').onclick = runToets;
  $('#sel-clear').onclick = () => { SEL.ids.clear(); SEL.layer.clearLayers(); SEL.extraLayer.clearLayers(); updateSelBar(); };

  const panel = document.createElement('section');
  panel.id = 'toets';
  panel.className = 'sheet wide-sheet';
  panel.hidden = true;
  panel.innerHTML = '<div class="sheet-head"><strong>Haalbaarheidstoets</strong><span><button id="toets-print">Afdrukken</button> <button id="toets-close">✕</button></span></div><div id="toets-body"></div>';
  document.body.appendChild(panel);
  $('#toets-close').onclick = () => { panel.hidden = true; SEL.extraLayer.clearLayers(); };
  $('#toets-print').onclick = () => window.print();
})();
function updateSelBar() {
  const n = SEL.ids.size;
  $('#sel-bar').hidden = !(SEL.active || n);
  const opp = [...SEL.ids.values()].reduce((s, f) => s + (f.properties.kadastrale_grootte_waarde || 0), 0);
  $('#sel-out').textContent = n ? `${n} kavel${n > 1 ? 's' : ''} · ${fmtNum(opp)} m²` : 'Klik kavels aan om te selecteren';
  $('#sel-toets').disabled = !n;
}
function toggleSelect(perceel) {
  const id = perceel.properties.identificatie_lokaal_id;
  if (SEL.ids.has(id)) SEL.ids.delete(id); else SEL.ids.set(id, perceel);
  SEL.layer.clearLayers();
  SEL.ids.forEach((f) => L.geoJSON(f.geometry, { style: { color: '#7048e8', weight: 3, fillColor: '#7048e8', fillOpacity: 0.25 }, interactive: false }).addTo(SEL.layer));
  updateSelBar();
}
async function selectAt(latlng) {
  const pt = [latlng.lng, latlng.lat], d = 0.00002;
  const fc = await getJSON(`${PDOK.brk}/perceel/items?f=json&bbox=${[pt[0] - d, pt[1] - d, pt[0] + d, pt[1] + d].join(',')}&limit=10`);
  const f = fc.features.find((x) => pointInGeom(pt, x.geometry));
  if (f) toggleSelect(f);
}

// ---------- Haalbaarheidstoets ----------
async function runToets() {
  if (!SEL.ids.size) return;
  const panel = $('#toets');
  panel.hidden = false;
  $('#info').hidden = true;
  $('#toets-body').innerHTML = '<p class="loading">Gegevens verzamelen: BAG, bestemming, buurt, hoogtes en omgeving. Dit duurt 20–40 seconden…</p>';
  try {
    const r = await buildSite([...SEL.ids.values()], { full: true });
    const [omg, buren] = await Promise.all([omgevingsCriteria(r), fetchBuren(r)]);
    r.omg = omg; r.buren = buren;
    renderToets(r);
  } catch (e) {
    console.error(e);
    $('#toets-body').innerHTML = `<p class="muted">Toets mislukt: ${esc(e.message)}</p>`;
  }
}
async function fetchBuren(r) {
  const bb = bboxAround(r.c, 120).map((v) => v.toFixed(6)).join(',');
  const fc = await getJSON(`${PDOK.bag}/pand/items?f=json&bbox=${bb}&limit=500`).catch(() => ({ features: [] }));
  return fc.features.filter((f) => !r.pandInfo.some((p) => p.id === f.properties.identificatie))
    .map((f) => ({ c: centroid(f.geometry), geometry: f.geometry, id: f.properties.identificatie, doel: f.properties.gebruiksdoel }));
}

function niveau(cls, txt) { return `<span class="lvl ${cls}">${txt}</span>`; }
function renderToets(r) {
  const inp = rekenInput(r);
  const sc = scenarios(r, inp);
  const o = r.omg || {};
  const h = r.hoogte || {};
  const sted = r.buurt?.stedelijkheid;

  // Schaduw: voor het beste nieuwbouw-/optopscenario
  const besteH = sc.maxH;
  const footForShadow = r.panden.length ? { type: 'MultiPolygon', coordinates: r.pandGeoms.flatMap((g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates)) } : r.geometry;
  const sch = schaduwen(footForShadow, besteH, r.buren || []);
  SEL.extraLayer.clearLayers();
  const maart = sch.find((s) => s.label === '21 mrt 15:00');
  sch.filter((s) => s.geom && s.label.startsWith('21 mrt')).forEach((s) => L.geoJSON(s.geom, { style: { color: '#495057', weight: 1, fillOpacity: s === maart ? 0.25 : 0.1, dashArray: '3 3' }, interactive: false }).addTo(SEL.extraLayer));
  map.fitBounds([[r.bbox[1], r.bbox[0]], [r.bbox[3], r.bbox[2]]], { maxZoom: 19, padding: [60, 60] });

  const dist = (d) => (d == null || d === Infinity ? '–' : d < 1000 ? `${Math.round(d)} m` : `${fmtNum(d / 1000, 1)} km`);
  const geluidLvl = (() => {
    const w = o.weg?.d ?? Infinity, s = o.spoor?.d ?? Infinity;
    if (w < 50 || s < 50) return niveau('rood', 'hoog');
    if (w < 150 || s < 150) return niveau('oranje', 'aandacht');
    return niveau('groen', 'laag');
  })();
  const stikstofLvl = !o.natura ? niveau('groen', 'onbekend/ver') : o.natura.d < 1000 ? niveau('rood', 'hoog') : o.natura.d < 5000 ? niveau('oranje', 'aandacht') : niveau('groen', 'laag');
  const fundLvl = o.fundering ? (/kwetsbaar/i.test(o.fundering.legenda) && !/niet kwetsbaar/i.test(o.fundering.legenda) ? niveau('oranje', 'aandacht') : niveau('groen', 'laag')) : niveau('grijs', 'onbekend');
  const bodemLvl = o.bodem === 'verhoogd' ? niveau('rood', 'verhoogd') : o.bodem === 'aandacht' ? niveau('oranje', 'aandacht') : niveau('groen', 'laag');
  const archLvl = o.archeologie?.length ? niveau('oranje', 'onderzoek nodig') : niveau('groen', 'geen dubbelbestemming');
  const indLvl = o.industrie && o.industrie.d < 300 ? niveau('rood', 'dichtbij') : o.industrie && o.industrie.d < 1000 ? niveau('oranje', 'aandacht') : niveau('groen', 'laag');
  const groenLvl = o.groen ? (o.groen.pct >= 20 ? niveau('groen', `${o.groen.pct}%`) : o.groen.pct >= 8 ? niveau('oranje', `${o.groen.pct}%`) : niveau('rood', `${o.groen.pct}%`)) : niveau('grijs', 'onbekend');
  const erfpacht = /amsterdam/i.test(r.aanduiding) ? 'vrijwel zeker erfpacht (Amsterdam): canon/afkoop meenemen'
    : /'s-gravenhage|den haag|rotterdam|utrecht|leiden|almere|zwolle/i.test(r.aanduiding) ? 'mogelijk erfpacht: controleer eigendomsinformatie' : 'meestal eigen grond (controleer bij Kadaster)';
  const ll = `${r.c[1].toFixed(6)},${r.c[0].toFixed(6)}`;

  const rows = (arr) => `<table>${arr.map(([k, v, x]) => `<tr><td>${esc(k)}</td><td>${v}</td>${x !== undefined ? `<td class="muted">${x}</td>` : ''}</tr>`).join('')}</table>`;
  const scenRows = sc.list.map((s) => `<tr>
      <td><strong>${esc(s.naam)}</strong><br><span class="muted">${esc(s.toelichting)}</span></td>
      <td>${s.woningen}</td><td>${fmtEuro(s.vonIncl)}<br><span class="muted">${fmtEuro(s.opbrengst)}</span></td><td>${fmtEuro(s.kosten)}</td>
      <td class="${s.marge >= 0 ? 'pos' : 'neg'}">${fmtEuro(Math.abs(s.marge)).replace('€', s.marge < 0 ? '−€' : '€')}<br><span class="muted">${fmtNum(s.margePct, 1)}%</span></td>
      <td>${s.maxAankoop > 0 ? fmtEuro(s.maxAankoop) : '<span class="neg">n.v.t.</span>'}</td></tr>`).join('');

  $('#toets-body').innerHTML = `
    <h4>Locatie</h4>
    ${rows([
      ['Kavels', esc(r.aanduiding)],
      ['Oppervlakte', `${fmtNum(r.opp)} m² (${r.percelen.length} perce${r.percelen.length > 1 ? 'len' : 'el'})`],
      ['Bebouwd', `${fmtNum(r.footprint)} m² (${Math.round(r.graad * 100)}%), ${r.panden.length} pand(en)`],
      ['Adressen', `${r.adressen} · wonen ${fmtNum(r.resM2)} m² · niet-wonen ${fmtNum(r.nonResM2)} m²`],
      ['Gebruik', esc([...r.doelen].join(', ') || 'geen adres')],
      ['Bouwjaar', r.bouwjaarMin ? `${r.bouwjaarMin}${r.bouwjaarMax !== r.bouwjaarMin ? '–' + r.bouwjaarMax : ''}` : '–'],
      ['Buurt', r.buurt ? `${esc(r.buurt.naam)} · woningwaarde €${fmtNum(r.buurt.woningwaarde || 0)}k · stedelijkheid ${sted ?? '–'}` : '–'],
    ])}
    ${scoreCardHtml(r)}

    <h4>Planologie</h4>
    ${rows([
      ['Bestemming', esc(r.enkel?.join(', ') || r.bestemming || 'onbekend')],
      ['Dubbelbestemming', esc(r.dubbel?.join(', ') || 'geen')],
      ['Rijksmonument', r.monument ? `<a href="${esc(r.monument)}" target="_blank" rel="noopener">ja</a>` : 'nee'],
      ['Beschermd gezicht', esc(r.gezicht || 'nee')],
      ['Maatvoering (plan)', r.dso && !r.dso.fout ? esc([r.dso.bouwhoogte && `bouwhoogte ${r.dso.bouwhoogte} m`, r.dso.goothoogte && `goothoogte ${r.dso.goothoogte} m`, r.dso.bebouwingspct && `bebouwing ${r.dso.bebouwingspct}%`, r.dso.inBouwvlak != null && (r.dso.inBouwvlak ? 'in bouwvlak' : 'buiten bouwvlak')].filter(Boolean).join(' · ') || 'geen maatvoering gevonden') : '<span class="muted">alleen met DSO-sleutel (☰ → API-sleutels)</span>'],
      ['Plannen in ontwikkeling', esc(r.dso?.planInOntwikkeling || (r.dso ? 'geen' : '–'))],
      ['Erfpacht', esc(erfpacht)],
    ])}

    <h4>Bouwhoogte en schaduw</h4>
    ${rows([
      ['Huidige hoogte', h.eigenMax != null ? `${fmtNum(h.eigenMax, 1)} m (±${h.eigenLagen} lagen${h.platDak ? ', plat dak' : ''})` : (r.panden.length ? 'onbekend' : 'onbebouwd')],
      ['Omgeving (50 m)', h.burenN ? `mediaan ${fmtNum(h.burenP50, 1)} m · 90% ${fmtNum(h.burenP90, 1)} m · max ${fmtNum(h.burenMax, 1)} m (${h.burenN} panden)` : 'onbekend'],
      ['Toegestaan (plan)', sc.planH ? `${fmtNum(sc.planH, 1)} m` : '<span class="muted">onbekend</span>'],
      ['Gehanteerd maximum', `<strong>${fmtNum(sc.maxH, 1)} m (${sc.maxLagen} lagen)</strong> <span class="muted">${sc.planH ? 'uit plan' : sc.omgevingH ? 'afgeleid van omgeving' : 'aanname naar stedelijkheid'}</span>`],
    ])}
    <table class="compact"><tr><td>Moment</td><td>Zonhoogte</td><td>Schaduwlengte</td><td>Panden in schaduw</td></tr>
      ${sch.map((s) => `<tr><td>${s.label}</td><td>${fmtNum(s.alt, 0)}°</td><td>${s.lengte === Infinity ? '–' : fmtNum(s.lengte, 0) + ' m'}</td><td>${s.geraakt.length}${s.geraakt.length ? ` <span class="muted">(${s.geraakt.filter((g) => /woon/.test(g.doel || '')).length} met wonen)</span>` : ''}</td></tr>`).join('')}
    </table>
    <p class="muted">Vereenvoudigde schaduw van een volume van ${fmtNum(besteH, 1)} m op ${r.panden.length ? 'de huidige footprint' : 'het hele kavel'}; op de kaart gestippeld voor 21 maart. Geen vervanging van een bezonningsstudie.</p>

    <h4>Omgeving en risico's</h4>
    ${rows([
      ['Bodem (indicatie)', bodemLvl, o.bodem === 'laag' ? 'geen industrieel gebruik' : 'industrieel/bedrijfsmatig gebruik: verkennend bodemonderzoek nodig'],
      ['Archeologie', archLvl, esc(o.archeologie?.join(', ') || '')],
      ['Fundering', fundLvl, esc(o.fundering ? `${o.fundering.legenda} · ${o.fundering.grond}` : '')],
      ['Geluid (indicatie)', geluidLvl, `drukke weg ${dist(o.weg?.d)}${o.weg?.naam ? ' (' + esc(o.weg.naam) + ')' : ''} · ${esc(o.spoor?.soort || 'spoor')} ${dist(o.spoor?.d)}`],
      ['Milieu / industrie', indLvl, o.industrie ? `${o.industrie.n} geregistreerde installatie(s) ≤ 1 km, dichtstbij ${dist(o.industrie.d)}` : 'geen geregistreerde installaties ≤ 1 km'],
      ['Stikstof (Natura 2000)', stikstofLvl, o.natura ? `${esc(o.natura.naam)} op ${dist(o.natura.d)}` : 'geen gebied ≤ 15 km'],
      ['Groen ≤ 150 m', groenLvl, 'aandeel begroeid terrein (BGT)'],
      ['Parkeren', niveau('grijs', `norm ±${sc.norm}/woning`), `indicatie naar stedelijkheid (CROW); exacte norm in gemeentelijke parkeerbeleidsregels`],
    ])}
    <div class="links">
      <a href="https://www.bodemloket.nl/kaart?zoom=12&lat=${r.c[1]}&lng=${r.c[0]}" target="_blank" rel="noopener">Bodemloket</a>
      <a href="https://www.atlasleefomgeving.nl/kaarten" target="_blank" rel="noopener">Atlas Leefomgeving (geluid, externe veiligheid)</a>
      <a href="https://www.klimaateffectatlas.nl/nl/" target="_blank" rel="noopener">Klimaateffectatlas (water)</a>
      <a href="https://capaciteitskaart.netbeheernederland.nl/" target="_blank" rel="noopener">Netcapaciteit</a>
      <a href="https://omgevingswet.overheid.nl/regels-op-de-kaart/zoeken/locatie?locatie=${ll}" target="_blank" rel="noopener">Regels op de kaart</a>
    </div>

    ${typeof refToetsHtml === 'function' ? refToetsHtml(r) : ''}

    <h4>Scenario's en rekensom</h4>
    ${sc.list.length ? `<table class="scen"><tr><th>Scenario</th><th>Won.</th><th>Verkoop VON incl. btw<br><span class="muted">opbrengst excl. btw</span></th><th>Kosten excl. btw</th><th>Marge</th><th>Max. aankoop*</th></tr>${scenRows}</table>
    <p class="muted">* Maximale aankoopprijs (excl. aankoopkosten) bij ${inp.margePct}% marge. Verkoop = nieuwe woningen × ${inp.gboPerWoning} m²${inp.gboBron === 'regio' && store.get('reken', {}).gboPerWoning == null ? ' (mediaan gerealiseerde projecten in de regio)' : ''} × €${fmtNum(sc.verkoopM2)}/m² VON incl. ${inp.btwPct}% btw. Opbrengst (excl. btw) = verkoop ÷ ${fmtNum(1 + inp.btwPct / 100, 2)}, plus de waarde van bestaand vastgoed dat blijft staan. Alle kosten zijn excl. btw; marge en maximale aankoop zijn berekend op de opbrengst excl. btw.
    Aankoop is geschat: niet-wonen × €${fmtNum(inp.aankoopNietWonenM2)}/m², bestaande woningen × buurtwaarde, onbebouwd × €${fmtNum(inp.aankoopGrondM2)}/m² (totaal €${fmtNum(sc.aankoop)}).</p>`
    : '<p class="muted">Geen scenario met minimaal 1 woning gevonden.</p>'}
    <details class="card"><summary><strong>Uitgangspunten aanpassen</strong></summary>
      <div class="grid2 reken">
        ${[['verkoopM2', 'Verkoopprijs €/m² GBO, VON incl. btw (leeg = uit buurt)'], ['gboPerWoning', 'm² GBO per woning'], ['gboBvo', 'Verhouding GBO/BVO'],
          ['aankoopNietWonenM2', 'Aankoop niet-wonen €/m²'], ['aankoopGrondM2', 'Aankoop grond €/m²'], ['aankoopKostenPct', 'Aankoopkosten/OVB %'],
          ['bouwTransfM2', 'Bouwkosten transformatie €/m² BVO excl. btw'], ['bouwOptopM2', 'Bouwkosten optoppen (staalframe) €/m² BVO excl. btw'], ['bouwNieuwM2', 'Bouwkosten nieuwbouw €/m² BVO excl. btw'],
          ['sloopM2', 'Sloop €/m² footprint'], ['bijkomendPct', 'Bijkomende kosten % (over bouw)'], ['onvoorzienPct', 'Onvoorzien % (over bouw)'], ['btwPct', 'Btw % op verkoop'],
          ['parkeerPlek', 'Parkeren (afkoop) €/plek'], ['margePct', 'Gewenste marge %']]
          .map(([k, l]) => `<label>${l}<input type="number" step="any" data-reken="${k}" value="${inp[k] ?? ''}" placeholder="${k === 'verkoopM2' ? fmtNum(sc.verkoopM2) : ''}"></label>`).join('')}
      </div>
      <div class="row"><button id="reken-reset">Standaardwaarden</button></div>
    </details>
    <p class="muted">Indicatief. Niet meegenomen: eigendomssituatie, huurcontracten, bodemsanering, funderingsherstel, netaansluiting, financieringslasten en fasering. Btw op bouwkosten is niet meegenomen (aftrekbaar bij btw-belaste verkoop).</p>`;

  $('#toets-body').querySelectorAll('[data-reken]').forEach((el) => el.addEventListener('change', () => {
    const cur = store.get('reken', {});
    const v = el.value === '' ? null : Number(el.value);
    if (v == null) delete cur[el.dataset.reken]; else cur[el.dataset.reken] = v;
    store.set('reken', cur);
    renderToets(r);
  }));
  $('#reken-reset').onclick = () => { store.set('reken', {}); renderToets(r); };
}
