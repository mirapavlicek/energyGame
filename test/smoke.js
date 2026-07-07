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

    // servisní smlouva se o rozvodnu postará automaticky
    sim.setContract(sub, true);
    sim.tick(0.1);
    const contractFixed = !sub.broken && sub.cond > 0.9;
    for (let i = 0; i < 30; i++) sim.tick(0.1);
    const poweredAgain = map.cities[0].powered;

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
      wearWorks,
      levelsEmpty, noCommonNull: noCommon === null, supports110,
      wrongLevelNull: wrongLevel === null, tooFarNull: tooFar === null,
      trafoLoad110: +trafoLoad110.toFixed(2),
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
  if (!mgmt.wearWorks) throw new Error('opotřebení v ticku neběží');
  if (mgmt.levelsEmpty !== '0.4') throw new Error('prázdná rozvodna má mít jen NN, má: ' + mgmt.levelsEmpty);
  if (!mgmt.noCommonNull) throw new Error('spojení bez společné úrovně prošlo');
  if (!mgmt.supports110) throw new Error('trafo 110/22 nepřidalo 110kV přípojnici');
  if (!mgmt.wrongLevelNull) throw new Error('vedení 22 kV k vodní elektrárně (110 kV) prošlo');
  if (!mgmt.tooFarNull) throw new Error('110kV vedení delší než 28 dlaždic prošlo');
  if (!(mgmt.trafoLoad110 > 0)) throw new Error('tok přes trafo se neměří');

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
  if (subPanel.nBuyBtns !== 8) throw new Error('má být 8 typů traf, je ' + subPanel.nBuyBtns);
  if (subPanel.bought !== 1) throw new Error('nákup trafa přes UI nefunguje');
  if (!subPanel.levels.includes('110')) throw new Error('trafo nepřidalo 110kV přípojnici: ' + subPanel.levels);
  await page.waitForTimeout(250);
  const schemaUi = await page.evaluate(() => {
    const el = document.querySelector('#bp-schema');
    return { visible: !el.hidden, text: el.textContent };
  });
  console.log('schéma v UI:', JSON.stringify({ visible: schemaUi.visible, has110: schemaUi.text.includes('110 kV') }));
  if (!schemaUi.visible || !schemaUi.text.includes('Schéma')) throw new Error('schéma se v panelu rozvodny nezobrazuje');
  if (!schemaUi.text.includes('110 kV')) throw new Error('schéma neukazuje 110kV přípojnici po nákupu trafa');
  await page.screenshot({ path: '/tmp/eg_panel.png' });

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
