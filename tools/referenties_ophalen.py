import json, ssl, urllib.request, concurrent.futures as cf, math, sys, time, os
OUT = sys.argv[1]
CTX = ssl.create_default_context(cafile='/root/.ccr/ca-bundle.crt')
BAG = 'https://api.pdok.nl/kadaster/bag/ogc/v2/collections'
C = (5.690, 51.555)  # Gemert
R = 20000
def within(lon, lat):
    dx = (lon - C[0]) * 111320 * math.cos(math.radians(C[1])); dy = (lat - C[1]) * 110574
    return math.hypot(dx, dy) <= R
BB = (5.40, 51.375, 5.98, 51.735)
def get(url, tries=8):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'Accept': 'application/json'}), context=CTX, timeout=90) as r:
                return json.load(r)
        except Exception as e:
            time.sleep(min(60, 3 * 2 ** i))
    raise RuntimeError('fail ' + url)
CACHE = os.path.join(OUT, 'cache'); os.makedirs(CACHE, exist_ok=True)
def fetch_all(url):
    # Tussenresultaat per bevraging bewaren, zodat een herstart niet opnieuw begint.
    import hashlib
    fn = os.path.join(CACHE, hashlib.md5(url.encode()).hexdigest() + '.json')
    if os.path.exists(fn): return json.load(open(fn))
    out = _fetch_all(url)
    json.dump(out, open(fn, 'w'))
    return out
def _fetch_all(url):
    out = []
    while url:
        try:
            d = get(url, tries=3)
        except RuntimeError:
            # PDOK geeft een time-out op diepe pagina's met filter; kleinere pagina's lukken wel.
            url = url.replace('limit=1000', 'limit=200')
            d = get(url)
        out += d.get('features', [])
        url = next((l['href'] for l in d.get('links', []) if l['rel'] == 'next'), None)
    return out
def tiles(n):
    x0, y0, x1, y1 = BB
    for i in range(n):
        for j in range(n):
            yield (x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * j / n, x0 + (x1 - x0) * (i + 1) / n, y0 + (y1 - y0) * (j + 1) / n)
def bbs(t): return ','.join(f'{v:.5f}' for v in t)

# 1. Nieuwe panden 2020-2026
panden = {}
def job_p(args):
    y, t = args
    return fetch_all(f'{BAG}/pand/items?f=json&limit=1000&bouwjaar={y}&bbox={bbs(t)}')
jobs = [(y, t) for y in range(2019, 2027) for t in tiles(3)]
with cf.ThreadPoolExecutor(4) as ex:
    for fs in ex.map(job_p, jobs):
        for f in fs:
            p = f['properties']
            ring = f['geometry']['coordinates'][0] if f['geometry']['type'] == 'Polygon' else f['geometry']['coordinates'][0][0]
            cx = sum(c[0] for c in ring) / len(ring); cy = sum(c[1] for c in ring) / len(ring)
            if not within(cx, cy): continue
            panden[f['id']] = {'id': p['identificatie'], 'bj': p['bouwjaar'], 'n': p.get('aantal_verblijfsobjecten'), 'doel': p.get('gebruiksdoel'), 'st': p.get('status'), 'c': [round(cx, 6), round(cy, 6)], 'ring': [[round(a, 6), round(b, 6)] for a, b in ring]}
print('nieuwe panden', len(panden), flush=True)
json.dump(panden, open(os.path.join(OUT, 'panden_nieuw.json'), 'w'))

# 2. Alle woon-VBO's (gebruiksdoel bevat woonfunctie)
vbos = []
def job_v(t):
    return fetch_all(f'{BAG}/verblijfsobject/items?f=json&limit=1000&gebruiksdoel=woonfunctie&bbox={bbs(t)}')
with cf.ThreadPoolExecutor(4) as ex:
    for k, fs in enumerate(ex.map(job_v, list(tiles(8)))):
        for f in fs:
            p = f['properties']; lon, lat = f['geometry']['coordinates'][:2]
            if not within(lon, lat): continue
            vbos.append({'id': p['identificatie'], 'opp': p.get('oppervlakte'), 'st': p.get('status'), 'doc': p.get('documentdatum'),
                         'pand': [h.rsplit('/', 1)[-1] for h in (p.get('pand.href') or [])], 'c': [round(lon, 6), round(lat, 6)],
                         'adres': f"{p.get('openbare_ruimte_naam')} {p.get('huisnummer')}{p.get('huisletter') or ''}{('-' + p['toevoeging']) if p.get('toevoeging') else ''}, {p.get('woonplaats_naam')}",
                         'gm': p.get('bronhouder_identificatie'), 'gmn': p.get('bronhouder_naam')})
        print('tegel', k, len(vbos), flush=True)
json.dump(vbos, open(os.path.join(OUT, 'vbos_woon.json'), 'w'))
print('klaar', len(vbos), flush=True)
