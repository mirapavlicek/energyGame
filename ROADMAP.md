# ⚡ EnergyGame – roadmapa rozšíření

Zásobník nápadů na další vývoj hry, seskupený do oblastí.
Všech 76 položek je implementováno (✅), byť některé ve zjednodušené podobě.

## Zdroje a technologie

1. ✅ Jaderná elektrárna – – obrovský stabilní výkon (1 000+ MW, 800 kV),
   velmi drahá stavba, palivo se mění jednou za několik let, dlouhé odstávky,
   přísné požadavky na chladicí vodu (jen u velké řeky).
2. ✅ Plynová elektrárna (špičková) – – rychlý start, drahé palivo; ideální
   na večerní špičky a zálohu obnovitelných zdrojů.
3. ✅ Geotermální elektrárna – – jen na vzácných geologických polích na mapě,
   stabilní malý výkon, minimální provoz.
4. ✅ Bioplynka – – malý stabilní zdroj u měst, palivo dodává okolní
   zemědělská krajina (louky v okolí).
5. ✅ Spalovna odpadu – – výkon roste s populací napojených měst (produkce
   odpadu), řeší i spokojenost měst.
6. ✅ Offshore vítr – – větrné turbíny na vodě (jezera), dražší, ale
   stabilnější vítr než na pevnině.
7. ✅ Solární tracker (modernizace soláru) – – dražší varianta soláru s širší denní křivkou
   (natáčí se za sluncem).
8. ✅ Malá vodní elektrárna (pokrývá stávající vodní – výkon roste s průtokem od 6 MW) – – levná, jen na malých tocích (nízký průtok),
   pro začátek hry.
9. ✅ Vodíkové hospodářství (úložiště H₂) – – elektrolyzér (přebytky → vodík) + vodíková
   elektrárna; sezónní ukládání energie (léto → zima).
10. ✅ Modernizace 4. a 5. úrovně – – prodloužení stromu vylepšení s klesající
    návratností a unikátními bonusy (např. rychlejší najíždění).
11. ✅ Retrofit uhelné na biomasu – – nižší výkon, levnější provoz, jiná
    palivová logistika.
12. ✅ Odstavení a konzervace – – elektrárnu lze dočasně odstavit (neplatí
    provoz, neopotřebovává se, ale nevyrábí a najíždí se s prodlevou).
73. ✅ Velké bateriové úložiště na stejnosměrné přípojnici – 700 MW·s,
    ±140 MW, účinnost 94 %; napojuje se přímo na DC 500 V a do střídavé
    sítě přes měnírnu 22 kV/500 V DC. Nízké napětí = obrovské proudy,
    takže DC vedení unese jen 3 dlaždice.
74. ✅ Tesla Power Grid – bateriová farma na ploše 10×10 dlaždic (první
    víceplošná stavba ve hře) za 30 000: 18 000 MW·s (15× vodík), ±400 MW,
    účinnost 95 %, přípojnice DC 1500 V na plný výkon a měnírna
    400 kV/1500 V DC. Náhled ukáže, které dlaždice plochy nevyhovují.

## Síť a fyzika

13. ✅ HVDC spojka – – stejnosměrné vedení bod–bod: řiditelný tok (jako
    regulační trafo), minimální ztráty na dálku, drahé měnírny na koncích.
14. ✅ Kompenzace jalového výkonu – – kondenzátorové baterie v rozvodnách;
    dlouhá VN vedení bez kompenzace ztrácí kapacitu.
15. ✅ Regulační trafa (přepínač odboček) – posílení/škrcení toku.
16. ✅ Paralelní systémy vedení (až 4× na trase).
17. ✅ Podzemní kabely – – dražší než venkovní vedení, ale nevadí jim bouřky
    a nekazí krajinu (spokojenost měst v okolí).
18. ✅ N-1 kritérium (analytické tlačítko) – – bonusové skóre/kontrakty za síť, která přežije
    výpadek libovolného jednoho prvku; analytický nástroj „co kdyby".
19. ✅ Black-start / studené starty – tepelné zdroje po odstávce chladnou a najíždí pozvolna (plyn 6 s, uhlí 30 s, jádro 90 s); po blackoutu síť nastartuje baterie či voda. Původně: města s vlastním záložním zdrojem přežijí krátký
    výpadek; black-start po totálním blackoutu (postupné najíždění).
20. ✅ Frekvence soustavy (ukazatel bilance) – – nedostatek výkonu snižuje frekvenci; pod 49 Hz
    kaskádové odpínání zátěže (brownout místo binárního blackoutu).
