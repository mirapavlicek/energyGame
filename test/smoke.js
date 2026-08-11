/* Smoke test: spustí hru v headless Chrome, ověří WebGL render,
   nasimuluje stavbu elektrárny + rozvodny + vedení a zkontroluje,
   že energie teče. Pořídí screenshoty. */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const f = path.normalize(path.join(ROOT, url === '/' ? 'index.html' : url));
  if (!f.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
    res.end(data);
  });
});

(async () => {
  await new Promise((r) => server.listen(8901, r));
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/usr/local/bin/google-chrome',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto('http://localhost:8901/?seed=42');
  await page.waitForTimeout(1500);

  // základní kontroly
  const checks = await page.evaluate(() => {
    const cv = document.querySelector('#game');
    const gl = cv.getContext('webgl2');
    return {
      webgl2: !!gl,
      renderer: gl ? gl.getParameter(gl.RENDERER) : null,
      cities: window.__eg_cities === undefined ? 'n/a' : window.__eg_cities,
      money: document.querySelector('#money').textContent,
      power: document.querySelector('#power').textContent,
      canvasSize: [cv.width, cv.height],
    };
  });
  console.log('checks:', JSON.stringify(checks));
  if (!checks.webgl2) throw new Error('WebGL2 se nepodařilo inicializovat');

  // --- PWA: manifest, ikony a service worker ---
  const pwa = await page.evaluate(async () => {
    const mf = await fetch('manifest.webmanifest').then((r) => r.ok ? r.json() : null).catch(() => null);
    const icon = await fetch('icons/icon-192.png').then((r) => r.ok).catch(() => false);
    let swOk = false;
    if ('serviceWorker' in navigator) {
      for (let i = 0; i < 20 && !swOk; i++) {
        const regs = await navigator.serviceWorker.getRegistrations();
        swOk = regs.length > 0;
        if (!swOk) await new Promise((r) => setTimeout(r, 250));
      }
    }
    return { name: mf && mf.name, display: mf && mf.display, icon, swOk };
  });
  console.log('PWA:', JSON.stringify(pwa));
  if (!pwa.name || pwa.display !== 'fullscreen') throw new Error('manifest PWA chybí nebo je špatně');
  if (!pwa.icon) throw new Error('chybí ikona PWA');
  if (!pwa.swOk) throw new Error('service worker se nezaregistroval');

  // --- dvojnásobná mapa: 226² ≈ 51 000 dlaždic a úměrně víc obsahu ---
  const bigmap = await page.evaluate(() => ({
    size: EG.game.map.size,
    tiles: EG.game.map.size * EG.game.map.size,
    cities: EG.game.map.cities.length,
    industries: EG.game.map.industries.length,
    crossings: EG.game.map.crossings.length,
    geo: EG.game.map.geoFields.length,
    railways: EG.game.map.railways.length,
    tract: EG.game.map.industries.filter((o) => o.type === 'trakce').length,
  }));
  console.log('mapa:', JSON.stringify(bigmap));
  if (bigmap.size !== 322) throw new Error('mapa nemá 322 dlaždic na stranu: ' + bigmap.size);
  if (!(bigmap.tiles >= 2 * 227 * 227)) throw new Error('počet dlaždic není znovu dvojnásobný: ' + bigmap.tiles);
  if (bigmap.cities < 40) throw new Error('málo měst na velké mapě: ' + bigmap.cities);
  if (bigmap.industries < 30) throw new Error('málo průmyslu na velké mapě: ' + bigmap.industries);
  if (bigmap.crossings < 5) throw new Error('málo předávacích bodů na velké mapě: ' + bigmap.crossings);
  if (bigmap.geo < 6) throw new Error('málo geotermálních polí: ' + bigmap.geo);
  if (bigmap.railways < 3 || bigmap.tract < 6) throw new Error('málo železnic/trakčních stanic: ' + bigmap.railways + '/' + bigmap.tract);

  // ověřit, že se něco vykreslilo – jednobarevná scéna by se zkomprimovala do pár kB
  await page.screenshot({ path: '/tmp/eg_start.png' });
  const shotSize = fs.statSync('/tmp/eg_start.png').size;
  console.log('screenshot:', shotSize, 'B');
  if (shotSize < 60000) throw new Error('Canvas vypadá prázdný (screenshot jen ' + shotSize + ' B)');

  // --- interakční test přes interní API hry (přímé volání simu je přes DOM eventy složité,
  //     takže klikáme jako hráč) ---
  const result = await page.evaluate(() => {
    // najdeme si sim a map přes closure? Nejsou globální – otestujeme aspoň logiku znovu-vytvořením
    const map = EG.generateMap(160, 42);
    const sim = new EG.Sim(map);
    sim.money = 100000;
    // najdi řeku
    let rx = -1, ry = -1;
    outer:
    for (let y = 0; y < map.size; y++) for (let x = 0; x < map.size; x++) {
      if (map.type[map.idx(x, y)] === EG.T.RIVER && sim.canPlace('hydro', x, y).ok) { rx = x; ry = y; break outer; }
    }
    const hydro = sim.place('hydro', rx, ry);
    // vodní nejde na trávu
    let gx = -1, gy = -1;
    outer2:
    for (let y = 0; y < map.size; y++) for (let x = 0; x < map.size; x++) {
      if (map.type[map.idx(x, y)] === EG.T.GRASS) { gx = x; gy = y; break outer2; }
    }
    const hydroOnGrass = sim.canPlace('hydro', gx, gy);
    // rozvodna u prvního města – potřebuje trafa 110/22 a 22/0,4 (vodní vyrábí na 110 kV)
    const c = map.cities[0];
    let sub = null;
    for (let dy = -3; dy <= 3 && !sub; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (sim.canPlace('sub', c.x + dx, c.y + dy).ok) { sub = sim.place('sub', c.x + dx, c.y + dy); break; }
    }
    sim.buyTrafo(sub, 't110_22');
    sim.buyTrafo(sub, 't22_04');
    // řetěz rozvoden od elektrárny k městu (110kV vedení max 28 dlaždic, průchozí suby potřebují 110kV přípojnici)
    const hops = [hydro];
    let cur = hydro;
    while (Math.hypot(cur.x - sub.x, cur.y - sub.y) > 24) {
      const d = Math.hypot(sub.x - cur.x, sub.y - cur.y);
      const t = 20 / d;
      let nx = Math.round(cur.x + (sub.x - cur.x) * t);
      let ny = Math.round(cur.y + (sub.y - cur.y) * t);
      let placed = null;
      for (let r = 0; r < 6 && !placed; r++) {
        for (let ay = -r; ay <= r && !placed; ay++) for (let ax = -r; ax <= r; ax++) {
          if (sim.canPlace('sub', nx + ax, ny + ay).ok) { placed = sim.place('sub', nx + ax, ny + ay); break; }
        }
      }
      if (!placed) return { fail: 'nelze umístit mezilehlou rozvodnu' };
      sim.buyTrafo(placed, 't110_22');
      hops.push(placed);
      cur = placed;
    }
    hops.push(sub);
    const lines = [];
    for (let i = 0; i < hops.length - 1; i++) lines.push(sim.connect(hops[i], hops[i + 1], 110));
    // simuluj 30 s
    for (let i = 0; i < 300; i++) sim.tick(0.1);
    // přehrada test: postavit na řece pod elektrárnou
    let dam = null;
    outer3:
    for (let y = 0; y < map.size; y++) for (let x = 0; x < map.size; x++) {
      if (map.type[map.idx(x, y)] === EG.T.RIVER && sim.canPlace('dam', x, y).ok) { dam = sim.place('dam', x, y); break outer3; }
    }
    for (let i = 0; i < 50; i++) sim.tick(0.1);
    return {
      hydroPlaced: !!hydro,
      hydroGen: hydro ? +hydro.gen.toFixed(1) : null,
      hydroOnGrassRejected: !hydroOnGrass.ok,
      subPlaced: !!sub,
      linesOk: lines.every((l) => !!l),
      nLines: lines.length,
      lineLevel: lines[0] && lines[0].level,
      lineCap: lines[0] && lines[0].cap,
      delivered: +sim.stats.delivered.toFixed(1),
      demand: +sim.stats.demand.toFixed(1),
      cityPowered: +(map.cities[0].powered || 0).toFixed(2),
      damPlaced: !!dam,
      damReservoir: dam ? dam.reservoir : null,
      damGen: dam ? +dam.gen.toFixed(1) : null,
      lineFlows: sim.lines.map((l) => +l.flow.toFixed(1)),
      money: Math.round(sim.money),
    };
  });
  console.log('herní test:', JSON.stringify(result, null, 1));
  if (result.fail) throw new Error(result.fail);
  if (!result.hydroPlaced || !result.hydroOnGrassRejected) throw new Error('pravidla umístění vodní elektrárny selhala');
  if (!result.linesOk) throw new Error('vedení se nepodařilo natáhnout');
  if (result.lineLevel !== 110 || result.lineCap !== 80) throw new Error('vedení nemá úroveň 110 kV / kapacitu 80 MW');
  if (!(result.cityPowered > 0.9)) throw new Error('město není napájené: ' + result.cityPowered);
  if (!result.damPlaced || !(result.damGen > 0)) throw new Error('přehrada nefunguje');

  // --- správa budov: opotřebení, servis, smlouva, modernizace, dosah rozvodny ---
  const mgmt = await page.evaluate(() => {
    const map = EG.generateMap(160, 42);
    const sim = new EG.Sim(map);
    sim.money = 100000;
    let rx = -1, ry = -1;
    outer:
    for (let y = 0; y < map.size; y++) for (let x = 0; x < map.size; x++) {
      if (map.type[map.idx(x, y)] === EG.T.RIVER && sim.canPlace('hydro', x, y).ok) { rx = x; ry = y; break outer; }
    }
    const hydro = sim.place('hydro', rx, ry);
    const c = map.cities[0];
    let sub = null;
    for (let dy = -3; dy <= 3 && !sub; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (sim.canPlace('sub', c.x + dx, c.y + dy).ok) { sub = sim.place('sub', c.x + dx, c.y + dy); break; }
    }
    sim.buyTrafo(sub, 't220_110');
    sim.buyTrafo(sub, 't110_22');
    sim.buyTrafo(sub, 't22_04');
    sim.tick(0.1);

    // opotřebení snižuje výkon
    const genFresh = sim._genOf(hydro, 1, 1);
    hydro.cond = 0.3;
    const genWorn = sim._genOf(hydro, 1, 1);

    // servis vrátí stav na 100 %
    const svcCost = sim.serviceCost(hydro);
    const moneyBefore = sim.money;
    const svcOk = sim.service(hydro);
    const svcPaid = moneyBefore - sim.money;

    // porucha vyřadí z provozu, servis opraví
    hydro.cond = 0.05; hydro.broken = true;
    const genBroken = sim._genOf(hydro, 1, 1);
    sim.service(hydro);
    const fixedAfterService = !hydro.broken && hydro.cond === 1;

    // modernizace zvedne výkon o 25 %
    const genL1 = sim._genOf(hydro, 1, 1);
    const upOk = sim.upgrade(hydro);
    const genL2 = sim._genOf(hydro, 1, 1);

    // rozvodna: rozšíření dosahu
    const r0 = sim.subRange(sub);
    const rngOk = sim.upgradeRange(sub);
    const r1 = sim.subRange(sub);

    // porouchaná rozvodna nenapájí město (uhelná hned vedle rozvodny, ať je vedení krátké)
    let coal = null;
    for (let r = 1; r <= 8 && !coal; r++)
      for (let dy = -r; dy <= r && !coal; dy++) for (let dx = -r; dx <= r; dx++)
        if (sim.canPlace('coal', sub.x + dx, sub.y + dy).ok) { coal = sim.place('coal', sub.x + dx, sub.y + dy); break; }
    sim.connect(coal, sub);
    for (let i = 0; i < 30; i++) sim.tick(0.1);
    const poweredOk = map.cities[0].powered > 0;
    sub.broken = true;
    for (let i = 0; i < 30; i++) sim.tick(0.1);
    const poweredBroken = map.cities[0].powered;

    // servisní smlouva rozvodnu postupně opraví (paušální údržba)
    sim.setContract(sub, true);
    for (let i = 0; i < 100; i++) sim.tick(0.1);
    const contractFixed = !sub.broken && sub.cond > 0.9;
    for (let i = 0; i < 30; i++) sim.tick(0.1);
    const poweredAgain = map.cities[0].powered;
    // se smlouvou se zařízení dál neopotřebovává
    const condHeld = sub.cond;
    for (let i = 0; i < 200; i++) sim.tick(0.1);
    const noWearUnderContract = sub.cond >= condHeld - 1e-9;
    sim.setContract(sub, false);

    // opotřebení běží v ticku samo
    const condBefore = hydro.cond;
    for (let i = 0; i < 200; i++) sim.tick(0.1);
    const wearWorks = hydro.cond < condBefore;

    // --- napěťové úrovně a trafa ---
    // prázdná rozvodna má jen NN (400 V) a bez trafa nepřipojí 110 kV
    let ex = -1, ey = -1;
    outerE:
    for (let y = 0; y < map.size; y++) for (let x = 0; x < map.size; x++) {
      const d = Math.hypot(x - hydro.x, y - hydro.y);
      if (d > 32 && d < 45 && sim.canPlace('sub', x, y).ok) { ex = x; ey = y; break outerE; }
    }
    const empty = sim.place('sub', ex, ey);
    const levelsEmpty = sim.levelsOf(empty).join(',');
    const noCommon = sim.connect(hydro, empty);        // žádná společná úroveň
    sim.buyTrafo(empty, 't110_22');
    const supports110 = sim.supportsLevel(empty, 110); // s trafem už 110 kV umí
    const wrongLevel = sim.connect(hydro, empty, 22);  // vodní vyrábí na 110, ne 22
    const tooFar = sim.connect(hydro, empty, 110);     // 110 kV má max 28 dlaždic
    // tok přes trafo se měří
    const trafoLoad110 = (sub.trafoLoad || {}).t110_22 || 0;

    // elektrárny se neřetězí: vedení musí končit v rozvodně
    const plantChain = sim.connect(hydro, coal);
    let solar2 = null, wind2 = null;
    outerP:
    for (let y = 0; y < map.size; y++) for (let x = 0; x < map.size; x++) {
      if (!solar2 && sim.canPlace('solar', x, y).ok) { solar2 = sim.place('solar', x, y); continue; }
      if (solar2 && sim.canPlace('wind', x, y).ok && Math.hypot(x - solar2.x, y - solar2.y) < 10) {
        wind2 = sim.place('wind', x, y); break outerP;
      }
    }
    const sameLevelChain = wind2 ? sim.connect(solar2, wind2, 22) : null; // oba 22 kV
    const cr = sim.buildings.find((o) => o.kind === 'xborder');
    const plantToBorder = sim.connect(hydro, cr);

    return {
      genFresh: +genFresh.toFixed(1), genWorn: +genWorn.toFixed(1),
      wornIsLess: genWorn < genFresh * 0.7,
      svcOk, svcPaid, svcCostMatches: svcPaid === svcCost,
      genBrokenZero: genBroken === 0, fixedAfterService,
      upOk, genL1: +genL1.toFixed(1), genL2: +genL2.toFixed(1),
      upgradeBoost: +(genL2 / genL1).toFixed(2),
      rngOk, rangeBefore: r0, rangeAfter: r1,
      poweredOk, poweredBroken: +poweredBroken.toFixed(2),
      contractFixed, poweredAgain: +poweredAgain.toFixed(2),
      noWearUnderContract,
      wearWorks,
      levelsEmpty, noCommonNull: noCommon === null, supports110,
      wrongLevelNull: wrongLevel === null, tooFarNull: tooFar === null,
      trafoLoad110: +trafoLoad110.toFixed(2),
      plantChainNull: plantChain === null,
      sameLevelChainNull: sameLevelChain === null,
      plantToBorderNull: plantToBorder === null,
    };
  });
  console.log('správa budov:', JSON.stringify(mgmt, null, 1));
  if (!mgmt.wornIsLess) throw new Error('opotřebení nesnižuje výkon');
  if (!mgmt.svcOk || !mgmt.svcCostMatches) throw new Error('servis nefunguje');
  if (!mgmt.genBrokenZero || !mgmt.fixedAfterService) throw new Error('porucha/oprava nefunguje');
  if (!mgmt.upOk || Math.abs(mgmt.upgradeBoost - 1.25) > 0.01) throw new Error('modernizace nefunguje');
  if (!mgmt.rngOk || mgmt.rangeAfter !== mgmt.rangeBefore + 2) throw new Error('rozšíření dosahu nefunguje');
  if (!(mgmt.poweredBroken < 0.1)) throw new Error('porouchaná rozvodna stále napájí město');
  if (!mgmt.contractFixed || !(mgmt.poweredAgain > 0.9)) throw new Error('servisní smlouva nefunguje');
  if (!mgmt.noWearUnderContract) throw new Error('zařízení se opotřebovává i pod smlouvou');
  if (!mgmt.wearWorks) throw new Error('opotřebení v ticku neběží');

  // --- paušál smlouvy: 20 % ceny zařízení ročně ---
  const pausal = await page.evaluate(() => {
    const run = (withContract) => {
      const map = EG.generateMap(160, 42);
      const sim = new EG.Sim(map);
      sim.money = 10000;
      let cx = -1, cy = -1;
      outer:
      for (let y = 0; y < map.size; y++) for (let x = 0; x < map.size; x++) {
        if (sim.canPlace('coal', x, y).ok) { cx = x; cy = y; break outer; }
      }
      const b = sim.place('coal', cx, cy);
      if (withContract) sim.setContract(b, true);
      const m0 = sim.money;
      for (let i = 0; i < 144; i++) sim.tick(0.1); // 14,4 s = 1 % roku (rok = 1440 s)
      return { drain: m0 - sim.money, cond: b.cond, broken: b.broken };
    };
    const no = run(false);
    const yes = run(true);
    // sleva za modernizaci: úroveň 2 -> 17 %, úroveň 3 -> 14 %
    const map3 = EG.generateMap(160, 42);
    const sim3 = new EG.Sim(map3);
    sim3.money = 10000;
    let cx3 = -1, cy3 = -1;
    outer3:
    for (let y = 0; y < map3.size; y++) for (let x = 0; x < map3.size; x++) {
      if (sim3.canPlace('coal', x, y).ok) { cx3 = x; cy3 = y; break outer3; }
    }
    const b3 = sim3.place('coal', cx3, cy3);
    const feeL1 = sim3.contractYearCost(b3);
    sim3.upgrade(b3);
    const feeL2 = sim3.contractYearCost(b3);
    sim3.upgrade(b3);
    const feeL3 = sim3.contractYearCost(b3);
    // očekávaný paušál za 1 % roku: 0,01 × 20 % × 380 = 0,76
    return {
      feeMeasured: +(yes.drain - no.drain).toFixed(3),
      feeExpected: +(0.01 * 0.2 * EG.BUILD.coal.cost).toFixed(3),
      condNo: +no.cond.toFixed(4), condYes: +yes.cond.toFixed(4),
      feeL1, feeL2, feeL3,
      feeL2Expected: Math.round(EG.BUILD.coal.cost * 0.17),
      feeL3Expected: Math.round(EG.BUILD.coal.cost * 0.14),
    };
  });
  console.log('paušál smlouvy:', JSON.stringify(pausal));
  if (Math.abs(pausal.feeMeasured - pausal.feeExpected) > 0.1)
    throw new Error('paušál není 20 % ceny/rok: ' + pausal.feeMeasured + ' vs ' + pausal.feeExpected);
  if (!(pausal.condYes >= 1 - 1e-6)) throw new Error('pod smlouvou se zařízení opotřebovává: ' + pausal.condYes);
  if (!(pausal.condNo < 1)) throw new Error('bez smlouvy se zařízení neopotřebovává (test je bezzubý)');
  if (pausal.feeL2 !== pausal.feeL2Expected || pausal.feeL3 !== pausal.feeL3Expected)
    throw new Error('modernizace nesnižuje paušál: ' + pausal.feeL1 + '/' + pausal.feeL2 + '/' + pausal.feeL3);
  if (!(pausal.feeL3 < pausal.feeL2 && pausal.feeL2 < pausal.feeL1))
    throw new Error('paušál neklesá s úrovní: ' + pausal.feeL1 + '/' + pausal.feeL2 + '/' + pausal.feeL3);
  if (mgmt.levelsEmpty !== '0.4') throw new Error('prázdná rozvodna má mít jen NN, má: ' + mgmt.levelsEmpty);
  if (!mgmt.noCommonNull) throw new Error('spojení bez společné úrovně prošlo');
  if (!mgmt.supports110) throw new Error('trafo 110/22 nepřidalo 110kV přípojnici');
  if (!mgmt.wrongLevelNull) throw new Error('vedení 22 kV k vodní elektrárně (110 kV) prošlo');
  if (!mgmt.tooFarNull) throw new Error('110kV vedení delší než 28 dlaždic prošlo');
  if (!(mgmt.trafoLoad110 > 0)) throw new Error('tok přes trafo se neměří');
  if (!mgmt.plantChainNull || !mgmt.sameLevelChainNull) throw new Error('elektrárny jdou řetězit napřímo');
  if (!mgmt.plantToBorderNull) throw new Error('elektrárna jde připojit rovnou na hraniční bod');

  // --- Kirchhoffovy zákony: bilance v každé přípojnici + nulový součet úbytků po smyčce ---
  const kirchhoff = await page.evaluate(() => {
    const map = EG.generateMap(160, 42);
    const sim = new EG.Sim(map);
    sim.money = 1000000;
    // uhelná (220 kV) + rozvodna u města s plnou kaskádou traf
    const c = map.cities[0];
    let s1 = null;
    for (let dy = -3; dy <= 3 && !s1; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (sim.canPlace('sub', c.x + dx, c.y + dy).ok) { s1 = sim.place('sub', c.x + dx, c.y + dy); break; }
    }
    sim.buyTrafo(s1, 't220_110'); sim.buyTrafo(s1, 't110_22'); sim.buyTrafo(s1, 't22_04');
    let coal = null;
    for (let r = 2; r <= 8 && !coal; r++)
      for (let dy = -r; dy <= r && !coal; dy++) for (let dx = -r; dx <= r; dx++)
        if (sim.canPlace('coal', s1.x + dx, s1.y + dy).ok) { coal = sim.place('coal', s1.x + dx, s1.y + dy); break; }
    // dvě průchozí rozvodny na 220 kV -> smyčka coal–s2–s3–s1–coal
    const passSubs = [];
    for (let r = 2; r <= 10 && passSubs.length < 2; r++)
      for (let dy = -r; dy <= r && passSubs.length < 2; dy++) for (let dx = -r; dx <= r; dx++) {
        if (passSubs.some((s) => Math.hypot(s.x - (coal.x + dx), s.y - (coal.y + dy)) < 2)) continue;
        if (sim.canPlace('sub', coal.x + dx, coal.y + dy).ok) {
          const s = sim.place('sub', coal.x + dx, coal.y + dy);
          sim.buyTrafo(s, 't220_110');
          passSubs.push(s);
          if (passSubs.length >= 2) break;
        }
      }
    const [s2, s3] = passSubs;
    const loop = [coal, s2, s3, s1];
    const loopLines = [];
    for (let i = 0; i < 4; i++) {
      const l = sim.connect(loop[i], loop[(i + 1) % 4], 220);
      if (!l) return { fail: 'smyčku se nepodařilo postavit (' + i + ')' };
      loopLines.push(l);
    }
    for (let i = 0; i < 50; i++) sim.tick(0.1);

    // 1. Kirchhoffův zákon: součet toků do každé přípojnice = injekce
    // (ztráty vedení působí jako dodatečný odběr, půl na každém konci)
    const bal = new Map();
    const add = (key, v) => bal.set(key, (bal.get(key) || 0) + v);
    const idx = new Map();
    sim.buildings.forEach((b, i) => idx.set(b.id, i));
    for (const l of sim.lines) {
      add(idx.get(l.a) + ':' + l.level, -l.flow - (l.loss || 0) / 2);
      add(idx.get(l.b) + ':' + l.level, +l.flow - (l.loss || 0) / 2);
    }
    sim.buildings.forEach((b, i) => {
      if (b.kind === 'sub') {
        for (const [key, f] of Object.entries(b.trafoFlow || {})) {
          const t = EG.TRAFOS[key];
          add(i + ':' + t.hi, -f);
          add(i + ':' + t.lo, +f);
        }
      } else {
        add(i + ':' + EG.GEN_LEVEL[b.kind], b.out);
      }
    });
    for (const ca of sim.cityAssign) if (ca.sub >= 0) add(ca.sub + ':0.4', -ca.served);
    for (const ia of sim.indAssign) if (ia.sub >= 0) add(ia.sub + ':' + ia.level, -ia.served);
    for (const xa of sim.xAssign) if (xa.bus >= 0) add(xa.bi + ':400', -xa.served);
    let kclErr = 0;
    for (const v of bal.values()) kclErr = Math.max(kclErr, Math.abs(v));

    // 2. Kirchhoffův zákon: součet úbytků „napětí" po smyčce = 0
    // (úbytek na vedení = tok / vodivost; orientace po směru obcházení)
    let kvlDrop = 0, flowsSum = 0;
    for (let i = 0; i < 4; i++) {
      const u = loop[i], v = loop[(i + 1) % 4];
      const l = loopLines[i];
      const sign = l.a === u.id ? 1 : -1;
      const w = 1 / Math.max(1, l.len * 0.25);
      kvlDrop += sign * l.flow / w;
      flowsSum += Math.abs(l.flow);
    }
    return {
      powered: +(c.powered || 0).toFixed(2),
      kclErr: +kclErr.toFixed(5),
      kvlDrop: +kvlDrop.toFixed(5),
      loopCarriesFlow: flowsSum > 1,
      nBuses: bal.size,
      losses: +sim.stats.losses.toFixed(3),
      balanceErr: +(sim.stats.produced - sim.stats.delivered - sim.stats.losses).toFixed(5),
    };
  });
  console.log('Kirchhoff:', JSON.stringify(kirchhoff));
  if (kirchhoff.fail) throw new Error(kirchhoff.fail);
  if (!(kirchhoff.powered > 0.9)) throw new Error('smyčková síť nenapájí město: ' + kirchhoff.powered);
  if (!kirchhoff.loopCarriesFlow) throw new Error('smyčkou nic neteče, KVL test je bezzubý');
  if (!(kirchhoff.kclErr < 0.01)) throw new Error('1. Kirchhoffův zákon porušen, max odchylka ' + kirchhoff.kclErr + ' MW');
  if (!(Math.abs(kirchhoff.kvlDrop) < 0.01)) throw new Error('2. Kirchhoffův zákon porušen, součet úbytků ' + kirchhoff.kvlDrop);
  if (!(kirchhoff.losses > 0)) throw new Error('síť pod zátěží nemá žádné ztráty');
  if (!(Math.abs(kirchhoff.balanceErr) < 0.01)) throw new Error('výroba ≠ dodávka + ztráty: ' + kirchhoff.balanceErr);

  // --- ztráty na vedení: stejná trasa po VN 22 kV ztrácí víc než po VVN 110 kV ---
  const losses = await page.evaluate(() => {
    // stejná geometrie, jen prostřední úsek jednou 110 kV a jednou 22 kV
    const build = (linkLevel) => {
      const map = EG.generateMap(160, 42);
      const sim = new EG.Sim(map);
      sim.money = 1000000;
      const c = map.cities[0];
      let sB = null; // rozvodna u města
      for (let dy = -3; dy <= 3 && !sB; dy++) for (let dx = -3; dx <= 3; dx++) {
        if (sim.canPlace('sub', c.x + dx, c.y + dy).ok) { sB = sim.place('sub', c.x + dx, c.y + dy); break; }
      }
      let sA = null; // vzdálená rozvodna u zdroje (10–12 dlaždic)
      outerA:
      for (let y = 0; y < map.size; y++) for (let x = 0; x < map.size; x++) {
        const d = Math.hypot(x - sB.x, y - sB.y);
        if (d >= 10 && d <= 12 && sim.canPlace('sub', x, y).ok) { sA = sim.place('sub', x, y); break outerA; }
      }
      let coal = null;
      for (let r = 1; r <= 5 && !coal; r++)
        for (let dy = -r; dy <= r && !coal; dy++) for (let dx = -r; dx <= r; dx++)
          if (sim.canPlace('coal', sA.x + dx, sA.y + dy).ok) { coal = sim.place('coal', sA.x + dx, sA.y + dy); break; }
      // trafa: sA převádí 220 na úroveň spoje, sB z úrovně spoje na NN
      sim.buyTrafo(sA, 't220_110');
      sim.buyTrafo(sB, 't110_22');
      sim.buyTrafo(sB, 't22_04');
      if (linkLevel === 22) sim.buyTrafo(sA, 't110_22');
      if (!sim.connect(coal, sA, 220)) return { fail: 'coal-sA' };
      if (!sim.connect(sA, sB, linkLevel)) return { fail: 'sA-sB @' + linkLevel };
      for (let i = 0; i < 40; i++) sim.tick(0.1);
      return {
        losses: sim.stats.losses,
        delivered: sim.stats.delivered,
        produced: sim.stats.produced,
        linkLoss: sim.lines[1].loss,
      };
    };
    const hi = build(110);
    const lo = build(22);
    return {
      hiFail: hi.fail, loFail: lo.fail,
      hiLoss: +hi.losses.toFixed(3), loLoss: +lo.losses.toFixed(3),
      hiLink: +hi.linkLoss.toFixed(3), loLink: +lo.linkLoss.toFixed(3),
      hiDelivered: +hi.delivered.toFixed(1), loDelivered: +lo.delivered.toFixed(1),
      hiProducedMore: hi.produced > hi.delivered,
    };
  });
  console.log('ztráty vedení:', JSON.stringify(losses));
  if (losses.hiFail || losses.loFail) throw new Error('scénář ztrát se nepostavil: ' + (losses.hiFail || losses.loFail));
  if (!(losses.hiLink > 0 && losses.loLink > 0)) throw new Error('zatížené vedení nemá ztráty');
  if (!(losses.loLink > losses.hiLink * 2)) throw new Error('22 kV neztrácí výrazně víc než 110 kV: ' + losses.loLink + ' vs ' + losses.hiLink);
  if (!losses.hiProducedMore) throw new Error('výroba nekryje ztráty (produced <= delivered)');

  // --- města: individuální potřeba (charakter, spotřeba, denní profil) a růst zástavby ---
  const cities = await page.evaluate(() => {
    const map = EG.generateMap(160, 42);
    const sim = new EG.Sim(map);
    const kinds = new Set(map.cities.map((c) => c.kind));
    const needs = new Set(map.cities.map((c) => +c.needPerCap.toFixed(2)));
    const c = map.cities[0];
    // večerní špička (19:30) vs hluboká noc (02:00)
    const eveningD = sim._cityDemand(c, 0.5625);
    const nightD = sim._cityDemand(c, 0.8333);
    // dvě města se stejnou populací mají různou potřebu
    const c2 = map.cities.find((o) => o !== c && Math.abs(o.needPerCap - c.needPerCap) > 0.05);
    const samePopDiffer = c2
      ? Math.abs(sim._cityDemand(c, 0.5) / c.pop - sim._cityDemand(c2, 0.5) / c2.pop) > 0.01
      : false;
    // růst populace přidává domy, úbytek je zase bere
    const before = c.houses.length;
    c.pop += 6; sim._syncHouses(c);
    const after = c.houses.length;
    c.pop -= 6; sim._syncHouses(c);
    const back = c.houses.length;
    return {
      nCities: map.cities.length, nKinds: kinds.size, nNeeds: needs.size,
      eveningD: +eveningD.toFixed(1), nightD: +nightD.toFixed(1),
      eveningHigher: eveningD > nightD * 1.15,
      samePopDiffer,
      housesBefore: before, housesGrown: after, housesBack: back,
      grew: after === before + 2, shrank: back === before,
    };
  });
  console.log('města:', JSON.stringify(cities));
  if (cities.nKinds < 2) throw new Error('města nemají různé charaktery');
  if (cities.nNeeds < 3) throw new Error('města nemají individuální spotřebu');
  if (!cities.eveningHigher) throw new Error('denní profil odběru nefunguje: ' + cities.eveningD + ' vs ' + cities.nightD);
  if (!cities.samePopDiffer) throw new Error('dvě města se stejnou populací mají stejnou potřebu na obyvatele');
  if (!cities.grew) throw new Error('růst populace nepřidává domy: ' + cities.housesBefore + ' -> ' + cities.housesGrown);
  if (!cities.shrank) throw new Error('úbytek populace neubírá domy');

  // --- průmysl jako samostatný prvek: generuje se, napájí se z VN a platí víc ---
  const industry = await page.evaluate(() => {
    const map = EG.generateMap(160, 42);
    const sim = new EG.Sim(map);
    sim.money = 1000000;
    const inds = map.industries || [];
    const types = new Set(inds.map((o) => o.type));
    const ind = inds[0];
    // rozvodna hned u podniku – zatím bez VN trafa
    let sub = null;
    for (let r = 1; r <= 4 && !sub; r++)
      for (let dy = -r; dy <= r && !sub; dy++) for (let dx = -r; dx <= r; dx++)
        if (sim.canPlace('sub', ind.x + dx, ind.y + dy).ok) { sub = sim.place('sub', ind.x + dx, ind.y + dy); break; }
    let coal = null;
    for (let r = 1; r <= 6 && !coal; r++)
      for (let dy = -r; dy <= r && !coal; dy++) for (let dx = -r; dx <= r; dx++)
        if (sim.canPlace('coal', sub.x + dx, sub.y + dy).ok) { coal = sim.place('coal', sub.x + dx, sub.y + dy); break; }
    sim.buyTrafo(sub, 't220_110');
    sim.buyTrafo(sub, 't110_22');
    sim.connect(coal, sub, 220);
    // bez VN? sub má 22 z t110_22 – nejdřív ověř bez něj nejde: uděláme druhý sim
    for (let i = 0; i < 30; i++) sim.tick(0.1);
    const poweredWithVN = ind.powered;
    const servedMW = (sim.indAssign.find((a) => a.ind === ind) || {}).served || 0;
    const level = (sim.indAssign.find((a) => a.ind === ind) || {}).level;
    // srovnání příjmů: průmysl platí 1.4×
    const ca = sim.indAssign.find((a) => a.ind === ind);
    const incomeOk = sim.stats.indDelivered > 0;

    // druhý scénář: rozvodna bez VN trafa průmysl nenapojí
    const map2 = EG.generateMap(160, 42);
    const sim2 = new EG.Sim(map2);
    sim2.money = 1000000;
    const ind2 = map2.industries[0];
    let sub2 = null;
    for (let r = 1; r <= 4 && !sub2; r++)
      for (let dy = -r; dy <= r && !sub2; dy++) for (let dx = -r; dx <= r; dx++)
        if (sim2.canPlace('sub', ind2.x + dx, ind2.y + dy).ok) { sub2 = sim2.place('sub', ind2.x + dx, ind2.y + dy); break; }
    let coal2 = null;
    for (let r = 1; r <= 6 && !coal2; r++)
      for (let dy = -r; dy <= r && !coal2; dy++) for (let dx = -r; dx <= r; dx++)
        if (sim2.canPlace('coal', sub2.x + dx, sub2.y + dy).ok) { coal2 = sim2.place('coal', sub2.x + dx, sub2.y + dy); break; }
    sim2.buyTrafo(sub2, 't220_110'); // jen VVN převod, žádné VN
    sim2.connect(coal2, sub2, 220);
    for (let i = 0; i < 30; i++) sim2.tick(0.1);
    const poweredNoVN = ind2.powered;

    // na podniku nejde stavět
    const buildOnInd = sim.canPlace('coal', ind.x, ind.y);

    // denní směny: důl/pila v noci šetří, huť jede pořád
    const shiftInd = inds.find((o) => o.type === 'dul' || o.type === 'pila');
    const contInd = inds.find((o) => o.type === 'hut' || o.type === 'chemicka');
    const shiftOk = shiftInd ? sim._industryDemand(shiftInd, 0.3) > sim._industryDemand(shiftInd, 0.9) * 2 : true;
    const contOk = contInd ? sim._industryDemand(contInd, 0.9) > contInd.demand * 0.7 : true;

    return {
      nInd: inds.length, nTypes: types.size,
      demands: inds.map((o) => +o.demand.toFixed(0)),
      poweredWithVN: +poweredWithVN.toFixed(2), servedMW: +servedMW.toFixed(1), level,
      incomeOk,
      poweredNoVN: +(poweredNoVN || 0).toFixed(2),
      buildOnIndRejected: !buildOnInd.ok,
      shiftOk, contOk,
    };
  });
  console.log('průmysl:', JSON.stringify(industry));
  if (industry.nInd < 4) throw new Error('málo podniků na mapě: ' + industry.nInd);
  if (industry.nTypes < 2) throw new Error('podniky nemají různé typy');
  if (!(industry.poweredWithVN > 0.9)) throw new Error('podnik s VN přípojkou není napájen: ' + industry.poweredWithVN);
  if (industry.level !== 22 && industry.level !== 11) throw new Error('průmysl se nenapájí z VN: ' + industry.level);
  if (!industry.incomeOk) throw new Error('dodávka průmyslu se nepočítá do příjmů');
  if (!(industry.poweredNoVN < 0.1)) throw new Error('rozvodna bez VN trafa nemá průmysl napojit: ' + industry.poweredNoVN);
  if (!industry.buildOnIndRejected) throw new Error('na průmyslovém areálu jde stavět');
  if (!industry.shiftOk || !industry.contOk) throw new Error('směnné profily průmyslu nefungují');

  // --- nové zdroje, merit order, retrofit, konzervace, 5 úrovní ---
  const sources = await page.evaluate(() => {
    const map = EG.generateMap(160, 42);
    const sim = new EG.Sim(map);
    sim.money = 1000000;
    // pravidla umístění
    let nukeSpot = null, geoOk = null, owindSpot = null, bioSpot = null;
    for (let y = 0; y < map.size && !(nukeSpot && owindSpot && bioSpot); y++)
      for (let x = 0; x < map.size; x++) {
        if (!nukeSpot && sim.canPlace('nuclear', x, y).ok) nukeSpot = [x, y];
        if (!owindSpot && sim.canPlace('owind', x, y).ok) owindSpot = [x, y];
        if (!bioSpot && sim.canPlace('bio', x, y).ok) bioSpot = [x, y];
      }
    geoOk = map.geoFields.length >= 2 && sim.canPlace('geo', map.geoFields[0].x, map.geoFields[0].y).ok;
    const geoOnGrass = sim.canPlace('geo', bioSpot[0], bioSpot[1]).ok; // mimo pole musí selhat
    const nuke = sim.place('nuclear', nukeSpot[0], nukeSpot[1]);
    const geo = sim.place('geo', map.geoFields[0].x, map.geoFields[0].y);
    sim.tick(0.05);
    const nukeGen = nuke.gen, geoGen = geo.gen;

    // merit order: hydro (0) jede před plynem (3)
    const map2 = EG.generateMap(160, 42);
    const sim2 = new EG.Sim(map2);
    sim2.money = 1000000;
    // najdi město s řekou do 20 dlaždic (města se generují u řek)
    let c = null, hydro = null;
    for (const cc of map2.cities) {
      let best = null, bd = Infinity;
      for (let dy = -20; dy <= 20; dy++) for (let dx = -20; dx <= 20; dx++) {
        const x = cc.x + dx, y = cc.y + dy;
        if (x < 0 || y < 0 || x >= map2.size || y >= map2.size) continue;
        if (map2.type[map2.idx(x, y)] !== EG.T.RIVER || !sim2.canPlace('hydro', x, y).ok) continue;
        const d = Math.hypot(dx, dy);
        if (d < bd) { bd = d; best = [x, y]; }
      }
      if (best) { c = cc; hydro = best; break; }
    }
    if (!c) return { fail: 'žádné město u řeky' };
    let sub = null;
    for (let dy = -3; dy <= 3 && !sub; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (sim2.canPlace('sub', c.x + dx, c.y + dy).ok) { sub = sim2.place('sub', c.x + dx, c.y + dy); break; }
    }
    for (const k of ['t110_22', 't22_04']) sim2.buyTrafo(sub, k);
    let gasP = null;
    for (let r = 1; r <= 6 && !gasP; r++)
      for (let dy = -r; dy <= r && !gasP; dy++) for (let dx = -r; dx <= r; dx++)
        if (sim2.canPlace('gas', sub.x + dx, sub.y + dy).ok) { gasP = sim2.place('gas', sub.x + dx, sub.y + dy); break; }
    const hydroB = sim2.place('hydro', hydro[0], hydro[1]);
    sim2.connect(hydroB, sub, 110);
    sim2.connect(gasP, sub, 110);
    for (let i = 0; i < 20; i++) sim2.tick(0.1);
    const gasIdle = gasP.out;         // poptávka < hydro -> plyn stojí
    const hydroRuns = hydroB.out;
    const cr2 = sim2.buildings.find((o) => o.kind === 'xborder');
    // zvýšit poptávku nad hydro: export ze sousední rozvodny nejde (daleko) -> vypnout hydro
    hydroB.mothball = true;
    for (let i = 0; i < 20; i++) sim2.tick(0.1);
    const gasKicksIn = gasP.out;      // hydro stojí -> plyn najede

    // konzervace: neběží, nestárne
    const mbCond = hydroB.cond;
    for (let i = 0; i < 100; i++) sim2.tick(0.1);
    const mothballOk = hydroB.out === 0 && Math.abs(hydroB.cond - mbCond) < 1e-9;
    sim2.setMothball(hydroB, false);

    // retrofit uhelné na biomasu
    let coal = null;
    for (let r = 1; r <= 8 && !coal; r++)
      for (let dy = -r; dy <= r && !coal; dy++) for (let dx = -r; dx <= r; dx++)
        if (sim2.canPlace('coal', sub.x + dx, sub.y + dy).ok) { coal = sim2.place('coal', sub.x + dx, sub.y + dy); break; }
    sim2.retrofitBiomass(coal);
    sim2.tick(0.05);
    const bioName = (EG.fuelDefOf(coal) || {}).name;
    const bioGen = coal.gen;

    // 5 úrovní modernizace
    while (sim2.upgradeCost(coal) !== null) sim2.upgrade(coal);
    const maxLevel = coal.level;
    const multL5 = EG.levelMult(5);

    return {
      nukePlaced: !!nuke, nukeGen: +nukeGen.toFixed(0),
      geoOk, geoOnGrassRejected: !geoOnGrass, geoGen: +geoGen.toFixed(0),
      owindFound: !!owindSpot, bioFound: !!bioSpot,
      gasIdle: +gasIdle.toFixed(1), hydroRuns: +hydroRuns.toFixed(1),
      gasKicksIn: +gasKicksIn.toFixed(1),
      mothballOk,
      bioName, bioGen: +bioGen.toFixed(0),
      maxLevel, multL5,
    };
  });
  console.log('nové zdroje:', JSON.stringify(sources));
  if (sources.fail) throw new Error(sources.fail);
  if (!sources.nukePlaced || sources.nukeGen !== 260) throw new Error('jaderná elektrárna nefunguje: ' + sources.nukeGen);
  if (!sources.geoOk || !sources.geoOnGrassRejected || sources.geoGen !== 25) throw new Error('geotermální pole/elektrárna nefunguje');
  if (!sources.owindFound || !sources.bioFound) throw new Error('offshore vítr nebo bioplynka nemají kde stát');
  if (!(sources.gasIdle < 1) || !(sources.hydroRuns > 5)) throw new Error('merit order: plyn běží, i když stačí hydro: ' + sources.gasIdle);
  if (!(sources.gasKicksIn > 5)) throw new Error('merit order: plyn nenajel při výpadku hydra: ' + sources.gasKicksIn);
  if (!sources.mothballOk) throw new Error('konzervace nefunguje');
  if (sources.bioName !== 'štěpka' || sources.bioGen !== 70) throw new Error('retrofit na biomasu nefunguje: ' + sources.bioName + '/' + sources.bioGen);
  if (sources.maxLevel !== 5 || sources.multL5 !== 1.8) throw new Error('5 úrovní modernizace nefunguje');

  // --- železnice: trakční stanice se napájí ze 110 kV a odběr pulzuje ---
  const rail = await page.evaluate(() => {
    const map = EG.generateMap(160, 42);
    const sim = new EG.Sim(map);
    sim.money = 1000000;
    const st = map.industries.find((o) => o.type === 'trakce');
    if (!st) return { fail: 'na mapě není trakční stanice' };
    // na trati nejde stavět
    const railIdx = map.railTiles[Math.floor(map.railTiles.length / 2)];
    const rx = railIdx % map.size, ry = Math.floor(railIdx / map.size);
    const onRail = sim.canPlace('coal', rx, ry);
    // rozvodna u stanice jen s VN trafem nestačí (trakce chce 110 kV)
    let sub = null;
    for (let r = 1; r <= 5 && !sub; r++)
      for (let dy = -r; dy <= r && !sub; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.hypot(dx, dy) > 5.5) continue; // musí být v dosahu rozvodny (6)
        if (sim.canPlace('sub', st.x + dx, st.y + dy).ok) { sub = sim.place('sub', st.x + dx, st.y + dy); break; }
      }
    let coal = null;
    for (let r = 1; r <= 8 && !coal; r++)
      for (let dy = -r; dy <= r && !coal; dy++) for (let dx = -r; dx <= r; dx++)
        if (sim.canPlace('coal', sub.x + dx, sub.y + dy).ok) { coal = sim.place('coal', sub.x + dx, sub.y + dy); break; }
    sim.buyTrafo(sub, 't220_110'); sim.buyTrafo(sub, 't110_22'); // 110 i VN přípojnice
    sim.connect(coal, sub, 220);
    for (let i = 0; i < 20; i++) sim.tick(0.1);
    const ia = sim.indAssign.find((a) => a.ind === st);
    const poweredVia110 = ia && ia.level === 110 && st.powered > 0.9;
    // odběr pulzuje (projíždějící vlaky)
    let mn = 1e9, mx = 0;
    for (let i = 0; i < 120; i++) {
      sim.tick(0.25);
      const d = sim.indAssign.find((a) => a.ind === st).demand;
      mn = Math.min(mn, d); mx = Math.max(mx, d);
    }
    return {
      onRailRejected: !onRail.ok, why: onRail.why,
      poweredVia110,
      pulseMin: +mn.toFixed(1), pulseMax: +mx.toFixed(1),
      pulses: mx > mn * 1.8,
    };
  });
  console.log('železnice:', JSON.stringify(rail));
  if (rail.fail) throw new Error(rail.fail);
  if (!rail.onRailRejected) throw new Error('na trati jde stavět');
  if (!rail.poweredVia110) throw new Error('trakce se nenapájí ze 110 kV');
  if (!rail.pulses) throw new Error('odběr trakce nepulzuje: ' + rail.pulseMin + '–' + rail.pulseMax);

  // --- G: determinismus simulace (replay-ready) ---
  const determin = await page.evaluate(() => {
    const run = () => {
      const map = EG.generateMap(160, 42);
      const sim = new EG.Sim(map);
      sim.money = 100000;
      const c = map.cities[0];
      let sub = null;
      for (let dy = -3; dy <= 3 && !sub; dy++) for (let dx = -3; dx <= 3; dx++) {
        if (sim.canPlace('sub', c.x + dx, c.y + dy).ok) { sub = sim.place('sub', c.x + dx, c.y + dy); break; }
      }
      sim.buyTrafo(sub, 't220_110'); sim.buyTrafo(sub, 't110_22'); sim.buyTrafo(sub, 't22_04');
      let coal = null;
      for (let r = 1; r <= 8 && !coal; r++)
        for (let dy = -r; dy <= r && !coal; dy++) for (let dx = -r; dx <= r; dx++)
          if (sim.canPlace('coal', sub.x + dx, sub.y + dy).ok) { coal = sim.place('coal', sub.x + dx, sub.y + dy); break; }
      sim.connect(coal, sub, 220);
      for (let i = 0; i < 500; i++) sim.tick(0.1); // vč. růstu měst, opotřebení, poruch
      return { money: sim.money, cond: coal.cond, pop: map.cities[0].pop, condLine: sim.lines[0].cond };
    };
    const a = run(), b = run();
    return {
      moneyEq: a.money === b.money,
      condEq: a.cond === b.cond,
      popEq: a.pop === b.pop,
      lineEq: a.condLine === b.condLine,
    };
  });
  console.log('determinismus:', JSON.stringify(determin));
  if (!determin.moneyEq || !determin.condEq || !determin.popEq || !determin.lineEq)
    throw new Error('simulace není deterministická: ' + JSON.stringify(determin));

  // --- G: plánovací režim (blueprint) ---
  const planT = await page.evaluate(() => {
    const g = EG.game;
    const realSim = g.sim;
    realSim.money = 10000;
    const moneyBefore = realSim.money;
    const nBefore = realSim.buildings.length;
    g.plan.enter();
    const inPlan = g.plan.active && g.sim !== realSim;
    // v plánu postavíme rozvodnu a koupíme trafo
    const psim = g.sim;
    let spot = null;
    outer:
    for (let y = 0; y < g.map.size; y++) for (let x = 0; x < g.map.size; x++) {
      if (psim.canPlace('sub', x, y).ok) { spot = [x, y]; break outer; }
    }
    const pb = psim.place('sub', spot[0], spot[1]);
    psim.buyTrafo(pb, 't22_04');
    const planCost = moneyBefore - psim.money;
    const realUntouched = realSim.money === moneyBefore && realSim.buildings.length === nBefore;
    // zrušení: nic se nepostaví
    g.plan.cancel();
    const afterCancel = g.sim === realSim && realSim.buildings.length === nBefore && realSim.money === moneyBefore;
    // znovu a potvrdit
    g.plan.enter();
    const psim2 = g.sim;
    const pb2 = psim2.place('sub', spot[0], spot[1]);
    psim2.buyTrafo(pb2, 't22_04');
    g.plan.confirm();
    const built = g.sim === realSim && realSim.buildings.length === nBefore + 1;
    const newSub = realSim.buildings[realSim.buildings.length - 1];
    const trafoBought = (newSub.trafos || {}).t22_04 === 1;
    const paidOnce = Math.round(moneyBefore - realSim.money) === Math.round(planCost);
    return { inPlan, planCost, realUntouched, afterCancel, built, trafoBought, paidOnce };
  });
  console.log('plán:', JSON.stringify(planT));
  if (!planT.inPlan || !planT.realUntouched) throw new Error('plán nepracuje na stínové kopii');
  if (!planT.afterCancel) throw new Error('zrušení plánu nevrátilo hru beze změn');
  if (!planT.built || !planT.trafoBought || !planT.paidOnce) throw new Error('potvrzení plánu nepřehrálo akce: ' + JSON.stringify(planT));

  // --- G: replay (přehrání záznamu) ---
  const replayT1 = await page.evaluate(() => {
    const g = EG.game;
    const realSim = g.sim;
    g.replay.start();
    return {
      active: g.replay.active,
      freshSim: g.sim !== realSim,
      timeAtStart: g.sim.time,
      barShown: !document.querySelector('#replay-bar').hidden,
    };
  });
  await page.waitForTimeout(1200);
  const replayT2 = await page.evaluate(() => {
    const g = EG.game;
    const progressed = g.sim.time;
    const wasActive = g.replay.active;
    if (wasActive) g.replay.stop();
    return { progressed, wasActive, restored: !g.replay.active && g.sim.time > 0 };
  });
  console.log('replay:', JSON.stringify({ ...replayT1, ...replayT2 }));
  if (!replayT1.active || !replayT1.freshSim || replayT1.timeAtStart > 1) throw new Error('replay nezačal od začátku');
  if (!(replayT2.progressed > replayT1.timeAtStart)) throw new Error('replay se nepřehrává');
  if (!replayT2.restored) throw new Error('replay nevrátil živou hru');

  // --- klikací log: zpráva s 📍 skočí kamerou a otevře panel viníka ---
  const logJump = await page.evaluate(() => {
    const { sim, renderer } = EG.game;
    // vyrobit cílenou zprávu na existující budovu
    const target = sim.buildings.find((b) => b.kind !== 'xborder');
    sim.msg('Testovací problém budovy', 'warn', target);
    // překreslit log (updateHUD běží v loopu – vynutíme změnou počtu zpráv)
    return { tx: target.x, ty: target.y, id: target.id };
  });
  // počkat, až loop log překreslí (headless kreslí zřídka)
  let hasRow = false;
  for (let k = 0; k < 12 && !hasRow; k++) {
    await page.waitForTimeout(700);
    hasRow = await page.evaluate(() => [...document.querySelectorAll('#log div')].some((d) => d.dataset.x !== undefined));
  }
  const logJump2 = await page.evaluate((t) => {
    const rows = [...document.querySelectorAll('#log div')];
    const row = rows.reverse().find((d) => d.dataset.x !== undefined);
    if (!row) return { fail: 'v logu není klikací zpráva' };
    const hasPin = row.textContent.includes('📍');
    row.click();
    const { sim, renderer } = EG.game;
    const [wx, wy] = renderer.tileToWorld(+row.dataset.x, +row.dataset.y);
    return {
      hasPin,
      camOk: Math.abs(renderer.cam.x - wx) < 1 && Math.abs(renderer.cam.y - wy) < 1,
      panelOpen: !document.querySelector('#bpanel').hidden,
      panelTitle: document.querySelector('#bp-title').textContent,
    };
  }, logJump);
  console.log('klikací log:', JSON.stringify(logJump2));
  if (logJump2.fail) throw new Error(logJump2.fail);
  if (!logJump2.hasPin) throw new Error('cílená zpráva nemá 📍');
  if (!logJump2.camOk) throw new Error('klik na zprávu neskočil kamerou');
  if (!logJump2.panelOpen) throw new Error('klik na zprávu neotevřel panel viníka');
  await page.evaluate(() => document.querySelector('#bp-close').click());

  // --- G: N-1 ve Web Workeru ---
  await page.evaluate(() => { document.querySelector('#btn-n1').click(); });
  let n1Done = false;
  for (let k = 0; k < 20 && !n1Done; k++) {
    await page.waitForTimeout(500);
    n1Done = await page.evaluate(() => EG.game.sim._n1Critical !== undefined &&
      EG.game.sim.messages.some((m) => m.text.startsWith('N-1:')));
  }
  console.log('N-1 worker:', JSON.stringify({ n1Done }));
  if (!n1Done) throw new Error('N-1 analýza ve workeru nedoběhla');

  // --- F: stárnutí vedení, studené starty, seznam objektů ---
  const batchF = await page.evaluate(() => {
    const map = EG.generateMap(160, 42);
    const sim = new EG.Sim(map);
    sim.money = 1000000;
    const c = map.cities[0];
    let sub = null;
    for (let dy = -3; dy <= 3 && !sub; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (sim.canPlace('sub', c.x + dx, c.y + dy).ok) { sub = sim.place('sub', c.x + dx, c.y + dy); break; }
    }
    sim.buyTrafo(sub, 't220_110'); sim.buyTrafo(sub, 't110_22'); sim.buyTrafo(sub, 't22_04');
    let coal = null;
    for (let r = 1; r <= 8 && !coal; r++)
      for (let dy = -r; dy <= r && !coal; dy++) for (let dx = -r; dx <= r; dx++)
        if (sim.canPlace('coal', sub.x + dx, sub.y + dy).ok) { coal = sim.place('coal', sub.x + dx, sub.y + dy); break; }
    const line = sim.connect(coal, sub, 220);
    for (let i = 0; i < 20; i++) sim.tick(0.1);

    // stárnutí vedení pod zátěží
    const condStart = line.cond;
    for (let i = 0; i < 100; i++) sim.tick(1);
    sim.buyFuel(coal); // ať mezitím nedošlo palivo
    const condAged = line.cond;
    const agesUnderLoad = condAged < condStart - 0.02;
    // zestárlé vedení ztrácí kapacitu a může vypadnout
    line.cond = 0.05;
    line.broken = true;
    sim.tick(0.1);
    const cityDark = map.cities[0].powered;
    const svcCost = sim.lineServiceCost(line);
    sim.serviceLine(line);
    const svcOk = line.cond === 1 && !line.broken;
    for (let i = 0; i < 5; i++) sim.tick(0.1);
    const cityBack = map.cities[0].powered;
    // smlouva rozvodny kryje vedení
    sim.setContract(sub, true);
    line.cond = 0.6;
    for (let i = 0; i < 50; i++) sim.tick(0.1);
    const contractHeals = line.cond > 0.6;
    sim.setContract(sub, false);

    // studený start: nečinná uhelná chladne a najíždí pozvolna
    const warmRunning = coal.warm;
    line.broken = true; // odpoj -> uhelná stojí
    for (let i = 0; i < 100; i++) sim.tick(1); // 100 s: 30 s grace + chladnutí
    const warmCold = coal.warm;
    line.broken = false; line.cond = 1;
    sim.tick(0.1);
    const outColdStart = coal.out; // hned po připojení jen zlomek
    for (let i = 0; i < 60; i++) sim.tick(1);
    sim.buyFuel(coal);
    sim.tick(0.1);
    const outWarmedUp = coal.out;
    return {
      condStart: +condStart.toFixed(3), condAged: +condAged.toFixed(3), agesUnderLoad,
      cityDark: +cityDark.toFixed(2), cityBack: +cityBack.toFixed(2), svcOk, svcCost,
      contractHeals,
      warmRunning: +warmRunning.toFixed(2), warmCold: +warmCold.toFixed(2),
      outColdStart: +outColdStart.toFixed(1), outWarmedUp: +outWarmedUp.toFixed(1),
    };
  });
  console.log('dávka F:', JSON.stringify(batchF));
  if (!batchF.agesUnderLoad) throw new Error('vedení nestárne provozem');
  if (!(batchF.cityDark < 0.1) || !(batchF.cityBack > 0.9) || !batchF.svcOk) throw new Error('porucha/servis vedení nefunguje');
  if (!batchF.contractHeals) throw new Error('smlouva rozvodny nekryje vedení');
  if (!(batchF.warmRunning > 0.95) || !(batchF.warmCold < 0.5)) throw new Error('chladnutí zdroje nefunguje: ' + batchF.warmCold);
  if (!(batchF.outColdStart < 30)) throw new Error('studený start neomezuje výkon: ' + batchF.outColdStart);
  if (!(batchF.outWarmedUp > batchF.outColdStart * 3)) throw new Error('zdroj se nenajel zpátky: ' + batchF.outWarmedUp);

  // --- F: panel vedení klikem v pan režimu + seznam objektů ---
  await page.evaluate(() => {
    const { sim, map, renderer } = EG.game;
    sim.money = 100000;
    let s1 = null, s2 = null;
    outer:
    for (let y = 0; y < map.size; y++) for (let x = 0; x < map.size; x++) {
      if (!sim.canPlace('sub', x, y).ok) continue;
      if (!s1) { s1 = sim.place('sub', x, y); continue; }
      const d = Math.hypot(x - s1.x, y - s1.y);
      if (d >= 3 && d <= 4.5) { s2 = sim.place('sub', x, y); break outer; }
    }
    window.__lineTest = sim.connect(s1, s2, 0.4);
    const [wx, wy] = renderer.tileToWorld((s1.x + s2.x) / 2, (s1.y + s2.y) / 2);
    renderer.cam.x = wx; renderer.cam.y = wy; renderer.cam.zoom = 1.6;
    document.querySelector('.tool[data-tool="pan"]').click();
  });
  await page.waitForTimeout(300);
  const centerF = await page.evaluate(() => {
    const cv = EG.game.renderer.canvas;
    return { x: cv.clientWidth / 2, y: cv.clientHeight / 2 };
  });
  await page.mouse.click(centerF.x, centerF.y);
  await page.waitForTimeout(250);
  const linePanel = await page.evaluate(() => ({
    title: document.querySelector('#bp-title').textContent,
    visible: !document.querySelector('#bpanel').hidden,
    svcBtn: !!document.querySelector('#bp-btn-lsvc'),
  }));
  console.log('panel vedení:', JSON.stringify(linePanel));
  if (!linePanel.visible || !linePanel.title.startsWith('Vedení')) throw new Error('panel vedení se neotevřel: ' + linePanel.title);
  if (!linePanel.svcBtn) throw new Error('panel vedení nemá servis');

  const objList = await page.evaluate(() => {
    document.querySelector('#btn-objlist').click();
    const visible = !document.querySelector('#objlist').hidden;
    const rows = document.querySelectorAll('#objlist-rows .obj-row').length;
    const row = document.querySelector('#objlist-rows .obj-row');
    if (row) row.click();
    const panelOpened = !document.querySelector('#bpanel').hidden;
    document.querySelector('#objlist-close').click();
    return { visible, rows, panelOpened, closed: document.querySelector('#objlist').hidden };
  });
  console.log('seznam objektů:', JSON.stringify(objList));
  if (!objList.visible || !(objList.rows > 3) || !objList.panelOpened || !objList.closed)
    throw new Error('seznam objektů nefunguje: ' + JSON.stringify(objList));

  // --- F: scénář s cílem (nová stránka ?scenario=2) ---
  const page2 = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  await page2.goto('http://localhost:8901/?scenario=2');
  await page2.waitForTimeout(1500);
  const scInfo = await page2.evaluate(() => ({
    seed: EG.game.map.seed,
    money: Math.round(EG.game.sim.money),
    goalMsg: EG.game.sim.messages.some((m) => m.text.includes('SCÉNÁŘ')),
  }));
  await page2.evaluate(() => { EG.game.sim.money = 30000; for (let i = 0; i < 3; i++) EG.game.sim.tick(1); });
  let victory = false;
  for (let k = 0; k < 8 && !victory; k++) {
    await page2.waitForTimeout(700);
    await page2.evaluate(() => { EG.game.sim.tick(1); });
    victory = await page2.evaluate(() => !document.querySelector('#victory').hidden);
  }
  console.log('scénář:', JSON.stringify({ ...scInfo, victory }));
  await page2.close();
  if (scInfo.seed !== 202 || scInfo.money !== 30000 && scInfo.money !== 900) throw new Error('scénář nepřenastavil hru: ' + JSON.stringify(scInfo));
  if (!scInfo.goalMsg) throw new Error('scénář nehlásí cíl');
  if (!victory) throw new Error('splněný scénář nevyhlásil vítězství');

  // --- UI/meta E: save/load, vrstvy, grafy, undo, kaskáda, rekord, výzva ---
  const metaE = await page.evaluate(() => {
    const results = {};
    const { sim, map } = EG.game;
    // uložit -> změnit peníze -> načíst -> peníze zpět
    sim.money = 4242;
    const saved = EG.serialize(sim);
    localStorage.setItem('eg_save', saved);
    results.saveSize = saved.length;
    const restored = EG.restore(saved);
    results.restoreMoney = Math.round(restored.money);
    results.restoreBuildings = restored.buildings.length === sim.buildings.length;
    results.restoreLines = restored.lines.length === sim.lines.length;
    results.restoreSeed = restored.map.seed === map.seed;
    // undo: postavit rozvodnu přes sim + zásobník akcí testujeme přes UI klávesu níže
    // achievementy/rekord: existence API
    results.spotShown = document.querySelector('#spot').textContent.includes('×');
    results.chartBtn = !!document.querySelector('#btn-chart');
    results.layerBtn = !!document.querySelector('#btn-layer');
    // kaskáda v panelu rozvodny se testuje nákupem přes sim API
    const sub2 = sim.buildings.find((b) => b.kind === 'sub' && !(b.trafos && b.trafos.t110_22));
    return results;
  });
  console.log('meta E:', JSON.stringify(metaE));
  if (metaE.restoreMoney !== 4242 || !metaE.restoreBuildings || !metaE.restoreLines || !metaE.restoreSeed)
    throw new Error('uložení/načtení hry nefunguje: ' + JSON.stringify(metaE));
  if (!metaE.spotShown || !metaE.chartBtn || !metaE.layerBtn) throw new Error('HUD prvky (spot/graf/vrstvy) chybí');

  // načtení přes tlačítko + graf + vrstvy + undo klávesou
  const metaE2 = await page.evaluate(() => {
    document.querySelector('#btn-load').click();
    const moneyAfterLoad = Math.round(EG.game.sim.money);
    document.querySelector('#btn-chart').click();
    const chartVisible = !document.querySelector('#chart').hidden;
    document.querySelector('#btn-layer').click();
    return { moneyAfterLoad, chartVisible };
  });
  // posunout herní čas, ať se nasbírají vzorky grafu (headless kreslí zřídka)
  for (let k = 0; k < 4; k++) {
    await page.evaluate(() => { for (let i = 0; i < 5; i++) EG.game.sim.tick(1); });
    await page.waitForTimeout(900);
  }
  const metaE3 = await page.evaluate(() => {
    const cv = document.querySelector('#chart');
    const g = cv.getContext('2d');
    const px = g.getImageData(0, 0, cv.width, cv.height).data;
    let nonEmpty = 0;
    for (let i = 3; i < px.length; i += 40) if (px[i] > 0) nonEmpty++;
    return { chartPixels: nonEmpty };
  });
  console.log('meta E2:', JSON.stringify({ ...metaE2, ...metaE3 }));
  if (metaE2.moneyAfterLoad !== 4242) throw new Error('načtení hry tlačítkem nefunguje: ' + metaE2.moneyAfterLoad);
  if (!metaE2.chartVisible || !(metaE3.chartPixels > 5)) throw new Error('graf se nekreslí');

  // --- ekonomika D: spot, prestiž, úvěry, rezerva, inflace, mise, EV, data ---
  const econ = await page.evaluate(() => {
    const map = EG.generateMap(160, 42);
    const sim = new EG.Sim(map);
    sim.money = 5000;
    const c = map.cities[0];
    let sub = null;
    for (let dy = -3; dy <= 3 && !sub; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (sim.canPlace('sub', c.x + dx, c.y + dy).ok) { sub = sim.place('sub', c.x + dx, c.y + dy); break; }
    }
    sim.buyTrafo(sub, 't220_110'); sim.buyTrafo(sub, 't110_22'); sim.buyTrafo(sub, 't22_04');
    sim.tick(0.1);
    const spotTight = sim.spotK;          // žádná výroba -> drahá elektřina
    let coal = null;
    for (let r = 1; r <= 8 && !coal; r++)
      for (let dy = -r; dy <= r && !coal; dy++) for (let dx = -r; dx <= r; dx++)
        if (sim.canPlace('coal', sub.x + dx, sub.y + dy).ok) { coal = sim.place('coal', sub.x + dx, sub.y + dy); break; }
    sim.connect(coal, sub, 220);
    for (let i = 0; i < 30; i++) sim.tick(0.1);
    const spotOk = sim.spotK;             // přebytek -> levnější
    const reservePay = sim.stats.reservePay; // uhelná jede částečně -> záloha placená

    // prestiž: výpadek srazí reliab i cenu
    c.reliab = 1; // dlouhodobě spolehlivé město
    const reliabBefore = c.reliab;
    coal.fuel = 0;
    for (let i = 0; i < 300; i++) sim.tick(0.1);
    const reliabAfter = c.reliab;
    sim.money = 5000; sim.buyFuel(coal);

    // úvěr a splátka
    const m0 = sim.money;
    sim.takeLoan(2000);
    const loanOk = sim.money === m0 + 2000 && sim.debt === 2000;
    sim.repayLoan(500);
    const repayOk = sim.debt === 1500;

    // roční ceny paliva a emisní povolenky
    const k0 = sim.fuelPriceK(coal);
    sim.yearIdx = 5;
    const k5 = sim.fuelPriceK(coal);
    sim.retrofitBiomass(coal);
    const k5bio = sim.fuelPriceK(coal);
    sim.yearIdx = 0;

    // elektromobilita: v roce 6 je noční odběr vyšší než v roce 0
    const nightPhase = (2 - 6 + 24) / 24; // 02:00
    const d0 = sim._cityDemand(c, nightPhase);
    sim.yearIdx = 6;
    const d6 = sim._cityDemand(c, nightPhase);
    sim.yearIdx = 0;

    // datacentrum: plochý odběr 24/7
    const dataInd = { type: 'data', demand: 30 };
    const dataFlat = sim._industryDemand(dataInd, 0.29) === 30 && sim._industryDemand(dataInd, 0.8) === 30;

    // zakázka a nové podniky
    const nInd0 = map.industries.length;
    sim._spawnMission();
    const missionInd = map.industries.find((o) => o.mission);
    missionInd.deadline = sim.time - 1; // propadne
    sim.tick(0.1);
    const missionExpired = !missionInd.mission;
    sim._indGoodT = 1e9;
    sim._maybeSpawnIndustry();
    const spawned = map.industries.length === nInd0 + 2;

    // bankrot
    sim.money = -2500;
    sim.tick(0.1);
    const bankrupt = sim.gameOver === true;

    return {
      spotTight: +spotTight.toFixed(2), spotOk: +spotOk.toFixed(2),
      reservePay: +(reservePay || 0).toFixed(2),
      reliabDropped: reliabAfter < reliabBefore - 0.2,
      loanOk, repayOk,
      k0: +k0.toFixed(3), k5: +k5.toFixed(3), co2Works: k5 > k0 * 1.1, bioExempt: k5bio < k5,
      evWorks: d6 > d0 * 1.1,
      dataFlat,
      missionSpawned: !!missionInd, missionExpired, spawned,
      bankrupt,
    };
  });
  console.log('ekonomika D:', JSON.stringify(econ));
  if (!(econ.spotTight > 1.4) || !(econ.spotOk < 1.1)) throw new Error('spotová cena nereaguje: ' + econ.spotTight + '/' + econ.spotOk);
  if (!(econ.reservePay > 0)) throw new Error('kapacitní platby za zálohu nefungují');
  if (!econ.reliabDropped) throw new Error('prestiž měst nereaguje na výpadky');
  if (!econ.loanOk || !econ.repayOk) throw new Error('úvěry nefungují');
  if (!econ.co2Works || !econ.bioExempt) throw new Error('emisní povolenky nefungují: ' + econ.k0 + '/' + econ.k5);
  if (!econ.evWorks) throw new Error('elektromobilita nezvedá noční odběr');
  if (!econ.dataFlat) throw new Error('datacentrum nemá plochý odběr');
  if (!econ.missionSpawned || !econ.missionExpired || !econ.spawned) throw new Error('zakázky/nové podniky nefungují');
  if (!econ.bankrupt) throw new Error('bankrot se nevyhlašuje');

  // --- události a počasí: bouřka, vedra, zatmění, povodeň, kůrovec, dotace ---
  const eventsT = await page.evaluate(() => {
    const map = EG.generateMap(160, 42);
    const sim = new EG.Sim(map);
    sim.money = 1000000;
    const c = map.cities[0];
    let sub = null;
    for (let dy = -3; dy <= 3 && !sub; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (sim.canPlace('sub', c.x + dx, c.y + dy).ok) { sub = sim.place('sub', c.x + dx, c.y + dy); break; }
    }
    sim.buyTrafo(sub, 't220_110'); sim.buyTrafo(sub, 't110_22'); sim.buyTrafo(sub, 't22_04');
    let coal = null, windB = null;
    for (let r = 1; r <= 10 && !(coal && windB); r++)
      for (let dy = -r; dy <= r && !(coal && windB); dy++) for (let dx = -r; dx <= r; dx++) {
        if (!coal && sim.canPlace('coal', sub.x + dx, sub.y + dy).ok) { coal = sim.place('coal', sub.x + dx, sub.y + dy); continue; }
        if (!windB && sim.canPlace('wind', sub.x + dx, sub.y + dy).ok) { windB = sim.place('wind', sub.x + dx, sub.y + dy); }
      }
    sim.connect(coal, sub, 220);
    sim.connect(windB, sub, 22);
    for (let i = 0; i < 10; i++) sim.tick(0.1);
    const windBefore = windB.gen;
    const coalBefore = coal.gen;

    // bouřka nad větrníkem: odstaví ho a sráží kapacitu vedení
    sim.triggerEvent('storm', { x: windB.x, y: windB.y, r: 10, dur: 30 });
    for (let i = 0; i < 5; i++) sim.tick(0.1);
    const windInStorm = windB.gen;
    const lineCapInStorm = sim.lines.find((l) => l.level === 22).effCap;

    // vlna veder: uhelná −30 %, spotřeba +15 %
    const demandBefore = sim._cityDemand(c, 0.3);
    sim.triggerEvent('heat', { dur: 30 });
    sim.tick(0.1);
    const coalInHeat = coal.gen;
    const demandInHeat = sim._cityDemand(c, 0.3);

    // zatmění: solár na nule i v poledne
    const map2 = EG.generateMap(160, 42);
    const sim2 = new EG.Sim(map2);
    sim2.money = 100000;
    sim2.time = 4 * sim2.dayLen + (7 / 24) * sim2.dayLen; // letní poledne
    sim2.tick(0.01);
    const sunBefore = sim2.sun;
    sim2.triggerEvent('eclipse', { dur: 5 });
    sim2.tick(0.01);
    const sunEclipse = sim2.sun;

    // povodeň: stavba u řeky se poškodí, s přehradou ne
    let riverside = null;
    outerR:
    for (let y = 1; y < map2.size - 1; y++) for (let x = 1; x < map2.size - 1; x++) {
      if (map2.type[map2.idx(x, y)] !== EG.T.RIVER) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (sim2.canPlace('sub', x + dx, y + dy).ok) { riverside = sim2.place('sub', x + dx, y + dy); break outerR; }
      }
    }
    sim2.triggerEvent('flood');
    const floodBroke = riverside.broken;
    // s přehradou povodeň neškodí
    riverside.broken = false; riverside.cond = 1;
    let damSpot = null;
    outerD:
    for (let y = 0; y < map2.size; y++) for (let x = 0; x < map2.size; x++) {
      if (map2.type[map2.idx(x, y)] === EG.T.RIVER && sim2.canPlace('dam', x, y).ok) { damSpot = sim2.place('dam', x, y); break outerD; }
    }
    sim2.triggerEvent('flood');
    const damProtects = !riverside.broken;

    // kůrovec mění les na louku
    const forestBefore = Array.from(map2.type).filter((t) => t === EG.T.FOREST).length;
    sim2.triggerEvent('beetle', { x: 80, y: 80, r: 12 });
    const forestAfter = Array.from(map2.type).filter((t) => t === EG.T.FOREST).length;

    // dotace: solár o 30 % levněji
    sim2.triggerEvent('subsidy');
    let gSpot = null;
    outerG:
    for (let y = 0; y < map2.size; y++) for (let x = 0; x < map2.size; x++) {
      if (sim2.canPlace('solar', x, y).ok) { gSpot = [x, y]; break outerG; }
    }
    const mS = sim2.money;
    sim2.place('solar', gSpot[0], gSpot[1]);
    const solarPaid = mS - sim2.money;

    return {
      windBefore: +windBefore.toFixed(1), windInStorm: +windInStorm.toFixed(1),
      lineCapInStorm,
      coalBefore: +coalBefore.toFixed(0), coalInHeat: +coalInHeat.toFixed(0),
      heatDemandUp: demandInHeat > demandBefore * 1.1,
      sunBefore: +sunBefore.toFixed(2), sunEclipse,
      floodBroke, damProtects,
      beetleAte: forestBefore - forestAfter,
      solarPaid, solarExpected: Math.ceil(EG.BUILD.solar.cost * 0.7),
    };
  });
  console.log('události:', JSON.stringify(eventsT));
  if (!(eventsT.windBefore > 1) || eventsT.windInStorm !== 0) throw new Error('bouřka neodstavila větrník: ' + eventsT.windInStorm);
  if (eventsT.lineCapInStorm !== 15) throw new Error('bouřka nesráží kapacitu vedení: ' + eventsT.lineCapInStorm);
  if (!(eventsT.coalInHeat < eventsT.coalBefore * 0.75)) throw new Error('vedra nesnižují výkon uhelné');
  if (!eventsT.heatDemandUp) throw new Error('vedra nezvyšují spotřebu');
  if (!(eventsT.sunBefore > 0.5) || eventsT.sunEclipse !== 0) throw new Error('zatmění nefunguje');
  if (!eventsT.floodBroke || !eventsT.damProtects) throw new Error('povodeň/ochrana přehradou nefunguje');
  if (!(eventsT.beetleAte > 0)) throw new Error('kůrovec nežere les: ' + eventsT.beetleAte);
  if (eventsT.solarPaid !== eventsT.solarExpected) throw new Error('dotace na OZE nefunguje: ' + eventsT.solarPaid);

  // --- síť: HVDC, kompenzace, kabely, pole rozvodny, N-1, frekvence ---
  const gridB = await page.evaluate(() => {
    const map = EG.generateMap(160, 42);
    const sim = new EG.Sim(map);
    sim.money = 1000000;
    // dvě rozvodny daleko od sebe (65–90 dlaždic): VVN 800 nedosáhne, HVDC ano
    let s1 = null, s2 = null;
    outer:
    for (let y = 0; y < map.size; y++) for (let x = 0; x < map.size; x++) {
      if (!sim.canPlace('sub', x, y).ok) continue;
      if (!s1) { s1 = sim.place('sub', x, y); continue; }
      const d = Math.hypot(x - s1.x, y - s1.y);
      if (d >= 65 && d <= 90) { s2 = sim.place('sub', x, y); break outer; }
    }
    sim.buyTrafo(s1, 'thvdc'); sim.buyTrafo(s2, 'thvdc');
    const far800 = sim.connect(s1, s2, 800);   // max 60 -> null (nemají ani 800 bus)
    const hvdc = sim.connect(s1, s2, 500);     // HVDC max 200 -> ok
    // pole rozvodny: úroveň 1 = 6 polí (thvdc zabírá 1, HVDC linka 1)
    let bought = 0;
    while (sim.buyTrafo(s1, 't22_04')) bought++;
    const fieldsFull = sim.fieldsUsed(s1) === sim.fieldLimit(s1);
    sim.upgrade(s1); // +3 pole
    const afterUpgrade = sim.buyTrafo(s1, 't22_04');

    // kompenzace: dlouhé 110kV vedení ztrácí 20 % kapacity, kondenzátor to spraví
    const map2 = EG.generateMap(160, 42);
    const sim2 = new EG.Sim(map2);
    sim2.money = 1000000;
    let a = null, b = null;
    outer2:
    for (let y = 0; y < map2.size; y++) for (let x = 0; x < map2.size; x++) {
      if (!sim2.canPlace('sub', x, y).ok) continue;
      if (!a) { a = sim2.place('sub', x, y); continue; }
      const d = Math.hypot(x - a.x, y - a.y);
      if (d >= 20 && d <= 26) { b = sim2.place('sub', x, y); break outer2; }
    }
    sim2.buyTrafo(a, 'c110'); sim2.buyTrafo(b, 'c110');
    const longLine = sim2.connect(a, b, 110); // len > 16,8 = penalizace
    sim2.tick(0.05);
    const capPenalized = longLine.effCap;
    sim2.buyCompensator(a);
    sim2.tick(0.05);
    const capFixed = longLine.effCap;
    // kabel: plná kapacita bez kompenzace a 2,5× cena (na jiné hladině,
    // ať nejde o posílení stávající 110kV trasy)
    const cableLine = sim2.connect(a, b, 22, true); // 22 kV max 14 -> moc daleko
    sim2.buyTrafo(a, 'c220'); sim2.buyTrafo(b, 'c220');
    const m0 = sim2.money;
    const cable220 = sim2.connect(a, b, 220, true);
    const cablePaid = m0 - sim2.money;
    const cablePlainCost = Math.ceil(cable220.len * EG.LINE_TYPES[220].cost);
    sim2.tick(0.05);

    // N-1 + frekvence: radiální síť = kritické vedení, smyčka = bez kritických
    const map3 = EG.generateMap(160, 42);
    const sim3 = new EG.Sim(map3);
    sim3.money = 1000000;
    const c = map3.cities[0];
    let sD = null;
    for (let dy = -3; dy <= 3 && !sD; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (sim3.canPlace('sub', c.x + dx, c.y + dy).ok) { sD = sim3.place('sub', c.x + dx, c.y + dy); break; }
    }
    sim3.buyTrafo(sD, 't220_110'); sim3.buyTrafo(sD, 't110_22'); sim3.buyTrafo(sD, 't22_04');
    sim3.tick(0.1);
    const freqDark = sim3.freq; // nic nenapájeno -> pod 50
    let coal = null;
    for (let r = 1; r <= 8 && !coal; r++)
      for (let dy = -r; dy <= r && !coal; dy++) for (let dx = -r; dx <= r; dx++)
        if (sim3.canPlace('coal', sD.x + dx, sD.y + dy).ok) { coal = sim3.place('coal', sD.x + dx, sD.y + dy); break; }
    const radial = sim3.connect(coal, sD, 220);
    for (let i = 0; i < 10; i++) sim3.tick(0.1);
    const freqOk = sim3.freq;
    const n1Radial = sim3.n1Report().critical;
    sim3.connect(coal, sD, 220); // druhý systém nepomůže (stejná trasa)? posílení sdílí stožáry
    let mid = null;
    for (let r = 2; r <= 6 && !mid; r++)
      for (let dy = -r; dy <= r && !mid; dy++) for (let dx = -r; dx <= r; dx++)
        if (sim3.canPlace('sub', coal.x + dx, coal.y + dy).ok) { mid = sim3.place('sub', coal.x + dx, coal.y + dy); break; }
    sim3.buyTrafo(mid, 'c220');
    sim3.connect(coal, mid, 220);
    sim3.connect(mid, sD, 220);
    for (let i = 0; i < 5; i++) sim3.tick(0.1);
    const n1Looped = sim3.n1Report().critical;

    return {
      far800Null: far800 === null, hvdcOk: !!hvdc, hvdcCap: hvdc && hvdc.cap,
      fieldsFull, boughtBeforeLimit: bought, afterUpgrade,
      capPenalized, capFixed,
      cableShortRejected: cableLine === null, cableOk: !!cable220, cableFlag: cable220 && cable220.cable,
      cablePricier: cablePaid > cablePlainCost * 2, cableFullCap: cable220 && cable220.effCap === 200,
      freqDark: +freqDark.toFixed(2), freqOk: +freqOk.toFixed(2),
      n1Radial, n1Looped,
    };
  });
  console.log('síť B:', JSON.stringify(gridB));
  if (!gridB.far800Null || !gridB.hvdcOk || gridB.hvdcCap !== 500) throw new Error('HVDC spojka nefunguje');
  if (!gridB.fieldsFull || !gridB.afterUpgrade) throw new Error('pole rozvodny se nevynucují/nerozšiřují');
  if (gridB.capPenalized !== 64 || gridB.capFixed !== 80) throw new Error('kompenzace jalového výkonu nefunguje: ' + gridB.capPenalized + '/' + gridB.capFixed);
  if (!gridB.cableOk || !gridB.cableFlag || !gridB.cableFullCap) throw new Error('podzemní kabel nefunguje');
  if (!(gridB.freqDark < 49.0) || !(gridB.freqOk > 49.8)) throw new Error('frekvence soustavy neodráží bilanci: ' + gridB.freqDark + '/' + gridB.freqOk);
  if (!(gridB.n1Radial >= 1)) throw new Error('N-1 nenašla kritické radiální vedení');
  if (gridB.n1Looped !== 0) throw new Error('N-1 hlásí kritická vedení i se zálohou: ' + gridB.n1Looped);

  // --- napájení ze dvou stran: zátěž se rozloží a nepřetěžuje jednu trasu ---
  const dispatch = await page.evaluate(() => {
    const map = EG.generateMap(160, 42);
    const sim = new EG.Sim(map);
    sim.money = 1000000;
    const c = map.cities[0];
    c.pop = 55; c.kind = 'res'; c.needPerCap = 1.1; // ~69 MW ve špičce
    let sD = null; // distribuční rozvodna u města
    for (let dy = -3; dy <= 3 && !sD; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (sim.canPlace('sub', c.x + dx, c.y + dy).ok) { sD = sim.place('sub', c.x + dx, c.y + dy); break; }
    }
    sim.buyTrafo(sD, 't110_22'); sim.buyTrafo(sD, 't22_04');
    let sS = null; // zdrojová rozvodna do 10 dlaždic
    for (let r = 6; r <= 10 && !sS; r++)
      for (let dy = -r; dy <= r && !sS; dy++) for (let dx = -r; dx <= r; dx++)
        if (Math.hypot(dx, dy) >= 6 && sim.canPlace('sub', sD.x + dx, sD.y + dy).ok) { sS = sim.place('sub', sD.x + dx, sD.y + dy); break; }
    sim.buyTrafo(sS, 't220_110'); sim.buyTrafo(sS, 't110_22');
    let coal = null, coal2 = null;
    for (let r = 1; r <= 6 && !(coal && coal2); r++)
      for (let dy = -r; dy <= r && !(coal && coal2); dy++) for (let dx = -r; dx <= r; dx++) {
        if (!sim.canPlace('coal', sS.x + dx, sS.y + dy).ok) continue;
        if (!coal) coal = sim.place('coal', sS.x + dx, sS.y + dy);
        else { coal2 = sim.place('coal', sS.x + dx, sS.y + dy); break; }
      }
    sim.connect(coal, sS, 220);
    sim.connect(coal2, sS, 220);
    // fáze 1: jen jedna 22kV trasa (radiální) -> nevyhnutelné přetížení
    const l22 = sim.connect(sS, sD, 22);
    sim.time = 67.5; // večerní špička
    for (let i = 0; i < 30; i++) sim.tick(0.1);
    const loadSingle = l22.load;
    const poweredSingle = c.powered;
    // fáze 2: druhá strana napájení po 110 kV -> zátěž se rozloží
    const l110 = sim.connect(sS, sD, 110);
    for (let i = 0; i < 30; i++) sim.tick(0.1);
    return {
      demand: +sim.cityAssign.find((a) => a.city === c).demand.toFixed(1),
      loadSingle: +loadSingle.toFixed(2), poweredSingle: +poweredSingle.toFixed(2),
      load22: +l22.load.toFixed(2), load110: +l110.load.toFixed(2),
      mw22: +Math.abs(l22.flow).toFixed(1), mw110: +Math.abs(l110.flow).toFixed(1),
      powered: +(c.powered || 0).toFixed(2),
    };
  });
  console.log('rozložení zátěže:', JSON.stringify(dispatch));
  if (!(dispatch.loadSingle > 1.15)) throw new Error('radiální trasa se nepřetížila (test bezzubý): ' + dispatch.loadSingle);
  if (!(dispatch.load22 <= 1.05)) throw new Error('po napojení z druhé strany zůstává 22 kV přetížené: ' + dispatch.load22);
  if (!(dispatch.load110 < 1)) throw new Error('110kV trasa se přetížila: ' + dispatch.load110);
  if (!(dispatch.mw110 > 20)) throw new Error('druhá trasa nepřevzala zátěž: ' + dispatch.mw110 + ' MW');
  if (!(dispatch.powered > 0.95)) throw new Error('město není plně napájené přes dvě trasy: ' + dispatch.powered);

  // --- paralelní systémy vedení: posílení trasy až na 4× ---
  const multi = await page.evaluate(() => {
    const map = EG.generateMap(160, 42);
    const sim = new EG.Sim(map);
    sim.money = 1000000;
    const c = map.cities[0];
    let sB = null; // NN distribuce u města
    for (let dy = -3; dy <= 3 && !sB; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (sim.canPlace('sub', c.x + dx, c.y + dy).ok) { sB = sim.place('sub', c.x + dx, c.y + dy); break; }
    }
    sim.buyTrafo(sB, 't22_04');
    let sA = null; // zdrojová rozvodna do 8 dlaždic (22 kV má max 14)
    for (let r = 5; r <= 8 && !sA; r++)
      for (let dy = -r; dy <= r && !sA; dy++) for (let dx = -r; dx <= r; dx++)
        if (Math.hypot(dx, dy) >= 5 && sim.canPlace('sub', sB.x + dx, sB.y + dy).ok) { sA = sim.place('sub', sB.x + dx, sB.y + dy); break; }
    sim.buyTrafo(sA, 't220_110'); sim.buyTrafo(sA, 't110_22');
    let coal = null;
    for (let r = 1; r <= 6 && !coal; r++)
      for (let dy = -r; dy <= r && !coal; dy++) for (let dx = -r; dx <= r; dx++)
        if (sim.canPlace('coal', sA.x + dx, sA.y + dy).ok) { coal = sim.place('coal', sA.x + dx, sA.y + dy); break; }
    sim.connect(coal, sA, 220);
    const link = sim.connect(sA, sB, 22); // kapacita 30 MW
    // večerní špička – město chce přes 30 MW, jeden systém se přetíží
    sim.time = 67.5;
    for (let i = 0; i < 30; i++) sim.tick(0.1);
    const load1 = link.load;
    const nLinesBefore = sim.lines.length;
    const second = sim.connect(sA, sB, 22); // posílení, ne nová linka
    for (let i = 0; i < 30; i++) sim.tick(0.1);
    const load2 = link.load;
    const cap2 = link.cap;
    sim.connect(sA, sB, 22);
    sim.connect(sA, sB, 22); // -> 4×
    const n4 = link.n;
    const fifth = sim.connect(sA, sB, 22); // nad maximum
    sim.removeLine(link); // odpojí jeden systém
    return {
      load1: +load1.toFixed(2),
      sameLine: second === link, nLinesSame: sim.lines.length === nLinesBefore,
      load2: +load2.toFixed(2), cap2,
      n4, fifthNull: fifth === null,
      nAfterRemove: link.n, stillExists: sim.lines.includes(link),
    };
  });
  console.log('paralelní systémy:', JSON.stringify(multi));
  if (!(multi.load1 > 1)) throw new Error('jeden systém se ve špičce nepřetížil (test bezzubý): ' + multi.load1);
  if (!multi.sameLine || !multi.nLinesSame) throw new Error('posílení vytvořilo novou linku místo systému');
  if (multi.cap2 !== 60) throw new Error('kapacita 2 systémů není 60 MW: ' + multi.cap2);
  if (!(multi.load2 < 0.8)) throw new Error('posílení nesnížilo zatížení: ' + multi.load1 + ' -> ' + multi.load2);
  if (multi.n4 !== 4 || !multi.fifthNull) throw new Error('maximum 4 systémů se nevynucuje');
  if (multi.nAfterRemove !== 3 || !multi.stillExists) throw new Error('bourání neodpojuje po jednom systému');

  // --- trafa obousměrně (zvyšovací provoz) a propojovací pole na prodloužení ---
  const coupler = await page.evaluate(() => {
    const map = EG.generateMap(160, 42);
    const sim = new EG.Sim(map);
    sim.money = 1000000;
    const c = map.cities[0];
    // rozvodna u města: NN distribuce
    let sB = null;
    for (let dy = -3; dy <= 3 && !sB; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (sim.canPlace('sub', c.x + dx, c.y + dy).ok) { sB = sim.place('sub', c.x + dx, c.y + dy); break; }
    }
    sim.buyTrafo(sB, 't110_22'); sim.buyTrafo(sB, 't22_04');
    // zdrojová rozvodna dál: solár (22 kV) se přes trafo 110⇄22 vyvede NAHORU na 110 kV
    let sA = null;
    outerA:
    for (let y = 0; y < map.size; y++) for (let x = 0; x < map.size; x++) {
      const d = Math.hypot(x - sB.x, y - sB.y);
      if (d >= 30 && d <= 45 && sim.canPlace('sub', x, y).ok) { sA = sim.place('sub', x, y); break outerA; }
    }
    sim.buyTrafo(sA, 't110_22');
    let solar = null;
    for (let r = 1; r <= 8 && !solar; r++)
      for (let dy = -r; dy <= r && !solar; dy++) for (let dx = -r; dx <= r; dx++)
        if (sim.canPlace('solar', sA.x + dx, sA.y + dy).ok) { solar = sim.place('solar', sA.x + dx, sA.y + dy); break; }
    sim.connect(solar, sA, 22);
    // trasa sA -> sB je delší než 28 dlaždic -> průchozí stanice s polem 110/110
    let mid = null;
    const mx = Math.round((sA.x + sB.x) / 2), my = Math.round((sA.y + sB.y) / 2);
    for (let r = 0; r <= 8 && !mid; r++)
      for (let dy = -r; dy <= r && !mid; dy++) for (let dx = -r; dx <= r; dx++)
        if (sim.canPlace('sub', mx + dx, my + dy).ok) { mid = sim.place('sub', mx + dx, my + dy); break; }
    const couplerBought = sim.buyTrafo(mid, 'c110');
    const midLevels = sim.levelsOf(mid).join(',');
    const l1 = sim.connect(sA, mid, 110);
    const l2 = sim.connect(mid, sB, 110);
    // poledne, ať solár vyrábí
    sim.time = 4 * sim.dayLen + (7 / 24) * sim.dayLen; // léto, 13:00
    for (let i = 0; i < 30; i++) sim.tick(0.1);
    const upFlow = (sA.trafoFlow || {}).t110_22 || 0; // záporný = teče NAHORU (22 -> 110)
    const regOnCoupler = sim.buyTrafoReg(mid, 'c110');
    return {
      couplerBought, midLevels,
      linesOk: !!l1 && !!l2,
      solarOut: +solar.out.toFixed(1),
      upFlow: +upFlow.toFixed(1),
      flowGoesUp: upFlow < -1,
      cityPowered: +(c.powered || 0).toFixed(2),
      midHasNoConversion: Object.keys(mid.trafoLoad || {}).length === 0,
      regOnCoupler,
    };
  });
  console.log('obousměrná trafa a pole:', JSON.stringify(coupler));
  if (!coupler.couplerBought) throw new Error('propojovací pole nejde koupit');
  if (!coupler.midLevels.includes('110')) throw new Error('pole 110/110 nepřidalo přípojnici: ' + coupler.midLevels);
  if (!coupler.linesOk) throw new Error('trasa přes průchozí stanici nejde natáhnout');
  if (!(coupler.solarOut > 5)) throw new Error('solár nevyrábí: ' + coupler.solarOut);
  if (!coupler.flowGoesUp) throw new Error('trafo nepřevádí nahoru (22→110): ' + coupler.upFlow);
  if (!(coupler.cityPowered > 0.3)) throw new Error('město nedostává energii přes zvyšovací trafo a pole: ' + coupler.cityPowered);
  if (!coupler.midHasNoConversion) throw new Error('pole se chová jako převodní trafo');
  if (coupler.regOnCoupler) throw new Error('na propojovací pole jde koupit regulace');

  // --- přeshraniční obchod: smlouvy oběma směry, take-or-pay import, sankce za export ---
  const xtrade = await page.evaluate(() => {
    const map = EG.generateMap(160, 42);
    const sim = new EG.Sim(map);
    sim.money = 100000;
    const crossings = sim.buildings.filter((b) => b.kind === 'xborder');
    const cr = crossings[0];
    const onEdge = (map.crossings || []).every((c) =>
      c.x <= 3 || c.y <= 3 || c.x >= map.size - 4 || c.y >= map.size - 4);
    const demolishRejected = !sim.demolish(cr.x, cr.y);
    const supports400 = sim.supportsLevel(cr, 400);
    // rozvodna + uhelná u předávacího bodu, spoj 400 kV
    let sub = null;
    for (let r = 1; r <= 6 && !sub; r++)
      for (let dy = -r; dy <= r && !sub; dy++) for (let dx = -r; dx <= r; dx++)
        if (sim.canPlace('sub', cr.x + dx, cr.y + dy).ok) { sub = sim.place('sub', cr.x + dx, cr.y + dy); break; }
    sim.buyTrafo(sub, 't400_220');
    let coal = null;
    for (let r = 1; r <= 8 && !coal; r++)
      for (let dy = -r; dy <= r && !coal; dy++) for (let dx = -r; dx <= r; dx++)
        if (sim.canPlace('coal', sub.x + dx, sub.y + dy).ok) { coal = sim.place('coal', sub.x + dx, sub.y + dy); break; }
    sim.connect(coal, sub, 220);
    const linkOk = !!sim.connect(sub, cr, 400);

    // export 30 MW: uhelná (90 MW) ho pokryje a inkasuje se
    sim.adjustXContract(cr, 'export', 30);
    for (let i = 0; i < 30; i++) sim.tick(0.1);
    const exportServed = cr.xServed;
    const exportedStat = sim.stats.exported;
    const m0 = sim.money;
    for (let i = 0; i < 20; i++) sim.tick(0.1);
    const incomeExporting = sim.money - m0;

    // smlouva nad možnosti (120 MW) -> sankce
    sim.adjustXContract(cr, 'export', 90);
    for (let i = 0; i < 20; i++) sim.tick(0.1);
    const penaltyStat = sim.stats.xPenalty;
    const servedAtCap = cr.xServed;

    // import: když uhelná stojí, sjednaný nákup drží dodávku (a smlouvě se dostojí)
    sim.adjustXContract(cr, 'import', 60);
    coal.fuel = 0;
    for (let i = 0; i < 20; i++) sim.tick(0.1);
    const servedFromImport = cr.xServed;
    const coalOut = coal.out;

    // take-or-pay: import se platí, i když ho nikdo nebere
    sim.adjustXContract(cr, 'export', -200); // -> 0
    const m1 = sim.money;
    for (let i = 0; i < 20; i++) sim.tick(0.1);
    const importBill = m1 - sim.money;
    const importUnused = Math.abs(cr.out) < 1;

    // meze smluv
    sim.adjustXContract(cr, 'import', 500);
    const clampedHi = cr.xImport;
    sim.adjustXContract(cr, 'import', -999);
    const clampedLo = cr.xImport;

    return {
      nCrossings: crossings.length, onEdge, demolishRejected, supports400, linkOk,
      exportServed: +exportServed.toFixed(1), exportedStat: +exportedStat.toFixed(1),
      incomeExporting: +incomeExporting.toFixed(1),
      penaltyStat: +penaltyStat.toFixed(2), servedAtCap: +servedAtCap.toFixed(1),
      servedFromImport: +servedFromImport.toFixed(1), coalOut: +coalOut.toFixed(1),
      importBill: +importBill.toFixed(1), importUnused,
      clampedHi, clampedLo,
    };
  });
  console.log('přeshraniční obchod:', JSON.stringify(xtrade));
  if (xtrade.nCrossings !== 3 || !xtrade.onEdge) throw new Error('předávací body nejsou 3 na okrajích mapy');
  if (!xtrade.demolishRejected) throw new Error('předávací bod jde zbourat');
  if (!xtrade.supports400 || !xtrade.linkOk) throw new Error('předávací bod nejde připojit na 400 kV');
  if (!(xtrade.exportServed > 28)) throw new Error('sjednaný export se nedodává: ' + xtrade.exportServed);
  if (!(xtrade.incomeExporting > 1)) throw new Error('export nevydělává: ' + xtrade.incomeExporting);
  if (!(xtrade.penaltyStat > 0.5)) throw new Error('nedodaný export nemá sankci: ' + xtrade.penaltyStat);
  if (!(xtrade.servedFromImport > 50) || xtrade.coalOut !== 0) throw new Error('import nekryje dodávku při výpadku: ' + xtrade.servedFromImport);
  if (!(xtrade.importBill > 8) || !xtrade.importUnused) throw new Error('import není take-or-pay: ' + xtrade.importBill);
  if (xtrade.clampedHi !== 120 || xtrade.clampedLo !== 0) throw new Error('meze smluv nefungují: ' + xtrade.clampedHi + '/' + xtrade.clampedLo);

  // --- zásobníky energie: nabíjení z přebytků, vybíjení při deficitu, účinnost ---
  const storage = await page.evaluate(() => {
    const map = EG.generateMap(160, 42);
    const sim = new EG.Sim(map);
    sim.money = 1000000;
    // uhelná (stabilní 90 MW) + město + baterie na 22 kV
    const c = map.cities[0];
    let sub = null;
    for (let dy = -3; dy <= 3 && !sub; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (sim.canPlace('sub', c.x + dx, c.y + dy).ok) { sub = sim.place('sub', c.x + dx, c.y + dy); break; }
    }
    sim.buyTrafo(sub, 't220_110'); sim.buyTrafo(sub, 't110_22'); sim.buyTrafo(sub, 't22_04');
    let coal = null, batt = null;
    for (let r = 1; r <= 8 && !(coal && batt); r++)
      for (let dy = -r; dy <= r && !(coal && batt); dy++) for (let dx = -r; dx <= r; dx++) {
        if (!coal && sim.canPlace('coal', sub.x + dx, sub.y + dy).ok) { coal = sim.place('coal', sub.x + dx, sub.y + dy); continue; }
        if (!batt && sim.canPlace('battery', sub.x + dx, sub.y + dy).ok) { batt = sim.place('battery', sub.x + dx, sub.y + dy); }
      }
    sim.connect(coal, sub, 220);
    sim.connect(batt, sub, 22);

    // přebytek (uhelná 90 MW >> město) -> baterie se nabíjí
    for (let i = 0; i < 5; i++) sim.tick(0.1);
    const chargedSome = batt.charge > 5;
    const modeCharging = batt.storMode;
    const coalCoversCharge = coal.out;
    for (let i = 0; i < 35; i++) sim.tick(0.1);
    // spotřebovaná energie vs. uložená (účinnost < 1)
    for (let i = 0; i < 200 && batt.charge < EG.STORAGE.battery.cap - 0.5; i++) sim.tick(0.1);
    const fullCharge = batt.charge;

    // deficit: uhelné dojde palivo -> baterie vybíjí a drží město
    coal.fuel = 0;
    sim.tick(0.1);
    const modeDischarging = batt.storMode;
    const cityHeld = map.cities[0].powered;
    const chargeBefore = batt.charge;
    for (let i = 0; i < 20; i++) sim.tick(0.1);
    const chargeDrained = batt.charge < chargeBefore - 1;

    // pravidla umístění přečerpávačky: jen kopec u vody
    let pshSpot = null, grassHill = null;
    for (let y = 0; y < map.size && !(pshSpot && grassHill); y++) for (let x = 0; x < map.size; x++) {
      if (!pshSpot && sim.canPlace('psh', x, y).ok) pshSpot = [x, y];
      if (!grassHill && map.type[map.idx(x, y)] === EG.T.GRASS && !sim.canPlace('psh', x, y).ok) grassHill = [x, y];
      if (pshSpot && grassHill) break;
    }
    const psh = pshSpot ? sim.place('psh', pshSpot[0], pshSpot[1]) : null;
    return {
      chargedSome, modeCharging, fullCharge: +fullCharge.toFixed(1),
      coalCoversCharge: +coalCoversCharge.toFixed(1),
      modeDischarging, cityHeld: +cityHeld.toFixed(2), chargeDrained,
      pshPlaced: !!psh, pshOnGrassRejected: !!grassHill,
      pshLevel: psh ? EG.GEN_LEVEL.psh : null,
    };
  });
  console.log('zásobníky:', JSON.stringify(storage));
  if (!storage.chargedSome || storage.modeCharging !== 'nabíjí') throw new Error('baterie se nenabíjí z přebytků');
  if (!(storage.fullCharge > 60)) throw new Error('baterie se nedobila: ' + storage.fullCharge);
  if (storage.modeDischarging !== 'vybíjí') throw new Error('baterie při deficitu nevybíjí: ' + storage.modeDischarging);
  if (!(storage.cityHeld > 0.4)) throw new Error('baterie nedrží město při výpadku: ' + storage.cityHeld);
  if (!storage.chargeDrained) throw new Error('vybíjení neubírá zásobu');
  if (!storage.pshPlaced) throw new Error('přečerpávačku nejde postavit na kopci u vody');
  if (!storage.pshOnGrassRejected) throw new Error('přečerpávačka jde postavit na trávě');

  // --- regulační trafa: přepínač odboček mění rozdělení toků ---
  const regulace = await page.evaluate(() => {
    const build = () => {
      const map = EG.generateMap(160, 42);
      const sim = new EG.Sim(map);
      sim.money = 1000000;
      const c = map.cities[0];
      let sub = null;
      for (let dy = -3; dy <= 3 && !sub; dy++) for (let dx = -3; dx <= 3; dx++) {
        if (sim.canPlace('sub', c.x + dx, c.y + dy).ok) { sub = sim.place('sub', c.x + dx, c.y + dy); break; }
      }
      // dvě paralelní cesty 400 -> 110: přímé trafo vs. 400/220 + 220/110
      for (const k of ['t400_110', 't400_220', 't220_110', 't110_22', 't22_04']) sim.buyTrafo(sub, k);
      let dam = null;
      outer:
      for (let y = 0; y < map.size; y++) for (let x = 0; x < map.size; x++) {
        if (map.type[map.idx(x, y)] === EG.T.RIVER && sim.canPlace('dam', x, y).ok &&
            Math.hypot(x - sub.x, y - sub.y) <= 48) { dam = sim.place('dam', x, y); break outer; }
      }
      if (!dam) return null;
      sim.connect(dam, sub, 400);
      return { sim, sub };
    };
    const a = build();
    if (!a) return { fail: 'přehrada se nepostavila' };
    for (let i = 0; i < 30; i++) a.sim.tick(0.1);
    const directBefore = Math.abs(a.sub.trafoFlow.t400_110 || 0);

    const regBought = a.sim.buyTrafoReg(a.sub, 't400_110');
    const regSet = a.sim.setTrafoReg(a.sub, 't400_110', 'limit');
    for (let i = 0; i < 30; i++) a.sim.tick(0.1);
    const directLimited = Math.abs(a.sub.trafoFlow.t400_110 || 0);
    const viaParallel = Math.abs(a.sub.trafoFlow.t400_220 || 0);

    a.sim.setTrafoReg(a.sub, 't400_110', 'boost');
    for (let i = 0; i < 30; i++) a.sim.tick(0.1);
    const directBoosted = Math.abs(a.sub.trafoFlow.t400_110 || 0);

    // regulaci nejde nastavit bez nákupu
    const noRegSet = a.sim.setTrafoReg(a.sub, 't400_220', 'boost');

    return {
      directBefore: +directBefore.toFixed(1),
      regBought, regSet,
      directLimited: +directLimited.toFixed(1),
      viaParallel: +viaParallel.toFixed(1),
      directBoosted: +directBoosted.toFixed(1),
      noRegSet,
    };
  });
  console.log('regulační trafa:', JSON.stringify(regulace));
  if (regulace.fail) throw new Error(regulace.fail);
  if (!regulace.regBought || !regulace.regSet) throw new Error('nákup/nastavení regulace nefunguje');
  if (!(regulace.directLimited < regulace.directBefore * 0.7)) throw new Error('škrcení tok trafem nesnížilo: ' + regulace.directBefore + ' -> ' + regulace.directLimited);
  if (!(regulace.viaParallel > 0.5)) throw new Error('škrcení nepřesměrovalo tok na paralelní cestu');
  if (!(regulace.directBoosted > regulace.directLimited * 1.5)) throw new Error('přednostní tok trafem nezvýšil: ' + regulace.directLimited + ' -> ' + regulace.directBoosted);
  if (regulace.noRegSet) throw new Error('regulaci lze nastavit bez nákupu přepínače');

  // --- palivo klasických elektráren: spotřeba, zastavení bez uhlí, nákup, smlouva ---
  const fuel = await page.evaluate(() => {
    const map = EG.generateMap(160, 42);
    const sim = new EG.Sim(map);
    sim.money = 1000000;
    // uhelná + rozvodna s kaskádou traf u města (ať elektrárna reálně vyrábí)
    const c = map.cities[0];
    let sub = null;
    for (let dy = -3; dy <= 3 && !sub; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (sim.canPlace('sub', c.x + dx, c.y + dy).ok) { sub = sim.place('sub', c.x + dx, c.y + dy); break; }
    }
    sim.buyTrafo(sub, 't220_110'); sim.buyTrafo(sub, 't110_22'); sim.buyTrafo(sub, 't22_04');
    let coal = null;
    for (let r = 1; r <= 8 && !coal; r++)
      for (let dy = -r; dy <= r && !coal; dy++) for (let dx = -r; dx <= r; dx++)
        if (sim.canPlace('coal', sub.x + dx, sub.y + dy).ok) { coal = sim.place('coal', sub.x + dx, sub.y + dy); break; }
    sim.connect(coal, sub, 220);

    const startFuel = coal.fuel;
    const capHalf = Math.abs(startFuel - EG.FUEL.coal.cap * 0.5) < 1;
    for (let i = 0; i < 50; i++) sim.tick(0.1);
    const afterFuel = coal.fuel;
    const consumes = afterFuel < startFuel - 0.1;
    const genWithFuel = coal.out;

    // bez paliva elektrárna stojí
    coal.fuel = 0;
    for (let i = 0; i < 10; i++) sim.tick(0.1);
    const genNoFuel = coal.gen;
    const cityDark = map.cities[0].powered;

    // nákup doplní sklad a stojí peníze
    const moneyBefore = sim.money;
    const cost = sim.fuelCost(coal);
    sim.buyFuel(coal);
    const paid = Math.round(moneyBefore - sim.money);
    const refilled = coal.fuel > EG.FUEL.coal.cap - 1;
    for (let i = 0; i < 10; i++) sim.tick(0.1);
    const genAgain = coal.out;

    // smlouva na palivo doplňuje sama: hned s podpisem…
    coal.fuel = EG.FUEL.coal.cap * 0.1;
    sim.setFuelContract(coal, true);
    const refilledOnSign = coal.fuel > EG.FUEL.coal.cap * 0.9;
    // …a znovu, jakmile zásoba klesne pod 50 %
    coal.fuel = EG.FUEL.coal.cap * 0.45;
    sim.tick(0.1);
    const contractRefilled = refilledOnSign && coal.fuel > EG.FUEL.coal.cap * 0.9;

    return {
      capHalf, consumes,
      startFuel: +startFuel.toFixed(1), afterFuel: +afterFuel.toFixed(1),
      genWithFuel: +genWithFuel.toFixed(1), genNoFuel: +genNoFuel.toFixed(1),
      cityDark: +cityDark.toFixed(2),
      paid, costMatches: paid === cost, refilled,
      genAgain: +genAgain.toFixed(1),
      contractRefilled,
    };
  });
  console.log('palivo:', JSON.stringify(fuel));
  if (!fuel.capHalf) throw new Error('nová uhelná nemá poloviční sklad');
  if (!fuel.consumes) throw new Error('elektrárna nespotřebovává palivo: ' + fuel.startFuel + ' -> ' + fuel.afterFuel);
  if (!(fuel.genWithFuel > 10)) throw new Error('uhelná s palivem nevyrábí');
  if (fuel.genNoFuel !== 0) throw new Error('uhelná bez paliva pořád vyrábí: ' + fuel.genNoFuel);
  if (!(fuel.cityDark < 0.1)) throw new Error('město svítí i bez paliva elektrárny');
  if (!fuel.refilled || !fuel.costMatches || !(fuel.paid > 0)) throw new Error('nákup paliva nefunguje: ' + JSON.stringify(fuel));
  if (!(fuel.genAgain > 10)) throw new Error('po doplnění paliva se výroba neobnovila');
  if (!fuel.contractRefilled) throw new Error('smlouva na palivo nedoplňuje sklad');

  // --- roční období: proměnná zátěž a výroba dle času a sezóny ---
  const seasons = await page.evaluate(() => {
    // sim posazený na daný den v roce (0..11) a hodinu dne
    const at = (dayInYear, hour) => {
      const map = EG.generateMap(160, 42);
      const sim = new EG.Sim(map);
      sim.time = dayInYear * sim.dayLen + ((hour - 6 + 24) % 24) / 24 * sim.dayLen;
      sim.tick(0.0001);
      return sim;
    };
    const winterNoon = at(10, 13);  // zima (den 10 z 12)
    const summerNoon = at(4, 13);   // léto
    const springNoon = at(1, 13);   // jaro
    const autumnNoon = at(7, 13);   // podzim
    const c = winterNoon.map.cities[0];
    const cS = summerNoon.map.cities[0];
    const noonPhase = (13 - 6) / 24;
    const fakeSolar = { kind: 'solar', level: 1, cond: 1, broken: false, x: 0, y: 0 };
    const winterEve = at(10, 18.5); // 18:30 – v zimě už tma
    const summerEve = at(4, 18.5);  // v létě ještě svítí
    return {
      names: [at(0.5, 12).seasonName, at(3.5, 12).seasonName, at(6.5, 12).seasonName, at(9.5, 12).seasonName],
      demandWinter: +winterNoon._cityDemand(c, noonPhase).toFixed(1),
      demandSummer: +summerNoon._cityDemand(cS, noonPhase).toFixed(1),
      winterHigher: winterNoon._cityDemand(c, noonPhase) > summerNoon._cityDemand(cS, noonPhase) * 1.3,
      solarWinter: +winterNoon._genOf(fakeSolar, winterNoon.sun, 0).toFixed(1),
      solarSummer: +summerNoon._genOf(fakeSolar, summerNoon.sun, 0).toFixed(1),
      hydroSpring: +springNoon.seasonFx.hydro.toFixed(2),
      hydroAutumn: +autumnNoon.seasonFx.hydro.toFixed(2),
      windAutumn: +autumnNoon.seasonFx.wind.toFixed(2),
      windSpring: +springNoon.seasonFx.wind.toFixed(2),
      eveSunWinter: +winterEve.sun.toFixed(2),
      eveSunSummer: +summerEve.sun.toFixed(2),
      indSeasonal: winterNoon._industryDemand(winterNoon.map.industries[0], noonPhase) >
        summerNoon._industryDemand(summerNoon.map.industries[0], noonPhase),
    };
  });
  console.log('sezóny:', JSON.stringify(seasons));
  if (JSON.stringify(seasons.names) !== JSON.stringify(['jaro', 'léto', 'podzim', 'zima']))
    throw new Error('sezóny se nestřídají správně: ' + JSON.stringify(seasons.names));
  if (!seasons.winterHigher) throw new Error('zimní spotřeba není vyšší než letní: ' + seasons.demandWinter + ' vs ' + seasons.demandSummer);
  if (!(seasons.solarSummer > seasons.solarWinter * 1.8)) throw new Error('letní solár nepřevyšuje zimní: ' + seasons.solarSummer + ' vs ' + seasons.solarWinter);
  if (!(seasons.hydroSpring > seasons.hydroAutumn * 1.4)) throw new Error('jarní tání nezvedá průtoky: ' + seasons.hydroSpring + ' vs ' + seasons.hydroAutumn);
  if (!(seasons.windAutumn > seasons.windSpring)) throw new Error('podzim není větrnější než jaro');
  if (!(seasons.eveSunWinter === 0 && seasons.eveSunSummer > 0.3)) throw new Error('délka dne se sezónou nemění: ' + seasons.eveSunWinter + ' / ' + seasons.eveSunSummer);
  if (!seasons.indSeasonal) throw new Error('průmysl nereaguje na sezónu');

  // --- schéma rozvodny: přípojnice a toky výkonu (kam výkon jde) ---
  const schema = await page.evaluate(() => {
    const map = EG.generateMap(160, 42);
    const sim = new EG.Sim(map);
    sim.money = 1000000;
    const c = map.cities[0];
    let sub = null;
    for (let dy = -3; dy <= 3 && !sub; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (sim.canPlace('sub', c.x + dx, c.y + dy).ok) { sub = sim.place('sub', c.x + dx, c.y + dy); break; }
    }
    sim.buyTrafo(sub, 't220_110'); sim.buyTrafo(sub, 't110_22'); sim.buyTrafo(sub, 't22_04');
    let coal = null;
    for (let r = 1; r <= 8 && !coal; r++)
      for (let dy = -r; dy <= r && !coal; dy++) for (let dx = -r; dx <= r; dx++)
        if (sim.canPlace('coal', sub.x + dx, sub.y + dy).ok) { coal = sim.place('coal', sub.x + dx, sub.y + dy); break; }
    sim.connect(coal, sub, 220);
    for (let i = 0; i < 30; i++) sim.tick(0.1);
    const rows = EG.schemaData(sim, sub);
    const buses = rows.filter((r) => r.type === 'bus').map((r) => r.lv);
    const line = rows.find((r) => r.type === 'line');
    const trafos = rows.filter((r) => r.type === 'trafo');
    const loads = rows.filter((r) => r.type === 'load');
    return {
      buses,
      lineDir: line && line.dir, lineMw: line ? +line.mw.toFixed(1) : 0,
      lineFrom: line && line.label,
      nTrafos: trafos.length,
      trafosDown: trafos.every((t) => t.dir === 'down'),
      trafoMws: trafos.map((t) => +t.mw.toFixed(1)),
      cityLoad: loads.find((l) => l.label.startsWith('město')),
    };
  });
  console.log('schéma rozvodny:', JSON.stringify(schema));
  if (JSON.stringify(schema.buses) !== JSON.stringify([220, 110, 22, 0.4]))
    throw new Error('schéma nemá přípojnice 220/110/22/0,4: ' + JSON.stringify(schema.buses));
  if (schema.lineDir !== 'in' || !(schema.lineMw > 1)) throw new Error('schéma neukazuje přítok z vedení');
  if (!schema.lineFrom.includes('Uhelná')) throw new Error('schéma neukazuje odkud výkon teče: ' + schema.lineFrom);
  if (schema.nTrafos !== 3 || !schema.trafosDown) throw new Error('schéma neukazuje toky přes trafa dolů');
  if (!schema.trafoMws.every((m) => m > 1)) throw new Error('trafa ve schématu nemají tok: ' + JSON.stringify(schema.trafoMws));
  if (!schema.cityLoad || !(schema.cityLoad.mw > 1)) throw new Error('schéma neukazuje odběr města');

  // --- panel správy v živé hře: klik na budovu jako hráč ---
  const panel = await page.evaluate(() => {
    const { sim, map, renderer } = EG.game;
    sim.money = 50000;
    let bx = -1, by = -1;
    outer:
    for (let y = 0; y < map.size; y++) for (let x = 0; x < map.size; x++) {
      if (sim.canPlace('coal', x, y).ok) { bx = x; by = y; break outer; }
    }
    const coal = sim.place('coal', bx, by);
    coal.cond = 0.5; // ať jde servis koupit
    const [wx, wy] = renderer.tileToWorld(bx, by);
    renderer.cam.x = wx; renderer.cam.y = wy; renderer.cam.zoom = 1.5;
    return { bx, by, id: coal.id };
  });
  await page.waitForTimeout(300);
  // kamera je vycentrovaná na budovu → klik doprostřed obrazovky ji vybere
  const clickPos = await page.evaluate(() => {
    const cv = EG.game.renderer.canvas;
    return { x: cv.clientWidth / 2, y: cv.clientHeight / 2 };
  });
  await page.mouse.click(clickPos.x, clickPos.y);
  await page.waitForTimeout(300);
  const panelState = await page.evaluate(() => {
    const p = document.querySelector('#bpanel');
    const visible = !p.hidden;
    const title = document.querySelector('#bp-title').textContent;
    const moneyBefore = EG.game.sim.money;
    const svcBtn = document.querySelector('#bp-btn-svc');
    if (svcBtn && !svcBtn.disabled) svcBtn.click();
    const upBtn = document.querySelector('#bp-btn-up');
    if (upBtn && !upBtn.disabled) upBtn.click();
    const b = EG.game.sim.buildings[EG.game.sim.buildings.length - 1];
    return {
      visible, title,
      spent: Math.round(moneyBefore - EG.game.sim.money),
      condAfterSvc: b.cond, levelAfterUp: b.level,
    };
  });
  console.log('panel v živé hře:', JSON.stringify(panelState));
  // grafická odezva: hvězda modernizace a spol.
  const gfx = await page.evaluate(() => ({
    star: EG.atlas.S.STAR !== undefined,
    pip: EG.atlas.S.PIP !== undefined,
  }));
  if (!gfx.star || !gfx.pip) throw new Error('chybí sprity pro grafickou odezvu (STAR/PIP)');
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/eg_upgrade.png' });
  if (!panelState.visible) throw new Error('panel správy se po kliknutí neotevřel');
  if (!panelState.title.includes('Uhelná')) throw new Error('panel ukazuje špatnou budovu: ' + panelState.title);
  if (panelState.condAfterSvc !== 1) throw new Error('servis přes UI nefunguje');
  if (panelState.levelAfterUp !== 2) throw new Error('modernizace přes UI nefunguje');

  // --- panel rozvodny: nákup trafa klikáním v UI ---
  await page.evaluate(() => {
    const { sim, map, renderer } = EG.game;
    let sx = -1, sy = -1;
    outer:
    for (let y = 0; y < map.size; y++) for (let x = 0; x < map.size; x++) {
      if (sim.canPlace('sub', x, y).ok) { sx = x; sy = y; break outer; }
    }
    sim.place('sub', sx, sy);
    const [wx, wy] = renderer.tileToWorld(sx, sy);
    renderer.cam.x = wx; renderer.cam.y = wy;
  });
  await page.waitForTimeout(250);
  await page.mouse.click(clickPos.x, clickPos.y);
  await page.waitForTimeout(250);
  const subPanel = await page.evaluate(() => {
    const sim = EG.game.sim;
    const sub = sim.buildings[sim.buildings.length - 1];
    const visible = !document.querySelector('#bpanel').hidden;
    const title = document.querySelector('#bp-title').textContent;
    const nBuyBtns = document.querySelectorAll('.trafo-buy').length;
    const buyBtn = document.querySelector('.trafo-buy[data-trafo="t110_22"]');
    if (buyBtn && !buyBtn.disabled) buyBtn.click();
    return {
      visible, title, nBuyBtns,
      bought: (sub.trafos || {}).t110_22 || 0,
      levels: sim.levelsOf(sub).join(','),
    };
  });
  console.log('panel rozvodny:', JSON.stringify(subPanel));
  if (!subPanel.visible || !subPanel.title.includes('Rozvodna')) throw new Error('panel rozvodny se neotevřel: ' + subPanel.title);
  if (subPanel.nBuyBtns !== 17) throw new Error('má být 11 typů traf (vč. HVDC a dvou DC měníren) + 6 propojovacích polí, je ' + subPanel.nBuyBtns);
  if (subPanel.bought !== 1) throw new Error('nákup trafa přes UI nefunguje');
  if (!subPanel.levels.includes('110')) throw new Error('trafo nepřidalo 110kV přípojnici: ' + subPanel.levels);
  await page.waitForTimeout(250);
  const schemaUi = await page.evaluate(() => {
    const el = document.querySelector('#bp-schema');
    const svg = el.querySelector('svg.bp-svg');
    return {
      visible: !el.hidden, text: el.textContent,
      hasSvg: !!svg,
      busbars: svg ? svg.querySelectorAll('line[stroke-width="3.5"]').length : 0,
      trafoCircles: svg ? svg.querySelectorAll('circle[fill="none"]').length : 0,
    };
  });
  console.log('schéma v UI:', JSON.stringify({ visible: schemaUi.visible, hasSvg: schemaUi.hasSvg, busbars: schemaUi.busbars, trafoCircles: schemaUi.trafoCircles, has110: schemaUi.text.includes('110 kV') }));
  if (!schemaUi.visible || !schemaUi.text.includes('Schéma')) throw new Error('schéma se v panelu rozvodny nezobrazuje');
  if (!schemaUi.hasSvg) throw new Error('schéma není grafické (chybí SVG)');
  if (schemaUi.busbars !== 3) throw new Error('SVG nemá 3 přípojnice (110/22/0,4): ' + schemaUi.busbars);
  if (schemaUi.trafoCircles !== 2) throw new Error('SVG nemá značku trafa (2 kružnice): ' + schemaUi.trafoCircles);
  if (!schemaUi.text.includes('110 kV')) throw new Error('schéma neukazuje 110kV přípojnici po nákupu trafa');
  await page.screenshot({ path: '/tmp/eg_panel.png' });

  // --- panel předávacího bodu: sjednání smlouvy klikáním v UI ---
  await page.evaluate(() => {
    const { sim, renderer } = EG.game;
    const cr = sim.buildings.find((b) => b.kind === 'xborder');
    const [wx, wy] = renderer.tileToWorld(cr.x, cr.y);
    renderer.cam.x = wx; renderer.cam.y = wy;
  });
  await page.waitForTimeout(250);
  await page.mouse.click(clickPos.x, clickPos.y);
  await page.waitForTimeout(250);
  const xPanel = await page.evaluate(() => {
    const sim = EG.game.sim;
    const cr = sim.buildings.find((b) => b.kind === 'xborder');
    const visible = !document.querySelector('#bpanel').hidden;
    const title = document.querySelector('#bp-title').textContent;
    const rows = document.querySelectorAll('#bp-actions .bp-xrow');
    const importPlus = rows[0] && rows[0].querySelectorAll('button')[1];
    if (importPlus) importPlus.click();
    return { visible, title, nRows: rows.length, imp: cr.xImport, statsText: document.querySelector('#bp-stats').textContent };
  });
  console.log('panel předávacího bodu:', JSON.stringify({ visible: xPanel.visible, title: xPanel.title, nRows: xPanel.nRows, imp: xPanel.imp }));
  if (!xPanel.visible || !xPanel.title.includes('Soused')) throw new Error('panel předávacího bodu se neotevřel: ' + xPanel.title);
  if (xPanel.nRows !== 2) throw new Error('panel nemá řádky pro oba směry smluv');
  if (xPanel.imp !== 10) throw new Error('sjednání importu klikáním nefunguje: ' + xPanel.imp);
  if (!xPanel.statsText.includes('take-or-pay')) throw new Error('panel neukazuje podmínky smluv');

  // --- schovávací manuál ---
  const helpToggle = await page.evaluate(() => {
    const disp = () => getComputedStyle(document.querySelector('#help')).display;
    const btnDisp = () => getComputedStyle(document.querySelector('#btn-help')).display;
    const visibleAtStart = disp() !== 'none';
    document.querySelector('#help-close').click();
    const hiddenAfterClose = disp() === 'none';
    const btnShown = btnDisp() !== 'none';
    document.querySelector('#btn-help').click();
    const backAgain = disp() !== 'none' && btnDisp() === 'none';
    return { visibleAtStart, hiddenAfterClose, btnShown, backAgain, stored: localStorage.getItem('eg_help') };
  });
  console.log('manuál:', JSON.stringify(helpToggle));
  if (!helpToggle.visibleAtStart || !helpToggle.hiddenAfterClose || !helpToggle.btnShown || !helpToggle.backAgain)
    throw new Error('schovávání manuálu nefunguje: ' + JSON.stringify(helpToggle));
  if (helpToggle.stored !== '1') throw new Error('volba manuálu se neukládá');

  // --- suché a mokré roky: každý rok jiná hydrologie (0,75–1,25×) ---
  const hydroYears = await page.evaluate(() => {
    const map = EG.generateMap(160, 42);
    const sim = new EG.Sim(map);
    const at = (year) => { sim.time = year * sim.dayLen * 12 + sim.dayLen; sim.tick(0.001); return sim._hydroYearFx; };
    const fx = [at(0), at(1), at(2), at(3), at(4)].map((v) => +v.toFixed(3));
    const inRange = fx.every((v) => v >= 0.75 && v <= 1.25);
    const varies = new Set(fx).size >= 3;
    const forecastMsg = sim.messages.some((m) => m.text.includes('Hydrologická předpověď'));
    return { fx, inRange, varies, forecastMsg };
  });
  console.log('hydrologické roky:', JSON.stringify(hydroYears));
  if (!hydroYears.inRange) throw new Error('roční hydrologie mimo rozsah: ' + JSON.stringify(hydroYears.fx));
  if (!hydroYears.varies) throw new Error('roky se hydrologicky neliší: ' + JSON.stringify(hydroYears.fx));
  if (!hydroYears.forecastMsg) throw new Error('chybí novoroční hydrologická předpověď');

  // --- cheat „funds" a měna v eurech ---
  const beforeCheat = await page.evaluate(() => EG.game.sim.money);
  await page.keyboard.type('funds');
  await page.waitForTimeout(200);
  const cheat = await page.evaluate(() => ({
    money: EG.game.sim.money,
    hud: document.querySelector('#money').textContent,
  }));
  console.log('cheat funds:', JSON.stringify({ delta: Math.round(cheat.money - beforeCheat), hud: cheat.hud }));
  if (Math.round(cheat.money - beforeCheat) !== 1000) throw new Error('cheat funds nepřidal 1000: ' + (cheat.money - beforeCheat));
  if (!cheat.hud.includes('€')) throw new Error('měna není v eurech: ' + cheat.hud);

  // --- odstranění vedení: klik nástrojem X přímo na linku (přesná trefa) + vratka ---
  await page.evaluate(() => {
    const { sim, map, renderer } = EG.game;
    sim.money = 100000;
    let s1 = null, s2 = null;
    outer:
    for (let y = 0; y < map.size; y++) for (let x = 0; x < map.size; x++) {
      if (!sim.canPlace('sub', x, y).ok) continue;
      if (!s1) { s1 = sim.place('sub', x, y); continue; }
      const d = Math.hypot(x - s1.x, y - s1.y);
      if (d >= 3 && d <= 4.5) { s2 = sim.place('sub', x, y); break outer; }
    }
    window.__delTest = { s1, s2, line: sim.connect(s1, s2, 0.4), nBefore: sim.lines.length, moneyBefore: sim.money };
    // kamera na střed spojnice
    const [wx, wy] = renderer.tileToWorld((s1.x + s2.x) / 2, (s1.y + s2.y) / 2);
    renderer.cam.x = wx; renderer.cam.y = wy; renderer.cam.zoom = 1.6;
    document.querySelector('.tool[data-tool="demolish"]').click();
  });
  await page.waitForTimeout(250);
  await page.mouse.click(clickPos.x, clickPos.y); // střed obrazovky = střed linky
  await page.waitForTimeout(200);
  const delLine = await page.evaluate(() => {
    const { sim } = EG.game;
    const t = window.__delTest;
    const removed = !sim.lines.includes(t.line);
    document.querySelector('.tool[data-tool="pan"]').click();
    return {
      lineOk: !!t.line, removed,
      nAfter: sim.lines.length, nBefore: t.nBefore,
      refund: +(sim.money - t.moneyBefore).toFixed(1),
    };
  });
  console.log('odstranění vedení:', JSON.stringify(delLine));
  if (!delLine.lineOk) throw new Error('testovací vedení se nepostavilo');
  if (!delLine.removed || delLine.nAfter !== delLine.nBefore - 1) throw new Error('klik nástrojem X vedení neodstranil');
  if (!(delLine.refund > 0)) throw new Error('za odstraněné vedení není vratka: ' + delLine.refund);

  // --- paleta napětí: skrytá v prohlížení, viditelná u nástroje vedení, 10 úrovní,
  //     různé max. délky přímo v popiscích ---
  const linebar = await page.evaluate(() => {
    const disp = () => getComputedStyle(document.querySelector('#linebar')).display;
    const hiddenInPan = disp() === 'none';
    document.querySelector('.tool[data-tool="line"]').click();
    const visibleInLine = disp() !== 'none';
    const lvlBtns = [...document.querySelectorAll('.linelvl[data-level]')];
    const nLevels = lvlBtns.length;
    const cell = (el, cls) => {
      const c = el.querySelector(cls);
      return c ? parseFloat(c.textContent) : null;
    };
    const maxLens = lvlBtns.map((el) => cell(el, '.lv-len'));
    const caps = lvlBtns.map((el) => cell(el, '.lv-cap'));
    const costs = lvlBtns.map((el) => cell(el, '.lv-cost'));
    const maxLensDiffer = new Set(maxLens).size === maxLens.length && !maxLens.includes(null);
    // údaje v liště musí sedět s tím, co o hladině tvrdí simulace
    const dataOk = lvlBtns.every((el) => {
      const LT = EG.LINE_TYPES[+el.dataset.level];
      return cell(el, '.lv-cap') === LT.cap && cell(el, '.lv-len') === LT.maxLen &&
        cell(el, '.lv-cost') === LT.cost;
    });
    const groups = [...document.querySelectorAll('#linebar .line-group')].map((el) => el.textContent);
    // přepínač kabelu je zvlášť, ne jako další napěťová úroveň
    const cbl = document.getElementById('btn-cable');
    const cableIsLevel = cbl.dataset.level !== undefined;
    cbl.click();
    const cableOn = cbl.classList.contains('active');
    cbl.click();
    const cableOff = !cbl.classList.contains('active');

    document.querySelector('.linelvl[data-level="400"]').click();
    const activeAfterClick = document.querySelector('.linelvl.active').dataset.level;
    document.querySelector('.tool[data-tool="pan"]').click();
    const hiddenAgain = disp() === 'none';
    return {
      hiddenInPan, visibleInLine, nLevels, hiddenAgain, maxLens, maxLensDiffer,
      caps, costs, dataOk, groups, cableIsLevel, cableOn, cableOff, activeAfterClick,
    };
  });
  console.log('paleta napětí:', JSON.stringify(linebar));
  if (!linebar.hiddenInPan || !linebar.visibleInLine || !linebar.hiddenAgain) throw new Error('paleta napětí se špatně schovává/ukazuje');
  if (linebar.nLevels !== 10) throw new Error('má být 10 napěťových úrovní (vč. HVDC a dvou DC), je ' + linebar.nLevels);
  if (!linebar.maxLensDiffer) throw new Error('každá úroveň má mít vlastní max. délku v popisku: ' + JSON.stringify(linebar.maxLens));
  if (!linebar.dataOk) throw new Error('čísla v liště nesedí s parametry hladin: ' + JSON.stringify(linebar));
  if (linebar.groups.length !== 4) throw new Error('hladiny nejsou po skupinách: ' + JSON.stringify(linebar.groups));
  if (linebar.cableIsLevel) throw new Error('podzemní kabel se tváří jako napěťová úroveň');
  if (!linebar.cableOn || !linebar.cableOff) throw new Error('přepínač kabelu se nepřepíná');
  if (linebar.activeAfterClick !== '400') throw new Error('klik na hladinu ji nezvýraznil: ' + linebar.activeAfterClick);

  // --- max. délky se u úrovní liší a vynucují se ---
  const maxLen = await page.evaluate(() => {
    const lens = EG.LEVELS.map((lv) => EG.LINE_TYPES[lv].maxLen);
    const map = EG.generateMap(160, 43);
    const sim = new EG.Sim(map);
    sim.money = 1000000;
    // dvě rozvodny s 400kV i 22kV přípojnicí ve vzdálenosti 15–20 dlaždic
    let s1 = null, s2 = null;
    outer:
    for (let y = 0; y < map.size; y++) for (let x = 0; x < map.size; x++) {
      if (!sim.canPlace('sub', x, y).ok) continue;
      if (!s1) { s1 = sim.place('sub', x, y); continue; }
      const d = Math.hypot(x - s1.x, y - s1.y);
      if (d >= 15 && d <= 20) { s2 = sim.place('sub', x, y); break outer; }
    }
    for (const s of [s1, s2]) { sim.buyTrafo(s, 't400_110'); sim.buyTrafo(s, 't110_22'); }
    const far22 = sim.connect(s1, s2, 22);    // 22 kV: max 14 -> musí selhat
    const ok400 = sim.connect(s1, s2, 400);   // 400 kV: max 48 -> projde
    return { lens, unique: new Set(lens).size, far22Null: far22 === null, ok400: !!ok400 };
  });
  console.log('max. délky:', JSON.stringify(maxLen));
  if (maxLen.unique !== 10) throw new Error('úrovně nemají rozdílné max. délky: ' + JSON.stringify(maxLen.lens));
  if (!maxLen.far22Null) throw new Error('22 kV vedení delší než 14 dlaždic prošlo');
  if (!maxLen.ok400) throw new Error('400 kV vedení na stejnou vzdálenost neprošlo');

  // --- opravy chyb: vratka kabelu, undo přehrady, zámek po bankrotu, save/load stavu ---
  const fixes = await page.evaluate(() => {
    const r = {};
    const map = EG.generateMap(160, 99);
    const sim = new EG.Sim(map);
    sim.money = 1000000;

    // 1) podzemní kabel: vratka počítá s příplatkem 2,5×
    let s1 = null, s2 = null;
    outer:
    for (let y = 0; y < map.size; y++) for (let x = 0; x < map.size; x++) {
      if (!sim.canPlace('sub', x, y).ok) continue;
      if (!s1) { s1 = sim.place('sub', x, y); continue; }
      const d = Math.hypot(x - s1.x, y - s1.y);
      if (d >= 5 && d <= 10) { s2 = sim.place('sub', x, y); break outer; }
    }
    for (const s of [s1, s2]) sim.buyTrafo(s, 't110_22');
    const mCable0 = sim.money;
    const cableL = sim.connect(s1, s2, 22, true);
    const cablePaid = mCable0 - sim.money;
    const mCable1 = sim.money;
    sim.removeLine(cableL);
    r.cablePaid = cablePaid;
    r.cableRefund = sim.money - mCable1;
    r.cableRefundOk = r.cableRefund === Math.floor(cablePaid * 0.4);

    // 2) revert přehrady vrátí terén (nádrž i průtoky)
    let dx = -1, dy = -1;
    outer2:
    for (let y = 0; y < map.size; y++) for (let x = 0; x < map.size; x++) {
      if (map.type[map.idx(x, y)] === EG.T.RIVER && sim.canPlace('dam', x, y).ok) { dx = x; dy = y; break outer2; }
    }
    const typeBefore = map.type.slice();
    const flowBefore = map.flow.slice();
    const dam = sim.place('dam', dx, dy);
    let changed = 0;
    for (let i = 0; i < map.type.length; i++) {
      if (map.type[i] !== typeBefore[i] || map.flow[i] !== flowBefore[i]) changed++;
    }
    r.damChangedTiles = changed;
    r.damReverted = sim._revertDam(dam);
    let diffAfter = 0;
    for (let i = 0; i < map.type.length; i++) {
      if (map.type[i] !== typeBefore[i] || map.flow[i] !== flowBefore[i]) diffAfter++;
    }
    r.damDiffAfterRevert = diffAfter;

    // 3) po bankrotu jsou akce zamčené
    sim.gameOver = true;
    const mOver = sim.money;
    const placeOver = sim.place('sub', s1.x + 2, s1.y + 2);
    const loanOver = sim.takeLoan(2000);
    r.overLocked = placeOver === null && loanOver === false && sim.money === mOver;
    sim.gameOver = false;

    // 4) save/load: hardMode, gameOver a stav RNG přežijí uložení
    sim.hardMode = true;
    for (let i = 0; i < 5; i++) sim._rng();
    const rngState = sim._rng.getState();
    const saved = EG.serialize(sim);
    const restored = EG.restore(saved);
    r.hardKept = restored.hardMode === true;
    r.rngKept = restored._rng.getState() === rngState;
    sim.gameOver = true;
    r.overKept = EG.restore(EG.serialize(sim)).gameOver === true;

    // 5) validace save: špatná verze a poškozený terén se odmítnou
    try { EG.restore(JSON.stringify({ v: 2 })); r.badVersionRejected = false; }
    catch (e) { r.badVersionRejected = true; }
    try {
      const dd = JSON.parse(saved);
      dd.type = dd.type.slice(0, 40);
      EG.restore(JSON.stringify(dd));
      r.corruptRejected = false;
    } catch (e) { r.corruptRejected = true; }
    return r;
  });
  console.log('opravy chyb:', JSON.stringify(fixes));
  if (!fixes.cableRefundOk) throw new Error('vratka kabelu nesedí: ' + JSON.stringify(fixes));
  if (!(fixes.damChangedTiles > 0)) throw new Error('přehrada nezměnila terén (test je vadný)');
  if (!fixes.damReverted || fixes.damDiffAfterRevert !== 0) throw new Error('revert přehrady nevrátil terén: ' + fixes.damDiffAfterRevert);
  if (!fixes.overLocked) throw new Error('po bankrotu jde dál stavět/půjčovat');
  if (!fixes.hardKept || !fixes.rngKept || !fixes.overKept) throw new Error('save/load neuchová hardMode/gameOver/RNG: ' + JSON.stringify(fixes));
  if (!fixes.badVersionRejected || !fixes.corruptRejected) throw new Error('poškozený save projde validací');

  // --- undo přes UI: postavit rozvodnu klikem, Ctrl+Z ji vrátí i s penězi ---
  const undoPrep = await page.evaluate(() => {
    const { sim, map, renderer } = EG.game;
    // pauza, ať průběžné příjmy nezkreslí kontrolu vratky
    const spd = document.querySelector('#btn-speed');
    let guard = 0;
    while (!spd.textContent.includes('pauza') && guard++ < 5) spd.click();
    sim.money = 10000;
    // volné místo s rezervou kolem (klik se trefí i po zaokrouhlení)
    let bx = -1, by = -1;
    outer:
    for (let y = 2; y < map.size - 2; y++) for (let x = 2; x < map.size - 2; x++) {
      let ok = true;
      for (let ddy = -1; ddy <= 1 && ok; ddy++) for (let ddx = -1; ddx <= 1; ddx++) {
        if (!sim.canPlace('sub', x + ddx, y + ddy).ok) { ok = false; break; }
      }
      if (ok) { bx = x; by = y; break outer; }
    }
    const [wx, wy] = renderer.tileToWorld(bx, by);
    renderer.cam.x = wx; renderer.cam.y = wy; renderer.cam.zoom = 1.5;
    document.querySelector('.tool[data-tool="sub"]').click();
    return { nBefore: sim.buildings.length, money: sim.money };
  });
  await page.waitForTimeout(200);
  await page.mouse.click(clickPos.x, clickPos.y);
  await page.waitForTimeout(200);
  const undoPlaced = await page.evaluate(() => ({
    n: EG.game.sim.buildings.length, money: EG.game.sim.money,
  }));
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  const undoDone = await page.evaluate(() => {
    document.querySelector('.tool[data-tool="pan"]').click();
    document.querySelector('#btn-speed').click(); // pauza -> 1×
    return { n: EG.game.sim.buildings.length, money: EG.game.sim.money };
  });
  console.log('undo přes UI:', JSON.stringify({ ...undoPrep, placed: undoPlaced, done: undoDone }));
  if (undoPlaced.n !== undoPrep.nBefore + 1) throw new Error('stavba rozvodny klikem nevyšla');
  if (undoDone.n !== undoPrep.nBefore) throw new Error('Ctrl+Z stavbu neodstranil');
  if (undoDone.money !== undoPrep.money) throw new Error('Ctrl+Z nevrátil peníze: ' + undoDone.money + ' vs ' + undoPrep.money);

  // --- vítr jako rozmarný zdroj: výkonová křivka, bezvětří, odstavení ---
  const windTest = await page.evaluate(() => {
    const W = EG.WIND;
    const curve = EG.windCurve;
    // výkonová křivka: stojí pod rozběhem, roste, drží, nad vypínací nula
    const shape = {
      belowCutIn: curve(W.cutIn - 0.2),
      justAbove: curve(W.cutIn + 0.3),
      mid: curve((W.cutIn + W.rated) / 2),
      atRated: curve(W.rated),
      aboveRated: curve(W.rated + 5),
      aboveCutOut: curve(W.cutOut + 1),
    };
    // roste monotónně mezi rozběhovou a jmenovitou rychlostí
    let monotone = true;
    for (let v = W.cutIn; v < W.rated - 0.1; v += 0.25) {
      if (curve(v + 0.25) < curve(v)) { monotone = false; break; }
    }

    const map = EG.generateMap(160, 4242);
    const sim = new EG.Sim(map);
    sim.money = 1000000;
    // turbína na kopci (větrnější) a na rovině
    let hill = null, flat = null;
    for (let y = 0; y < map.size && !(hill && flat); y++) for (let x = 0; x < map.size; x++) {
      const t = map.type[map.idx(x, y)];
      if (!sim.canPlace('wind', x, y).ok) continue;
      if (!hill && t === EG.T.HILL) hill = sim.place('wind', x, y);
      else if (!flat && t === EG.T.GRASS) flat = sim.place('wind', x, y);
      if (hill && flat) break;
    }
    sim.tick(0.1);
    const hillWindier = sim.windAt(hill) > sim.windAt(flat);

    /* dlouhodobý chod přes několik let: kolik času turbína stojí, jak často
       jede na plno a jaké je využití. U větru se čeká vysoká variabilita,
       ne stabilní pásmo – proto se měří i rozptyl rychlosti. */
    let samples = 0, stopped = 0, full = 0, sumCurve = 0, minV = Infinity, maxV = -Infinity;
    const yearLen = sim.dayLen * 12;
    // servisní smlouva, aby výsledek nezkreslilo opotřebení za pět let
    flat.contract = true; hill.contract = true;
    for (let i = 0; i < 6000; i++) {
      sim.tick(yearLen * 5 / 6000);
      samples++;
      const v = sim.windSpeed;
      minV = Math.min(minV, v); maxV = Math.max(maxV, v);
      const p = curve(sim.windAt(flat));
      if (p === 0) stopped++;
      if (p === 1) full++;
      sumCurve += p;
    }
    const capFactor = sumCurve / samples;
    const stoppedShare = stopped / samples;

    // bezvětří: vyvolaná událost turbíny zastaví úplně
    sim.triggerEvent('calm', { dur: 40 });
    for (let i = 0; i < 20; i++) sim.tick(0.2);
    const calmSpeed = sim.windSpeed;
    const calmGen = hill.gen + flat.gen;
    const calmFlagged = !!sim.calmActive;

    // větrník na vodě má vyšší štítek i vyšší rychlost než na pevnině
    sim.events = [];
    let ow = null;
    for (let y = 0; y < map.size && !ow; y++) for (let x = 0; x < map.size; x++) {
      if (sim.canPlace('owind', x, y).ok) { ow = sim.place('owind', x, y); break; }
    }
    sim.tick(0.1);
    const seaWindier = ow ? sim.windAt(ow) > sim.windAt(flat) : false;

    /* bouřkový vítr: nad vypínací rychlostí se turbína odstaví a drží
       odstávku (hystereze), dokud vítr nepoleví pod restartovací rychlost.
       Rychlost se vnucuje přes windAt – tick si ji jinak přepočítá sám. */
    const forceWind = (v) => { sim.windAt = () => v; };
    flat.cond = 1; flat.broken = false; // ať výsledek neovlivní technický stav
    forceWind(W.cutOut + 3);
    sim.tick(0.05);
    const cutOutStopped = flat.wcut === true && flat.gen === 0;
    // vítr poleví jen mírně (mezi restartovací a vypínací) – stále stojí
    forceWind((W.restart + W.cutOut) / 2);
    sim.tick(0.05);
    const hysteresisHolds = flat.wcut === true && flat.gen === 0;
    // až pod restartovací rychlostí se rozjede
    forceWind(W.rated);
    sim.tick(0.05);
    const restarted = flat.wcut === false && flat.gen > 20;

    return {
      shape, monotone, hillWindier, seaWindier, cutIn: W.cutIn,
      capFactor: +capFactor.toFixed(3), stoppedShare: +stoppedShare.toFixed(3),
      fullShare: +(full / samples).toFixed(3),
      minV: +minV.toFixed(1), maxV: +maxV.toFixed(1),
      calmSpeed: +calmSpeed.toFixed(2), calmGen: +calmGen.toFixed(2), calmFlagged,
      cutOutStopped, hysteresisHolds, restarted,
      cond: +flat.cond.toFixed(2), broken: !!flat.broken, genAfter: +flat.gen.toFixed(1),
    };
  });
  console.log('vítr:', JSON.stringify(windTest));
  if (windTest.shape.belowCutIn !== 0 || windTest.shape.aboveCutOut !== 0) {
    throw new Error('turbína vyrábí mimo pracovní rozsah: ' + JSON.stringify(windTest.shape));
  }
  if (windTest.shape.atRated !== 1 || windTest.shape.aboveRated !== 1) throw new Error('nad jmenovitou rychlostí nedrží štítkový výkon');
  if (!(windTest.shape.justAbove < 0.1)) throw new Error('těsně nad rozběhem má být výkon minimální (P~v³)');
  if (!windTest.monotone) throw new Error('výkonová křivka není monotónní');
  if (!windTest.hillWindier) throw new Error('na kopci nefouká víc než na rovině');
  if (!windTest.seaWindier) throw new Error('nad vodou nefouká víc než na pevnině');
  // rozmarnost: turbína musí občas stát úplně a jen zřídka jet na plno
  if (!(windTest.stoppedShare > 0.05)) throw new Error('turbína nikdy nestojí – vítr je moc stabilní: ' + windTest.stoppedShare);
  if (!(windTest.capFactor > 0.18 && windTest.capFactor < 0.55)) {
    throw new Error('nereálné využití větru (má být ~0,2–0,5): ' + windTest.capFactor);
  }
  if (!(windTest.fullShare > 0.02)) throw new Error('turbína se nikdy nedostane na štítkový výkon: ' + windTest.fullShare);
  if (!(windTest.minV < 2 && windTest.maxV > 20)) throw new Error('rychlost větru nemá realistický rozptyl: ' + windTest.minV + '–' + windTest.maxV);
  if (!(windTest.calmGen === 0 && windTest.calmSpeed < windTest.cutIn)) throw new Error('bezvětří turbíny nezastavilo: ' + JSON.stringify(windTest));
  if (!windTest.calmFlagged) throw new Error('bezvětří se nepropíše do stavu hry');
  if (!windTest.cutOutStopped) throw new Error('bouřkový vítr turbínu neodstavil');
  if (!windTest.hysteresisHolds) throw new Error('odstavená turbína se rozjela dřív, než vítr polevil (chybí hystereze)');
  if (!windTest.restarted) throw new Error('turbína se po zklidnění větru nerozjela');

  // --- velké bateriové úložiště na stejnosměrných 500 V ---
  const bess = await page.evaluate(() => {
    const map = EG.generateMap(160, 77);
    const sim = new EG.Sim(map);
    sim.money = 1000000;
    const sd = EG.STORAGE.bess;
    const dcLevel = EG.GEN_LEVEL.bess;

    // rozvodna u města + kaskáda do NN
    const c = map.cities[0];
    let sub = null;
    for (let r = 1; r <= 4 && !sub; r++)
      for (let dy = -r; dy <= r && !sub; dy++) for (let dx = -r; dx <= r; dx++)
        if (sim.canPlace('sub', c.x + dx, c.y + dy).ok) { sub = sim.place('sub', c.x + dx, c.y + dy); break; }
    sim.buyTrafo(sub, 't220_110'); sim.buyTrafo(sub, 't110_22'); sim.buyTrafo(sub, 't22_04');

    // úložiště hned u rozvodny (DC přípojnice snese jen pár dlaždic)
    let store = null;
    for (let r = 1; r <= 3 && !store; r++)
      for (let dy = -r; dy <= r && !store; dy++) for (let dx = -r; dx <= r; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > EG.LINE_TYPES[dcLevel].maxLen) continue;
        if (sim.canPlace('bess', sub.x + dx, sub.y + dy).ok) { store = sim.place('bess', sub.x + dx, sub.y + dy); break; }
      }
    // bez měnírny nemá rozvodna DC přípojnici -> spojení musí selhat
    const withoutConverter = sim.connect(store, sub, dcLevel);
    // ani na 22 kV se baterie připojit nedá (vyrábí stejnosměrně)
    const onAc = sim.connect(store, sub, 22);
    sim.buyTrafo(sub, 'tdc05');
    const dcLine = sim.connect(store, sub, dcLevel);
    // DC hladinu nelze táhnout na dálku (nízké napětí = obrovské proudy)
    let far = null;
    for (let r = EG.LINE_TYPES[dcLevel].maxLen + 2; r <= 8 && !far; r++)
      for (let dy = -r; dy <= r && !far; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.hypot(dx, dy) <= EG.LINE_TYPES[dcLevel].maxLen + 1) continue;
        if (sim.canPlace('bess', sub.x + dx, sub.y + dy).ok) { far = sim.place('bess', sub.x + dx, sub.y + dy); break; }
      }
    const farLine = far ? sim.connect(far, sub, dcLevel) : 'nenalezeno';

    // uhelná jako zdroj přebytku
    let coal = null;
    for (let r = 1; r <= 8 && !coal; r++)
      for (let dy = -r; dy <= r && !coal; dy++) for (let dx = -r; dx <= r; dx++)
        if (sim.canPlace('coal', sub.x + dx, sub.y + dy).ok) { coal = sim.place('coal', sub.x + dx, sub.y + dy); break; }
    sim.connect(coal, sub, 220);

    // nabíjení z přebytku
    for (let i = 0; i < 40; i++) sim.tick(0.1);
    const charging = store.storMode;
    const chargedSome = store.charge > 5;
    // dobít až po strop a ověřit, že strop je opravdu velký
    for (let i = 0; i < 4000 && store.charge < sd.cap - 1; i++) sim.tick(0.2);
    const fullCharge = store.charge;

    // deficit: uhelné dojde palivo -> baterie drží město
    coal.fuel = 0; coal.mothball = true;
    sim.tick(0.1);
    const dischargeMode = store.storMode;
    const chargeBefore = store.charge;
    for (let i = 0; i < 30; i++) sim.tick(0.1);
    const drained = store.charge < chargeBefore - 1;
    const cityHeld = map.cities[0].powered;

    /* velký deficit: úložiště musí dodat řádově víc než malý zásobník
       (dispečink jinak vybíjí jen do výše chybějícího výkonu) */
    store.charge = sd.cap;
    map.cities[0].pop = 140;
    let peakOut = 0;
    for (let i = 0; i < 20; i++) { sim.tick(0.05); peakOut = Math.max(peakOut, store.out); }
    const bigDeficitDemand = sim.stats.demand;

    // stejnosměrná hladina nemá jalový výkon -> žádná penalizace kapacity
    const dcNoReactive = dcLine ? (dcLine.effCap === dcLine.cap) : false;

    return {
      placed: !!store, dcLevel,
      withoutConverterNull: withoutConverter === null,
      onAcNull: onAc === null,
      dcLineOk: !!dcLine,
      farLineNull: farLine === null || farLine === 'nenalezeno',
      cap: sd.cap, maxP: sd.maxP, eff: sd.eff, smallMaxP: EG.STORAGE.battery.maxP,
      biggerThanSmall: sd.cap > EG.STORAGE.battery.cap * 4 && sd.maxP > EG.STORAGE.battery.maxP * 4,
      charging, chargedSome, fullCharge: +fullCharge.toFixed(1),
      dischargeMode, peakOut: +peakOut.toFixed(1), drained,
      bigDeficitDemand: +bigDeficitDemand.toFixed(0),
      cityHeld: +(cityHeld || 0).toFixed(2), dcNoReactive,
      inObjList: EG.STORAGE.bess !== undefined,
    };
  });
  console.log('velké úložiště (DC 500 V):', JSON.stringify(bess));
  if (!bess.placed) throw new Error('velké úložiště nejde postavit');
  if (bess.dcLevel !== 0.5) throw new Error('úložiště se nepřipojuje na 500 V DC: ' + bess.dcLevel);
  if (!bess.withoutConverterNull) throw new Error('DC vedení prošlo i bez měnírny v rozvodně');
  if (!bess.onAcNull) throw new Error('baterii šlo připojit přímo na střídavých 22 kV');
  if (!bess.dcLineOk) throw new Error('DC vedení po nákupu měnírny neprošlo');
  if (!bess.farLineNull) throw new Error('DC 500 V šlo natáhnout na velkou vzdálenost');
  if (!bess.biggerThanSmall) throw new Error('velké úložiště není výrazně větší než malý zásobník');
  if (bess.charging !== 'nabíjí' || !bess.chargedSome) throw new Error('úložiště se nenabíjí z přebytků');
  if (!(bess.fullCharge > bess.cap * 0.9)) throw new Error('úložiště se nedobilo: ' + bess.fullCharge);
  if (bess.dischargeMode !== 'vybíjí') throw new Error('úložiště při deficitu nevybíjí');
  if (!bess.drained) throw new Error('vybíjení neubírá zásobu');
  if (!(bess.peakOut > bess.smallMaxP * 2)) {
    throw new Error('úložiště nedodává velký výkon (' + bess.peakOut + ' MW při poptávce ' + bess.bigDeficitDemand + ' MW)');
  }
  if (!(bess.cityHeld > 0.5)) throw new Error('úložiště nedrží město při výpadku: ' + bess.cityHeld);
  if (!bess.dcNoReactive) throw new Error('DC přípojnice je penalizovaná za jalový výkon');

  // --- Tesla Power Grid: bateriová farma na ploše 10×10 s DC 1500 V ---
  const mega = await page.evaluate(() => {
    const map = EG.generateMap(226, 1234);
    const sim = new EG.Sim(map);
    sim.money = 10000000;
    const sd = EG.STORAGE.tesla;
    const dcLevel = EG.GEN_LEVEL.tesla;
    const LT = EG.LINE_TYPES[dcLevel];

    // najít místo, kde se vejde celý areál 10×10
    let spot = null, tooSmallRejected = false;
    for (let y = 12; y < map.size - 12 && !spot; y++) for (let x = 12; x < map.size - 12; x++) {
      if (sim.canPlace('tesla', x, y).ok) { spot = [x, y]; break; }
    }
    // na vodě to nesmí jít ani jednou dlaždicí
    for (let y = 0; y < map.size && !tooSmallRejected; y++) for (let x = 0; x < map.size; x++) {
      if (map.type[map.idx(x, y)] === EG.T.WATER) {
        tooSmallRejected = !sim.canPlace('tesla', x, y).ok;
        break;
      }
    }
    const farm = sim.place('tesla', spot[0], spot[1]);
    const f = sim.footprintOf(farm);
    const tiles = (f.x1 - f.x0 + 1) * (f.y1 - f.y0 + 1);

    // celá plocha je obsazená: stavba se najde i v rohu, jinam nic nejde
    const foundAtCorner = sim.buildingAt(f.x0, f.y0) === farm &&
      sim.buildingAt(f.x1, f.y1) === farm && sim.buildingAt(f.x1, f.y0) === farm;
    const insideBlocked = !sim.canPlace('sub', f.x0 + 3, f.y0 + 3).ok;
    const overlapBlocked = !sim.canPlace('tesla', spot[0] + 4, spot[1]).ok;
    const outsideFree = sim.buildingAt(f.x1 + 1, f.y1 + 1) === null;

    // rozvodna hned u hrany areálu (DC přípojnice zvládne 6 dlaždic)
    let sub = null;
    for (let r = 5; r <= 7 && !sub; r++)
      for (let dy = -r; dy <= r && !sub; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.hypot(dx, dy) > LT.maxLen) continue;
        if (sim.canPlace('sub', farm.x + dx, farm.y + dy).ok) { sub = sim.place('sub', farm.x + dx, farm.y + dy); break; }
      }
    // bez měnírny 400/1,5 se farma nepřipojí
    const withoutConverter = sim.connect(farm, sub, dcLevel);
    sim.buyTrafo(sub, 'tdc15');
    const dcLine = sim.connect(farm, sub, dcLevel);
    // DC přívod musí unést plný výkon farmy
    const feedCoversFullPower = LT.cap >= sd.maxP * EG.levelMult(1);

    // cesta do sítě: 400 kV z farmy dolů na 22 kV k městu (a 220 kV pro uhelnou);
    // tolik traf i vývodů se vejde jen do modernizované rozvodny
    sim.upgrade(sub); sim.upgrade(sub);
    sim.buyTrafo(sub, 't400_220'); sim.buyTrafo(sub, 't400_110');
    sim.buyTrafo(sub, 't110_22'); sim.buyTrafo(sub, 't22_04');
    let coal = null;
    for (let r = 1; r <= 10 && !coal; r++)
      for (let dy = -r; dy <= r && !coal; dy++) for (let dx = -r; dx <= r; dx++)
        if (sim.canPlace('coal', sub.x + dx, sub.y + dy).ok) { coal = sim.place('coal', sub.x + dx, sub.y + dy); break; }
    sim.connect(coal, sub, 220);

    // nabíjení z přebytku uhelné
    for (let i = 0; i < 40; i++) sim.tick(0.1);
    const charging = farm.storMode;
    const chargedSome = farm.charge > 5;

    /* vybíjení plným výkonem: v komponentě musí vzniknout velký deficit.
       Polohu farmy určuje volná plocha 10×10, ne blízkost měst, takže se
       velké město pro účel testu přesune do dosahu rozvodny. */
    const city = map.cities[0];
    const away = Math.sign(sub.x - farm.x) || 1;
    city.x = sub.x + away; city.y = sub.y;
    city.pop = 600;
    farm.charge = sd.cap;
    coal.mothball = true;
    let peakOut = 0;
    for (let i = 0; i < 20; i++) { sim.tick(0.05); peakOut = Math.max(peakOut, farm.out); }
    const megaDemand = sim.stats.demand;

    // demolice kliknutím kdekoli v areálu odstraní celou farmu
    const nBefore = sim.buildings.length;
    sim.demolish(f.x0 + 2, f.y0 + 7);
    const demolishedFromCorner = sim.buildings.length === nBefore - 1 &&
      sim.buildings.indexOf(farm) === -1;

    return {
      spot, tiles, size: f.s, cost: EG.BUILD.tesla.cost,
      cap: sd.cap, maxP: sd.maxP, eff: sd.eff,
      capVsH2: +(sd.cap / EG.STORAGE.h2.cap).toFixed(1),
      dcLevel, dcCap: LT.cap, dcMaxLen: LT.maxLen,
      tooSmallRejected, foundAtCorner, insideBlocked, overlapBlocked, outsideFree,
      withoutConverterNull: withoutConverter === null, dcLineOk: !!dcLine,
      dcLineLen: dcLine ? +dcLine.len.toFixed(1) : null,
      feedCoversFullPower, charging, chargedSome,
      peakOut: +peakOut.toFixed(1), megaDemand: +megaDemand.toFixed(0), demolishedFromCorner,
    };
  });
  console.log('Tesla Power Grid:', JSON.stringify(mega));
  if (mega.size !== 10 || mega.tiles !== 100) throw new Error('areál nemá 10×10 dlaždic: ' + mega.size + '/' + mega.tiles);
  if (mega.capVsH2 !== 15) throw new Error('kapacita nemá být 15× vodík, je ' + mega.capVsH2 + '×');
  if (mega.cost !== 30000) throw new Error('cena má být 30 000, je ' + mega.cost);
  if (!mega.tooSmallRejected) throw new Error('areál jde postavit i na vodě');
  if (!mega.foundAtCorner) throw new Error('stavba se nenajde v rozích svého areálu');
  if (!mega.insideBlocked) throw new Error('do areálu jde postavit jiná stavba');
  if (!mega.overlapBlocked) throw new Error('dva areály se mohou překrývat');
  if (!mega.outsideFree) throw new Error('areál blokuje i dlaždice mimo sebe');
  if (!mega.withoutConverterNull) throw new Error('farma se připojila bez měnírny 400/1,5');
  if (!mega.dcLineOk) throw new Error('DC 1500 V po nákupu měnírny neprošlo');
  if (!mega.feedCoversFullPower) throw new Error('DC přívod neunese plný výkon: ' + mega.dcCap + ' < ' + mega.maxP);
  if (mega.charging !== 'nabíjí' || !mega.chargedSome) throw new Error('farma se nenabíjí z přebytků');
  if (!(mega.peakOut > mega.maxP * 0.9)) throw new Error('farma nedodá plný výkon: ' + mega.peakOut + ' z ' + mega.maxP);
  if (!mega.demolishedFromCorner) throw new Error('demolice kliknutím v areálu farmu neodstranila');

  // --- městská elektrická doprava: trolejbusy, tramvaje a metro ---
  const mhd = await page.evaluate(() => {
    const map = EG.generateMap(160, 42);
    const sim = new EG.Sim(map);
    sim.money = 1000000;
    sim.tick(0.001); // ať jsou k dispozici sezónní koeficienty
    const c = map.cities[0];
    const atH = (h) => ((h - 6 + 24) % 24) / 24; // hodina -> fáze dne

    // trakční měnírna chce VN: bez rozvodny s 22 kV to nejde
    c.pop = 30;
    const noSubRejected = sim.canBuyTransit(c, 'trolley');
    let sub = null;
    for (let r = 1; r <= 4 && !sub; r++) {
      for (let dy = -r; dy <= r && !sub; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (sim.canPlace('sub', c.x + dx, c.y + dy).ok) { sub = sim.place('sub', c.x + dx, c.y + dy); break; }
      }
    }
    const nnOnlyRejected = sim.canBuyTransit(c, 'trolley'); // rozvodna zatím jen s NN
    sim.buyTrafo(sub, 't110_22');
    const withVnOk = sim.canBuyTransit(c, 'trolley').ok;

    // podmínky stavby: velikost města a návaznost systémů
    c.pop = 6;
    const smallRejected = !sim.canBuyTransit(c, 'trolley').ok;
    c.pop = 30;
    const tramNeedsTrolley = sim.canBuyTransit(c, 'tram');
    const metroNeedsTram = sim.canBuyTransit(c, 'metro');

    // cena roste s velikostí města (delší síť)
    c.pop = 8;
    const costSmall = sim.transitCost(c, 'trolley');
    c.pop = 32;
    const costBig = sim.transitCost(c, 'trolley');

    // nákup: strhne se přesně cena a systém začne jezdit
    c.pop = 30;
    const demandBefore = sim._cityDemand(c, atH(8));
    const price = sim.transitCost(c, 'trolley');
    const moneyBefore = sim.money;
    const bought = sim.buyTransit(c, 'trolley');
    const paid = moneyBefore - sim.money;
    const demandAfter = sim._cityDemand(c, atH(8));
    const twiceRejected = !sim.buyTransit(c, 'trolley');

    // tramvaj se odemkla až po trolejbusech
    const tramNowOk = sim.canBuyTransit(c, 'tram').ok;
    sim.buyTransit(c, 'tram');
    const metroStillSmall = !sim.canBuyTransit(c, 'metro').ok;
    c.pop = 45;
    const metroOk = sim.canBuyTransit(c, 'metro').ok;

    // rekuperace: trolejbus odebere jen (1 − regen) štítkového příkonu
    c.pop = 30;
    c.transit = { trolley: 1 };
    const def = EG.TRANSIT.trolley;
    const season = sim.seasonFx.demand;
    const peak = sim.transitDemand(c, atH(7));
    const peakExpect = c.pop * def.mw * EG.transitCurve(7, def) * (1 - def.regen) *
      (1 + 0.5 * (season - 1));

    // denní profil: přepravní špičky ráno a odpoledne, v sedle a v noci útlum
    const mMorning = sim.transitDemand(c, atH(7));
    const mMidday = sim.transitDemand(c, atH(11));
    const mAfternoon = sim.transitDemand(c, atH(16));
    const mNight = sim.transitDemand(c, atH(2));

    // metro v noci nejezdí vůbec, trolejbusy mají noční linky
    c.transit = { metro: 1 };
    const metroNight = sim.transitDemand(c, atH(2));
    c.transit = { trolley: 1 };
    const trolleyNight = sim.transitDemand(c, atH(2));

    // bonus k růstu a stropu populace
    c.transit = { trolley: 1, tram: 1, metro: 1 };
    const bonus = sim.transitBonus(c);
    const noneBonus = sim.transitBonus({ });

    // uložení a načtení hry si dopravu pamatuje
    const json = EG.serialize(sim);
    const sim2 = EG.restore(json);
    const keptTransit = JSON.stringify(sim2.map.cities[0].transit);

    return {
      smallRejected,
      noSubRejected: noSubRejected.ok === false && /VN|22/.test(noSubRejected.why),
      nnOnlyRejected: nnOnlyRejected.ok === false, withVnOk,
      tramNeedsTrolley: tramNeedsTrolley.ok === false && /trolejbus/i.test(tramNeedsTrolley.why),
      metroNeedsTram: metroNeedsTram.ok === false,
      costSmall, costBig, costGrows: costBig > costSmall,
      bought, paid, price, priceMatches: paid === price,
      addedMw: +(demandAfter - demandBefore).toFixed(2),
      twiceRejected, tramNowOk, metroStillSmall, metroOk,
      peak: +peak.toFixed(3), peakExpect: +peakExpect.toFixed(3),
      mMorning: +mMorning.toFixed(2), mMidday: +mMidday.toFixed(2),
      mAfternoon: +mAfternoon.toFixed(2), mNight: +mNight.toFixed(2),
      metroNight: +metroNight.toFixed(3), trolleyNight: +trolleyNight.toFixed(3),
      bonus, noneBonus, keptTransit,
    };
  });
  console.log('městská doprava:', JSON.stringify(mhd));
  if (!mhd.noSubRejected) throw new Error('trakce se postaví i bez rozvodny v dosahu');
  if (!mhd.nnOnlyRejected) throw new Error('trakční měnírna se spokojila s pouhým NN');
  if (!mhd.withVnOk) throw new Error('trakce nejde postavit ani s VN přípojnicí');
  if (!mhd.smallRejected) throw new Error('trolejbusy jdou postavit i v malé vsi');
  if (!mhd.tramNeedsTrolley) throw new Error('tramvaj nevyžaduje trolejbusy');
  if (!mhd.metroNeedsTram) throw new Error('metro nevyžaduje tramvaje');
  if (!mhd.costGrows) throw new Error('cena neroste s velikostí města: ' + mhd.costSmall + ' -> ' + mhd.costBig);
  if (!mhd.bought || !mhd.priceMatches) throw new Error('nákup nestrhl přesnou cenu: ' + mhd.paid + ' / ' + mhd.price);
  if (!(mhd.addedMw > 1 && mhd.addedMw < 3)) throw new Error('trolejbusy přidaly divný odběr: ' + mhd.addedMw + ' MW');
  if (!mhd.twiceRejected) throw new Error('stejný systém jde koupit dvakrát');
  if (!mhd.tramNowOk || !mhd.metroStillSmall || !mhd.metroOk) throw new Error('odemykání systémů nefunguje');
  if (Math.abs(mhd.peak - mhd.peakExpect) > 0.01) throw new Error('rekuperace nesedí: ' + mhd.peak + ' vs ' + mhd.peakExpect);
  if (!(mhd.mMorning > mhd.mMidday && mhd.mAfternoon > mhd.mMidday)) {
    throw new Error('chybí přepravní špičky: ráno ' + mhd.mMorning + ', sedlo ' + mhd.mMidday + ', odpoledne ' + mhd.mAfternoon);
  }
  if (!(mhd.mNight < mhd.mMidday)) throw new Error('v noci se nejezdí míň: ' + mhd.mNight);
  if (mhd.metroNight !== 0) throw new Error('metro jezdí i v noci: ' + mhd.metroNight);
  if (!(mhd.trolleyNight > 0)) throw new Error('trolejbusy nemají noční linky');
  if (mhd.bonus.cap !== 28 || Math.abs(mhd.bonus.growth - 0.8) > 1e-9) {
    throw new Error('bonus kompletní MHD nesedí: ' + JSON.stringify(mhd.bonus));
  }
  if (mhd.noneBonus.cap !== 0 || mhd.noneBonus.growth !== 0) throw new Error('město bez MHD dostává bonus');
  if (mhd.keptTransit !== '{"trolley":1,"tram":1,"metro":1}') throw new Error('uložená hra zapomněla MHD: ' + mhd.keptTransit);

  // --- MHD v provozu: jízdné, provoz a odstávka při výpadku ---
  const mhdRun = await page.evaluate(() => {
    const map = EG.generateMap(160, 42);
    const sim = new EG.Sim(map);
    sim.money = 1000000;
    const c = map.cities[0];
    c.pop = 30;

    // rozvodna u města a dvě uhelné na 220 kV, ať město opravdu svítí
    const near = (kind, cx, cy, maxR) => {
      for (let r = 1; r <= maxR; r++) {
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (sim.canPlace(kind, cx + dx, cy + dy).ok) return sim.place(kind, cx + dx, cy + dy);
        }
      }
      return null;
    };
    const sub = near('sub', c.x, c.y, 4);
    sim.upgrade(sub); sim.upgrade(sub); sim.upgrade(sub); // víc vývodových polí
    sim.buyTrafo(sub, 't220_110');
    sim.buyTrafo(sub, 't110_22'); sim.buyTrafo(sub, 't110_22');
    sim.buyTrafo(sub, 't22_04'); sim.buyTrafo(sub, 't22_04'); sim.buyTrafo(sub, 't22_04');
    for (let k = 0; k < 2; k++) {
      const p = near('coal', c.x + 8 + k * 3, c.y + 6, 6);
      if (p) { sim.connect(p, sub, 220); sim.setFuelContract(p, true); }
    }
    for (let i = 0; i < 60; i++) sim.tick(0.2);
    const poweredBefore = c.powered;
    const fareBefore = sim.stats.fareIncome || 0;

    sim.buyTransit(c, 'trolley');
    sim.buyTransit(c, 'tram');
    for (let i = 0; i < 60; i++) sim.tick(0.2);
    const fareRunning = sim.stats.fareIncome || 0;
    const downWhileRunning = !!c.transitDown;

    // provoz dopravního podniku se platí i tak: bez MHD je upkeep nižší
    const incomeWithMhd = sim.stats.income;

    // vypnout dodávku: MHD zůstane ve vozovně a přijde hlášení
    for (const b of sim.buildings) if (b.kind !== 'sub') sim.setMothball(b, true);
    for (let i = 0; i < 80; i++) sim.tick(0.2);
    const downAfterBlackout = !!c.transitDown;
    const fareWhenDown = sim.stats.fareIncome || 0;
    const stopMsg = sim.messages.some((m) => m.text.includes('zastavil městskou dopravu'));

    // obnovit dodávku
    for (const b of sim.buildings) sim.setMothball(b, false);
    for (let i = 0; i < 160; i++) sim.tick(0.2);
    const backUp = !c.transitDown;
    const backMsg = sim.messages.some((m) => m.text.includes('opět jezdí'));

    return {
      poweredBefore: +poweredBefore.toFixed(2), fareBefore,
      fareRunning: +fareRunning.toFixed(3), downWhileRunning,
      incomeWithMhd: +incomeWithMhd.toFixed(2),
      downAfterBlackout, fareWhenDown, stopMsg, backUp, backMsg,
    };
  });
  console.log('MHD v provozu:', JSON.stringify(mhdRun));
  if (!(mhdRun.poweredBefore > 0.9)) throw new Error('testovací síť město nenapájí: ' + mhdRun.poweredBefore);
  if (mhdRun.fareBefore !== 0) throw new Error('město bez MHD vybírá jízdné');
  if (!(mhdRun.fareRunning > 0)) throw new Error('jezdící MHD nevybírá jízdné: ' + mhdRun.fareRunning);
  if (mhdRun.downWhileRunning) throw new Error('napájená MHD se hlásí jako odstavená');
  if (!mhdRun.downAfterBlackout) throw new Error('výpadek nezastavil MHD');
  if (mhdRun.fareWhenDown !== 0) throw new Error('stojící MHD pořád vybírá jízdné: ' + mhdRun.fareWhenDown);
  if (!mhdRun.stopMsg) throw new Error('chybí hlášení o zastavení MHD');
  if (!mhdRun.backUp || !mhdRun.backMsg) throw new Error('MHD se po obnovení dodávky nerozjela');

  // --- roční daně a poplatky ---
  const dane = await page.evaluate(() => {
    const map = EG.generateMap(160, 42);
    const sim = new EG.Sim(map);
    sim.money = 200000;

    // hodnota majetku: stavba + trafa + vedení
    const near = (kind, cx, cy, maxR) => {
      for (let r = 1; r <= maxR; r++) {
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (sim.canPlace(kind, cx + dx, cy + dy).ok) return sim.place(kind, cx + dx, cy + dy);
        }
      }
      return null;
    };
    const c = map.cities[0];
    const sub = near('sub', c.x, c.y, 4);
    const coal = near('coal', c.x + 9, c.y + 6, 6);
    sim.buyTrafo(sub, 't220_110');
    const line = sim.connect(coal, sub, 220);
    const expectAssets = EG.BUILD.sub.cost + EG.TRAFOS.t220_110.cost + EG.BUILD.coal.cost +
      line.len * EG.LINE_TYPES[220].cost;
    const assets = sim.assetValue();

    // ziskový rok: základ = zisk − odpisy, daň 21 %
    sim.yearProfit = 10000;
    sim.taxLosses = [];
    sim.taxBaseHistory = [];
    const r1 = sim.taxReport(1);
    const depOk = Math.abs(r1.depreciation - assets * EG.TAX.depreciation) < 0.01;
    const baseOk = Math.abs(r1.base - (10000 - r1.depreciation)) < 0.01;
    const incomeOk = Math.abs(r1.incomeTax - r1.base * EG.TAX.income) < 0.01;
    const propertyOk = Math.abs(r1.property - assets * EG.TAX.property) < 0.01;
    const licenseOk = r1.license === EG.TAX.licenseBase + EG.TAX.license * r1.licensed;
    const noWindfallFirst = r1.windfall === 0; // bez historie není s čím srovnávat

    // ztrátový rok: nulová daň z příjmu a ztráta se přenese
    sim.yearProfit = -4000;
    sim.taxLosses = [];
    sim.taxBaseHistory = [];
    const r2 = sim.taxReport(2);
    const lossZeroTax = r2.incomeTax === 0 && r2.base === 0;
    const lossCarried = r2.losses.length === 1 && Math.abs(r2.losses[0].a - (4000 + r2.depreciation)) < 0.01;

    // následující ziskový rok ztrátu uplatní
    sim.taxLosses = r2.losses;
    sim.yearProfit = 10000;
    const r3 = sim.taxReport(3);
    const lossUsed = r3.lossUsed > 0 && Math.abs(r3.base - (10000 - r3.depreciation - r3.lossUsed)) < 0.01;

    // stará ztráta po TAX.lossCarry letech propadne
    sim.taxLosses = [{ y: 0, a: 9999 }];
    sim.yearProfit = 10000;
    const rOld = sim.taxReport(1 + EG.TAX.lossCarry + 1);
    const oldLossExpired = rOld.lossUsed === 0;

    // windfall daň: skokový zisk nad násobkem průměru minulých let
    sim.taxLosses = [];
    sim.taxBaseHistory = [4000, 4000, 4000, 4000]; // práh = 1,5 × 4000 = 6000
    sim.yearProfit = 5000;
    const rCalm = sim.taxReport(6);
    sim.yearProfit = 60000;
    const rSpike = sim.taxReport(6);
    const windfallOk = rCalm.windfall === 0 && rSpike.windfall > 0 &&
      Math.abs(rSpike.windfall - (rSpike.base - rSpike.windfallFrom) * EG.TAX.windfall) < 0.01;
    const calmBase = Math.round(rCalm.base);

    // expertní režim má práh níž
    const normalFrom = sim.taxReport(6).windfallFrom;
    sim.hardMode = true;
    const hardFrom = sim.taxReport(6).windfallFrom;
    sim.hardMode = false;

    // odvod na Silvestra: strhne peníze a zapíše historii
    sim.taxLosses = [];
    sim.taxBaseHistory = [];
    sim.yearProfit = 10000;
    sim.money = 50000;
    const paid = sim._payTaxes(7);
    const moneyAfter = sim.money;
    const chargedOk = Math.abs(50000 - moneyAfter - paid.total) < 0.01;
    const profitReset = sim.yearProfit === 0;
    const historyKept = sim.taxBaseHistory.length === 1;
    const taxMsg = sim.messages.some((m) => m.text.includes('Přiznání za rok 7'));

    // zálohy zaplacené během roku se od doplatku odečtou
    sim.taxLosses = [];
    sim.taxBaseHistory = [];
    sim.yearProfit = 10000;
    sim.money = 50000;
    sim.taxAdvance = 900;
    const withAdvance = sim._payTaxes(8);
    const advanceOk = Math.abs(withAdvance.due - (withAdvance.total - 900)) < 0.01 &&
      Math.abs(50000 - sim.money - withAdvance.due) < 0.01;
    const advanceReset = sim.taxAdvance === 0;

    // přeplatek na zálohách se vrátí zpátky do pokladny
    sim.taxLosses = [];
    sim.taxBaseHistory = [];
    sim.yearProfit = -1000;
    sim.money = 1000;
    sim.taxAdvance = 5000;
    const refund = sim._payTaxes(9);
    const refundOk = refund.due < 0 && sim.money > 1000;

    // nedoplatek pokryje provozní úvěr, hráč nespadne rovnou do mínusu
    sim.taxBaseHistory = [];
    sim.taxLosses = [];
    sim.yearProfit = 20000;
    sim.money = 10;
    sim.debt = 0;
    sim.taxAdvance = 0;
    sim._payTaxes(10);
    const rescuedByLoan = sim.money >= 0 && sim.debt > 0;

    return {
      assets: +assets.toFixed(1), expectAssets: +expectAssets.toFixed(1),
      depOk, baseOk, incomeOk, propertyOk, licenseOk, noWindfallFirst,
      lossZeroTax, lossCarried, lossUsed, oldLossExpired,
      windfallOk, calmBase, windfallFrom: Math.round(rSpike.windfallFrom),
      spikeWindfall: Math.round(rSpike.windfall),
      normalFrom: Math.round(normalFrom), hardFrom: Math.round(hardFrom),
      chargedOk, profitReset, historyKept, taxMsg, rescuedByLoan,
      advanceOk, advanceReset, refundOk, refundDue: Math.round(refund.due),
      total: Math.round(paid.total),
    };
  });
  console.log('daně:', JSON.stringify(dane));
  if (Math.abs(dane.assets - dane.expectAssets) > 0.1) {
    throw new Error('hodnota majetku nesedí: ' + dane.assets + ' vs ' + dane.expectAssets);
  }
  if (!dane.depOk) throw new Error('odpisy nejsou 5 % majetku');
  if (!dane.baseOk) throw new Error('daňový základ nezohlednil odpisy');
  if (!dane.incomeOk) throw new Error('daň z příjmu není 21 % základu');
  if (!dane.propertyOk) throw new Error('daň z majetku nesedí');
  if (!dane.licenseOk) throw new Error('licenční poplatky nesedí');
  if (!dane.noWindfallFirst) throw new Error('windfall daň bez historie nemá co srovnávat');
  if (!dane.lossZeroTax) throw new Error('ztrátový rok se zdanil');
  if (!dane.lossCarried) throw new Error('ztráta se nepřenesla do dalších let');
  if (!dane.lossUsed) throw new Error('přenesená ztráta se neuplatnila');
  if (!dane.oldLossExpired) throw new Error('propadlá ztráta se pořád uplatňuje');
  if (!dane.windfallOk) {
    throw new Error('windfall daň nesedí: klidný základ ' + dane.calmBase + ' při prahu ' +
      dane.windfallFrom + ', skok dal ' + dane.spikeWindfall);
  }
  if (!(dane.hardFrom < dane.normalFrom)) {
    throw new Error('expertní režim nemá nižší práh windfall daně: ' + dane.hardFrom + ' vs ' + dane.normalFrom);
  }
  if (!dane.chargedOk) throw new Error('odvod nestrhl správnou částku');
  if (!dane.profitReset) throw new Error('hospodářský výsledek se po uzávěrce nevynuloval');
  if (!dane.historyKept) throw new Error('daňová historie se nezapsala');
  if (!dane.taxMsg) throw new Error('chybí hlášení o daňovém přiznání');
  if (!dane.advanceOk) throw new Error('zálohy se od doplatku neodečetly');
  if (!dane.advanceReset) throw new Error('zálohy se po uzávěrce nevynulovaly');
  if (!dane.refundOk) throw new Error('přeplatek na zálohách se nevrátil: doplatek ' + dane.refundDue);
  if (!dane.rescuedByLoan) throw new Error('nedoplatek nepokryl provozní úvěr');

  // --- uzávěrka běží na přelomu roku a načtená hra se nezdaní podruhé ---
  const daneRok = await page.evaluate(() => {
    const map = EG.generateMap(160, 42);
    const sim = new EG.Sim(map);
    sim.money = 50000;
    const yearLen = sim.dayLen * 12;

    // těsně před koncem roku 1 ještě uzávěrka neproběhla
    sim.time = yearLen - 1;
    sim.tick(0.001);
    sim.yearProfit = 6000;
    const before = sim.money;
    const taxedEarly = sim.messages.some((m) => m.text.includes('Přiznání za rok 1'));

    // překročení roku uzávěrku spustí
    sim.time = yearLen + 1;
    sim.tick(0.001);
    const taxedAtTurn = sim.messages.some((m) => m.text.includes('Přiznání za rok 1'));
    const dropped = before - sim.money;

    // druhý tick ve stejném roce už nedaní znovu
    const moneyAfterTax = sim.money;
    sim.tick(0.001);
    const filings = sim.messages.filter((m) => m.text.includes('Přiznání za rok 1')).length;
    const stable = Math.abs(sim.money - moneyAfterTax) < 5;

    // uložení a načtení hry uzávěrku nezopakuje
    const json = EG.serialize(sim);
    const sim2 = EG.restore(json);
    const reloadDiff = Math.abs(sim2.money - sim.money);
    const filingsAfterLoad = sim2.messages.filter((m) => m.text.includes('Přiznání za rok 1')).length;

    return {
      taxedEarly, taxedAtTurn, dropped: Math.round(dropped), filings, stable,
      reloadDiff: +reloadDiff.toFixed(2), filingsAfterLoad,
      hydroFx: +(sim2._hydroYearFx || 0).toFixed(3),
    };
  });
  console.log('daňový rok:', JSON.stringify(daneRok));
  if (daneRok.taxedEarly) throw new Error('uzávěrka proběhla ještě před koncem roku');
  if (!daneRok.taxedAtTurn) throw new Error('na přelomu roku se nedanilo');
  if (!(daneRok.dropped > 0)) throw new Error('uzávěrka nestrhla peníze: ' + daneRok.dropped);
  if (daneRok.filings !== 1) throw new Error('uzávěrka proběhla vícekrát: ' + daneRok.filings);
  if (!daneRok.stable) throw new Error('daň se strhává každý tick');
  if (!(daneRok.reloadDiff < 5)) throw new Error('načtení hry zdanilo znovu: rozdíl ' + daneRok.reloadDiff);
  if (daneRok.filingsAfterLoad !== 0) throw new Error('načtená hra vygenerovala nové přiznání');
  if (!(daneRok.hydroFx >= 0.75 && daneRok.hydroFx <= 1.25)) {
    throw new Error('načtená hra ztratila hydrologický koeficient: ' + daneRok.hydroFx);
  }

  // --- panel města: nákup MHD přes UI ---
  const cityPanel = await page.evaluate(() => {
    const { sim, map, renderer } = EG.game;
    sim.money = 200000;
    const c = map.cities[0];
    c.pop = 30;
    // trakce potřebuje v dosahu rozvodnu s VN přípojnicí
    let sub = null;
    for (let r = 1; r <= 4 && !sub; r++) {
      for (let dy = -r; dy <= r && !sub; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (sim.canPlace('sub', c.x + dx, c.y + dy).ok) { sub = sim.place('sub', c.x + dx, c.y + dy); break; }
      }
    }
    sim.buyTrafo(sub, 't110_22');
    const [wx, wy] = renderer.tileToWorld(c.x, c.y);
    renderer.cam.x = wx; renderer.cam.y = wy;
    // klik na střed města otevře panel
    const cv = document.getElementById('game');
    const r = cv.getBoundingClientRect();
    const ev = (type, x, y) => cv.dispatchEvent(new MouseEvent(type, {
      clientX: x, clientY: y, bubbles: true, button: 0,
    }));
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    ev('mousemove', cx, cy);
    ev('mousedown', cx, cy);
    ev('mouseup', cx, cy);
    const panel = document.getElementById('bpanel');
    const title = document.getElementById('bp-title').textContent;
    const btns = [...document.querySelectorAll('#bp-actions .bp-btn[data-transit]')];
    const before = sim.money;
    const trolleyBtn = btns.find((b) => b.dataset.transit === 'trolley');
    if (trolleyBtn) trolleyBtn.click();
    const bought = sim.hasTransit(c, 'trolley');
    const spent = before - sim.money;
    const btnsAfter = [...document.querySelectorAll('#bp-actions .bp-btn[data-transit]')].map((b) => b.dataset.transit);

    // města jdou najít i v seznamu objektů a klik na řádek otevře jejich panel
    document.getElementById('btn-objlist').click();
    const filter = document.getElementById('objlist-filter');
    filter.value = 'city';
    filter.dispatchEvent(new Event('change'));
    const cityRows = document.querySelectorAll('#objlist-rows .obj-row[data-city]').length;
    const anyBuilding = document.querySelectorAll('#objlist-rows .obj-row:not([data-city])').length;
    document.getElementById('btn-objlist').click();

    return {
      visible: !panel.hidden, title, isCity: title.startsWith(c.name),
      nBtns: btns.length, bought, spent,
      btnsAfter, statsHasMhd: document.getElementById('bp-stats').textContent.includes('Doprava'),
      cityRows, anyBuilding, nCities: map.cities.length,
    };
  });
  console.log('panel města:', JSON.stringify(cityPanel));
  if (!cityPanel.visible || !cityPanel.isCity) throw new Error('klik na město neotevřel panel města: ' + cityPanel.title);
  if (cityPanel.nBtns !== 3) throw new Error('panel nenabízí tři dopravní systémy: ' + cityPanel.nBtns);
  if (!cityPanel.bought || !(cityPanel.spent > 0)) throw new Error('tlačítko trolejbusů nic nepostavilo');
  if (cityPanel.btnsAfter.includes('trolley')) throw new Error('postavený systém zůstal v nabídce');
  if (!cityPanel.statsHasMhd) throw new Error('panel neukazuje postavenou dopravu');
  if (cityPanel.cityRows !== cityPanel.nCities) {
    throw new Error('filtr měst nevypsal všechna města: ' + cityPanel.cityRows + ' z ' + cityPanel.nCities);
  }
  if (cityPanel.anyBuilding !== 0) throw new Error('filtr měst vypsal i stavby');

  // --- grafika: ořez terénu, osvětlení, záře a postprocess ---
  const cullTest = await page.evaluate(() => {
    const { renderer, sim, map } = EG.game;
    const iso = EG.iso;

    /* Kolik dlaždic doopravdy padne do výřezu – spočítáno hrubou silou,
       nezávisle na diagonální matematice v rendereru. Renderer smí
       nakreslit o kousek víc (zaokrouhlení), ale nikdy ne míň. */
    const brute = () => {
      const c = renderer.cull;
      let n = 0;
      for (let y = 0; y < map.size; y++) for (let x = 0; x < map.size; x++) {
        const wx = (x - y) * iso.HW, wy = (x + y) * iso.HH;
        if (wx >= c.x0 && wx <= c.x1 && wy >= c.y0 && wy <= c.y1) n++;
      }
      return n;
    };

    const sample = (zoom) => {
      renderer.cam.zoom = zoom;
      renderer.render(0);
      return { zoom, drawn: renderer.stats.terrain, need: brute() };
    };

    // kamera doprostřed mapy, ať je výřez plný souše i vody
    const [wx, wy] = renderer.tileToWorld(map.size / 2, map.size / 2);
    renderer.cam.x = wx; renderer.cam.y = wy;
    const near = sample(1.5);
    const mid = sample(0.9);
    const far = sample(0.35);

    // roh mapy: ořez nesmí sáhnout mimo pole diagonál
    renderer.cam.x = 0; renderer.cam.y = 0;
    const corner = sample(0.9);
    renderer.cam.x = wx; renderer.cam.y = wy;
    renderer.cam.zoom = 1.2;

    return {
      total: renderer.stats.terrainTotal,
      near, mid, far, corner,
      samples: renderer.samples,
      maxDpr: EG.MAX_DPR,
      canvasW: renderer.canvas.width,
      clientW: renderer.canvas.clientWidth,
    };
  });
  console.log('grafika – ořez terénu:', JSON.stringify(cullTest));
  if (cullTest.total < 10000) throw new Error('mapa nemá čím zahltit GPU: ' + cullTest.total);
  for (const s of [cullTest.near, cullTest.mid, cullTest.far, cullTest.corner]) {
    if (s.drawn < s.need) {
      throw new Error('ořez zahodil viditelné dlaždice při zoomu ' + s.zoom + ': ' +
        s.drawn + ' < ' + s.need);
    }
    if (s.drawn > s.need * 3 + 3000) {
      throw new Error('ořez skoro nic neušetřil při zoomu ' + s.zoom + ': ' + s.drawn + ' vs ' + s.need);
    }
  }
  if (!(cullTest.near.drawn < cullTest.total / 20)) {
    throw new Error('při přiblížení se pořád kreslí celá mapa: ' + cullTest.near.drawn + ' z ' + cullTest.total);
  }
  if (!(cullTest.far.drawn > cullTest.near.drawn)) throw new Error('oddálení nepřidalo dlaždice');
  if (cullTest.canvasW > cullTest.clientW * cullTest.maxDpr + 1) {
    throw new Error('plátno ignoruje strop DPR: ' + cullTest.canvasW + ' px na ' + cullTest.clientW + ' CSS px');
  }

  // osvětlení: den je světlý a barevný, noc tmavá, modrá a odbarvená
  // (kamera musí koukat na stavbu, jinak není co rozsvěcet)
  const litSpot = await page.evaluate(() => {
    const { sim, renderer } = EG.game;
    const b = sim.buildings.find((o) => o.kind === 'sub') || sim.buildings[0];
    if (!b) return null;
    const [wx, wy] = renderer.tileToWorld(b.x, b.y);
    renderer.cam.x = wx; renderer.cam.y = wy; renderer.cam.zoom = 1.2;
    return { x: b.x, y: b.y, kind: b.kind };
  });
  if (!litSpot) throw new Error('v živé hře není žádná stavba k osvětlení');

  /* Světlo se přepočítá až v dalším snímku – pod softwarovým rasterizérem
     může snímek trvat i desetinu sekundy, takže se čeká na počítadlo
     snímků, ne na pevný časový úsek. */
  const nextFrames = async (n) => {
    const from = await page.evaluate(() => EG.game.renderer.frame);
    await page.waitForFunction(
      ({ f, k }) => EG.game.renderer.frame >= f + k, { f: from, k: n }, { timeout: 20000 });
  };

  const atHour = async (h) => {
    await page.evaluate((hh) => {
      const { sim } = EG.game;
      const phase = ((hh - 6 + 24) % 24) / 24;
      sim.time = Math.floor(sim.time / sim.dayLen) * sim.dayLen + sim.dayLen * phase;
      sim.tick(0.001);
    }, h);
    await nextFrames(2);
    return page.evaluate(() => ({
      light: JSON.parse(JSON.stringify(EG.game.renderer.light)),
      clear: EG.game.renderer.clearColor.slice(),
      glows: EG.game.renderer.stats.glows,
      sun: +(EG.game.sim.sun || 0).toFixed(2),
    }));
  };
  const noon = await atHour(13);
  const night = await atHour(2);
  console.log('grafika – osvětlení:', JSON.stringify({ spot: litSpot, noon, night }));
  if (!(noon.sun > 0.8)) throw new Error('v poledne nesvítí slunce: ' + noon.sun);
  if (night.sun !== 0) throw new Error('ve dvě ráno svítí slunce: ' + night.sun);
  if (!(night.light.r < noon.light.r * 0.6)) {
    throw new Error('noc není tmavší než poledne: ' + night.light.r + ' vs ' + noon.light.r);
  }
  if (!(night.light.b > night.light.r)) throw new Error('noc není do modra: ' + JSON.stringify(night.light));
  if (!(night.light.desat > 0.4) || !(noon.light.desat < 0.05)) {
    throw new Error('odbarvení za šera nefunguje: ' + night.light.desat + ' / ' + noon.light.desat);
  }
  if (!(night.clear[2] < noon.clear[2])) throw new Error('noční obloha není tmavší');
  if (!(night.glows > 0)) throw new Error('v noci se nerozsvítilo jediné světlo');
  if (noon.glows !== 0) throw new Error('v poledne svítí noční světla: ' + noon.glows);

  // přepínač kvality: nízká vypne postprocess a uvolní cíle vykreslování
  const quality = await page.evaluate(async () => {
    const { renderer } = EG.game;
    const btn = document.getElementById('btn-gfx');
    const before = renderer.quality;
    const hadTargets = !!renderer.targets;
    btn.click();
    const low = renderer.quality;
    const freed = renderer.targets === null;
    renderer.render(0);
    const drawsLow = renderer.stats.draws;
    btn.click();
    const back = renderer.quality;
    renderer.render(0);
    const drawsHigh = renderer.stats.draws;
    let stored = null;
    try { stored = localStorage.getItem('eg_gfx'); } catch (e) { /* ignoruj */ }
    return { before, hadTargets, low, freed, back, drawsLow, drawsHigh, stored,
      targetsBack: !!renderer.targets, active: btn.classList.contains('active') };
  });
  console.log('grafika – kvalita:', JSON.stringify(quality));
  if (quality.before !== 'high' || quality.low !== 'low' || quality.back !== 'high') {
    throw new Error('přepínač kvality nepřepíná: ' + JSON.stringify(quality));
  }
  if (!quality.hadTargets || !quality.freed) throw new Error('nízká kvalita neuvolnila framebuffery');
  if (!quality.targetsBack) throw new Error('vysoká kvalita si framebuffery nevyrobila zpět');
  if (!(quality.drawsHigh > quality.drawsLow)) {
    throw new Error('vysoká kvalita nepřidala postprocess: ' + quality.drawsHigh + ' vs ' + quality.drawsLow);
  }
  if (quality.stored !== 'high' || !quality.active) throw new Error('volba kvality se nepamatuje');

  // změna velikosti okna musí cíle vykreslování přestavět, ne rozbít
  await page.setViewportSize({ width: 900, height: 620 });
  await nextFrames(3);
  const resized = await page.evaluate(() => ({
    w: EG.game.renderer.targets && EG.game.renderer.targets.w,
    canvasW: EG.game.renderer.canvas.width,
    terrain: EG.game.renderer.stats.terrain,
  }));
  console.log('grafika – změna velikosti:', JSON.stringify(resized));
  if (resized.w !== resized.canvasW) throw new Error('framebuffery neodpovídají plátnu po změně velikosti');
  if (!(resized.terrain > 0)) throw new Error('po změně velikosti se nekreslí terén');
  await page.setViewportSize({ width: 1100, height: 700 });
  await nextFrames(3);

  // --- přehled zatížení: co je v pořádku a co už nestíhá ---
  const overload = await page.evaluate(() => {
    const { sim, map } = EG.game;
    sim.money = 500000;
    // město s velkým odběrem napájené přes jedno slabé distribuční trafo
    const c = map.cities.find((o) => !sim.buildings.some((b) => Math.hypot(b.x - o.x, b.y - o.y) < 12))
      || map.cities[0];
    c.pop = 55;
    sim._syncHouses(c);
    const near = (kind, cx, cy, maxR) => {
      for (let r = 1; r <= maxR; r++) {
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (sim.canPlace(kind, cx + dx, cy + dy).ok) return sim.place(kind, cx + dx, cy + dy);
        }
      }
      return null;
    };
    const sub = near('sub', c.x, c.y, 4);
    sim.buyTrafo(sub, 't220_110');
    sim.buyTrafo(sub, 't110_22');
    sim.buyTrafo(sub, 't22_04'); // 30 MW na město, které chce dvakrát tolik
    const coal = near('coal', c.x + 10, c.y + 8, 8);
    const link = coal ? sim.connect(coal, sub, 220) : null;
    if (coal) sim.setFuelContract(coal, true);
    for (let i = 0; i < 60; i++) sim.tick(0.2);

    document.getElementById('objlist').hidden = false;
    const filter = document.getElementById('objlist-filter');
    filter.value = 'load';
    filter.dispatchEvent(new Event('change'));
    const rowsEl = [...document.querySelectorAll('#objlist-rows .obj-row')];
    const readLoad = (el) => {
      const b = el.querySelector('.o-load b');
      return b ? parseInt(b.textContent, 10) : -1;
    };
    const loads = rowsEl.map(readLoad);
    const sorted = loads.every((v, i) => i === 0 || loads[i - 1] >= v);
    const lineRows = rowsEl.filter((el) => el.dataset.line !== undefined).length;
    const trafoRows = rowsEl.filter((el) => el.querySelector('.o-name').textContent.startsWith('Trafo')).length;
    const overRows = rowsEl.filter((el) => el.textContent.includes('přetíženo')).length;
    const okRows = rowsEl.filter((el) => /\bok\b/.test(el.textContent)).length;
    // barva proužku podle stavu
    const worst = rowsEl[0];
    const worstBar = worst && worst.querySelector('.o-load i');
    const worstColor = worstBar ? worstBar.style.background : '';

    // klik na řádek vedení otevře panel vedení
    const lineRow = rowsEl.find((el) => el.dataset.line !== undefined);
    let linePanel = null;
    if (lineRow) {
      lineRow.click();
      linePanel = document.getElementById('bp-title').textContent;
    }
    document.getElementById('objlist').hidden = true;

    return {
      rows: rowsEl.length, loads: loads.slice(0, 4), sorted,
      lineRows, trafoRows, overRows, okRows, worstColor, linePanel,
      linkOk: !!link, coalOut: coal ? +coal.out.toFixed(0) : 0,
    };
  });
  await nextFrames(2);
  const overloadHud = await page.evaluate(() => {
    const item = document.getElementById('overload-item');
    const shown = !item.hidden;
    item.click(); // zkratka z HUD rovnou do přehledu
    const open = !document.getElementById('objlist').hidden;
    const filter = document.getElementById('objlist-filter').value;
    document.getElementById('objlist-close').click();
    return { shown, text: document.getElementById('overload').textContent, open, filter };
  });
  console.log('přehled zatížení:', JSON.stringify({ ...overload, hud: overloadHud }));
  if (!overload.linkOk) throw new Error('testovací vedení se nepostavilo');
  if (!(overload.rows > 3)) throw new Error('přehled zatížení je prázdný: ' + overload.rows);
  if (!(overload.lineRows > 0)) throw new Error('v přehledu chybí vedení');
  if (!(overload.trafoRows > 0)) throw new Error('v přehledu chybí trafa');
  if (!overload.sorted) throw new Error('přehled není seřazený od nejhoršího: ' + JSON.stringify(overload.loads));
  if (!(overload.loads[0] > 100)) throw new Error('nepovedlo se nic přetížit: ' + overload.loads[0]);
  if (!(overload.overRows > 0)) throw new Error('přetížený prvek se nehlásí jako přetížený');
  if (!(overload.okRows > 0)) throw new Error('nic se nehlásí jako v pořádku – přehled má ukázat obojí');
  if (!overload.worstColor.includes('255, 83, 64')) {
    throw new Error('nejhorší prvek nemá červený proužek: ' + overload.worstColor);
  }
  if (!overload.linePanel || !overload.linePanel.startsWith('Vedení')) {
    throw new Error('klik na řádek vedení neotevřel jeho panel: ' + overload.linePanel);
  }
  if (!overloadHud.shown) throw new Error('HUD nehlásí přetížení');
  if (+overloadHud.text !== overload.overRows) {
    throw new Error('počet v HUD nesouhlasí se seznamem: ' + overloadHud.text + ' vs ' + overload.overRows);
  }
  if (!overloadHud.open || overloadHud.filter !== 'load') {
    throw new Error('klik na varování v HUD neotevřel přehled zatížení');
  }

  // --- cenovka u kurzoru: kolik bude stát to, co se chystám postavit ---
  const priceTag = await page.evaluate(async () => {
    const { sim, map, renderer } = EG.game;
    const cv = renderer.canvas;
    const W = cv.clientWidth, H = cv.clientHeight;
    const ev = (type, x, y) => cv.dispatchEvent(new MouseEvent(type, {
      clientX: x, clientY: y, bubbles: true, button: 0,
    }));
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const badge = () => {
      const el = document.getElementById('build-cost');
      return { text: el.hidden ? null : el.textContent, bad: el.classList.contains('bad') };
    };
    /* kamera se posadí tak, aby daná dlaždice padla na dané místo obrazovky;
       tím jsou souřadnice kliků deterministické bez ohledu na mapu */
    const aim = (gx, gy, sx, sy) => {
      const [wx, wy] = renderer.tileToWorld(gx, gy);
      renderer.cam.x = wx - (sx - W / 2) / renderer.cam.zoom;
      renderer.cam.y = wy - (sy - H / 2) / renderer.cam.zoom;
    };
    const screenOf = (gx, gy) => {
      const [wx, wy] = renderer.tileToWorld(gx, gy);
      return [(wx - renderer.cam.x) * renderer.cam.zoom + W / 2,
        (wy - renderer.cam.y) * renderer.cam.zoom + H / 2];
    };

    sim.money = 100000;
    renderer.cam.zoom = 1.3;
    // dvě rozvodny na 110 kV v rozumné vzdálenosti od sebe
    let s1 = null, s2 = null;
    outer:
    for (let y = 0; y < map.size; y++) for (let x = 0; x < map.size; x++) {
      if (!sim.canPlace('sub', x, y).ok) continue;
      if (!s1) { s1 = sim.place('sub', x, y); continue; }
      const d = Math.hypot(s1.x - x, s1.y - y);
      if (d > 8 && d < 14) { s2 = sim.place('sub', x, y); break outer; }
    }
    sim.buyTrafo(s1, 't110_22');
    sim.buyTrafo(s2, 't110_22');

    // --- stavba budovy: cena, sleva i důvod, proč to nejde ---
    document.querySelector('.tool[data-tool="coal"]').click();
    let land = null;
    for (let r = 3; r <= 12 && !land; r++) {
      for (let dy = -r; dy <= r && !land; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (sim.canPlace('coal', s1.x + dx, s1.y + dy).ok) { land = [s1.x + dx, s1.y + dy]; break; }
      }
    }
    aim(land[0], land[1], 700, 560);
    ev('mousemove', 700, 560);
    await frame();
    const onLand = badge();

    sim.money = 100;
    await frame();
    const tooPoor = badge();
    sim.money = 100000;

    // dlaždice pod vodou: místo ceny důvod
    let water = null;
    for (let i = 0; i < map.type.length && !water; i++) {
      if (map.type[i] === EG.T.WATER) water = [i % map.size, (i / map.size) | 0];
    }
    aim(water[0], water[1], 700, 560);
    ev('mousemove', 700, 560);
    await frame();
    const onWater = badge();

    // --- stavba vedení: cena roste s délkou ---
    document.querySelector('.tool[data-tool="line"]').click();
    document.querySelector('.linelvl[data-level="110"]').click();
    aim(s1.x, s1.y, 700, 600);
    ev('mousemove', 700, 600);
    await frame();
    const beforeStart = badge();

    ev('mousedown', 700, 600);
    ev('mouseup', 700, 600);
    const started = !!EG.game.sim && document.getElementById('build-cost');
    const [bx, by] = screenOf(s2.x, s2.y);
    ev('mousemove', bx, by);
    await frame();
    const onTarget = badge();

    // cena z cenovky musí sedět s tím, co stavba opravdu strhne
    const quote = sim.lineQuote(s1, s2, 110, false);
    const before = sim.money;
    const line = sim.connect(s1, s2, 110, false);
    const paid = before - sim.money;

    // druhý systém na téže trase je levnější (společné stožáry)
    const quote2 = sim.lineQuote(s1, s2, 110, false);
    // a příliš daleká trasa cenu vůbec nedá (110 kV táhne max 28 dlaždic)
    let s3 = null;
    for (let r = 40; r <= 70 && !s3; r++) {
      for (let dy = -r; dy <= r && !s3; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (sim.canPlace('sub', s1.x + dx, s1.y + dy).ok) { s3 = sim.place('sub', s1.x + dx, s1.y + dy); break; }
      }
    }
    if (s3) sim.buyTrafo(s3, 't110_22');
    const far = s3 ? sim.lineQuote(s1, s3, 110, false) : { ok: false, why: 'daleko' };

    document.querySelector('.tool[data-tool="pan"]').click();
    await frame();
    const hiddenInPan = document.getElementById('build-cost').hidden;

    return {
      onLand, tooPoor, onWater, beforeStart, onTarget, started: !!started, hiddenInPan,
      quoteCost: quote.cost, paid, lineOk: !!line, quoteLen: +quote.len.toFixed(1),
      parallelCost: quote2.cost, parallelNote: quote2.note || null,
      farOk: far.ok, farWhy: far.why,
      coalCost: sim.buildCost('coal'),
    };
  });
  console.log('cenovka:', JSON.stringify(priceTag));
  if (!priceTag.onLand.text || !priceTag.onLand.text.includes('−' + priceTag.coalCost + ' €')) {
    throw new Error('cenovka neukazuje cenu stavby: ' + JSON.stringify(priceTag.onLand));
  }
  if (priceTag.onLand.bad) throw new Error('cenovka hlásí problém tam, kde se stavět dá');
  if (!priceTag.tooPoor.bad || !priceTag.tooPoor.text.includes('nemáš')) {
    throw new Error('cenovka neupozorní, že na stavbu nemám: ' + JSON.stringify(priceTag.tooPoor));
  }
  if (!priceTag.onWater.bad || priceTag.onWater.text.includes('€')) {
    throw new Error('na vodě má být důvod, ne cena: ' + JSON.stringify(priceTag.onWater));
  }
  if (!priceTag.beforeStart.text || !priceTag.beforeStart.text.includes('/dl')) {
    throw new Error('před prvním klikem chybí cena za dlaždici: ' + JSON.stringify(priceTag.beforeStart));
  }
  if (!priceTag.onTarget.text || !priceTag.onTarget.text.includes('−' + priceTag.quoteCost + ' €')) {
    throw new Error('cenovka vedení neukazuje cenu trasy: ' + JSON.stringify(priceTag.onTarget) +
      ' (čekal jsem ' + priceTag.quoteCost + ')');
  }
  if (!priceTag.onTarget.text.includes(priceTag.quoteLen.toFixed(1) + ' dl')) {
    throw new Error('cenovka vedení neukazuje délku: ' + priceTag.onTarget.text);
  }
  if (!priceTag.lineOk || priceTag.paid !== priceTag.quoteCost) {
    throw new Error('stavba strhla jinou částku, než slibovala cenovka: ' +
      priceTag.paid + ' vs ' + priceTag.quoteCost);
  }
  if (!(priceTag.parallelCost < priceTag.quoteCost) || !priceTag.parallelNote) {
    throw new Error('posílení trasy nemá levnější cenu ani poznámku: ' + JSON.stringify(priceTag));
  }
  if (priceTag.farOk || !/daleko/.test(priceTag.farWhy)) {
    throw new Error('příliš dlouhá trasa se tváří jako v pořádku: ' + priceTag.farWhy);
  }
  if (!priceTag.hiddenInPan) throw new Error('cenovka svítí i v režimu prohlížení');

  // --- panel nástrojů: skupiny, ikonky a dostupnost podle peněz ---
  const toolbar = await page.evaluate(async () => {
    const { sim } = EG.game;
    // třídy dostupnosti přepisuje herní smyčka, takže se čeká na snímek
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const tools = [...document.querySelectorAll('#toolbar .tool')];
    const groups = [...document.querySelectorAll('#toolbar .tool-group')].map((el) => el.textContent);
    const withIcon = tools.filter((el) => el.querySelector('.ico')).length;
    const withAtlas = tools.filter((el) => (el.querySelector('.ico').style.backgroundImage || '').startsWith('url(')).length;
    const kinds = Object.entries(EG.BUILD).filter(([, v]) => !v.hidden).length;

    sim.money = 300;
    await frame();
    const poor = tools.filter((el) => el.classList.contains('cant')).map((el) => el.dataset.tool);
    sim.money = 1000000;
    await frame();
    const rich = tools.filter((el) => el.classList.contains('cant')).length;

    // dotace na obnovitelné zdroje zlevní i cenovku v panelu
    const solarCost = document.querySelector('.tool[data-tool="solar"] .cost');
    const normal = solarCost.textContent;
    sim.triggerEvent('subsidy');
    const cheap = { cost: sim.buildCost('solar'), full: EG.BUILD.solar.cost };
    return {
      tools: tools.length, kinds, groups, withIcon, withAtlas,
      poor, rich, normal: +normal, cheap,
      lineIcon: document.querySelector('.tool[data-tool="line"] .ico').classList.contains('ico-line'),
      panGlyph: document.querySelector('.tool[data-tool="pan"] .ico').textContent,
    };
  });
  await nextFrames(2);
  const toolbarAfter = await page.evaluate(() => ({
    solar: +document.querySelector('.tool[data-tool="solar"] .cost').textContent,
    sale: document.querySelector('.tool[data-tool="solar"] .cost').classList.contains('sale'),
  }));
  console.log('panel nástrojů:', JSON.stringify({ ...toolbar, po: toolbarAfter }));
  if (toolbar.groups.length !== 4) throw new Error('nástroje nejsou po skupinách: ' + JSON.stringify(toolbar.groups));
  if (toolbar.tools !== toolbar.kinds + 2) {
    throw new Error('v panelu chybí nástroje: ' + toolbar.tools + ' vs ' + (toolbar.kinds + 2));
  }
  if (toolbar.withIcon !== toolbar.tools) throw new Error('některý nástroj nemá ikonku');
  if (!(toolbar.withAtlas > 10)) throw new Error('ikonky se neberou z herního atlasu: ' + toolbar.withAtlas);
  if (!toolbar.lineIcon || !toolbar.panGlyph) throw new Error('vedení a prohlížení nemají vlastní ikonku');
  if (!toolbar.poor.includes('nuclear')) throw new Error('drahá stavba se při málu peněz nezešedne');
  if (toolbar.rich !== 0) throw new Error('s plnou kasou se pořád něco tváří jako nedostupné: ' + toolbar.rich);
  if (!(toolbarAfter.solar < toolbar.normal) || !toolbarAfter.sale) {
    throw new Error('dotace se nepromítla do ceny v panelu: ' + toolbarAfter.solar + ' vs ' + toolbar.normal);
  }

  // --- info pod kurzorem: rozvodna nic nevyrábí, ať tam nesvítí 0/0 ---
  const hoverText = await page.evaluate(async () => {
    const { sim, renderer } = EG.game;
    const cv = renderer.canvas;
    const W = cv.clientWidth, H = cv.clientHeight;
    const sub = sim.buildings.find((b) => b.kind === 'sub');
    const gen = sim.buildings.find((b) => b.kind === 'coal' || b.kind === 'hydro');
    const look = (b) => {
      const [wx, wy] = renderer.tileToWorld(b.x, b.y);
      renderer.cam.x = wx; renderer.cam.y = wy;
      cv.dispatchEvent(new MouseEvent('mousemove', {
        clientX: W / 2, clientY: H / 2, bubbles: true, button: 0,
      }));
      return document.getElementById('hover-info').textContent;
    };
    return { sub: look(sub), gen: gen ? look(gen) : null };
  });
  console.log('info pod kurzorem:', JSON.stringify(hoverText));
  if (!hoverText.sub.includes('Rozvodna')) throw new Error('kurzor nad rozvodnou ji nepozná: ' + hoverText.sub);
  if (/\b0\s*\/\s*0 MW/.test(hoverText.sub)) {
    throw new Error('u rozvodny pořád svítí výkon 0/0: ' + hoverText.sub);
  }
  if (!hoverText.sub.includes('přípojnice') || !hoverText.sub.includes('pole ')) {
    throw new Error('u rozvodny chybí přípojnice a pole: ' + hoverText.sub);
  }
  if (hoverText.gen && !/\d+ \/ \d+ MW/.test(hoverText.gen)) {
    throw new Error('u elektrárny naopak výkon chybí: ' + hoverText.gen);
  }

  // --- mapa podle skutečné krajiny: čtení odkazu a výřez ---
  const place = await page.evaluate(() => {
    const p = EG.parsePlace;
    const r = {
      google: p('https://www.google.com/maps/@50.0755,14.4378,12z'),
      googlePlace: p('https://www.google.com/maps/place/Praha/@50.0755,14.4378,11z/data=!3m1!4b1'),
      googleData: p('https://www.google.com/maps/place/X/data=!3m1!4b1!3d49.1951!4d16.6068'),
      googleQuery: p('https://maps.google.com/?q=48.8584,2.2945'),
      osm: p('https://www.openstreetmap.org/#map=12/50.0755/14.4378'),
      plain: p('50.0755, 14.4378'),
      junk: p('kde to jsem'),
      empty: p(''),
      outOfRange: p('123.0, 14.0'),
    };
    const b25 = EG.bboxAround(50.0755, 14.4378, 25);
    const b50 = EG.bboxAround(50.0755, 14.4378, 50);
    // strana výřezu v km: poledníky se k pólům sbíhají
    const kmLat = (b25.n - b25.s) * 111.32;
    const kmLon = (b25.e - b25.w) * 111.32 * Math.cos(50.0755 * Math.PI / 180);
    const q = EG.overpassQuery(b25);
    return {
      ...r,
      kmLat: +kmLat.toFixed(2), kmLon: +kmLon.toFixed(2),
      wider: (b50.n - b50.s) / (b25.n - b25.s),
      queryHasWater: q.includes('natural"="water'),
      queryHasRail: q.includes('railway"="rail'),
      queryHasPlace: q.includes('place'),
      queryHasBox: q.includes(b25.s.toFixed(5)),
      zoom12: EG.terrainZoom(b25, 16),
      zoomBudget: EG.terrainZoom(EG.bboxAround(50.0755, 14.4378, 90), 16),
    };
  });
  console.log('mapa z odkazu:', JSON.stringify(place));
  for (const k of ['google', 'googlePlace', 'googleQuery', 'osm', 'plain']) {
    const v = place[k];
    if (!v) throw new Error('odkaz „' + k + '" se nepodařilo přečíst');
  }
  if (Math.abs(place.google.lat - 50.0755) > 1e-6 || Math.abs(place.google.lon - 14.4378) > 1e-6) {
    throw new Error('špatné souřadnice z odkazu Google Map: ' + JSON.stringify(place.google));
  }
  if (Math.abs(place.googleData.lat - 49.1951) > 1e-6) throw new Error('nepřečetl jsem !3d/!4d z odkazu');
  if (Math.abs(place.googleQuery.lon - 2.2945) > 1e-6) throw new Error('nepřečetl jsem ?q= souřadnice');
  if (Math.abs(place.osm.lat - 50.0755) > 1e-6) throw new Error('nepřečetl jsem odkaz z OpenStreetMap');
  if (place.junk || place.empty || place.outOfRange) throw new Error('nesmysl se tváří jako poloha');
  if (Math.abs(place.kmLat - 25) > 0.2 || Math.abs(place.kmLon - 25) > 0.2) {
    throw new Error('výřez není čtvercových 25 km: ' + place.kmLat + ' × ' + place.kmLon);
  }
  if (Math.abs(place.wider - 2) > 0.01) throw new Error('dvojnásobné území nemá dvojnásobnou stranu');
  if (!place.queryHasWater || !place.queryHasRail || !place.queryHasPlace || !place.queryHasBox) {
    throw new Error('dotaz na Overpass nemá všechno, co potřebujeme');
  }
  if (!(place.zoom12 >= 11 && place.zoom12 <= 13)) throw new Error('přiblížení výškopisu mimo rozsah: ' + place.zoom12);
  if (!(place.zoomBudget < place.zoom12)) throw new Error('větší území musí sáhnout po hrubším výškopisu');

  // --- převod dat na hrací plochu (bez sítě, na vlastní předloze) ---
  const osmMap = await page.evaluate(() => {
    // jednotkový výřez: zeměpisná délka 0..1 -> x, šířka 1..0 -> y
    const bbox = { s: 0, w: 0, n: 1, e: 1, lat: 0.5, lon: 0.5, km: 25 };
    const ring = (latA, lonA, latB, lonB) => [
      { lat: latA, lon: lonA }, { lat: latA, lon: lonB }, { lat: latB, lon: lonB },
      { lat: latB, lon: lonA }, { lat: latA, lon: lonA },
    ];
    const osm = { elements: [
      { type: 'way', tags: { natural: 'water' }, geometry: ring(0.60, 0.20, 0.70, 0.30) },
      { type: 'way', tags: { waterway: 'river' },
        geometry: [{ lat: 0.90, lon: 0.05 }, { lat: 0.50, lon: 0.50 }, { lat: 0.10, lon: 0.95 }] },
      { type: 'way', tags: { landuse: 'forest' }, geometry: ring(0.60, 0.60, 0.80, 0.80) },
      { type: 'way', tags: { landuse: 'industrial', name: 'Zóna Sever' }, geometry: ring(0.10, 0.10, 0.20, 0.20) },
      // trať rozsekaná na dva úseky, které na sebe navazují
      { type: 'way', tags: { railway: 'rail', name: 'Trať X' },
        geometry: [{ lat: 0.95, lon: 0.10 }, { lat: 0.70, lon: 0.35 }] },
      { type: 'way', tags: { railway: 'rail' },
        geometry: [{ lat: 0.70, lon: 0.35 }, { lat: 0.45, lon: 0.60 }] },
      { type: 'node', lat: 0.50, lon: 0.20, tags: { place: 'city', name: 'Velkoměsto', population: '250000' } },
      { type: 'node', lat: 0.35, lon: 0.75, tags: { place: 'village', name: 'Vesnička', population: '400' } },
    ] };
    const map = EG.buildMapFromOSM(osm, { size: 322, bbox, seed: 42 });
    const T = EG.T;
    const counts = {};
    for (let i = 0; i < map.type.length; i++) counts[map.type[i]] = (counts[map.type[i]] || 0) + 1;

    // řeka musí mít průtok a směr, aby na ní šla postavit elektrárna
    let maxFlow = 0, dirSet = 0, riverSpot = null;
    for (let i = 0; i < map.flow.length; i++) {
      if (map.flow[i] > maxFlow) maxFlow = map.flow[i];
      if (map.type[i] === T.RIVER && map.flowDir[i] >= 0) dirSet++;
    }
    const sim = new EG.Sim(map);
    sim.money = 100000;
    for (let i = 0; i < map.type.length && !riverSpot; i++) {
      if (map.type[i] !== T.RIVER) continue;
      const x = i % 322, y = (i / 322) | 0;
      if (sim.canPlace('hydro', x, y).ok) riverSpot = [x, y];
    }
    const hydro = riverSpot ? sim.place('hydro', riverSpot[0], riverSpot[1]) : null;
    for (let i = 0; i < 20; i++) sim.tick(0.1);

    // uložení a načtení nesmí importovanou krajinu ani výškopis ztratit
    const restored = EG.restore(EG.serialize(sim));
    let typeSame = true, elevMaxDiff = 0;
    for (let i = 0; i < map.type.length; i++) {
      if (restored.map.type[i] !== map.type[i]) { typeSame = false; break; }
      const d = Math.abs(restored.map.elev[i] - map.elev[i]);
      if (d > elevMaxDiff) elevMaxDiff = d;
    }

    return {
      water: counts[T.WATER] || 0, river: counts[T.RIVER] || 0, forest: counts[T.FOREST] || 0,
      maxFlow: +maxFlow.toFixed(1), dirSet,
      cities: map.cities.map((c) => c.name + ':' + c.pop),
      citiesFromOSM: map.osm.citiesFromOSM,
      industries: map.industries.filter((o) => o.type !== 'trakce').map((o) => o.name),
      traction: map.industries.filter((o) => o.type === 'trakce').length,
      railways: map.railways.length,
      railName: map.railways[0] && map.railways[0].name,
      railLen: map.railways[0] && map.railways[0].path.length,
      railTiles: map.railTiles.length,
      crossings: map.crossings.length, geo: map.geoFields.length,
      hydroGen: hydro ? +hydro.gen.toFixed(1) : 0,
      cityPowered: map.cities[0].powered !== undefined,
      typeSame, elevMaxDiff: +elevMaxDiff.toFixed(3),
      restoredOsm: !!restored.map.osm,
      popBig: EG.gamePop({ population: '250000' }), popSmall: EG.gamePop({ population: '400' }),
      popNone: EG.gamePop({ place: 'town' }),
    };
  });
  console.log('krajina z OSM:', JSON.stringify(osmMap));
  if (!(osmMap.water > 400)) throw new Error('jezero se nevykreslilo: ' + osmMap.water + ' dlaždic');
  if (!(osmMap.river > 200)) throw new Error('řeka se nevykreslila: ' + osmMap.river + ' dlaždic');
  if (!(osmMap.forest > 400)) throw new Error('les se nevykreslil: ' + osmMap.forest + ' dlaždic');
  if (!(osmMap.maxFlow > 3)) throw new Error('řeka nemá průtok: ' + osmMap.maxFlow);
  if (!(osmMap.dirSet > 100)) throw new Error('řeka nemá určený směr toku: ' + osmMap.dirSet);
  if (osmMap.citiesFromOSM !== 2) throw new Error('sídla z OSM nesedí: ' + osmMap.citiesFromOSM);
  if (!osmMap.cities.some((c) => c.startsWith('Velkoměsto')) || !osmMap.cities.some((c) => c.startsWith('Vesnička'))) {
    throw new Error('města nemají skutečná jména: ' + JSON.stringify(osmMap.cities));
  }
  if (osmMap.cities.length > 6) throw new Error('dogenerovalo se moc měst navíc: ' + osmMap.cities.length);
  if (!(osmMap.popBig > osmMap.popSmall + 15)) {
    throw new Error('velikost sídel se nerozlišuje: ' + osmMap.popBig + ' vs ' + osmMap.popSmall);
  }
  if (!(osmMap.popBig <= 58 && osmMap.popSmall >= 4)) throw new Error('populace mimo hratelný rozsah');
  if (!(osmMap.popNone > 4)) throw new Error('sídlo bez údaje o populaci nedostalo odhad');
  if (!osmMap.industries.some((n) => n.includes('Zóna Sever'))) {
    throw new Error('průmyslová zóna z OSM chybí: ' + JSON.stringify(osmMap.industries));
  }
  if (osmMap.railways !== 1) throw new Error('úseky trati se nespojily do koridoru: ' + osmMap.railways);
  if (osmMap.railName !== 'Trať X') throw new Error('trať ztratila jméno z OSM: ' + osmMap.railName);
  if (!(osmMap.railLen > 200) || !(osmMap.railTiles > 200)) throw new Error('trať je moc krátká: ' + osmMap.railLen);
  if (!(osmMap.traction > 0)) throw new Error('podél trati nevznikla trakční stanice');
  if (!(osmMap.crossings >= 3) || !(osmMap.geo >= 2)) throw new Error('chybí hraniční body nebo geotermální pole');
  if (!(osmMap.hydroGen > 0)) throw new Error('na importované řece nejde vyrobit proud: ' + osmMap.hydroGen);
  if (!osmMap.typeSame) throw new Error('uložení a načtení změnilo terén importované mapy');
  if (!(osmMap.elevMaxDiff < 0.01)) throw new Error('výškopis se uložením rozešel: ' + osmMap.elevMaxDiff);
  if (!osmMap.restoredOsm) throw new Error('načtená hra zapomněla, že jde o importovanou mapu');

  // --- výškopis: rovina zůstane rovinou, hory jen tam, kde jsou ---
  const relief = await page.evaluate(() => {
    const bbox = { s: 0, w: 0, n: 1, e: 1, lat: 0.5, lon: 0.5, km: 25 };
    const osm = { elements: [
      { type: 'node', lat: 0.5, lon: 0.5, tags: { place: 'town', name: 'Město', population: '9000' } },
    ] };
    const run = (metersPerTile) => {
      const el = new Float32Array(322 * 322);
      for (let y = 0; y < 322; y++) for (let x = 0; x < 322; x++) el[y * 322 + x] = x * metersPerTile;
      const map = EG.buildMapFromOSM(osm, { size: 322, bbox, seed: 3, elevation: el });
      const counts = {};
      for (let i = 0; i < map.type.length; i++) counts[map.type[i]] = (counts[map.type[i]] || 0) + 1;
      return {
        relief: map.osm.relief, real: map.osm.realElevation,
        hill: counts[EG.T.HILL] || 0, mountain: counts[EG.T.MOUNTAIN] || 0,
      };
    };
    const flat = run(0.02);   // převýšení ~6 m
    const rolling = run(1);   // ~300 m
    const alpine = run(6);    // ~1800 m
    const noData = EG.buildMapFromOSM(osm, { size: 322, bbox, seed: 3 });
    return { flat, rolling, alpine, noDataReal: noData.osm.realElevation };
  });
  console.log('výškopis:', JSON.stringify(relief));
  if (!relief.flat.real || relief.noDataReal) throw new Error('nepoznám, jestli je výškopis skutečný');
  if (relief.flat.hill !== 0 || relief.flat.mountain !== 0) {
    throw new Error('z roviny vyrostly kopce: ' + JSON.stringify(relief.flat));
  }
  if (!(relief.rolling.hill > 1000)) throw new Error('pahorkatina nemá kopce: ' + relief.rolling.hill);
  if (relief.rolling.mountain !== 0) throw new Error('pahorkatina má hory: ' + relief.rolling.mountain);
  if (!(relief.alpine.mountain > 5000)) throw new Error('hornatý kraj nemá hory: ' + relief.alpine.mountain);
  if (!(relief.alpine.relief > relief.rolling.relief * 3)) throw new Error('převýšení se nepočítá');

  // rozehraná hra v živé instanci + screenshot
  const live = await page.evaluate(() => {
    const { sim, map, renderer } = EG.game;
    sim.money = 50000;
    let rx = -1, ry = -1, bestScore = -1;
    for (let y = 0; y < map.size; y++) for (let x = 0; x < map.size; x++) {
      if (map.type[map.idx(x, y)] !== EG.T.RIVER || !sim.canPlace('hydro', x, y).ok) continue;
      // vybrat řeku co nejblíž některému městu
      let d = Infinity;
      for (const c of map.cities) d = Math.min(d, Math.hypot(c.x - x, c.y - y));
      const score = -d + map.flow[map.idx(x, y)];
      if (score > bestScore) { bestScore = score; rx = x; ry = y; }
    }
    const hydro = sim.place('hydro', rx, ry);
    let city = map.cities[0], cd = Infinity;
    for (const c of map.cities) {
      const d = Math.hypot(c.x - rx, c.y - ry);
      if (d < cd) { cd = d; city = c; }
    }
    let sub = null;
    for (let r = 2; r <= 5 && !sub; r++)
      for (let dy = -r; dy <= r && !sub; dy++) for (let dx = -r; dx <= r; dx++)
        if (sim.canPlace('sub', city.x + dx, city.y + dy).ok) { sub = sim.place('sub', city.x + dx, city.y + dy); break; }
    sim.buyTrafo(sub, 't110_22');
    sim.buyTrafo(sub, 't22_04');
    sim.connect(hydro, sub, 110);
    for (let i = 0; i < 100; i++) sim.tick(0.05);
    const [wx, wy] = renderer.tileToWorld((hydro.x + sub.x) / 2, (hydro.y + sub.y) / 2);
    renderer.cam.x = wx; renderer.cam.y = wy; renderer.cam.zoom = 1.4;
    return { hydroGen: hydro.gen, cityPowered: city.powered, lineLoad: sim.lines[0] && sim.lines[0].load };
  });
  console.log('živá hra:', JSON.stringify(live));
  await page.waitForTimeout(900);
  await page.screenshot({ path: '/tmp/eg_played.png' });

  // --- dialog importu: čte odkaz, hlásí nesmysl a umí mapu vyměnit ---
  // (až na konci – vymění živou mapu za importovanou)
  const importUi = await page.evaluate(async () => {
    document.getElementById('btn-import').click();
    const dlg = document.getElementById('import-dlg');
    const opened = !dlg.hidden;
    // nesmyslný vstup se musí zastavit dřív, než se sáhne na síť
    document.getElementById('import-url').value = 'tady u nás za rohem';
    document.getElementById('import-go').click();
    await new Promise((r) => setTimeout(r, 60));
    const status = document.getElementById('import-status');
    const badClass = status.className;
    document.getElementById('import-close').click();

    // výměna mapy za importovanou (bez sítě, z předlohy)
    const bbox = { s: 0, w: 0, n: 1, e: 1, lat: 50.0755, lon: 14.4378, km: 25 };
    const osm = { elements: [
      { type: 'way', tags: { waterway: 'river' },
        geometry: [{ lat: 0.9, lon: 0.1 }, { lat: 0.1, lon: 0.9 }] },
      { type: 'node', lat: 0.5, lon: 0.3, tags: { place: 'town', name: 'Testov', population: '12000' } },
    ] };
    const built = EG.buildMapFromOSM(osm, { size: 322, bbox, seed: 5 });
    EG.game.applyMap(built, '50.076, 14.438 · 25 km');
    return {
      opened, badClass, closed: dlg.hidden,
      mapIsOsm: !!EG.game.map.osm,
      city: EG.game.map.cities[0] && EG.game.map.cities[0].name,
      money: Math.round(EG.game.sim.money),
      // přeshraniční body si zakládá simulace sama, hráčovy stavby zmizet musí
      built: EG.game.sim.buildings.filter((b) => b.kind !== 'xborder').length,
      crossings: EG.game.sim.buildings.filter((b) => b.kind === 'xborder').length,
    };
  });
  await nextFrames(2);
  const importLabel = await page.evaluate(() => document.getElementById('seed-label').textContent);
  console.log('dialog importu:', JSON.stringify({ ...importUi, label: importLabel }));
  if (!importUi.opened || !importUi.closed) throw new Error('dialog importu se neotevře nebo nezavře');
  if (!importUi.badClass.includes('bad')) throw new Error('nesmyslný odkaz se nereklamuje: ' + importUi.badClass);
  if (!importUi.mapIsOsm || importUi.city !== 'Testov') throw new Error('výměna mapy neproběhla: ' + importUi.city);
  if (importUi.built !== 0) throw new Error('importovaná mapa si nese stavby z minulé hry: ' + importUi.built);
  if (!(importUi.crossings > 0)) throw new Error('importovaná mapa nemá přeshraniční body');
  if (importUi.money !== 900) throw new Error('import nezačíná se startovními penězi: ' + importUi.money);
  if (!importLabel.startsWith('🌍')) throw new Error('HUD neukazuje, že jde o importovanou mapu: ' + importLabel);

  await browser.close();
  server.close();

  if (errors.length) {
    console.log('CHYBY V KONZOLI:'); errors.forEach((e) => console.log(' -', e));
    process.exit(1);
  }
  console.log('SMOKE TEST OK');
})().catch((e) => { console.error(e); process.exit(1); });
