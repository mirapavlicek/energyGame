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
- **Zásobníky energie**: **přečerpávací elektrárna** (jen na kopci do 3 dlaždic
  od vody; 300 MWs, ±70 MW, účinnost 75 %, připojení 110 kV) a **bateriové
  úložiště** (kdekoli na pevnině; 80 MWs, ±25 MW, účinnost 90 %, připojení
  22 kV). Automaticky nabíjejí z přebytků své sítě a vybíjejí při deficitu –
  ideální na solární poledne vs. večerní špičku.
- **Regulační trafa**: k instalovanému trafu lze dokoupit přepínač odboček
  (50 % ceny trafa) a pak tok trafem řídit – **▲ přednostní tok** ho posílí,
  **▼ škrcení** ho omezí a přesměruje výkon na paralelní cesty.
- **Napojení mimo mapu**: na okrajích jsou 3 **přeshraniční předávací body**
  sousedních soustav (Bavorsko, Sasko, Rakousko…, 400 kV). Po kliknutí
  sjednáš smlouvy **oběma směry** po 10 MW (strop 120 MW): **import** je
  take-or-pay (platíš sjednaný výkon 0,075/MWs, i když ho nevyužiješ),
  **export** platí 0,050/MWs za skutečně dodané – a **nedodaný export se
  sankcionuje 0,12/MWs**. Bod musíš připojit vedením 400 kV.
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

Stejnou trasu lze **posilovat paralelními systémy**: další kliknutí na tutéž
dvojici staveb se stejnou hladinou přidá druhý (třetí, čtvrtý) systém na
společných stožárech za 70 % ceny – kapacita i vodivost se násobí, **maximum
jsou 4 systémy**. Bourání (X) odpojuje po jednom systému.

**Vedení se odstraňuje** nástrojem Zbourat (X) kliknutím přímo na linku –
vrátí 40 % ceny; vícenásobné trasy se odpojují po jednom systému.

Rozvodna napájená **z více stran si zátěž rozloží**: základní rozdělení dá
fyzika (impedance), a když se některá trasa přesto přetíží, dispečink jí
v několika iteracích „přivře kohout" a tok se přelije na paralelní cesty
s volnou kapacitou. Kde alternativa není (radiální přípojka), přetížení
zůstává a trasu je potřeba posílit.

Každá elektrárna vyrábí na svém výstupním napětí (přehrada 400 kV, uhelná
220 kV, vodní 110 kV, solár a vítr 22 kV) a vedení k ní musí mít stejnou
úroveň. **Rozvodna má od výroby jen NN (400 V) přípojnici** – aby připojila
vyšší napětí, musíš do ní koupit **trafa** (klik na rozvodnu → sekce Trafa).
Traf je osm typů podle převodu a kapacity (800⇄400 kV … 11⇄0,4 kV
distribuční); **převádí obousměrně** – 400/220 funguje i jako zvyšovací
220/400 (např. vyvedení výkonu malých zdrojů nahoru na přenosovou soustavu).
Více kusů téhož typu sčítá kapacitu a přetížené trafo hlásí varování.
Města se napájí z NN strany rozvodny.

K prodloužení trasy na stejné hladině slouží **propojovací pole**
(800/800 … 11/11): levně přidá rozvodně přípojnici dané hladiny bez
převodu, takže jde řetězit vedení přes průchozí (spínací) stanice.

Typický řetěz: vodní elektrárna (110 kV) → vedení 110 kV → rozvodna
s trafem 110/22 kV + 22/0,4 kV → město.

**Elektrárny se neřetězí napřímo** – každé vedení musí mít alespoň jeden
konec v rozvodně (výkon se vyvádí přes rozvodnu, jako v reálné soustavě).
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
- **Roční období** (rok = 12 dní, 3 dny na sezónu, plynulé přechody):
  v **zimě** je spotřeba měst ~1,2× (topení, osvětlení) a den jen ~7,5 h,
  v **létě** spotřeba klesá na ~0,8× a slunce svítí ~16,5 h se silnějším
  výkonem solárů, **jarní tání** zvedá průtoky řek (vodní elektrárny ~1,3×,
  pozdní léto naopak ~0,7×) a **podzim** přináší nejvíc větru. Průmysl je
  na sezónu citlivý zhruba z poloviny. HUD ukazuje den i sezónu.

### Správa budov

Každou elektrárnu i rozvodnu lze **kliknutím otevřít** (v režimu prohlížení)
a spravovat v panelu:

- **Technický stav** – budovy se provozem opotřebovávají a ztrácí výkon;
  pod 20 % stavu hrozí **porucha** a úplný výpadek.
- **Servis** – jednorázová oprava, cena roste se zanedbaností (a s poruchou).
- **Servisní smlouva** – paušální údržba: zařízení se **neopotřebovává ani
  neporouchá** (technici průběžně udržují a postupně spraví i stávající
  poškození), ale stojí **20 % ceny zařízení ročně** – za 5 let tedy
  zaplatíš jako za nové. U rozvodny se paušál počítá včetně traf.
  **Modernizace paušál snižuje o 15 % za úroveň** (úroveň 2 → 17 %,
  úroveň 3 → 14 % ceny ročně).
- **Palivo** (klasické elektrárny) – uhelná má sklad uhlí (240 t, při stavbě
  z poloviny plný) a spotřebovává ho podle skutečně vyrobených MWh. **Bez
  uhlí stojí!** Palivo se kupuje v panelu, nebo **smlouvou na dodávky**
  (automaticky pod 25 % zásoby, +15 % k ceně). Nízká zásoba se hlásí.
- **Modernizace** (3 úrovně) – +25 % výkonu za úroveň a pomalejší opotřebení,
  mírně vyšší provozní náklady.
- **Schéma a toky** (jen rozvodna) – živé jednopólové schéma: přípojnice po
  napěťových hladinách, u každého vedení odkud/kam a kolik MW teče, toky přes
  trafa mezi hladinami (se zatížením) a odběry měst i průmyslu.
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
| napsat `funds` | cheat: +1 000 € |
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

- **WebGL2** – celá scéna instancovaně: statický buffer terénu (~51 000 dlaždic
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
