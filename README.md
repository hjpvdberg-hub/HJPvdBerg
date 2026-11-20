# Perceelkaart

Webapp om kadastrale percelen in Nederland te bekijken, vergelijkbaar met apps als *Kadastrale Kaart Max*.
Draait volledig in de browser op open data van PDOK. Geen backend, geen API-sleutels.

## Starten

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Of zet de bestanden op een statische host (GitHub Pages, Netlify, enz.).

## Functies

| Functie | Bron |
|---|---|
| Zoeken op adres, postcode, straat, plaats, perceel (bijv. `Aalten K 1234`) | PDOK Locatieserver |
| Kadastrale grenzen en perceelnummers (vanaf zoom 16) | BRK Kadastrale kaart (WMS) |
| Perceelinfo: aanduiding, kadastrale grootte, berekende oppervlakte en omtrek, status | BRK Kadastrale kaart (OGC API) |
| Adressen op het perceel: gebruiksdoel, oppervlakte, status | BAG verblijfsobjecten |
| Gebouwen op het perceel: bouwjaar, gebruiksdoel, status, footprint | BAG panden |
| Bestemmingsplan op het aangeklikte punt, met link naar de regels | Ruimtelijke plannen (WMS GetFeatureInfo) |
| Kaartlagen: topografisch, grijs, luchtfoto, bestemmingsplan, bouwvlakken, AHN-hoogte, beschermde gebieden | PDOK WMTS/WMS |
| Afstand en oppervlakte meten | lokaal berekend |
| GPS-locatie, deellink (`#lat,lon,zoom`) | browser |
| Favorieten met notitie, export als GeoJSON; perceel downloaden als GeoJSON | localStorage |

## Wat niet open beschikbaar is

- **Eigenaar / hypotheek / koopsom**: alleen betaald via het Kadaster (per opvraging, of via een zakelijk
  abonnement/API). De app linkt naar het Kadaster.
- **WOZ-waarde**: geen officiële open API. De app linkt naar wozwaardeloket.nl.
- **Omgevingsplan (Omgevingswet)**: de DSO-API vereist een API-sleutel. Nu worden alleen de Wro-bestemmingsplannen
  getoond, plus een link naar het Omgevingsloket.

## Bestanden

- `index.html`: opmaak
- `styles.css`: stijl, inclusief mobiele layout en donker thema
- `app.js`: alle logica (kaart, zoeken, opvragen, meten, favorieten)
