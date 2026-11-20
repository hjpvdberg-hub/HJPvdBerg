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

## Gebiedsanalyse: (her)ontwikkelkansen (knop 🏗)

Haalt alle percelen, panden en verblijfsobjecten op in het kaartbeeld (zoom ≥ 15) of in een getekend gebied
(maximaal 8000 objecten per bron), koppelt ze per perceel en filtert:

- perceeloppervlakte min/max; langgerekte percelen (wegen, sloten, spoor) uitsluiten
- onbebouwd / bebouwd, maximale bebouwingsgraad, minimale grond per adres
- bouwjaar van het oudste pand (vóór / na), aantal adressen
- gebruiksdoel: bevat één van / alleen / geen van (bijv. "geen woonfunctie" voor transformatie)
- BAG-signalen: pand of verblijfsobject buiten gebruik, sloopvergunning, bouwvergunning, verbouwing
- minimale ontwikkelscore (0–100)
- bestemming (Wro-plan) ophalen voor de top 100, daarna filteren op tekst (bijv. "bedrijf")

Filters werken direct op de opgehaalde gegevens. Resultaten worden op de kaart gekleurd naar score,
gesorteerd weergegeven met de redenen voor de score, en zijn te exporteren als CSV (Excel) of GeoJSON.

De score is een zeef, geen oordeel. Ze houdt geen rekening met eigendom, erfpacht, monumentstatus, milieu,
geluid of de markt. Heel grote percelen (>5 ha) en percelen met bestemming verkeer, water of groen krijgen minder punten.

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
