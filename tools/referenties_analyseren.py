import json, ssl, urllib.request, concurrent.futures as cf, math, sys, os, statistics as st, time, datetime
D = sys.argv[1]; OUTF = sys.argv[2]
CTX = ssl.create_default_context(cafile='/root/.ccr/ca-bundle.crt')
def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'Accept': 'application/json'}), context=CTX, timeout=60) as r:
                return json.load(r)
        except Exception:
            time.sleep(2 * (i + 1))
    return None
panden = json.load(open(os.path.join(D, 'panden_nieuw.json')))
vbos = json.load(open(os.path.join(D, 'vbos_woon.json')))
INGEBRUIK = lambda s: s and s.startswith('Verblijfsobject in gebruik')
seq = lambda vid: int(vid[6:]) if vid and len(vid) == 16 else None
gm = lambda vid: vid[:4]
def dist(a, b):
    return math.hypot((a[0] - b[0]) * 111320 * math.cos(math.radians(b[1])), (a[1] - b[1]) * 110574)

# --- nieuwbouw ---
nb = [v for v in vbos if any(p in panden for p in v['pand'])]
print('woon-vbo totaal', len(vbos), 'in nieuwbouw', len(nb))
# drempel per gemeente: 10e percentiel van volgnummers in panden 2021-2022
thr = {}
by_gm = {}
for v in nb:
    p = next(panden[x] for x in v['pand'] if x in panden)
    if p['bj'] in (2021, 2022) and seq(v['id']): by_gm.setdefault(gm(v['id']), []).append(seq(v['id']))
for g, arr in by_gm.items():
    arr.sort()
    if len(arr) >= 20: thr[g] = arr[int(0.1 * len(arr))]
print('drempels', len(thr))

# panden -> woningen
pw = {}
for v in nb:
    if not INGEBRUIK(v['st']): continue
    for x in v['pand']:
        if x in panden: pw.setdefault(x, []).append(v); break
# cluster panden: zelfde bouwjaar (±1), binnen 40 m
keys = list(pw)
parent = {k: k for k in keys}
def find(k):
    while parent[k] != k: parent[k] = parent[parent[k]]; k = parent[k]
    return k
grid = {}
for k in keys:
    c = panden[k]['c']; grid.setdefault((round(c[0] / 0.0006), round(c[1] / 0.0004)), []).append(k)
for k in keys:
    c = panden[k]['c']; gx, gy = round(c[0] / 0.0006), round(c[1] / 0.0004)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for o in grid.get((gx + dx, gy + dy), []):
                if o != k and abs(panden[o]['bj'] - panden[k]['bj']) <= 1 and dist(panden[o]['c'], c) <= 40:
                    parent[find(o)] = find(k)
clusters = {}
for k in keys: clusters.setdefault(find(k), []).append(k)
projects = []
for ks in clusters.values():
    w = [v for k in ks for v in pw[k]]
    n = len(w)
    if n < 2 or n > 20: continue
    app = any(len(pw[k]) >= 2 for k in ks)
    opp = [v['opp'] for v in w if v['opp']]
    cx = sum(panden[k]['c'][0] for k in ks) / len(ks); cy = sum(panden[k]['c'][1] for k in ks) / len(ks)
    projects.append({'t': 'nieuwbouw appartementen' if app else 'nieuwbouw grondgebonden', 'j': max(panden[k]['bj'] for k in ks), 'n': n,
                     'gbo': round(st.median(opp)) if opp else None, 'c': [round(cx, 6), round(cy, 6)], 'adres': w[0]['adres'], 'gm': w[0].get('gmn'),
                     'panden': [panden[k]['id'] for k in ks], 'grond': None})
print('nieuwbouwprojecten 2-20', len(projects))

# --- transformatie / splitsing ---
cand = [v for v in vbos if not any(p in panden for p in v['pand']) and INGEBRUIK(v['st']) and seq(v['id']) and gm(v['id']) in thr and seq(v['id']) > thr[gm(v['id'])]]
print('kandidaten transformatie', len(cand))
pids = sorted({v['pand'][0] for v in cand if v['pand']})
def pinfo(uuid):
    d = get(f'https://api.pdok.nl/kadaster/bag/ogc/v2/collections/pand/items/{uuid}?f=json')
    return uuid, (d or {}).get('properties')
