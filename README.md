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

## Omgevingswet / DSO-koppeling (API-sleutels nodig)

Vul onder ☰ Kaartlagen → *API-sleutels (DSO)* je gratis sleutels in (aan te vragen via
developer.omgevingswet.overheid.nl, inclusief de aparte sleutel voor Informatiehuis Ruimte). Daarna:

- **Bij een perceel:**
  - bestemmingsplan in detail: bestemming, wel/geen bouwvlak, maatvoering (bouw-/goothoogte, bebouwingspercentage);
  - plannen in ontwikkeling;
  - omgevingsplan-onderwerpen (activiteiten, gebiedsaanwijzingen, omgevingsnormen);
  - omgevingsvergunningen op het perceel en ontwerpregelingen.
- **In de gebiedsanalyse:** knop *Plandata DSO (top 50)*. Haalt dit op voor de beste resultaten, voegt het toe aan
  score en export (punten voor: plan in ontwikkeling, vergunningen, toegestane bebouwing ruim boven de huidige,
  bouwhoogte ≥ 12 m).

Sleutels worden alleen in de browser opgeslagen (localStorage). Zet je de app publiek online, gebruik dan de
proxy in `proxy/` zodat de sleutels op een server staan.

Gebruikte API's: *Ruimtelijke plannen opvragen v4* en *Omgevingsdocumenten presenteren v8*.

## Wat niet open beschikbaar is

- **Eigenaar / hypotheek / koopsom**: alleen betaald via het Kadaster (per opvraging, of via een zakelijk
  abonnement/API). De app linkt naar het Kadaster.
- **WOZ-waarde**: geen officiële open API. De app linkt naar wozwaardeloket.nl.
- **Concrete normwaarden uit het omgevingsplan** (bijv. de maximale bouwhoogte als getal): de DSO-koppeling toont
  nu welke normen gelden, niet de waarden. Die zitten dieper in de regeltekst-annotaties.

## Bestanden

- `index.html`: opmaak
- `styles.css`: stijl, inclusief mobiele layout en donker thema
- `app.js`: kaart, zoeken, perceelinfo, meten, favorieten
- `search.js`: gebiedsanalyse en score
- `dso.js`: koppeling met de Omgevingswet-API's
- `proxy/`: optionele Cloudflare Worker die de API-sleutels server-side toevoegt
