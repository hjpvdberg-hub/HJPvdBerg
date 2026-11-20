# Referentieprojecten genereren

`referenties.json` bevat kleinschalige woningbouwprojecten (2–20 woningen) die in de afgelopen ±5 jaar zijn
gerealiseerd binnen 20 km van Gemert-Bakel. De app gebruikt dit als kaartlaag, als precedent in de
beoordeling en voor het kental woninggrootte.

## Opnieuw maken

```bash
mkdir -p /tmp/ref
python3 tools/referenties_ophalen.py /tmp/ref            # ±10–20 min, haalt BAG-data op via PDOK
python3 tools/referenties_analyseren.py /tmp/ref referenties.json
```

Een andere regio: pas `C` (middelpunt), `R` (straal) en `BB` (omsluitende bbox) aan in `referenties_ophalen.py`
en `centrum`/`gebied` in `referenties_analyseren.py`. Buiten het referentiegebied doet de referentiedata niets.

## Methode

- **Nieuwbouw:** panden met bouwjaar 2019–2026 (BAG) binnen de straal. Woningen = verblijfsobjecten met
  woonfunctie en status "in gebruik". Panden met hetzelfde bouwjaar (±1) binnen 40 m worden één project.
  Type *appartementen* als minstens één pand 2 of meer woningen heeft, anders *grondgebonden*.
- **Transformatie/splitsing:** woningen in bestaande panden (bouwjaar ≤ 2015) waarvan het BAG-volgnummer
  hoger is dan het 10e percentiel van de volgnummers in nieuwbouw van 2021–2022 in dezelfde gemeente, dus
  ruwweg aangemaakt na 2020. *Splitsing* als het pand daarvoor al woningen had, anders *transformatie*.
- Alleen projecten met 2 tot en met 20 woningen.
- Hoogte en bouwlagen uit 3D BAG voor appartementen en transformaties.

## Beperkingen

- De volgnummer-methode is een benadering: correcties in de BAG kunnen ten onrechte als transformatie tellen,
  en het jaartal van een transformatie is niet bekend (alleen het bouwjaar van het pand).
- Verkoopprijzen staan niet in open data; de referenties zeggen iets over wat vergund en gebouwd is, niet
  over wat het opbracht.
