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
  větrné turbíny (rozmarné – viz níže).
- **Vítr je nejrozmarnější zdroj v hře.** Rychlost větru se losuje
  z Weibullova rozdělení (k = 2) přes tři časové škály povětrnostní situace
  a turbína z ní vyrábí podle **skutečné výkonové křivky**: pod rozběhovou
  rychlostí **3,5 m/s rotor stojí**, mezi rozběhovou a jmenovitou roste výkon
  s **třetí mocninou rychlosti**, od **12 m/s** dává štítkový výkon a nad
  **25 m/s se bezpečnostně odstaví** (a rozjede se až pod 18 m/s). Terén mění
  místní rychlost – na kopcích fouká o 26 % víc, v lese o 24 % méně.
  Výsledkem je roční využití jen **~31 %**: turbíny **14 % času úplně stojí**
  a jen 10 % času jedou na plno. Navíc občas přijde **bezvětří** (tlaková
  výše, nejčastěji v zimě), kdy se zastaví všechny. Aktuální rychlost i důvod,
  proč turbína stojí, ukazuje HUD a panel turbíny. **Větrník na vodě** má nad
  hladinou silnější a vytrvalejší vítr, takže vyrobí přibližně dvojnásobek.
- **Zásobníky energie** – protože na vítr se spolehnout nedá:
  **přečerpávací elektrárna** (jen na kopci do 3 dlaždic od vody; 300 MW·s,
  ±70 MW, účinnost 75 %, připojení 110 kV), **bateriové úložiště** (kdekoli
  na pevnině; 80 MW·s, ±25 MW, účinnost 90 %, 22 kV) a **velké bateriové
  úložiště** (700 MW·s, ±140 MW, účinnost 94 %). Automaticky nabíjejí
  z přebytků své sítě a vybíjejí při deficitu – ideální na solární poledne
  vs. večerní špičku i na přečkání bezvětří.
- **Velké úložiště jede na stejnosměrných 500 V**, jak to u bateriových
  kontejnerů skutečně bývá: připojuje se přímo na přípojnici **DC 500 V**
  a do střídavé sítě ho převede **měnírna 22 kV/500 V DC** v rozvodně.
  Na střídavou hladinu ho napojit nelze. Nízké napětí znamená obrovské
  proudy, takže DC vedení unese jen **3 dlaždice** a má vysoké ztráty –
  úložiště patří hned k rozvodně. Zato stejnosměrná hladina nemá jalový
  výkon, takže ji netrápí kompenzace.
- **Tesla Power Grid** je vrchol téhle větve: bateriová farma na ploše
  **10×10 dlaždic** za **30 000**, s kapacitou **18 000 MW·s** (15× vodíkové
  úložiště), výkonem **±400 MW** a účinností 95 %. Je to jediná víceplošná
  stavba ve hře – potřebuje sto dlaždic rovinatého terénu, náhled pod
  kurzorem rovnou ukáže, které dlaždice nevyhovují. Tisíce paralelních
  bloků sdílí přípojnici **DC 1500 V**, která unese plný výkon farmy
  (500 MW, max 6 dlaždic), a do sítě ji vyvede **měnírna 400 kV/1500 V DC**.
  Strategická rezerva, která pokryje i několik dní bezvětří.
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

Vedení existuje v deseti napěťových úrovních – liší se kapacitou, cenou za
dlaždici a maximální délkou:

| Úroveň | Kapacita | Cena/dl | Max. délka | Ztráty/dl¹ |
| --- | --- | --- | --- | --- |
| VVN 800 kV | 800 MW | 34 | 60 | 0,16 % |
| HVDC 500 kV | 500 MW | 28 | 200 | 0,06 % |
| VVN 400 kV | 400 MW | 20 | 48 | 0,20 % |
| VVN 220 kV | 200 MW | 11 | 36 | 0,26 % |
| VVN 110 kV | 80 MW | 6 | 28 | 0,34 % |
| VN 22 kV | 30 MW | 3 | 14 | 0,60 % |
| VN 11 kV | 14 MW | 2 | 10 | 0,80 % |
| DC 1500 V | 500 MW | 9 | 6 | 0,35 % |
| DC 500 V | 150 MW | 4 | 3 | 1,10 % |
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

