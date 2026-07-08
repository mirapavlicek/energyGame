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
  const f = path.join(ROOT, url === '/' ? 'index.html' : url);
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
    res.end(data);
  });
});

(async () => {
  await new Promise((r) => server.listen(8901, r));
  const browser = await chromium.launch({
    executablePath: '/usr/local/bin/google-chrome',
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

  // --- dvojnásobná mapa: 226² ≈ 51 000 dlaždic a úměrně víc obsahu ---
  const bigmap = await page.evaluate(() => ({
    size: EG.game.map.size,
    tiles: EG.game.map.size * EG.game.map.size,
    cities: EG.game.map.cities.length,
    industries: EG.game.map.industries.length,
    crossings: EG.game.map.crossings.length,
  }));
  console.log('mapa:', JSON.stringify(bigmap));
  if (bigmap.size !== 227) throw new Error('mapa nemá 227 dlaždic na stranu: ' + bigmap.size);
  if (!(bigmap.tiles >= 2 * 160 * 160)) throw new Error('počet dlaždic není dvojnásobný: ' + bigmap.tiles);
  if (bigmap.cities < 18) throw new Error('málo měst na velké mapě: ' + bigmap.cities);
  if (bigmap.industries < 9) throw new Error('málo průmyslu na velké mapě: ' + bigmap.industries);
  if (bigmap.crossings < 4) throw new Error('málo předávacích bodů na velké mapě: ' + bigmap.crossings);

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

    // smlouva na palivo doplňuje automaticky
    coal.fuel = EG.FUEL.coal.cap * 0.1;
    sim.setFuelContract(coal, true);
    sim.tick(0.1);
    const contractRefilled = coal.fuel > EG.FUEL.coal.cap * 0.5;

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
  if (subPanel.nBuyBtns !== 14) throw new Error('má být 8 typů traf + 6 propojovacích polí, je ' + subPanel.nBuyBtns);
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

  // --- paleta napětí: skrytá v prohlížení, viditelná u nástroje vedení, 7 úrovní,
  //     různé max. délky přímo v popiscích ---
  const linebar = await page.evaluate(() => {
    const disp = () => getComputedStyle(document.querySelector('#linebar')).display;
    const hiddenInPan = disp() === 'none';
    document.querySelector('.tool[data-tool="line"]').click();
    const visibleInLine = disp() !== 'none';
    const nLevels = document.querySelectorAll('.linelvl').length;
    const maxLens = [...document.querySelectorAll('.linelvl')].map((el) => {
      const m = el.textContent.match(/max (\d+) dl/);
      return m ? +m[1] : null;
    });
    const maxLensDiffer = new Set(maxLens).size === maxLens.length && !maxLens.includes(null);
    document.querySelector('.linelvl[data-level="400"]').click();
    document.querySelector('.tool[data-tool="pan"]').click();
    const hiddenAgain = disp() === 'none';
    return { hiddenInPan, visibleInLine, nLevels, hiddenAgain, maxLens, maxLensDiffer };
  });
  console.log('paleta napětí:', JSON.stringify(linebar));
  if (!linebar.hiddenInPan || !linebar.visibleInLine || !linebar.hiddenAgain) throw new Error('paleta napětí se špatně schovává/ukazuje');
  if (linebar.nLevels !== 7) throw new Error('má být 7 napěťových úrovní, je ' + linebar.nLevels);
  if (!linebar.maxLensDiffer) throw new Error('každá úroveň má mít vlastní max. délku v popisku: ' + JSON.stringify(linebar.maxLens));

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
  if (maxLen.unique !== 7) throw new Error('úrovně nemají rozdílné max. délky: ' + JSON.stringify(maxLen.lens));
  if (!maxLen.far22Null) throw new Error('22 kV vedení delší než 14 dlaždic prošlo');
  if (!maxLen.ok400) throw new Error('400 kV vedení na stejnou vzdálenost neprošlo');

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

  await browser.close();
  server.close();

  if (errors.length) {
    console.log('CHYBY V KONZOLI:'); errors.forEach((e) => console.log(' -', e));
    process.exit(1);
  }
  console.log('SMOKE TEST OK');
})().catch((e) => { console.error(e); process.exit(1); });
