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

## Gebiedsanalyse: kansrijkheid (knop 🏗)

Gericht op kleinschalige ontwikkeling (standaard 2–10 woningen) via **transformatie**, **optoppen** en
**inbreiding**. *Analyseer* haalt alle percelen, panden en adressen in het kaartbeeld (zoom ≥ 15) of een getekend
gebied op, plus CBS-buurtcijfers en rijksmonumenten/beschermde gezichten. *Verdiepen top 60* haalt voor de beste
60 ook gebouwhoogte en bouwlagen (3D BAG), bestemming (PDOK) en, met API-sleutels, DSO-plandata op.

**Woningpotentie per perceel**
- transformatie: m² niet-wonen (BAG) ÷ 65 m² per woning
- optoppen (na verdiepen): extra lagen × footprint × 0,8 ÷ 65. Extra lagen volgen uit de toegestane bouwhoogte
  (DSO) min de huidige hoogte (3D BAG). Zonder plandata: +1 laag bij 1–2 lagen met plat dak in een stedelijke buurt (aanname).
- inbreiding: onbebouwde kavel of vrije grond ÷ 110–220 m² per woning, afhankelijk van de stedelijkheid. Niet bij stroken
  smaller dan 12 m; in landelijk gebied alleen kleine onbebouwde kavels.

**Vier deelscores (0–100), met instelbare weging**
- *Fysiek*: hoe goed de potentie past bij de gezochte omvang
- *Juridisch*: bestemming (wonen/gemengd +, kernwinkelgebied 0, agrarisch −), rijksmonument, beschermd gezicht,
  karakteristiek; met DSO: plan in ontwikkeling, vergunningen, bebouwingsruimte, bouwvlak
- *Markt*: gemiddelde woningwaarde van de buurt (CBS), stedelijkheid, afstand tot station en supermarkt
- *Verwerving*: adressen per pand (1 = waarschijnlijk één eigenaar, >10 = VvE), leegstand (BAG "buiten gebruik"),
  bouwjaar 1950–1985 +, recent gebouwd −, eigenaar al bezig (vergunning/bouw gestart) −, bewoond woonhuis −

Uitgesloten: langgerekte percelen (wegen, sloten), > 5 ha, bestemming verkeer/water/groen/natuur; rijksmonumenten
optioneel. Per perceel staan woningpotentie, een indicatieve bruto verkoopopbrengst (woningen × buurtwaarde × 0,8)
en de redenen achter de score. Sorteren kan op score, opbrengst of aantal woningen; export als CSV of GeoJSON
met alle deelscores.

Niet meegenomen: eigendom, bodem, geluid, parkeren, stikstof en bouwkosten. Gebruik de score als zeef, niet als oordeel.

## Omgevingswet / DSO-koppeling (API-sleutels nodig)

Vul onder ☰ Kaartlagen → *API-sleutels (DSO)* je gratis sleutels in (aan te vragen via
developer.omgevingswet.overheid.nl, inclusief de aparte sleutel voor Informatiehuis Ruimte). Daarna:

- **Bij een perceel:**
  - bestemmingsplan in detail: bestemming, wel/geen bouwvlak, maatvoering (bouw-/goothoogte, bebouwingspercentage);
  - plannen in ontwikkeling;
  - omgevingsplan-onderwerpen (activiteiten, gebiedsaanwijzingen, omgevingsnormen);
  - omgevingsvergunningen op het perceel en ontwerpregelingen.
- **In de gebiedsanalyse:** wordt meegenomen bij *Verdiepen top 60* (juridische score en optoppen).

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
- `search.js`: gebiedsanalyse (ophalen, filters, resultaten)
- `kansen.js`: kansrijkheidsmodel (woningpotentie, deelscores, CBS, monumenten, 3D BAG)
- `dso.js`: koppeling met de Omgevingswet-API's
- `proxy/`: optionele Cloudflare Worker die de API-sleutels server-side toevoegt