**HVDC 500 kV**: stejnosměrná spojka pro extrémní vzdálenosti (až 200
dlaždic, 500 MW, minimální ztráty) – na obou koncích potřebuje drahou
**měnírnu** (HVDC 500/400). **DC 500 V** a **DC 1500 V** jsou naopak
stejnosměrné přípojnice bateriových úložišť: krátké (3 a 6 dlaždic), ale
s velkou kapacitou a bez jalového výkonu; do střídavé sítě je propojí
**měnírna 22 kV/500 V DC**, resp. **400 kV/1500 V DC**.
**Podzemní kabel** (přepínač v paletě vedení)
stojí 2,5×, ale odolá bouřkám, má nižší ztráty a netrpí na jalový výkon.
Dlouhá střídavá vedení (přes 60 % max. délky) bez **kompenzace jalového
výkonu** v rozvodně ztrácí 20 % kapacity. Každá rozvodna má omezený počet
**polí** (vývodů: 6 + 3 za úroveň modernizace) a HUD nabízí **N-1 analýzu**
(kritická vedení bez zálohy blikají) i ukazatel „frekvence" soustavy.

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
- **Městská elektrická doprava**: do každého města jde koupit **trolejbusy**
  (od 8 tis. obyvatel, 600 V DC), **tramvaje** (od 18 tis., 750 V DC) a
  **metro** (od 40 tis., 750 V DC) – vždy jen v tomhle pořadí, protože bez
  páteřní sítě se dražší systém nezaplatí. Podrobnosti níž.
- **Železnice**: mapu protínají koridory spojující vzdálená města; podél
  tratí stojí **trakční napájecí stanice** (14–28 MW) – napájí se výhradně
  ze **110kV přípojnice** rozvodny v dosahu a jejich odběr **pulzuje
  s projíždějícími vlaky** (v noci útlum grafikonu). Na trati se nedá stavět.
- **Průmysl je samostatný prvek**: na mapě se generují podniky (důl u kopců,
  chemička u řeky, pila u lesa, ocelárna 45–70 MW, jinde huť) s velkou
  vlastní spotřebou 8–70 MW.
  Huť a chemička jedou nepřetržitě, důl a pila na denní směny. Průmysl se
  **napájí z VN přípojnice** (22 nebo 11 kV) rozvodny v dosahu – rozvodna bez
  VN trafa ho nenapojí – a platí o **40 % víc** za MWh než města. Podnik bez
  proudu stojí a hlásí odstávku.
- Den/noc cyklus ovlivňuje poptávku i výrobu (slunce, vítr).
- **Suché a mokré roky**: každý rok má vlastní hydrologii (průtoky ±25 %),
  hlásí ji novoroční předpověď – v suchém roce se bez záloh neobejdeš.
- Manuál vpravo nahoře jde schovat (×) a vrátit tlačítkem `?`.
- Další plánovaná rozšíření: viz [ROADMAP.md](ROADMAP.md).
- **iPhone**: hra funguje jako PWA (Přidat na plochu) a v repu je hotový
  nativní Xcode projekt (Capacitor) – postup v [IOS.md](IOS.md).
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
  uhlí stojí!** Palivo se kupuje v panelu, nebo **smlouvou na dodávky** –
  ta dokupuje sama: první dodávka hned s podpisem, další vždy při poklesu
  pod 50 % zásoby (+15 % k ceně). Nízká zásoba se hlásí.
- **Modernizace** (3 úrovně) – +25 % výkonu za úroveň a pomalejší opotřebení,
  mírně vyšší provozní náklady.
- **Schéma a toky** (jen rozvodna) – živé jednopólové schéma: přípojnice po
  napěťových hladinách, u každého vedení odkud/kam a kolik MW teče, toky přes
  trafa mezi hladinami (se zatížením) a odběry měst i průmyslu.
