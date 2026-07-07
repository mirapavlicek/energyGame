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
    // rozvodna u prvního města
    const c = map.cities[0];
    let sub = null;
    for (let dy = -3; dy <= 3 && !sub; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (sim.canPlace('sub', c.x + dx, c.y + dy).ok) { sub = sim.place('sub', c.x + dx, c.y + dy); break; }
    }
    // řetěz rozvoden od elektrárny k městu (vedení max 24 dlaždic)
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
      hops.push(placed);
      cur = placed;
    }
    hops.push(sub);
    const lines = [];
    for (let i = 0; i < hops.length - 1; i++) lines.push(sim.connect(hops[i], hops[i + 1]));
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
  await page.screenshot({ path: '/tmp/eg_panel.png' });

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
    sim.connect(hydro, sub);
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
