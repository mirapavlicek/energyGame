/* Hlavní smyčka, vstup, UI, minimapa. */
(function () {
  'use strict';
  const EG = window.EG;
  const A = EG.atlas;
  const S = A.S;

  const MAP_SIZE = 160;

  let map, sim, renderer;
  let tool = 'pan';            // pan | hydro | dam | coal | solar | wind | sub | line | demolish
  let lineFrom = null;         // budova, odkud táhneme vedení
  let lineLevel = 110;         // zvolená napěťová úroveň vedení
  let selected = null;         // budova otevřená v panelu správy

  /* barvy vedení podle napěťové úrovně */
  const LEVEL_COLOR = {
    800: [0.83, 0.45, 1.00],
    400: [1.00, 0.72, 0.20],
    220: [0.35, 0.78, 0.95],
    110: [0.62, 0.66, 0.72],
    22:  [0.42, 0.85, 0.45],
    11:  [0.72, 0.90, 0.45],
    0.4: [0.95, 0.95, 0.88],
  };
  let hover = [0, 0];
  let mouse = { x: 0, y: 0, down: false, panning: false, lastX: 0, lastY: 0 };
  let speed = 1;
  let lastMsgCount = 0;

  const $ = (s) => document.querySelector(s);

  function kindSprite(kind) {
    return { hydro: S.HYDRO, dam: S.DAM, coal: S.COAL, solar: S.SOLAR, wind: S.WIND, sub: S.SUBST }[kind];
  }

  function init() {
    const seedStr = new URLSearchParams(location.search).get('seed');
    const seed = seedStr ? (parseInt(seedStr, 10) || 1) : ((Math.random() * 1e9) | 0);
    map = EG.generateMap(MAP_SIZE, seed);
    sim = new EG.Sim(map);
    const canvas = $('#game');
    renderer = new EG.Renderer(canvas);
    // jemné tónování podle výšky, ať mapa není plochá jednolitá barva
    const tintFn = (x, y) => 0.88 + Math.min(0.24, Math.max(0, map.elev[map.idx(x, y)] - 0.3) * 0.55);
    EG.onTerrainChanged = () => renderer.uploadTerrain(map, tintFn);
    renderer.uploadTerrain(map, tintFn);

    // kamera do středu první osady
    const c0 = map.cities[0] || { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };
    const [wx, wy] = renderer.tileToWorld(c0.x, c0.y);
    renderer.cam.x = wx; renderer.cam.y = wy;
    renderer.cam.zoom = 0.9;

    $('#seed-label').textContent = 'seed ' + seed;
    $('#btn-newmap').addEventListener('click', () => {
      location.search = '?seed=' + ((Math.random() * 1e9) | 0);
    });

    setupInput(canvas);
    setupToolbar();
    setupLinebar();
    setupMinimap();
    $('#bp-close').addEventListener('click', closePanel);
    sim.msg('Vítej! Postav elektrárnu, u města rozvodnu a kup do ní trafa (klik na rozvodnu).');
    sim.msg('Pak vše spoj vedením správného napětí – vodní elektrárna vyrábí na 110 kV.');

    // ladicí přístup (používá i smoke test)
    EG.game = { get sim() { return sim; }, get map() { return map; }, get renderer() { return renderer; } };

    requestAnimationFrame(loop);
  }

  /* ---------- vstup ---------- */
  function setupInput(canvas) {
    canvas.addEventListener('mousedown', (e) => {
      mouse.down = true; mouse.lastX = e.clientX; mouse.lastY = e.clientY;
      mouse.panning = (e.button === 1 || e.button === 2 || tool === 'pan');
    });
    window.addEventListener('mouseup', (e) => {
      const wasPan = mouse.panning && (Math.abs(e.clientX - mouse.lastX) + Math.abs(e.clientY - mouse.lastY) > 4);
      mouse.down = false; mouse.panning = false;
      if (e.button === 0 && !wasPan && e.target === canvas) click();
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = e.clientX - rect.left; mouse.y = e.clientY - rect.top;
      if (mouse.down && mouse.panning) {
        renderer.cam.x -= (e.clientX - mouse.lastX) / renderer.cam.zoom;
        renderer.cam.y -= (e.clientY - mouse.lastY) / renderer.cam.zoom;
        mouse.lastX = e.clientX; mouse.lastY = e.clientY;
      } else {
        mouse.lastX = e.clientX; mouse.lastY = e.clientY;
      }
      hover = renderer.screenToTile(mouse.x, mouse.y);
      updateHoverInfo();
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const z = renderer.cam.zoom;
      const nz = Math.min(3.2, Math.max(0.18, z * (e.deltaY < 0 ? 1.15 : 0.87)));
      // zoom ke kurzoru
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left - canvas.clientWidth / 2;
      const my = e.clientY - rect.top - canvas.clientHeight / 2;
      renderer.cam.x += mx / z - mx / nz;
      renderer.cam.y += my / z - my / nz;
      renderer.cam.zoom = nz;
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      const byHotkey = Object.entries(EG.BUILD).find(([, v]) => v.hotkey === k);
      if (byHotkey) {
        if (byHotkey[0] === 'line' && tool === 'line') {
          // opakovaný stisk 7 cykluje napěťové úrovně
          const i = EG.LEVELS.indexOf(lineLevel);
          setLineLevel(EG.LEVELS[(i + 1) % EG.LEVELS.length]);
        } else setTool(byHotkey[0]);
      }
      else if (k === 'escape') { if (selected) closePanel(); else setTool('pan'); }
      else if (k === 'q') setTool('pan');
      else if (k === 'x') setTool('demolish');
      else if (k === ' ') { e.preventDefault(); speed = speed === 0 ? 1 : 0; updateSpeedLabel(); }
      else if (k === '+' || k === '=') { speed = Math.min(4, (speed || 1) * 2); updateSpeedLabel(); }
      else if (k === '-') { speed = Math.max(1, speed / 2) * (speed === 0 ? 0 : 1); updateSpeedLabel(); }
    });
  }

  function click() {
    const [gx, gy] = hover;
    if (tool === 'pan') {
      const b = sim.buildingAt(gx, gy);
      if (b) selectBuilding(b); else closePanel();
      return;
    }
    if (tool === 'demolish') {
      // klik na vedení? – najdi nejbližší segment do 0.6 dlaždice
      const l = lineNear(gx, gy);
      if (l && !sim.buildingAt(gx, gy)) { sim.removeLine(l); return; }
      const b = sim.buildingAt(gx, gy);
      if (sim.demolish(gx, gy) && b === selected) closePanel();
      return;
    }
    if (tool === 'line') {
      const b = sim.buildingAt(gx, gy);
      if (!b) { sim.msg('Vedení musí začínat i končit na stavbě', 'warn'); return; }
      if (!sim.supportsLevel(b, lineLevel)) {
        const lvls = sim.levelsOf(b).map((lv) => EG.LINE_TYPES[lv].name).join(', ');
        sim.msg(EG.BUILD[b.kind].name + ' nemá přípojnici ' + EG.LINE_TYPES[lineLevel].name +
          (lvls ? ' (má: ' + lvls + ')' : ''), 'warn');
        return;
      }
      if (!lineFrom) { lineFrom = b; sim.msg('Vyber cílovou stavbu (' + EG.LINE_TYPES[lineLevel].name + ')'); return; }
      sim.connect(lineFrom, b, lineLevel);
      lineFrom = b; // řetězení vedení
      return;
    }
    // stavba budovy
    const b = sim.place(tool, gx, gy);
    if (b && tool !== 'sub') {
      // pohodlí: po postavení elektrárny rovnou nabídnout vedení
    }
  }

  function lineNear(gx, gy) {
    let best = null, bestD = 0.7;
    for (const l of sim.lines) {
      const a = sim.buildings.find((b) => b.id === l.a);
      const b = sim.buildings.find((o) => o.id === l.b);
      if (!a || !b) continue;
      const d = distToSeg(gx, gy, a.x, a.y, b.x, b.y);
      if (d < bestD) { bestD = d; best = l; }
    }
    return best;
  }

  function distToSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  /* ---------- toolbar ---------- */
  function setTool(t) {
    tool = t;
    lineFrom = null;
    document.querySelectorAll('.tool').forEach((el) => {
      el.classList.toggle('active', el.dataset.tool === t);
    });
    $('#linebar').hidden = t !== 'line';
    $('#game').style.cursor = t === 'pan' ? 'grab' : 'crosshair';
  }

  function setLineLevel(lv) {
    lineLevel = lv;
    lineFrom = null;
    document.querySelectorAll('.linelvl').forEach((el) => {
      el.classList.toggle('active', +el.dataset.level === lv);
    });
    const LT = EG.LINE_TYPES[lv];
    sim.msg('Vedení: ' + LT.name + ' (kapacita ' + LT.cap + ' MW, max ' + LT.maxLen + ' dl.)');
  }

  function setupLinebar() {
    const bar = $('#linebar');
    for (const lv of EG.LEVELS) {
      const LT = EG.LINE_TYPES[lv];
      const el = document.createElement('button');
      el.className = 'linelvl';
      el.dataset.level = lv;
      const [r, g, b] = LEVEL_COLOR[lv];
      el.innerHTML = '<span class="swatch" style="background:rgb(' +
        Math.round(r * 255) + ',' + Math.round(g * 255) + ',' + Math.round(b * 255) + ')"></span>' +
        LT.name + '<span class="cost">' + LT.cap + ' MW · max ' + LT.maxLen + ' dl · ' + LT.cost + '/dl</span>';
      el.title = 'Kapacita ' + LT.cap + ' MW, max. délka ' + LT.maxLen + ' dlaždic, cena ' + LT.cost +
        ' za dlaždici, ztráty ' + (LT.loss * 100).toFixed(2) + ' %/dl při plném zatížení.';
      el.addEventListener('click', () => setLineLevel(lv));
      bar.appendChild(el);
    }
    document.querySelector('.linelvl[data-level="110"]').classList.add('active');
  }

  function setupToolbar() {
    const bar = $('#toolbar');
    const tools = [
      { t: 'pan', label: 'Prohlížet', key: 'Q' },
      ...Object.entries(EG.BUILD).map(([k, v]) => ({
        t: k, label: v.name, key: v.hotkey.toUpperCase(), cost: v.cost, desc: v.desc,
      })),
      { t: 'demolish', label: 'Zbourat', key: 'X' },
    ];
    for (const def of tools) {
      const el = document.createElement('button');
      el.className = 'tool';
      el.dataset.tool = def.t;
      el.innerHTML = '<span class="key">' + def.key + '</span>' + def.label +
        (def.cost ? '<span class="cost">' + def.cost + (def.t === 'line' ? '/dl' : '') + '</span>' : '');
      if (def.desc) el.title = def.desc;
      el.addEventListener('click', () => setTool(def.t));
      bar.appendChild(el);
    }
    setTool('pan');
    $('#btn-speed').addEventListener('click', () => {
      speed = speed === 0 ? 1 : speed >= 4 ? 0 : speed * 2;
      updateSpeedLabel();
    });
  }

  function updateSpeedLabel() {
    $('#btn-speed').textContent = speed === 0 ? '⏸ pauza' : '▶ ' + speed + '×';
  }

  /* ---------- schéma rozvodny: přípojnice, trafa a toky výkonu ---------- */
  /* Vrací řádky jednopólového schématu: kudy výkon do rozvodny přitéká,
     kam odtéká vedeními, trafy mezi hladinami a odběry měst/průmyslu. */
  function schemaData(sim, b) {
    const bi = sim.buildings.indexOf(b);
    const rows = [];
    const eps = 0.05;
    for (const lv of sim.levelsOf(b)) {
      rows.push({ type: 'bus', lv, label: EG.LINE_TYPES[lv].name });
      // vedení na této hladině
      for (const l of sim.lines) {
        if (l.level !== lv || (l.a !== b.id && l.b !== b.id)) continue;
        const other = sim.buildings.find((o) => o.id === (l.a === b.id ? l.b : l.a));
        if (!other) continue;
        const inflow = l.b === b.id ? l.flow : -l.flow; // kladné = teče SEM
        const name = EG.BUILD[other.kind].name + ' [' + other.x + ',' + other.y + ']';
        rows.push({
          type: 'line',
          dir: inflow > eps ? 'in' : inflow < -eps ? 'out' : 'idle',
          mw: Math.abs(inflow), label: name, load: l.load,
        });
      }
      // odběry: města na NN, průmysl na VN
      if (lv === 0.4) {
        for (const ca of (sim.cityAssign || [])) {
          if (ca.sub >= 0 && sim.buildings[ca.sub] === b) {
            rows.push({ type: 'load', dir: 'out', mw: ca.served, label: 'město ' + ca.city.name });
          }
        }
      }
      for (const ia of (sim.indAssign || [])) {
        if (ia.level === lv && ia.sub >= 0 && sim.buildings[ia.sub] === b) {
          rows.push({ type: 'load', dir: 'out', mw: ia.served, label: ia.ind.name });
        }
      }
      // trafa z této hladiny dolů
      for (const [key, count] of Object.entries(b.trafos || {})) {
        if (!count) continue;
        const t = EG.TRAFOS[key];
        if (t.hi !== lv) continue;
        const flow = (b.trafoFlow || {})[key] || 0; // kladné = hi -> lo
        rows.push({
          type: 'trafo', key,
          dir: flow >= 0 ? 'down' : 'up',
          mw: Math.abs(flow), load: (b.trafoLoad || {})[key] || 0,
          label: t.name + (count > 1 ? ' ×' + count : ''), lo: t.lo,
        });
      }
    }
    return rows;
  }
  EG.schemaData = schemaData;

  function renderSchema(b) {
    const rows = schemaData(sim, b);
    let html = '';
    for (const r of rows) {
      if (r.type === 'bus') {
        html += '<div class="bp-bus">' + r.label + '</div>';
      } else if (r.type === 'trafo') {
        const arrow = r.dir === 'down' ? '⇩' : '⇧';
        const cls = r.load > 1 ? 'bad' : r.load > 0.75 ? 'warn' : '';
        html += '<div class="bp-sch-trafo ' + cls + '">' + arrow + ' trafo ' + r.label +
          ' · ' + r.mw.toFixed(1) + ' MW · ' + Math.round(r.load * 100) + ' %</div>';
      } else {
        const arrow = r.dir === 'in' ? '←' : r.dir === 'out' ? '→' : '·';
        const verb = r.type === 'load' ? '' : (r.dir === 'in' ? ' z ' : r.dir === 'out' ? ' do ' : ' ');
        const cls = r.dir === 'in' ? 'in' : r.dir === 'out' ? 'out' : 'idle';
        const over = r.type === 'line' && r.load > 1 ? ' <span class="bad">PŘETÍŽENO</span>' : '';
        html += '<div class="bp-sch-feed ' + cls + '">' + arrow + verb + r.label +
          ' · ' + r.mw.toFixed(1) + ' MW' + over + '</div>';
      }
    }
    if (!rows.some((r) => r.type !== 'bus')) {
      html += '<div class="bp-trafo-none">Žádné toky – připoj vedení a kup trafa.</div>';
    }
    return html;
  }

  /* ---------- panel správy budovy ---------- */
  function selectBuilding(b) {
    selected = b;
    $('#bpanel').hidden = false;
    buildPanelActions();
    updatePanel();
  }

  function closePanel() {
    selected = null;
    $('#bpanel').hidden = true;
  }

  function bpButton(html, cls, onClick) {
    const el = document.createElement('button');
    el.className = 'bp-btn' + (cls ? ' ' + cls : '');
    el.innerHTML = html;
    el.addEventListener('click', () => { onClick(); buildPanelActions(); updatePanel(); });
    $('#bp-actions').appendChild(el);
    return el;
  }

  /* tlačítka se přestaví po každé akci (mění se ceny a úrovně) */
  function buildPanelActions() {
    const b = selected;
    const box = $('#bp-actions');
    box.innerHTML = '';
    if (!b) return;

    const svc = bpButton('🔧 Servis' + (b.broken ? ' (oprava poruchy)' : '') +
      '<span class="cost" id="bp-svc-cost"></span>', b.broken ? 'danger' : '',
      () => sim.service(b));
    svc.id = 'bp-btn-svc';

    const contract = bpButton('📋 Servisní smlouva <span class="cost">+20 % k ceně servisu</span>',
      b.contract ? 'on' : '',
      () => sim.setContract(b, !b.contract));
    contract.id = 'bp-btn-contract';
    contract.title = 'Technici vyjedou automaticky, když stav klesne pod 50 % nebo při poruše.';

    if (EG.FUEL[b.kind]) {
      const fd = EG.FUEL[b.kind];
      const fuel = bpButton('⛽ Koupit ' + fd.name + ' <span class="cost" id="bp-fuel-cost"></span>', '',
        () => sim.buyFuel(b));
      fuel.id = 'bp-btn-fuel';
      fuel.title = 'Doplní sklad (' + fd.cap + ' ' + fd.unit + ') za ' + fd.price + '/' + fd.unit +
        '. Bez paliva elektrárna stojí!';
      const fc = bpButton('🚚 Smlouva na palivo <span class="cost">+15 % k ceně</span>',
        b.fuelContract ? 'on' : '',
        () => sim.setFuelContract(b, !b.fuelContract));
      fc.id = 'bp-btn-fuelcontract';
      fc.title = 'Dodávky přijedou automaticky, když zásoba klesne pod 25 %.';
    }

    const up = bpButton('⚙ Modernizace <span class="cost" id="bp-up-cost"></span>', '',
      () => sim.upgrade(b));
    up.id = 'bp-btn-up';
    up.title = b.kind === 'sub'
      ? 'Kvalitnější technologie rozvodny: výrazně pomalejší opotřebení.'
      : 'Nové turbíny/panely/kotle: +25 % výkonu za úroveň a pomalejší opotřebení.';

    if (b.kind === 'sub') {
      const rng = bpButton('📡 Větší dosah NN distribuce <span class="cost" id="bp-rng-cost"></span>', '',
        () => sim.upgradeRange(b));
      rng.id = 'bp-btn-rng';
      rng.title = 'Zvětší dosah rozvodny k městům o 2 dlaždice.';

      // --- trafa: instalovaná + nákup ---
      const sec = document.createElement('div');
      sec.className = 'bp-sec';
      sec.textContent = 'Trafa';
      box.appendChild(sec);
      const list = document.createElement('div');
      list.id = 'bp-trafo-list';
      box.appendChild(list);
      for (const [key, t] of Object.entries(EG.TRAFOS)) {
        const el = bpButton('➕ ' + t.name + '<span class="cost">' + t.cap + ' MW · −' + t.cost + '</span>', 'trafo-buy',
          () => sim.buyTrafo(b, key));
        el.dataset.trafo = key;
        el.title = 'Převádí ' + EG.LINE_TYPES[t.hi].name + ' ↔ ' + EG.LINE_TYPES[t.lo].name +
          ', kapacita ' + t.cap + ' MW. Více kusů se sčítá.';
      }
    }

    if (b.kind !== 'dam') {
      bpButton('🗑 Zbourat <span class="cost">+' + Math.floor(EG.BUILD[b.kind].cost * 0.4) + '</span>', 'danger',
        () => { if (sim.demolish(b.x, b.y)) closePanel(); });
    }
  }

  function updatePanel() {
    const b = selected;
    if (!b) return;
    // budova mohla mezitím zaniknout
    if (!sim.buildings.includes(b)) { closePanel(); return; }
    const def = EG.BUILD[b.kind];
    $('#bp-title').textContent = def.name + ' [' + b.x + ',' + b.y + ']';

    let rows = '';
    if (b.kind === 'sub') {
      rows += 'Přípojnice: <span class="val">' +
        sim.levelsOf(b).map((lv) => EG.LINE_TYPES[lv].name.replace(/^(VVN|VN|NN) /, '')).join(', ') + '</span><br>';
      rows += 'Dosah NN: <span class="val">' + sim.subRange(b) + ' dlaždic</span><br>';
      rows += 'Odběr přes rozvodnu: <span class="val">' +
        (sim.cityAssign || []).filter((ca) => ca.sub >= 0 && sim.buildings[ca.sub] === b)
          .reduce((s, ca) => s + ca.served, 0).toFixed(0) + ' MW</span><br>';
    } else {
      rows += 'Výkon: <span class="val">' + b.out.toFixed(1) + ' / ' + b.gen.toFixed(1) + ' MW</span><br>';
      rows += 'Výstupní napětí: <span class="val">' + EG.LINE_TYPES[EG.GEN_LEVEL[b.kind]].name + '</span><br>';
      const fd = EG.FUEL[b.kind];
      if (fd) {
        const pct = Math.round(b.fuel / fd.cap * 100);
        const cls = b.fuel <= 0 ? 'bad' : pct < 20 ? 'bad' : '';
        rows += 'Palivo (' + fd.name + '): <span class="val ' + cls + '">' +
          Math.round(b.fuel) + ' / ' + fd.cap + ' ' + fd.unit + ' (' + pct + ' %)</span>';
        if (b.fuel <= 0) rows += ' <span class="bad">⚠ STOJÍ BEZ PALIVA</span>';
        if (b.fuelContract) rows += ' · <span class="val">smlouva ✓</span>';
        rows += '<br>';
      }
    }
    rows += 'Úroveň: <span class="val">' + b.level + ' / ' + EG.MAX_LEVEL + '</span>';
    if (b.kind === 'sub') rows += ' · dosah <span class="val">+' + (b.rangeLevel || 0) * 2 + '</span>';
    rows += '<br>Provoz: <span class="val">' + (def.upkeep * (1 + 0.25 * (b.level - 1))).toFixed(1) + '/s</span>';
    if (b.contract) rows += ' · <span class="val">smlouva ✓</span>';
    if (b.broken) rows += '<br><span class="bad">⚠ PORUCHA – mimo provoz, nutný servis!</span>';
    $('#bp-stats').innerHTML = rows;

    const pct = Math.round(b.cond * 100);
    $('#bp-cond-pct').textContent = pct + ' %';
    const fill = $('#bp-cond-fill');
    fill.style.width = pct + '%';
    fill.style.background = b.broken ? '#ff5340' : pct > 60 ? '#5dbb63' : pct > 30 ? '#e8c84a' : '#ff8c40';

    // živé ceny + dostupnost tlačítek
    const svcCost = sim.serviceCost(b);
    const svcBtn = $('#bp-btn-svc');
    if (svcBtn) {
      $('#bp-svc-cost').textContent = '−' + svcCost;
      svcBtn.disabled = (!b.broken && b.cond > 0.97) || sim.money < svcCost;
    }
    const upBtn = $('#bp-btn-up');
    if (upBtn) {
      const c = sim.upgradeCost(b);
      $('#bp-up-cost').textContent = c === null ? 'max' : '−' + c;
      upBtn.disabled = c === null || sim.money < c;
    }
    const rngBtn = $('#bp-btn-rng');
    if (rngBtn) {
      const c = sim.rangeUpgradeCost(b);
      $('#bp-rng-cost').textContent = c === null ? 'max' : '−' + c;
      rngBtn.disabled = c === null || sim.money < c;
    }
    const cBtn = $('#bp-btn-contract');
    if (cBtn) cBtn.classList.toggle('on', !!b.contract);
    const fuelBtn = $('#bp-btn-fuel');
    if (fuelBtn && EG.FUEL[b.kind]) {
      const c = sim.fuelCost(b);
      $('#bp-fuel-cost').textContent = c === 0 ? 'plný sklad' : '−' + c;
      fuelBtn.disabled = c === 0 || sim.money < EG.FUEL[b.kind].price;
    }
    const fcBtn = $('#bp-btn-fuelcontract');
    if (fcBtn) fcBtn.classList.toggle('on', !!b.fuelContract);

    // schéma rozvodny: přípojnice a toky výkonu
    const schema = $('#bp-schema');
    if (b.kind === 'sub') {
      schema.hidden = false;
      schema.innerHTML = '<div class="bp-sec" style="border-top:none;margin-top:0;padding-top:0">Schéma a toky</div>' + renderSchema(b);
    } else {
      schema.hidden = true;
    }

    // trafa: instalované kusy + zatížení, dostupnost nákupu
    if (b.kind === 'sub') {
      const list = $('#bp-trafo-list');
      if (list) {
        const items = Object.entries(b.trafos || {}).filter(([, c]) => c > 0);
        list.innerHTML = items.length === 0
          ? '<div class="bp-trafo-none">Žádné trafo – rozvodna má jen NN (400 V). Bez trafa nepřipojí VN/VVN vedení.</div>'
          : items.map(([key, count]) => {
            const t = EG.TRAFOS[key];
            const load = (b.trafoLoad || {})[key] || 0;
            const pct = Math.round(load * 100);
            const cls = load > 1 ? 'bad' : load > 0.75 ? 'warn' : '';
            return '<div class="bp-trafo-item">' + t.name + ' ×' + count +
              ' <span class="' + cls + '">' + pct + ' %</span>' +
              ' <span class="dim">z ' + t.cap * count + ' MW</span></div>';
          }).join('');
      }
      document.querySelectorAll('.trafo-buy').forEach((el) => {
        el.disabled = sim.money < EG.TRAFOS[el.dataset.trafo].cost;
      });
    }
  }

  function updateHoverInfo() {
    const [gx, gy] = hover;
    const el = $('#hover-info');
    if (gx < 0 || gy < 0 || gx >= map.size || gy >= map.size) { el.textContent = ''; return; }
    const t = map.type[map.idx(gx, gy)];
    const names = ['jezero', 'písek', 'louka', 'les', 'kopec', 'hora', 'řeka', 'nádrž'];
    let s = '[' + gx + ',' + gy + '] ' + (names[t] || '?');
    if (t === 6) s += ' · průtok ' + map.flow[map.idx(gx, gy)].toFixed(1);
    const b = sim.buildingAt(gx, gy);
    if (b) {
      s += ' · ' + EG.BUILD[b.kind].name;
      if (b.kind !== 'sub') s += ' (' + EG.LINE_TYPES[EG.GEN_LEVEL[b.kind]].name + ')';
      s += ' ' + b.out.toFixed(0) + '/' + b.gen.toFixed(0) + ' MW';
      s += b.broken ? ' · PORUCHA' : ' · stav ' + Math.round(b.cond * 100) + ' %';
      const fd = EG.FUEL[b.kind];
      if (fd) s += b.fuel > 0 ? ' · ' + fd.name + ' ' + Math.round(b.fuel / fd.cap * 100) + ' %' : ' · BEZ PALIVA';
    }
    const ind = (map.industries || []).find((o) => Math.abs(o.x - gx) <= 1 && Math.abs(o.y - gy) <= 1);
    if (ind) {
      const ia = (sim.indAssign || []).find((a) => a.ind === ind);
      s += ' · ' + ind.name + ' (průmysl, potřeba ' + (ia ? ia.demand.toFixed(0) : ind.demand.toFixed(0)) +
        ' MW z VN, napájení ' + Math.round((ind.powered || 0) * 100) + ' %, platí +40 %)';
    }
    const city = map.cities.find((c) => Math.abs(c.x - gx) <= 2 && Math.abs(c.y - gy) <= 2);
    if (city) {
      const kindName = { res: 'obytné', ind: 'průmyslové', mix: 'smíšené' }[city.kind] || '';
      const ca = (sim.cityAssign || []).find((a) => a.city === city);
      s += ' · ' + city.name + ' (' + kindName + ', ' + city.pop + ' tis., potřeba ' +
        (ca ? ca.demand.toFixed(0) : '?') + ' MW, napájení ' + Math.round((city.powered || 0) * 100) + ' %)';
    }
    if (tool === 'line' && lineFrom) {
      const LT = EG.LINE_TYPES[lineLevel];
      const d = Math.hypot(lineFrom.x - gx, lineFrom.y - gy);
      s += ' · ' + LT.name + ' délka ' + d.toFixed(1) + ' / max ' + LT.maxLen + ' dl' +
        (d > LT.maxLen ? ' – PŘÍLIŠ DALEKO' : '');
    }
    el.textContent = s;
  }

  /* ---------- minimapa ---------- */
  let minimapCtx, minimapBase;
  function setupMinimap() {
    const cv = $('#minimap');
    cv.width = map.size; cv.height = map.size;
    minimapCtx = cv.getContext('2d');
    minimapBase = document.createElement('canvas');
    minimapBase.width = map.size; minimapBase.height = map.size;
    const g = minimapBase.getContext('2d');
    const img = g.createImageData(map.size, map.size);
    const colors = {
      0: [46, 111, 168], 1: [216, 201, 141], 2: [124, 179, 91], 3: [105, 160, 76],
      4: [143, 174, 100], 5: [142, 141, 134], 6: [63, 134, 192], 7: [51, 115, 159],
    };
    for (let i = 0; i < map.size * map.size; i++) {
      const c = colors[map.type[i]] || [0, 0, 0];
      img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2]; img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    cv.addEventListener('click', (e) => {
      const r = cv.getBoundingClientRect();
      const gx = (e.clientX - r.left) / r.width * map.size;
      const gy = (e.clientY - r.top) / r.height * map.size;
      const [wx, wy] = renderer.tileToWorld(gx, gy);
      renderer.cam.x = wx; renderer.cam.y = wy;
    });
  }

  function drawMinimap() {
    const g = minimapCtx;
    g.drawImage(minimapBase, 0, 0);
    for (const c of map.cities) {
      g.fillStyle = (c.powered || 0) > 0.9 ? '#ffe14d' : '#ff5340';
      g.fillRect(c.x - 1.5, c.y - 1.5, 4, 4);
    }
    g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 1;
    for (const l of sim.lines) {
      const a = sim.buildings.find((b) => b.id === l.a);
      const b = sim.buildings.find((o) => o.id === l.b);
      if (!a || !b) continue;
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    }
    for (const ind of map.industries || []) {
      g.fillStyle = (ind.powered || 0) > 0.9 ? '#c77dff' : '#ff5340';
      g.fillRect(ind.x - 1.5, ind.y - 1.5, 4, 4);
    }
    for (const b of sim.buildings) {
      g.fillStyle = b.kind === 'sub' ? '#e8c84a' : '#ffffff';
      g.fillRect(b.x - 1, b.y - 1, 2.5, 2.5);
    }
    // rámeček kamery
    const z = renderer.cam.zoom;
    const cw = renderer.canvas.clientWidth / z, ch = renderer.canvas.clientHeight / z;
    const gx = (renderer.cam.x / EG.iso.HW + renderer.cam.y / EG.iso.HH) / 2;
    const gy = (renderer.cam.y / EG.iso.HH - renderer.cam.x / EG.iso.HW) / 2;
    g.strokeStyle = 'rgba(255,255,255,0.6)';
    g.strokeRect(gx - cw / 130, gy - ch / 70, cw / 65, ch / 35);
  }

  /* ---------- HUD ---------- */
  function updateHUD() {
    $('#money').textContent = Math.floor(sim.money).toLocaleString('cs-CZ') + ' ₤';
    const st = sim.stats;
    $('#power').textContent = st.delivered.toFixed(0) + ' / ' + st.demand.toFixed(0) + ' MW';
    $('#power').className = st.demand > 0 && st.delivered / st.demand < 0.7 ? 'bad' : (st.delivered / Math.max(1, st.demand) < 0.98 ? 'warn' : '');
    $('#losses').textContent = (st.losses || 0).toFixed(1) + ' MW';
    $('#losses').style.color = (st.losses || 0) > 0.15 * Math.max(1, st.delivered) ? '#ff6a5a' : '';
    $('#income').textContent = (st.income >= 0 ? '+' : '') + (st.income * 60).toFixed(1) + '/min';
    $('#score').textContent = Math.floor(sim.score).toLocaleString('cs-CZ');
    const ph = sim.dayPhase || 0;
    const hours = Math.floor(6 + ph * 24) % 24;
    const seasonIco = { 'jaro': '🌱', 'léto': '☀️', 'podzim': '🍂', 'zima': '❄️' }[sim.seasonName] || '';
    $('#clock').textContent = 'den ' + (sim.day || 1) + ' · ' + seasonIco + (sim.seasonName || '') + ' · ' +
      String(hours).padStart(2, '0') + ':00 ' +
      (sim.sun > 0.05 ? '☀' + Math.round(sim.sun * 100) + '%' : '☾') + ' 💨' + Math.round(sim.wind * 100) + '%';

    if (sim.messages.length !== lastMsgCount) {
      lastMsgCount = sim.messages.length;
      const log = $('#log');
      log.innerHTML = sim.messages.slice(-6).map((m) =>
        '<div class="' + m.kind + '">' + m.text + '</div>').join('');
      log.scrollTop = log.scrollHeight;
    }
  }

  /* ---------- vykreslení scény ---------- */
  function pushScene() {
    renderer.beginDynamic();
    const id2b = new Map();
    for (const b of sim.buildings) id2b.set(b.id, b);

    // vedení – barva podle napěťové úrovně, přetížení červeně/oranžově
    for (const l of sim.lines) {
      const a = id2b.get(l.a), b = id2b.get(l.b);
      if (!a || !b) continue;
      const lc = LEVEL_COLOR[l.level] || [0.25, 0.25, 0.28];
      let r = lc[0] * 0.45, g = lc[1] * 0.45, bl = lc[2] * 0.45;
      if (l.load > 1) { r = 0.95; g = 0.2; bl = 0.15; }
      else if (l.load > 0.75) { r = 0.95; g = 0.6; bl = 0.1; }
      const dir = l.flow > 0.5 ? 1 : (l.flow < -0.5 ? -1 : 0);
      renderer.pushLine(a.x, a.y, b.x, b.y, r, g, bl, 0.95, Math.min(1, l.load), dir);
    }
    // rozestavěné vedení – barvou zvolené úrovně, červeně když je moc dlouhé
    if (tool === 'line' && lineFrom) {
      const tooLong = Math.hypot(lineFrom.x - hover[0], lineFrom.y - hover[1]) > EG.LINE_TYPES[lineLevel].maxLen;
      const lc = tooLong ? [1, 0.2, 0.15] : LEVEL_COLOR[lineLevel];
      renderer.pushLine(lineFrom.x, lineFrom.y, hover[0], hover[1], lc[0], lc[1], lc[2], 0.6, 0, 0);
    }

    // města (seřazení podle hloubky řeší pořadí přidání – kreslíme po diagonálách zjednodušeně dle y)
    const spr = [];
    for (const c of map.cities) {
      for (let i = 0; i < c.houses.length; i++) {
        const [hx, hy] = c.houses[i];
        if (hx === c.x && hy === c.y) continue;
        spr.push([hx, hy, (hx * 7 + hy * 13) % 3 === 0 ? S.HOUSE2 : S.HOUSE, c]);
      }
      spr.push([c.x, c.y, S.CENTER, c]);
    }
    for (const ind of map.industries || []) spr.push([ind.x, ind.y, S.FACTORY, null, null, ind]);
    for (const b of sim.buildings) spr.push([b.x, b.y, kindSprite(b.kind), null, b]);
    spr.sort((p, q) => (p[0] + p[1]) - (q[0] + q[1]));
    for (const [x, y, sId, city, b, ind] of spr) {
      let dim = 1;
      if (city && (city.powered || 0) < 0.5 && sim.sun < 0.15) dim = 0.55; // blackout v noci
      if (ind && (ind.powered || 0) < 0.5) dim = 0.62; // stojící podnik potemní
      let tintR = dim, tintG = dim, tintB = dim;
      if (b && b.kind !== 'sub' && b.gen > 0.5 && b.out < 0.1) { tintG = 0.75; tintB = 0.7; } // odpojená elektrárna
      if (b && b.broken) { tintR = 1; tintG = 0.35; tintB = 0.3; } // porucha
      renderer.pushSprite(x, y, sId, tintR, tintG, tintB, 1);
    }

    // vybraná budova: zvýraznění + dosah rozvodny
    if (selected && sim.buildings.includes(selected)) {
      renderer.pushSprite(selected.x, selected.y, S.SEL, 1, 1, 1, 0.9);
      if (selected.kind === 'sub') {
        const R = sim.subRange(selected);
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
          if (Math.hypot(dx, dy) > R || (dx === 0 && dy === 0)) continue;
          if ((dx + dy) % 2 !== 0) continue;
          renderer.pushSprite(selected.x + dx, selected.y + dy, S.CITYRING, 1, 1, 1, 0.3);
        }
      }
      // porucha nad vybranou budovou bliká
      if (selected.broken) {
        const bl = (Math.sin(performance.now() * 0.008) + 1) / 2;
        renderer.pushSprite(selected.x, selected.y, S.BAD, 1, 1, 1, 0.3 + 0.5 * bl);
      }
    }

    // dosah rozvodny při stavbě
    if (tool === 'sub') {
      const R = EG.SUB_RANGE;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        if (Math.hypot(dx, dy) > R || (dx === 0 && dy === 0)) continue;
        if ((dx + dy) % 2 !== 0) continue; // řidší mřížka, ať to neruší
        renderer.pushSprite(hover[0] + dx, hover[1] + dy, S.CITYRING, 1, 1, 1, 0.35);
      }
    }

    // kurzor
    if (tool !== 'pan') {
      const [gx, gy] = hover;
      let ok = true;
      if (tool === 'demolish') ok = !!sim.buildingAt(gx, gy) || !!lineNear(gx, gy);
      else if (tool === 'line') ok = !!sim.buildingAt(gx, gy);
      else ok = sim.canPlace(tool, gx, gy).ok;
      renderer.pushSprite(gx, gy, ok ? S.SEL : S.BAD);
      if (ok && tool !== 'demolish' && tool !== 'line') {
        renderer.pushSprite(gx, gy, kindSprite(tool), 1, 1, 1, 0.55);
      }
    }

    // nenapájená města a porouchané budovy – blikající indikátor
    const blink = (Math.sin(performance.now() * 0.006) + 1) / 2;
    for (const c of map.cities) {
      if ((c.powered || 0) < 0.9) {
        renderer.pushSprite(c.x, c.y, S.BAD, 1, 1, 1, 0.25 + 0.5 * blink);
      }
    }
    for (const b of sim.buildings) {
      if (b.broken && b !== selected) {
        renderer.pushSprite(b.x, b.y, S.BAD, 1, 1, 1, 0.2 + 0.4 * blink);
      }
    }
    for (const ind of map.industries || []) {
      if ((ind.powered || 0) < 0.9) {
        renderer.pushSprite(ind.x, ind.y, S.BAD, 1, 1, 1, 0.2 + 0.45 * blink);
      }
    }
  }

  /* ---------- smyčka ---------- */
  let lastT = 0;
  function loop(t) {
    const dt = Math.min(0.1, (t - lastT) / 1000 || 0.016);
    lastT = t;
    if (speed > 0) sim.tick(dt * speed);
    pushScene();
    renderer.render(t / 1000);
    drawMinimap();
    updateHUD();
    if (selected) updatePanel();
    requestAnimationFrame(loop);
  }

  window.addEventListener('DOMContentLoaded', init);
})();