- **Trafa** (jen rozvodna) – nákup transformátorů podle typu a kapacity,
  zobrazuje se jejich aktuální zatížení.
- **Větší dosah NN distribuce** (jen rozvodna) – +2 dlaždice za úroveň.
- **Zbourat** – vrátí 40 % ceny včetně traf (přehradu zbourat nejde).

### Městská elektrická doprava

**Klikni na město** (v režimu prohlížení) a otevře se jeho panel: obyvatelstvo,
odběr, napájení, spokojenost a nabídka dopravních systémů. Historicky stavěly
tramvajové dráhy právě elektrárenské společnosti – trakce jim dělala odbyt
mimo večerní světelnou špičku – a ve hře to funguje stejně: zaplatíš stavbu
a získáš stálého odběratele, tržby z jízdného a atraktivnější město.

| Systém | Cena od | Od velikosti | Trakce | Rekuperace | Špička |
| --- | --- | --- | --- | --- | --- |
| 🚎 Trolejbusy | 420 | 8 tis. | 600 V DC | 15 % | 0,08 MW/tis. |
| 🚊 Tramvaje | 1 500 | 18 tis. | 750 V DC | 25 % | 0,18 MW/tis. |
| 🚇 Metro | 9 000 | 40 tis. | 750 V DC | 35 % | 0,30 MW/tis. |

- **Systémy na sebe navazují** – metro chce nejdřív tramvaje, tramvaje
  nejdřív trolejbusy. Cena roste s velikostí města (delší síť).
- **Trakční měnírna visí na vysokém napětí**, ne na domovní síti: město
  musí mít v dosahu rozvodnu s **VN přípojnicí (22 nebo 11 kV)**. Samotné
  NN na trakci nestačí – nejdřív tedy pořádná rozvodna, pak tramvaj.
- **Vlastní denní profil**: trakce má přepravní špičky kolem 7:00 a 16:00,
  mezi nimi sedlo a v noci vozovnu. Odpolední špička přichází dřív než
  domácí večerní, takže trakce zátěž spíš rozprostírá.
- **Rekuperace**: brzdící vozy vracejí energii zpět do troleje – metro
  brzdí do každé stanice, proto ušetří nejvíc.
- **V noci**: metro nejezdí vůbec, tramvaje a trolejbusy jedou noční linky.
- **Výpadek zastaví MHD** – když město spadne pod 50 % dodávky, vozy zůstanou
  ve vozovně, přestane téct jízdné a cestující jsou nespokojenější než
  z obyčejného zhasnutí. Panel i seznam objektů to hlásí.
- **Odměna**: kromě jízdného město rychleji roste (+15/25/40 %) a unese víc
  obyvatel (strop 60 + 4/8/16). Provoz dopravního podniku se ale platí pořád,
  i když se zrovna nejezdí.

### Daně a poplatky

Na **Silvestra** (rok = 12 herních dní) přijde daňové přiznání za uplynulý
rok. HUD ukazuje 🧾 rozjetý hospodářský výsledek a v popisku i odhad odvodů.

- **Daň z příjmu 21 %** ze zisku sníženého o odpisy.
- **Odpisy 5 % hodnoty majetku ročně** (rovnoměrně, 20 let) daňový základ
  snižují – investice se tedy vyplatí i daňově.
- **Daňová ztráta** ze ztrátového roku se přenáší a jde ji uplatnit
  v následujících **5 letech**.
- **Daň z majetku 0,8 %** z hodnoty staveb, traf a vedení.
- **Licenční poplatky** regulátora: paušál 40 € + 12 € za každou výrobnu.
- **Windfall daň 60 %** z části základu, která přesáhne **1,5násobek průměru
  posledních čtyř let** – kdo roste postupně, nezaplatí nic; kdo jednorázově
  vystřelí, přispěje. Expertní režim má práh níž.
- **Zálohy na daň** se platí průběžně celý rok podle loňské povinnosti,
  na Silvestra se doúčtuje jen rozdíl (přeplatek se vrací). První rok
  žádné zálohy nejsou, takže přijde celá částka najednou.
