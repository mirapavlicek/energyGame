# ⚡ EnergyGame

Budovatelská strategie o stavbě energetické sítě. Běží čistě v prohlížeči,
2D izometrie vykreslovaná přes **WebGL2** s instancovaným renderováním
(terén, budovy i animovaná vedení se kreslí na GPU).

**[▶ Hrát](https://mirapavlicek.github.io/energyGame/)** (po zapnutí GitHub Pages)

## Princip hry

- Mapa je **náhodně generovaná** (fraktální šum): jezera, louky, lesy, kopce,
  hory a **řeky** s reálným průtokem, které pramení v horách a stékají po spádu.
- **Vodní elektrárnu** postavíš **jen na řece** – výkon roste s průtokem.
- **Přehrada** (také jen na řece) zaplaví údolí proti proudu, dá velký stabilní
  výkon a **posílí průtok** po proudu – vodní elektrárny níže pak vyrábí víc.
- Dále: uhelná elektrárna (stabilní, drahý provoz), solární park (jen ve dne),
  větrné turbíny (kolísají s větrem, na kopcích víc).
- Města napájíš přes **rozvodny** (dosah 6 dlaždic) a vše spojuješ **vedením**.
- **Toky v síti** se počítají zjednodušeným DC power-flow modelem – energie si
  sama najde cesty, delší vedení „klade větší odpor". Přetížené trasy červeně
  blikají a chtějí paralelní posilu nebo vyšší napěťovou hladinu.
- Model **splňuje Kirchhoffovy zákony**: toky se řeší z uzlových potenciálů
  (L·θ = P), takže v každé přípojnici platí bilance výroba − spotřeba = odtok
  (1. zákon) a součet úbytků po libovolné smyčce je nulový (2. zákon) – i přes
  trafa mezi napěťovými hladinami. Smoke test to numericky ověřuje.
- **Ztráty na vedení**: každé vedení ztrácí výkon kvadraticky s tokem (I²R),
  úměrně délce a nepřímo úměrně napěťové hladině – dálkový přenos po 22 kV je
  několikanásobně ztrátovější než po 110 kV. Ztráty musí pokrýt výroba navíc
  nad spotřebu měst (řeší se dvoufázově, bilance zůstává přesná) a HUD je
  průběžně zobrazuje.

### Napěťové úrovně a trafa

Vedení existuje v sedmi napěťových úrovních – liší se kapacitou, cenou za
dlaždici a maximální délkou:

| Úroveň | Kapacita | Cena/dl | Max. délka | Ztráty/dl¹ |
| --- | --- | --- | --- | --- |
| VVN 800 kV | 800 MW | 34 | 60 | 0,16 % |
| VVN 400 kV | 400 MW | 20 | 48 | 0,20 % |
| VVN 220 kV | 200 MW | 11 | 36 | 0,26 % |
| VVN 110 kV | 80 MW | 6 | 28 | 0,34 % |
| VN 22 kV | 30 MW | 3 | 14 | 0,60 % |
| VN 11 kV | 14 MW | 2 | 10 | 0,80 % |
| NN 400 V | 5 MW | 1 | 5 | 1,20 % |

¹ při plném zatížení; ztráta roste kvadraticky s tokem (I²R).

Každá elektrárna vyrábí na svém výstupním napětí (přehrada 400 kV, uhelná
220 kV, vodní 110 kV, solár a vítr 22 kV) a vedení k ní musí mít stejnou
úroveň. **Rozvodna má od výroby jen NN (400 V) přípojnici** – aby připojila
vyšší napětí, musíš do ní koupit **trafa** (klik na rozvodnu → sekce Trafa).
Traf je osm typů podle převodu a kapacity (800/400 kV … 11/0,4 kV
distribuční); více kusů téhož typu sčítá kapacitu a přetížené trafo hlásí
varování. Města se napájí z NN strany rozvodny.

Typický řetěz: vodní elektrárna (110 kV) → vedení 110 kV → rozvodna
s trafem 110/22 kV + 22/0,4 kV → město.
- **Každé město má vlastní potřebu**: charakter (obytné / smíšené / průmyslové)
  určuje spotřebu na obyvatele i denní profil odběru – obytná města mají ranní
  a večerní špičku, průmyslová jedou přes den naplno a v noci v útlumu.
- Napájená a spokojená města **pomalu rostou** – přibývají obyvatelé i domy
  na mapě (čím větší město, tím pomalejší růst); při výpadcích se lidé stěhují
  pryč a zástavba se zmenšuje. Za dodanou energii města platí.
- **Průmysl je samostatný prvek**: na mapě se generují podniky (důl u kopců,
  chemička u řeky, pila u lesa, jinde huť) s velkou vlastní spotřebou 8–48 MW.
  Huť a chemička jedou nepřetržitě, důl a pila na denní směny. Průmysl se
  **napájí z VN přípojnice** (22 nebo 11 kV) rozvodny v dosahu – rozvodna bez
  VN trafa ho nenapojí – a platí o **40 % víc** za MWh než města. Podnik bez
  proudu stojí a hlásí odstávku.
- Den/noc cyklus ovlivňuje poptávku i výrobu (slunce, vítr).

### Správa budov

Každou elektrárnu i rozvodnu lze **kliknutím otevřít** (v režimu prohlížení)
a spravovat v panelu:

- **Technický stav** – budovy se provozem opotřebovávají a ztrácí výkon;
  pod 20 % stavu hrozí **porucha** a úplný výpadek.
- **Servis** – jednorázová oprava, cena roste se zanedbaností (a s poruchou).
- **Servisní smlouva** – technici vyjíždějí automaticky (pod 50 % stavu nebo
  při poruše) za přirážku 20 %.
- **Modernizace** (3 úrovně) – +25 % výkonu za úroveň a pomalejší opotřebení,
  mírně vyšší provozní náklady.
- **Trafa** (jen rozvodna) – nákup transformátorů podle typu a kapacity,
  zobrazuje se jejich aktuální zatížení.
- **Větší dosah NN distribuce** (jen rozvodna) – +2 dlaždice za úroveň.
- **Zbourat** – vrátí 40 % ceny včetně traf (přehradu zbourat nejde).

## Ovládání

| Vstup | Akce |
| --- | --- |
| tažení myší | posun kamery |
| kolečko | zoom ke kurzoru |
| klik na budovu | panel správy (servis, smlouva, modernizace, trafa…) |
| `7` opakovaně | přepínání napěťové úrovně vedení |
| `1`–`6` | stavby (vodní, přehrada, uhelná, solár, vítr, rozvodna) |
| `7` | vedení – klikej z budovy na budovu (řetězí se) |
| `Q` / `Esc` | režim prohlížení |
| `X` | bourání (budovy i vedení) |
| mezerník | pauza |
| `+` / `−` | rychlost hry |
| klik na minimapu | přesun kamery |

## Spuštění lokálně

Žádný build, žádné závislosti:

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

Konkrétní mapu lze sdílet přes URL: `index.html?seed=123456`.

## Technika

- **WebGL2** – celá scéna instancovaně: statický buffer terénu (25 600 dlaždic
  nahraných jednou), dynamický buffer budov/kurzorů, vedení jako instancované
  segmenty s animovanými „pakety" energie ve fragment shaderu.
- **Sprite atlas** se generuje procedurálně do canvasu při startu – repozitář
  neobsahuje žádné binární assety.
- Deterministický RNG (mulberry32) + hodnotový fBm šum pro terén.
- Čistý vanilla JS (ES2020), bez frameworků a bez build kroku.

## Struktura

```
index.html      – vstupní stránka + UI
style.css       – vzhled HUD
js/rng.js       – seedovaný RNG a šum
js/map.js       – generátor mapy (terén, řeky, města)
js/atlas.js     – procedurální sprite atlas
js/renderer.js  – WebGL2 izometrický renderer
js/sim.js       – simulace sítě (DC power flow, ekonomika, města)
js/game.js      – herní smyčka, vstup, HUD, minimapa
```