21. ✅ Údržba vedení – vedení stárne provozem, ztrácí kapacitu a může vypadnout; panel vedení (klik) se servisem, smlouva rozvodny ho kryje. Původně: vedení stárne (izolátory), občas potřebuje odstávku;
    plánování odstávek do období nízké zátěže.
22. ✅ Rozvodny s poli – – omezený počet vývodových polí podle velikosti
    rozvodny (malá 4, velká 12); nutnost rozšiřování.

## Počasí a události

23. ✅ Roční období (spotřeba, slunce, vítr, průtoky).
24. ✅ Suché a mokré roky (roční hydrologie ±25 %).
25. ✅ Bouřky – – putující bouřkové fronty: riziko výpadku venkovních vedení,
    posílené trasy odolají; radar v HUD.
26. ✅ Vichřice (součást bouřek) – – větrné turbíny se při extrémním větru odstavují
    (bezpečnostní stop), padající stromy na vedení v lese.
27. ✅ Povodně – – extrémní jarní tání zaplaví stavby u řeky; přehrady
    po proudu riziko snižují.
28. ✅ Vlna veder – – nedostatek chladicí vody sníží výkon uhelných/jaderných
    elektráren, špička spotřeby klimatizací.
29. ✅ Námraza – – zimní událost: vedení v horách ztrácí kapacitu, riziko pádu.
30. ✅ Zatmění slunce – – vzácná plánovaná událost: krátký hluboký propad
    soláru, hráč se může připravit.
31. ✅ Kůrovcová kalamita – – lesy se mění na louky, mění se větrný bonus
    a možnosti pily.
72. ✅ Realistický vítr – rychlost v m/s z Weibullova rozdělení (k = 2) a
    skutečná výkonová křivka turbíny: rozběhová rychlost 3,5 m/s, P ~ v³ do
    jmenovitých 12 m/s, vypínací 25 m/s s hysterezí. Drsnost terénu mění
    místní rychlost, roční využití ~31 %, turbíny 14 % času stojí. Přidána
    událost bezvětří (tlaková výše), kdy se zastaví všechny.

## Ekonomika a obchod

32. ✅ Přeshraniční obchod se smlouvami a sankcemi.
33. ✅ Spotová cena – – cena elektřiny se mění po hodinách podle celkové
    bilance; prodej/nákup bez smluv za aktuální cenu (rizikovější).
34. ✅ Kontrakty s průmyslem (spolehlivostní cena, SLA datacenter) – – podnik nabídne fixní cenu za
    garantovanou dodávku na X let; sankce za nedodržení.
35. ✅ Úvěry – – půjčka na rozvoj s úrokem; bankrot = konec hry.
36. ✅ Emisní povolenky – – uhlí postupně zdražuje; motivace k přechodu na
    čisté zdroje.
37. ✅ Dotace na obnovitelné zdroje – – dočasné programy: levnější stavba
    soláru/větru v určitém období.
38. ✅ Ceny paliva se hýbou – – uhlí zdražuje/zlevňuje podle trhu; nákup do
    zásoby ve správný moment.
39. ✅ Inflace nákladů – – provozní náklady pomalu rostou, tlačí na efektivitu.
40. ✅ Kapacitní platby – – stát platí za drženou zálohu (nevyužitý
    pohotový výkon).
76. ✅ Roční daně a poplatky – na Silvestra přijde přiznání: daň z příjmu
    21 % ze zisku po odpisech (5 % majetku ročně), daň z majetku 0,8 %,
    licenční poplatky regulátora a windfall daň 60 % z části základu nad
    1,5násobkem průměru posledních čtyř let. Ztrátový rok se přenáší jako
    daňová ztráta na 5 let. Během roku se platí zálohy podle loňské
    povinnosti a na Silvestra se doúčtuje jen rozdíl (přeplatek se vrací);
    nedoplatek pokryje provozní úvěr.

## Města, průmysl a poptávka

41. ✅ Individuální charakter měst a pomalý růst se zástavbou.
42. ✅ Průmysl jako samostatný prvek s VN přípojkou.
43. ✅ Nové podniky se otevírají – – u spolehlivé a levné sítě vznikají nové
    továrny (růst poptávky jako odměna).
44. ✅ Elektromobilita – – po letech roste noční nabíjecí špička měst;
    chytré nabíjení jako vylepšení rozvodny.
45. ✅ Tepelná čerpadla – – postupná elektrifikace vytápění: zimní spotřeba
    měst dál roste s časem.
46. ✅ Prestiž měst – – dlouhodobě spolehlivá města platí bonus; často
    zhasínaná města dají méně i po obnovení dodávky.
