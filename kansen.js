'use strict';
// Kansrijkheidsmodel voor kleinschalige (her)ontwikkeling (2–10 woningen):
// transformatie, optoppen en inbreiding. Vier deelscores (fysiek, juridisch, markt, verwerving),
// gewogen tot één score, plus een geschat aantal woningen en een indicatieve verkoopopbrengst.
// Gebruikt gegevens die search.js per perceel verzamelt, plus CBS-buurtcijfers, RCE-monumenten,
// 3D BAG (op verzoek, top-resultaten) en DSO-plandata (dso.js, optioneel).

const KANS = {
  cbs: 'https://api.pdok.nl/cbs/wijken-en-buurten-2024/ogc/v1/collections/buurten/items',
  rce: 'https://api.pdok.nl/rce/beschermde-gebieden-cultuurhistorie/ogc/v1/collections',
  d3: 'https://api.3dbag.nl/collections/pand/items',
  m2PerWoning: 65,   // gemiddeld GBO per appartement incl. verlies aan verkeersruimte
  laagHoogte: 3.1,   // m per bouwlaag
};
const DEFAULT_W = { fys: 35, jur: 25, markt: 20, verw: 20 };
const cbsVal = (v) => (v == null || v <= -99990 ? null : v);

// ---------- Context: CBS-buurten en monumenten voor het hele gebied ----------
async function fetchContext(bb, percelen, lookup) {
  const [buurten, punten, vlakken] = await Promise.all([
    fetchAll(`${KANS.cbs}?f=json&limit=100&bbox=${bb}`, 'buurten', () => {}).catch(() => ({ features: [] })),
    fetchAll(`${KANS.rce}/rce_inspire_points/items?f=json&limit=1000&bbox=${bb}`, 'monumenten', () => {}).catch(() => ({ features: [] })),
    fetchAll(`${KANS.rce}/rce_inspire_polygons/items?f=json&limit=1000&bbox=${bb}`, 'gezichten', () => {}).catch(() => ({ features: [] })),
  ]);
  const bs = buurten.features.map((f) => ({ geometry: f.geometry, bbox: bboxOf(f.geometry), p: f.properties }));
  percelen.forEach((r) => {
    const b = bs.find((x) => r.c[0] >= x.bbox[0] && r.c[0] <= x.bbox[2] && r.c[1] >= x.bbox[1] && r.c[1] <= x.bbox[3] && pointInGeom(r.c, x.geometry));
    if (b) {
      const p = b.p;
      r.buurt = {
        naam: p.buurtnaam,
        woningwaarde: cbsVal(p.gemiddelde_woningwaarde), // x 1000 euro
        stedelijkheid: cbsVal(p.stedelijkheid_adressen_per_km2), // klasse 1 (zeer sterk) – 5 (niet stedelijk)
        station: cbsVal(p.treinstation_gemiddelde_afstand_in_km),
        supermarkt: cbsVal(p.grote_supermarkt_gemiddelde_afstand_in_km),
        meergezins: cbsVal(p.percentage_meergezinswoning),
      };
    }
  });
  punten.features.forEach((f) => {
    if (f.properties.namespace !== 'nlps-rijksmonumenten' || f.geometry?.type !== 'Point') return;
    const r = lookup(f.geometry.coordinates);
    if (r) r.monument = f.properties.ci_citation || 'rijksmonument';
  });
  vlakken.features.forEach((f) => {
    const ns = f.properties.namespace;
    const bbox = bboxOf(f.geometry);
    percelen.forEach((r) => {
      if (r.c[0] < bbox[0] || r.c[0] > bbox[2] || r.c[1] < bbox[1] || r.c[1] > bbox[3] || !pointInGeom(r.c, f.geometry)) return;
      if (ns === 'nlps-rijksmonumenten') r.monument = r.monument || f.properties.ci_citation || 'rijksmonument';
      else if (ns === 'nlps-stadsendorpsgezichten') r.gezicht = f.properties.text || 'beschermd stads-/dorpsgezicht';
      else if (ns === 'nlps-werelderfgoed') r.werelderfgoed = true;
    });
  });
}