pd = {}
with cf.ThreadPoolExecutor(12) as ex:
    for u, p in ex.map(pinfo, pids): pd[u] = p
oud = {u for u, p in pd.items() if p and p.get('bouwjaar') and p['bouwjaar'] <= 2015}
# bestaande woningen per pand (voor splitsing vs transformatie)
bestaand = {}
for v in vbos:
    if v['pand'] and v['pand'][0] in oud and seq(v['id']) and gm(v['id']) in thr and seq(v['id']) <= thr[gm(v['id'])] and INGEBRUIK(v['st']):
        bestaand[v['pand'][0]] = bestaand.get(v['pand'][0], 0) + 1
grp = {}
for v in cand:
    if v['pand'] and v['pand'][0] in oud: grp.setdefault(v['pand'][0], []).append(v)
nt = 0
for u, w in grp.items():
    n = len(w)
    if n < 2 or n > 20: continue
    opp = [v['opp'] for v in w if v['opp']]
    cx = sum(v['c'][0] for v in w) / n; cy = sum(v['c'][1] for v in w) / n
    projects.append({'t': 'woningsplitsing' if bestaand.get(u) else 'transformatie', 'j': None, 'n': n, 'gbo': round(st.median(opp)) if opp else None,
                     'c': [round(cx, 6), round(cy, 6)], 'adres': w[0]['adres'], 'gm': w[0].get('gmn'), 'panden': [pd[u]['identificatie']],
                     'pandBj': pd[u]['bouwjaar'], 'pandDoel': pd[u].get('gebruiksdoel')})
    nt += 1
print('transformatie/splitsing 2-20', nt)

# --- 3D BAG: lagen voor appartementen en transformaties ---
def h3d(pid):
    d = get(f'https://api.3dbag.nl/collections/pand/items/NL.IMBAG.Pand.{pid}')
    try:
        a = d['feature']['CityObjects'][f'NL.IMBAG.Pand.{pid}']['attributes']
        h = a['b3_h_dak_70p'] - (a.get('b3_h_maaiveld') or 0)
        return pid, (round(h, 1), a.get('b3_bouwlagen') or max(1, round(h / 3.1)))
    except Exception:
        return pid, None
need = [p for p in projects if p['t'] != 'nieuwbouw grondgebonden']
ids = sorted({p['panden'][0] for p in need})
hs = {}
with cf.ThreadPoolExecutor(8) as ex:
    for pid, v in ex.map(h3d, ids): hs[pid] = v
for p in need:
    v = hs.get(p['panden'][0])
    if v: p['h'], p['lagen'] = v

# --- samenvatting ---
def med(xs):
    xs = [x for x in xs if x is not None]
    return round(st.median(xs), 1) if xs else None
stats = {}
for t in sorted({p['t'] for p in projects}):
    ps = [p for p in projects if p['t'] == t]
    stats[t] = {'aantal': len(ps), 'woningen_mediaan': med([p['n'] for p in ps]), 'woningen_totaal': sum(p['n'] for p in ps),
                'gbo_mediaan': med([p['gbo'] for p in ps]), 'lagen_mediaan': med([p.get('lagen') for p in ps]),
                'hoogte_mediaan': med([p.get('h') for p in ps])}
per_gm = {}
for p in projects:
    per_gm.setdefault(p['gm'] or '?', {}).setdefault(p['t'], 0); per_gm[p['gm'] or '?'][p['t']] += 1
out = {'meta': {'gebied': 'Gemert-Bakel, straal 20 km', 'centrum': [5.690, 51.555], 'straal_m': 20000, 'periode': '±2019–2026 (bouwjaar) / volgnummer na ±2020 (transformatie)',
                'woningen': '2–20 per project', 'gegenereerd': datetime.date.today().isoformat(), 'stats': stats, 'per_gemeente': per_gm},
       'p': [[p['t'], p['j'] or p.get('pandBj'), p['n'], p['gbo'], p['c'][0], p['c'][1], p['adres'], p.get('lagen'), p.get('h'), p['gm']] for p in projects]}
json.dump(out, open(OUTF, 'w'), ensure_ascii=False, separators=(',', ':'))
print(json.dumps(stats, indent=1, ensure_ascii=False))
print(json.dumps(per_gm, ensure_ascii=False))
