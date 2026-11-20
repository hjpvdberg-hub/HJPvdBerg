# DSO-proxy (optioneel)

Alleen nodig als je de app publiek online zet. Voor eigen gebruik kun je de sleutels gewoon in de app
invullen (☰ Kaartlagen → API-sleutels); ze blijven dan in je eigen browser.

## Cloudflare Worker (gratis plan volstaat)

```bash
npm create cloudflare@latest dso-proxy   # kies "Hello World" worker
cp proxy/worker.js dso-proxy/src/index.js
cd dso-proxy
npx wrangler secret put RP_KEY           # sleutel Ruimtelijke plannen (Informatiehuis Ruimte)
npx wrangler secret put DSO_KEY          # DSO-sleutel (omgevingsdocumenten)
npx wrangler secret put ALLOWED_ORIGIN   # bijv. https://jouwnaam.github.io (aanrader, anders kan iedereen je proxy gebruiken)
npx wrangler deploy
```

Vul daarna de worker-URL in de app in bij *Eigen proxy*, en laat de sleutelvelden leeg.