// ---------- 3D BAG: hoogte en bouwlagen voor de top-resultaten ----------
async function fetch3d(pandId) {
  const d = await getJSON(`${KANS.d3}/NL.IMBAG.Pand.${pandId}`);
  const co = d.feature?.CityObjects || d.CityObjects || {};
  const a = co[`NL.IMBAG.Pand.${pandId}`]?.attributes || Object.values(co)[0]?.attributes;
  if (!a) return null;
  const h = (a.b3_h_dak_70p ?? a.b3_h_dak_max) - (a.b3_h_maaiveld ?? 0);
  return {
    hoogte: Math.round(h * 10) / 10,
    lagen: a.b3_bouwlagen || Math.max(1, Math.round(h / KANS.laagHoogte)),
    platDak: a.b3_dak_type === 'horizontal' || (a.b3_opp_dak_plat || 0) > 0.6 * (a.b3_opp_grond || Infinity),
  };
}
// Eén stap voor de top-resultaten: 3D BAG, bestemming (PDOK) en, met sleutels, DSO-plandata.
async function verdiepAlles(results, onProgress) {
  await verdiepen(results, (n) => onProgress(`3D BAG ${n}/${results.length}`));
  const todo = results.filter((r) => !r.bestemming);
  let done = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (todo.length) {
      const r = todo.shift();
      try {
        const feats = await fetchBestemming(L.latLng(r.c[1], r.c[0]));
        const enkel = [...new Set(feats.filter((f) => f.id.startsWith('enkelbestemming')).map((f) => f.properties.naam))];
        const dubbel = [...new Set(feats.filter((f) => f.id.startsWith('dubbelbestemming')).map((f) => f.properties.naam))];
        r.bestemming = enkel.join(', ') + (dubbel.length ? ` (+ ${dubbel.join(', ')})` : '') || 'geen Wro-plan gevonden';
      } catch { r.bestemming = 'niet opgehaald'; }
      AN.plans.set(r.id, r.bestemming);
      onProgress(`bestemming ${++done}`);
    }
  }));
  if (typeof dsoEnrich === 'function' && dsoEnabled()) {
    try { await dsoEnrich(results, (n) => onProgress(`DSO-plandata ${n}/${results.length}`)); } catch (e) { onProgress(`DSO: ${e.message}`); }
  }
}
async function verdiepen(results, onProgress) {
  const todo = results.filter((r) => r.pandInfo.length && !r.d3);
  let done = 0;
  const worker = async () => {
    while (todo.length) {
      const r = todo.shift();
      const grootste = r.pandInfo.slice().sort((a, b) => b.area - a.area)[0];
      try { r.d3 = (await fetch3d(grootste.id)) || { fout: 'geen 3D-gegevens' }; } catch (e) { r.d3 = { fout: e.message }; }
      r.d3.footprint = grootste.area;
      onProgress(++done);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

// ---------- Woningpotentie ----------
function potentie(r, strat) {
  const out = { transf: 0, optop: 0, inbr: 0, notes: [] };
  const sted = r.buurt?.stedelijkheid ?? 3;
  if (strat.transf && r.nonResM2 >= 120) {
    const gboT = (typeof refGbo === 'function' && refGbo(r.c, 'transf')) || KANS.m2PerWoning; // regionaal kental indien beschikbaar
    out.transf = Math.floor(r.nonResM2 / gboT);
    if (out.transf) out.notes.push(`transformatie ${fmtNum(r.nonResM2)} m² niet-wonen → ±${out.transf} won.`);
  }
  if (strat.optop && r.d3 && !r.d3.fout && r.d3.footprint > 60) {
    let extra = 0, bron = '';
    if (r.dso?.bouwhoogte) {
      extra = Math.floor((r.dso.bouwhoogte - r.d3.hoogte) / KANS.laagHoogte);
      bron = `plan staat ${r.dso.bouwhoogte} m toe, nu ${r.d3.hoogte} m`;
    } else if (r.d3.lagen <= 2 && r.d3.platDak && (sted <= 2 || (r.buurt?.meergezins ?? 0) >= 30)) {
      extra = 1; bron = `${r.d3.lagen} lagen met plat dak in stedelijke buurt (aanname, toets aan plan)`;
    }
    if (extra > 0) {
      const gboO = (typeof refGbo === 'function' && refGbo(r.c, 'nieuw')) || KANS.m2PerWoning;
      out.optop = Math.floor((extra * r.d3.footprint * 0.8) / gboO);
      if (out.optop) out.notes.push(`optoppen +${extra} laag: ±${out.optop} won. (${bron})`);
    }
  }
  // Gemiddelde breedte ≈ 2·A/P; smalle stroken (groen, paden, sloten) zijn geen bouwkavel.
  const breedte = r.omtrek ? (2 * (r.oppGeo || r.opp)) / r.omtrek : 0;
  if (strat.inbr && breedte >= 12) {
    const vrij = (r.oppGeo || r.opp) - r.footprint;
    const m2pw = sted <= 2 ? 110 : sted === 3 ? 160 : 220; // grond per woning naar stedelijkheid
    if (sted >= 4) {
      // Buitengebied/landelijk: alleen kleine onbebouwde kavels (gat in een lint); erfsplitsing is daar zelden kansrijk.
      if (!r.panden.length && r.opp >= 300 && r.opp <= 1500) {
        out.inbr = Math.floor(r.opp / m2pw);
        if (out.inbr) out.notes.push(`onbebouwde kavel in landelijk gebied → ±${out.inbr} won. (lastig vergunbaar)`);
      }
    } else if (!r.panden.length && r.opp >= 200 && r.opp <= 5000) {
      out.inbr = Math.floor(r.opp / m2pw);
      if (out.inbr) out.notes.push(`onbebouwde kavel → ±${out.inbr} won.`);
    } else if (r.panden.length && vrij >= 400 && r.graad < 0.3) {
      out.inbr = Math.floor((vrij - 200) / (m2pw * 1.3));
      if (out.inbr) out.notes.push(`${fmtNum(vrij)} m² vrije grond → ±${out.inbr} won. extra`);
    }
  }
  out.totaal = out.transf + out.optop + out.inbr;
  return out;
}

// ---------- Deelscores ----------
const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));
function fysiekScore(w) {
  if (w <= 0) return 0;
  if (w === 1) return 25;
  if (w <= 10) return 60 + (w - 2) * 5;  // 2 → 60, 10 → 100
  if (w <= 15) return 75;
  if (w <= 30) return 50;
  return 25;
}
const BESTEMMING_UIT = /verkeer|water|groen|natuur|bos|spoor|recreatie/i;
const BESTEMMING_WONEN = /wonen|woongebied|gemengd|centrum/i;
const BESTEMMING_TRANSF = /bedrijf|kantoor|detailhandel|horeca|dienstverlening|maatschappelijk/i;

function juridischScore(r, why) {
  let s = 55;
  if (r.monument) { s -= 35; why.push('rijksmonument'); }
  if (r.gezicht) { s -= 10; why.push('beschermd stads-/dorpsgezicht'); }
  const best = (r.bestemming || '').split(' (+')[0];
  if (best) {
    if (/kernwinkel|winkelgebied/i.test(best)) { s += 0; why.push(`bestemming ${best} (gemeente beschermt winkelplint vaak; wonen op verdieping kansrijker)`); }
    else if (BESTEMMING_WONEN.test(best)) { s += 20; why.push(`bestemming ${best}`); }
    else if (BESTEMMING_TRANSF.test(best)) { s += 5; why.push(`bestemming ${best} (afwijking nodig voor wonen)`); }
    else if (/agrarisch/i.test(best)) { s -= 15; why.push('agrarische bestemming'); }
  }
  if (/karakteristiek|cultuurhistori/i.test(r.bestemming || '')) { s -= 5; why.push('dubbelbestemming karakteristiek/cultuurhistorie'); }
  const d = r.dso;
  if (d && !d.fout) {
    if (d.planInOntwikkeling) { s += 10; why.push('plan in ontwikkeling'); }
    if (d.vergunningen) { s += 5; why.push(`${d.vergunningen} omgevingsvergunning(en) op perceel`); }
    if (d.bebouwingspct && d.bebouwingspct - r.graad * 100 >= 20) { s += 10; why.push(`plan: ${d.bebouwingspct}% bebouwing toegestaan, nu ${Math.round(r.graad * 100)}%`); }
    if (d.inBouwvlak === false && !r.panden.length) { s -= 15; why.push('buiten bouwvlak'); }
  }
  return clamp(s);
}
function marktScore(r, why) {
  const b = r.buurt;
  if (!b || b.woningwaarde == null) { why.push('geen buurtcijfers'); return 50; }
  let s = (b.woningwaarde - 200) / 4; // €200k → 0, €600k → 100
  if (b.stedelijkheid != null) s += b.stedelijkheid <= 2 ? 10 : b.stedelijkheid >= 5 ? -10 : 0;
  if (b.station != null && b.station <= 1.5) s += 5;
  if (b.supermarkt != null && b.supermarkt <= 1) s += 5;
  why.push(`buurt ${b.naam}: gem. woningwaarde €${fmtNum(b.woningwaarde)}k`);
  return clamp(s);
}
function verwervingScore(r, why) {
  let s = 50;
  if (r.panden.length) {
    if (r.maxVboPerPand <= 1) { s += 15; why.push('één adres in pand (waarschijnlijk één eigenaar)'); }
    else if (r.maxVboPerPand <= 3) s += 8;
    else if (r.maxVboPerPand > 10) { s -= 25; why.push(`${r.maxVboPerPand} adressen in pand (VvE, veel eigenaren)`); }
    else s -= 5;
  }
  const sig = r.signalen;
  if (sig.has('pand buiten gebruik') || sig.has('verblijfsobject buiten gebruik')) { s += 25; why.push('leegstand (BAG: buiten gebruik)'); }
  if (sig.has('bouwvergunning verleend') || sig.has('bouw gestart') || sig.has('sloopvergunning verleend') || sig.has('verblijfsobject in voorbereiding')) {
    s -= 15; why.push('eigenaar is al aan het ontwikkelen');
  }
  if (r.bouwjaarMax && r.bouwjaarMax >= 2010) { s -= 30; why.push(`recent gebouwd (${r.bouwjaarMax})`); }
  else if (r.bouwjaarMin && r.bouwjaarMin >= 1950 && r.bouwjaarMin <= 1985) { s += 10; why.push(`bouwjaar ${r.bouwjaarMin} (functioneel verouderd)`); }
  if (r.nonResM2 && r.resM2 > 0 && r.nonResM2 < 400) s += 5; // winkel/werkplaats onder woning: vaak kleine eigenaar
  if (r.resM2 > 0 && !r.nonResM2 && r.adressen <= 2 && r.pot && !r.pot.transf && !r.pot.optop) {
    s -= 10; why.push('bewoond woonhuis (alleen kans via erfsplitsing)');
  }
  return clamp(s);
}

// ---------- Totaal ----------
function scoreParcel(r) {
  const s = AN.filters || {};
  const strat = s.strat || { transf: true, optop: true, inbr: true };
  const w = s.w || DEFAULT_W;
  const why = [];
  r.uitsluiting = null;
  if (r.compact < 0.12 && r.opp > 300) r.uitsluiting = 'langgerekt (weg/water/spoor)';
  else if (r.opp > 50000) r.uitsluiting = 'groter dan 5 ha';
  else if (r.bestemming && BESTEMMING_UIT.test(r.bestemming.split(' (+')[0])) r.uitsluiting = `bestemming ${r.bestemming.split(' (+')[0]}`;

  r.pot = potentie(r, strat);
  why.push(...r.pot.notes);
  const fys = fysiekScore(r.pot.totaal);
  // Precedent uit gerealiseerde projecten in de regio (referenties.js), alleen binnen het referentiegebied.
  const prec = typeof refPrecedent === 'function' ? refPrecedent(r, why) : { jur: 0, markt: 0 };
  const jur = clamp(juridischScore(r, why) + prec.jur);
  const markt = clamp(marktScore(r, why) + prec.markt);
  const verw = verwervingScore(r, why);
  r.deel = { fys, jur, markt, verw };
  const sumW = (w.fys + w.jur + w.markt + w.verw) || 1;
  let total = (fys * w.fys + jur * w.jur + markt * w.markt + verw * w.verw) / sumW;
  if (!r.pot.totaal) { total *= 0.3; why.unshift('geen woningpotentie gevonden'); }
  if (r.uitsluiting) { total *= 0.2; why.unshift(`uitgesloten: ${r.uitsluiting}`); }
  r.score = clamp(total);
  r.opbrengst = r.buurt?.woningwaarde && r.pot.totaal ? r.pot.totaal * r.buurt.woningwaarde * 1000 * 0.8 : null;
  r.why = why;
}
const fmtEuro = (v) => (v >= 1e6 ? `€${fmtNum(v / 1e6, 1)} mln` : `€${fmtNum(v / 1000)}k`);