- Kdyby na odvody nezbylo, **nedoplatek pokryje provozní úvěr** – hra tě
  nepošle rovnou do bankrotu, ale dluh začne nabíhat úroky.

## Ovládání

| Vstup | Akce |
| --- | --- |
| tažení myší | posun kamery |
| kolečko | zoom ke kurzoru |
| klik na budovu | panel správy (servis, smlouva, modernizace, trafa…) |
| klik na město | panel města (trolejbusy, tramvaje, metro) |
| `7` opakovaně | přepínání napěťové úrovně vedení |
| napsat `funds` | cheat: +1 000 € |
| `Ctrl+Z` | vrátit poslední stavbu/vedení (plná vratka) |
| `P` | fotorežim (schová UI) |
| ✨ v HUD | kvalita grafiky (bloom, třpyt hladiny, vyhlazení hran) |
| 🌍 v HUD | mapa podle skutečné krajiny (odkaz z Google Map / OSM) |
| klik na hlášku v logu | skok kamerou na místo (`[x,y]`) |

**Vedení stárne** provozem (klik na linku v režimu prohlížení otevře jeho
panel se stavem, servisem a odpojením; smlouva rozvodny na konci trasy ho
udržuje). **Tepelné zdroje po odstávce chladnou** a najíždí pozvolna (plyn
6 s, uhlí 30 s, jádro 90 s) – po blackoutu se hodí baterie nebo voda na
nastartování. Scénáře s cíli: `?scenario=1` (Elektrifikace), `2` (Zbohatni),
`3` (Zelená síť). Hra jde ovládat i dotykem (tažení, pinch zoom, ťuknutí).

**Plánovací režim** (📐 nebo `B`): hra se zastaví a stavíš na zkoušku ve
stínové kopii – vidíš průběžnou cenu plánu a zaplatíš až po potvrzení
(zrušení nic nestojí). **Replay** (🎬): simulace je deterministická a
zaznamenává akce, takže jde celá seance přehrát od začátku 8× rychle.
N-1 analýza počítá ve **Web Workeru**, ať se render nezasekne.

HUD navíc nabízí: 📋 seznam objektů s filtrem (včetně měst a jejich MHD),
🗺 mapové vrstvy (dosahy rozvoden / zatížení vedení),
📈 grafy výroby, dodávky, ztrát a spotové ceny, 💾/📂 uložení a načtení hry,
💳 úvěr a splátky, N-1 analýzu, 🗓 výzvu dne (společný seed z data) a rekord
na seed. Achievementy se hlásí v logu. Režimy: `?mode=sandbox` (neomezené
peníze) a `?mode=expert` (méně peněz, rychlejší opotřebení, dvojité sankce);
při −2 000 € přijde bankrot a konec hry.
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

## Mapa podle skutečné krajiny

Tlačítko 🌍 v HUD postaví hrací plochu podle opravdového místa na Zemi.
Otevři si ho v Google Mapách, zkopíruj odkaz z adresního řádku a vlož ho
do dialogu – stačí, aby v adrese bylo `@šířka,délka` (zkrácený odkaz
`maps.app.goo.gl` nejdřív rozklikni). Vzít jde i odkaz z OpenStreetMap
(`#map=…`) nebo rovnou souřadnice `50.0755, 14.4378`.

**Z Google Map se bere jen poloha.** Jejich licence odvozování dat
zakazuje a API navíc chce klíč, takže samotnou krajinu staví
**OpenStreetMap** přes Overpass API:

| Ve hře | Z čeho |
| --- | --- |
| jezera, přehrady, břehy velkých řek | `natural=water`, `landuse=reservoir` |
| koryta řek s průtokem a směrem toku | `waterway=river`, `canal` |
| města se skutečnými jmény a velikostí | `place=city/town/village` + `population` |
| lesy | `landuse=forest`, `natural=wood` |
| podniky | `landuse=industrial` (typ podle okolní krajiny) |
| železniční koridory a trakční stanice | `railway=rail` s `usage=main/branch` |
| kopce a hory | skutečný model terénu (AWS Terrain Tiles) |

