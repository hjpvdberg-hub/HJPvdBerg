// Cloudflare Worker die DSO-verzoeken doorstuurt en de API-sleutels toevoegt.
// Zo staan de sleutels niet in de browser. Instellen: zie proxy/README.md.
//
//   /rp/...    -> Ruimtelijke plannen opvragen v4   (secret RP_KEY)
//   /pres/...  -> Omgevingsdocumenten presenteren v8 (secret DSO_KEY)

const TARGETS = {
  rp: { base: 'https://ruimte.omgevingswet.overheid.nl/ruimtelijke-plannen/api/opvragen/v4', key: 'RP_KEY' },
  pres: { base: 'https://service.omgevingswet.overheid.nl/publiek/omgevingsdocumenten/api/presenteren/v8', key: 'DSO_KEY' },
};
const PASS_HEADERS = ['content-type', 'accept', 'content-crs', 'accept-crs'];

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, Content-Crs, Accept-Crs',
      'Access-Control-Max-Age': '3600',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (origin !== '*' && request.headers.get('Origin') !== origin) return new Response('Forbidden', { status: 403 });

    const url = new URL(request.url);
    const [, api, ...rest] = url.pathname.split('/');
    const t = TARGETS[api];
    if (!t || !['GET', 'POST'].includes(request.method)) return new Response('Not found', { status: 404, headers: cors });

    const headers = new Headers();
    PASS_HEADERS.forEach((h) => { const v = request.headers.get(h); if (v) headers.set(h, v); });
    headers.set('x-api-key', env[t.key]);

    const upstream = await fetch(`${t.base}/${rest.join('/')}${url.search}`, {
      method: request.method,
      headers,
      body: request.method === 'POST' ? await request.text() : undefined,
    });
    const out = new Response(upstream.body, upstream);
    Object.entries(cors).forEach(([k, v]) => out.headers.set(k, v));
    return out;
  },
};