47. ✅ Velkoodběratel na přání (roční zakázky) – – nabídky typu „postav do 2 let přípojku
    pro novou huť, odměna X" (mise/kontrakty).
48. ✅ Datacentrum – – nový typ podniku: konstantní vysoká spotřeba, extrémní
    nároky na spolehlivost (sankce za každý výpadek).
75. ✅ Placená městská elektrická doprava – trolejbusy (600 V DC, od 8 tis.
    obyvatel), tramvaje (750 V DC, od 18 tis.) a metro (750 V DC, od 40 tis.)
    se kupují v panelu města a navazují na sebe. Trakce má vlastní přepravní
    špičky (7:00 a 16:00), noční útlum (metro v noci nejezdí) a rekuperační
    brzdění (15/25/35 %). Vynáší jízdné, zrychluje růst města a zvedá strop
    populace; při výpadku zůstane ve vozovně a cestující to štve. Trakční
    měnírna se napájí z VN, takže město musí mít v dosahu rozvodnu
    s přípojnicí 22 nebo 11 kV – samotné NN na trakci nestačí.

## UI/UX a přehlednost

49. ✅ Grafické jednopólové schéma rozvodny.
50. ✅ Schovávací manuál (tlačítko ?).
51. ✅ Grafy (📈) – – historie výroby/spotřeby/ceny/ztrát za den a rok; skládaný
    graf podle typu zdroje.
52. ✅ Mapové vrstvy (🗺: dosahy, zatížení) – – přepínatelné overlaye: zatížení vedení, napěťové
    hladiny, spokojenost měst, průtoky řek, větrnost, dosahy rozvoden.
53. ✅ Plánovací režim (📐/B) – stínová simulace: stavíš na zkoušku s živou cenou, platí se až potvrzením. Původně: rozmístění staveb „na zkoušku" s cenovou kalkulací
    před potvrzením (blueprint).
54. ✅ Undo posledního kroku (Ctrl+Z) – – vrácení poslední stavby/demolice.
55. ✅ Seznam objektů (📋) s filtrem a skokem kamery. Původně: tabulka všech elektráren/rozvoden
    s filtrací (stav, zatížení, smlouvy) a skokem kamery.
56. ✅ Klikací log (skok na místo problému) – – klikací výstrahy (skok na místo problému),
    prioritizace, ztlumení kategorií.
57. ✅ Ukládání hry (💾/📂, localStorage) – – save/load do localStorage + export/import souboru.
58. ✅ Kaskáda traf jedním tlačítkem – – „vybav rozvodnu kaskádou" jedním
    tlačítkem (koupí 110/22 + 22/0,4 najednou).
59. ✅ Dotykové ovládání – tažení, pinch zoom, ťuknutí. Původně: dotyková gesta (pinch zoom, dlouhý stisk = panel).

## Grafika a atmosféra

60. ✅ Denní/noční tónování scény – – tónování terénu podle slunce, světla
    měst v noci, svítící okna podle napájení.
61. ✅ Animace rotorů větrníků – – rychlost podle větru/výkonu.
62. ✅ Počasí vizuálně (bouřkové tónování, zóny) – – déšť, sníh, bouřkové mraky nad mapou.
63. ✅ Stavební animace (fade-in výstavby ~3 s). Původně: jeřáb a lešení během výstavby (stavba trvá čas).
64. ✅ Fotorežim (P) – – skrytí UI a export screenshotu mapy.

## Meta a progrese

65. ✅ Scénáře – ?scenario=1..3 (Elektrifikace / Zbohatni / Zelená síť) s cíli a vítězstvím. Původně: série map s cíli (elektrifikuj region, zvládni
    uhelný útlum, přiveď síť po katastrofě).
66. ✅ Obtížnosti (?mode=sandbox|expert) – – sandbox (bez peněz) / normální / expert (přísné sankce,
    N-1, dražší kapitál).
67. ✅ Rekordy na seed (localStorage) – – nejlepší skóre na seed, sdílení seedů.
68. ✅ Achievementy – – „Rok bez blackoutu", „100 % z obnovitelných zdrojů",
    „Exportní velmoc"…
69. ✅ Výzva dne (🗓, seed z data) – – všichni hrají stejný seed se stejnými událostmi.

## Technika

70. ✅ Web Worker – těžké analýzy (N-1) běží mimo hlavní vlákno; herní tick zůstává na main threadu kvůli interaktivitě. Původně: oddělení výpočtu od renderu (větší mapy).
71. ✅ Replay (🎬) – deterministická simulace + záznam akcí; přehrání seance od začátku 8× rychle. Původně: záznam a přehrání průběhu hry.