- **Výškopis** se stahuje jako dlaždice Terrarium a měří se podle
  místního převýšení: rovina zůstane rovinou, pahorkatina dostane kopce
  na hřbetech a hornatý kraj i hory. Praha tak vyjde bez jediné hory,
  Innsbruck s 13 % horských dlaždic. Když se model nestáhne, výšky se
  odhadnou z odstupu od vody (údolí u řek, kopce na rozvodích).
- **Počet obyvatel** se komprimuje logaritmicky, aby se milionové město
  a vesnice vešly do hratelných 4–58 tisíc.
- **Dogeneruje se, co v datech není**: geotermální pole, přeshraniční
  body, a když v území nejsou žádné tratě, spojnice dvou nejvzdálenějších
  měst. V úplné pustině přibude i pár smyšlených sídel, ať je co napájet.
- Velikost území je 12 až 90 km. Větší území znamená víc dat (25 km kolem
  Prahy je asi 2 MB po kompresi) a hrubší měřítko – při 25 km připadá na
  dlaždici zhruba 78 metrů.
- Uložená hra si importovanou krajinu i výškopis pamatuje.

Data © přispěvatelé [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL).

## Grafika

Renderer stojí na WebGL2 a snaží se nechat práci na grafické kartě, ne na
procesoru. Tlačítko ✨ v HUD přepíná mezi **vysokou a nízkou kvalitou**
(volba se pamatuje); v HUD je taky ukazatel 🎞 snímků za sekundu, jehož
popisek prozradí, kolik dlaždic terénu se z mapy opravdu kreslí.

- **Ořez terénu.** Mapa má přes 100 000 dlaždic, ale do bufferu jsou uložené
  po diagonálách (x+y), takže viditelný výřez je vždycky souvislý úsek –
  a uvnitř diagonály navíc klesá vodorovná souřadnice, takže i vodorovné
  okno je souvislé. Místo celé mapy se tak kreslí řádově tisíc dlaždic.
  Stejně se ořezávají i segmenty vedení, aby železniční koridory přes celou
  mapu nezatěžovaly GPU mimo obraz.
- **Denní světlo řeší shader.** Poledne je skoro bílé, svítání a soumrak
  táhnou do oranžova, noc je tmavě modrá a odbarvená (oko za šera barvy
  nerozezná), bouřka sebere jas i kontrast. Dřív to byla poloprůhledná
  plachta přes celý obraz – teď se tónuje jen scéna, ne UI.
- **Světla v noci.** Napájená města, provozy a běžící stroje se rozsvěcí
  aditivní vrstvou záře; zhasnuté město zůstane tmavé.
- **Bloom.** Ve vysoké kvalitě jde obraz přes framebuffer: jasné pixely se
  vytáhnou prahem, rozmažou separabilním gaussem ve čtvrtinovém rozlišení
  a přičtou zpět. Rozzáří to noční okna i energetické pakety ve vedení.
- **Vyhlazení hran** multisamplovaným framebufferem (4× vzorky, pokud je
  karta umí) – bez něj by šikmá vedení kostrbatila.
- **Třpyt hladiny** počítají dvě interferující vlny ve fragment shaderu,
  žádná animovaná textura.
- **Strop DPR na 2** – na telefonu s trojnásobným displejem by se jinak
  počítalo devětkrát víc pixelů, než je vidět.

## Technika

- **WebGL2** – celá scéna instancovaně: statický buffer terénu (~104 000 dlaždic
  nahraných jednou, kreslí se z něj jen viditelný výřez), dynamický buffer
  budov/kurzorů, aditivní vrstva záře a vedení jako instancované segmenty
  s animovanými „pakety" energie ve fragment shaderu.
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
js/osm.js       – import skutečné krajiny z OpenStreetMap
js/game.js      – herní smyčka, vstup, HUD, minimapa
```
