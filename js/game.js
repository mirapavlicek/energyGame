/* Hlavní smyčka, vstup, UI, minimapa. */
(function () {
  'use strict';
  const EG = window.EG;
  const A = EG.atlas;
  const S = A.S;

  const MAP_SIZE = 322; // 322² = 103 684 dlaždic (≥ 2× předchozích 227² = 51 529)

  let map, sim, renderer;
  let tool = 'pan';            // pan | hydro | dam | coal | solar | wind | sub | line | demolish
  let lineFrom = null;         // budova, odkud táhneme vedení
  let lineLevel = 110;         // zvolená napěťová úroveň vedení
  let lineCable = false;       // stavět jako podzemní kabel (2,5× cena)
  let selected = null;         // budova otevřená v panelu správy
  let selectedLine = null;     // vedení otevřené v panelu správy
  let selectedCity = null;     // město otevřené v panelu správy (městská doprava)
  let hoverF = [0, 0];         // přesná pozice kurzoru v dlaždicích (trefa na vedení)

  /* barvy vedení podle napěťové úrovně */
  const LEVEL_COLOR = {
    500: [1.00, 0.35, 0.75], // HVDC
    800: [0.83, 0.45, 1.00],
    400: [1.00, 0.72, 0.20],
    220: [0.35, 0.78, 0.95],
    110: [0.62, 0.66, 0.72],
    22:  [0.42, 0.85, 0.45],
    11:  [0.72, 0.90, 0.45],
    1.5: [1.00, 0.40, 0.20], // silná DC přípojnice bateriové farmy
    0.5: [1.00, 0.55, 0.30], // DC přípojnice baterií
    0.4: [0.95, 0.95, 0.88],
  };
  let hover = [0, 0];
  let mouse = { x: 0, y: 0, down: false, panning: false, lastX: 0, lastY: 0 };
  let speed = 1;
  let lastMsgCount = 0;
  let cheatBuf = '';           // buffer pro psané cheaty (funds)
  let mapLayer = 0;            // mapové vrstvy: 0 nic, 1 dosahy rozvoden, 2 zatížení vedení
  let chartOn = false;         // panel grafů
  const history = [];          // vzorky pro grafy (výroba/spotřeba/ztráty/spot)
  let lastSample = 0;
  const undoStack = [];        // undo posledních staveb (Ctrl+Z)
  let gfxQuality = 'high';     // vysoká = bloom, třpyt hladiny a multisampling
  let fps = 60;                // vyhlazené snímky za sekundu do HUD

  const $ = (s) => document.querySelector(s);

  /* Kvalita grafiky: na slabším železe se dá vypnout postprocess.
     Volba se pamatuje mezi seancemi. */
  function setQuality(q, quiet) {
    gfxQuality = renderer.setQuality(q);
    const high = gfxQuality === 'high';
    $('#btn-gfx').classList.toggle('active', high);
    $('#btn-gfx').title = 'Kvalita grafiky: ' + (high ? 'vysoká' : 'nízká') +
      ' (bloom, třpyt hladiny a vyhlazení hran) – klikni pro přepnutí';
    try { localStorage.setItem('eg_gfx', gfxQuality); } catch (e) { /* ignoruj */ }
    if (!quiet) sim.msg('✨ Kvalita grafiky: ' + (high ? 'vysoká' : 'nízká'));
  }

  /* Vítr v HUD: rychlost v m/s a co znamená pro turbíny. Rychlost je
     důležitější než procenta – z ní je vidět, proč turbíny stojí. */
  function windLabel() {
    const W = EG.WIND;
    const v = sim.windSpeed || 0;
    let state;
    if (sim.calmActive) state = 'bezvětří';
    else if (v >= W.cutOut) state = 'odstaveno';
    else if (v < W.cutIn) state = 'turbíny stojí';
    else if (v >= W.rated) state = 'plný výkon';
    else state = Math.round((sim.wind || 0) * 100) + ' %';
    const bad = v < W.cutIn || v >= W.cutOut;
    return '💨 <span class="' + (bad ? 'bad' : '') + '">' + v.toFixed(1) + ' m/s · ' + state + '</span>';
  }

  function kindSprite(kind) {
    return {
      hydro: S.HYDRO, dam: S.DAM, coal: S.COAL, solar: S.SOLAR, wind: S.WIND,
      sub: S.SUBST, psh: S.PSH, battery: S.BATT, xborder: S.XBORDER,
      nuclear: S.NUKE, gas: S.GASP, geo: S.GEOTH, bio: S.BIOG, waste: S.WASTE,
      owind: S.OWIND, h2: S.H2, bess: S.BESS, tesla: S.MCONV,
    }[kind];
  }

  function init() {
    const urlParams = new URLSearchParams(location.search);
    const seedStr = urlParams.get('seed');
    const scPre = SCENARIOS[urlParams.get('scenario')];
    const seed = scPre ? scPre.seed
      : seedStr ? (parseInt(seedStr, 10) || 1) : ((Math.random() * 1e9) | 0);
    map = EG.generateMap(MAP_SIZE, seed);
    sim = new EG.Sim(map);
    const canvas = $('#game');
    renderer = new EG.Renderer(canvas);
    // jemné tónování podle výšky, ať mapa není plochá jednolitá barva
    const tintFn = (x, y) => 0.88 + Math.min(0.24, Math.max(0, map.elev[map.idx(x, y)] - 0.3) * 0.55);
    EG.onTerrainChanged = () => renderer.uploadTerrain(map, tintFn);
    renderer.uploadTerrain(map, tintFn);
    let savedGfx = 'high';
    try { savedGfx = localStorage.getItem('eg_gfx') || 'high'; } catch (e) { /* ignoruj */ }
    setQuality(savedGfx, true);

    // kamera do středu první osady
    const c0 = map.cities[0] || { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };
    const [wx, wy] = renderer.tileToWorld(c0.x, c0.y);
    renderer.cam.x = wx; renderer.cam.y = wy;
    renderer.cam.zoom = 0.9;

    $('#seed-label').textContent = 'seed ' + seed;
    $('#btn-newmap').addEventListener('click', () => {
      location.search = '?seed=' + ((Math.random() * 1e9) | 0);
    });
    $('#btn-loan').addEventListener('click', () => sim.takeLoan(2000));
    $('#btn-repay').addEventListener('click', () => sim.repayLoan(500));

    // mapové vrstvy, grafy, uložení/načtení, výzva dne
    $('#btn-layer').addEventListener('click', () => {
      mapLayer = (mapLayer + 1) % 3;
      sim.msg('Vrstva: ' + ['žádná', 'dosahy rozvoden', 'zatížení vedení'][mapLayer]);
      $('#btn-layer').classList.toggle('active', mapLayer > 0);
    });
    $('#btn-chart').addEventListener('click', () => {
      chartOn = !chartOn;
      $('#chart').hidden = !chartOn;
    });
    $('#btn-gfx').addEventListener('click', () => setQuality(gfxQuality === 'high' ? 'low' : 'high'));

    // mapa podle skutečné krajiny
    $('#btn-import').addEventListener('click', () => {
      const el = $('#import-dlg');
      el.hidden = !el.hidden;
      if (!el.hidden) $('#import-url').focus();
    });
    $('#import-close').addEventListener('click', () => { $('#import-dlg').hidden = true; });
    $('#import-go').addEventListener('click', runImport);
    $('#import-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') runImport(); });
    $('#btn-save').addEventListener('click', () => {
      try {
        localStorage.setItem('eg_save', EG.serialize(sim));
        sim.msg('💾 Hra uložena');
      } catch (e) { sim.msg('Uložení selhalo: ' + e.message, 'warn'); }
    });
    $('#btn-load').addEventListener('click', loadSave);
    $('#btn-daily').addEventListener('click', () => {
      const d = new Date();
      const s = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
      location.search = '?seed=' + s;
    });

    // plánovací režim a replay
    $('#btn-plan').addEventListener('click', () => (planning ? cancelPlan() : enterPlan()));
    $('#plan-confirm').addEventListener('click', confirmPlan);
    $('#plan-cancel').addEventListener('click', cancelPlan);
    $('#btn-replay').addEventListener('click', startReplay);
    $('#replay-stop').addEventListener('click', stopReplay);

    // Web Worker: N-1 analýza na pozadí (render se nezasekne)
    let n1Worker = null;
    try {
      n1Worker = new Worker('js/worker.js');
      n1Worker.onmessage = (e) => {
        if (e.data.cmd !== 'n1') return;
        sim._n1Critical = new Set(e.data.critical);
        sim._n1Until = sim.time + 12;
        if (e.data.critical.length === 0) {
          sim.msg('N-1: síť přežije výpadek libovolného vedení ✓');
        } else {
          const first = sim.lines.find((l) => l.id === e.data.critical[0]);
          sim.msg('N-1: ' + e.data.critical.length + ' kritických vedení (blikají) – dostav zálohy!', 'warn',
            first && sim._lineMid(first));
        }
      };
      n1Worker.onerror = () => { n1Worker = null; };
    } catch (e) { n1Worker = null; }
    $('#btn-n1').addEventListener('click', () => {
      if (n1Worker) {
        sim.msg('N-1 analýza běží na pozadí…');
        n1Worker.postMessage({ cmd: 'n1', save: EG.serialize(sim) });
      } else {
        sim.n1Report();
      }
    });

    // seznam objektů
    $('#btn-objlist').addEventListener('click', () => {
      const el = $('#objlist');
      el.hidden = !el.hidden;
      if (!el.hidden) refreshObjList();
    });
    $('#objlist-close').addEventListener('click', () => { $('#objlist').hidden = true; });
    $('#objlist-filter').addEventListener('change', refreshObjList);
    // varování v HUD je zkratka rovnou do přehledu zatížení
    $('#overload-item').addEventListener('click', () => {
      $('#objlist').hidden = false;
      $('#objlist-filter').value = 'load';
      refreshObjList();
    });
    $('#objlist-rows').addEventListener('click', (e) => {
      const row = e.target.closest('.obj-row');
      if (!row) return;
      const [wx, wy] = renderer.tileToWorld(+row.dataset.x, +row.dataset.y);
      renderer.cam.x = wx; renderer.cam.y = wy;
      if (row.dataset.city !== undefined) {
        const c = map.cities[+row.dataset.city];
        if (c) selectCity(c);
        return;
      }
      if (row.dataset.line !== undefined) {
        const l = sim.lines.find((o) => o.id === +row.dataset.line);
        if (l) selectLine(l);
        return;
      }
      const b = sim.buildings.find((o) => o.id === +row.dataset.id);
      if (b) selectBuilding(b);
    });

    // scénář přes URL (?scenario=1..3)
    const scParam = new URLSearchParams(location.search).get('scenario');
    if (scParam && SCENARIOS[scParam]) {
      scenario = SCENARIOS[scParam];
      scenario.id = scParam;
      sim.money = scenario.money;
      sim.msg('🎯 SCÉNÁŘ „' + scenario.name + '": ' + scenario.desc);
      $('#seed-label').title = 'Scénář: ' + scenario.desc;
    }

    // režimy obtížnosti přes URL (?mode=sandbox|expert)
    const mode = new URLSearchParams(location.search).get('mode');
    if (mode === 'sandbox') { sim.money = 1e9; sim.msg('Režim SANDBOX: neomezené peníze.'); }
    if (mode === 'expert') { sim.money = 500; sim.hardMode = true; sim.msg('Režim EXPERT: méně peněz, rychlejší opotřebení, dvojité sankce!', 'warn'); }

    // klik na hlášku v logu skočí kamerou na místo problému a otevře jeho panel
    $('#log').addEventListener('click', (e) => {
      const row = e.target.closest('div[data-x]');
      let tx, ty;
      if (row) {
        tx = +row.dataset.x; ty = +row.dataset.y;
      } else {
        // starší hlášky bez cíle: zkusit souřadnice [x,y] z textu
        const mch = (e.target.textContent || '').match(/\[(\d+),(\d+)\]/);
        if (!mch) return;
        tx = +mch[1]; ty = +mch[2];
      }
      const [wx, wy] = renderer.tileToWorld(tx, ty);
      renderer.cam.x = wx; renderer.cam.y = wy;
      if (renderer.cam.zoom < 1) renderer.cam.zoom = 1.2;
      // rovnou otevřít panel viníka: budova na místě, jinak nejbližší vedení
      const b = sim.buildingAt(tx, ty);
      if (b) { selectBuilding(b); return; }
      const l = lineNear(tx, ty);
      if (l) selectLine(l);
    });

    setupInput(canvas);
    setupToolbar();
    setupLinebar();
    setupMinimap();
    $('#bp-close').addEventListener('click', closePanel);

    // schovávací manuál (volba se pamatuje)
    const setHelp = (show) => {
      $('#help').hidden = !show;
      $('#btn-help').hidden = show;
      try { localStorage.setItem('eg_help', show ? '1' : '0'); } catch (e) { /* soukromý režim */ }
    };
    $('#help-close').addEventListener('click', () => setHelp(false));
    $('#btn-help').addEventListener('click', () => setHelp(true));
    try { if (localStorage.getItem('eg_help') === '0') setHelp(false); } catch (e) { /* ignoruj */ }
    sim.msg('Vítej! Postav elektrárnu, u města rozvodnu a kup do ní trafa (klik na rozvodnu).');
    sim.msg('Pak vše spoj vedením správného napětí – vodní elektrárna vyrábí na 110 kV.');

    // záznam akcí pro replay (po scénářích/režimech, ať sedí startovní peníze)
    instrument(sim);

    // ladicí přístup (používá i smoke test)
    EG.game = {
      get sim() { return sim; }, get map() { return map; }, get renderer() { return renderer; },
      plan: { enter: enterPlan, confirm: confirmPlan, cancel: cancelPlan, get active() { return planning; } },
      replay: { start: startReplay, stop: stopReplay, get active() { return !!replaying; } },
      applyMap: applyImportedMap,
    };

    requestAnimationFrame(loop);
  }

  /* ---------- záznam akcí (replay + plánovací režim) ----------
     Mutující metody simu se obalí a každá úspěšná akce se zapíše
     s časem; odkazy na budovy/vedení se ukládají přes id. */
  const MUTATORS = ['place', 'connect', 'demolish', 'removeLine', 'buyTrafo', 'buyTrafoReg',
    'setTrafoReg', 'buyCompensator', 'upgrade', 'upgradeRange', 'service', 'serviceLine',
    'setContract', 'setFuelContract', 'buyFuel', 'setMothball', 'retrofitBiomass',
    'adjustXContract', 'takeLoan', 'repayLoan'];

  function encodeArg(x) {
    if (x && typeof x === 'object') {
      if (x.kind !== undefined && x.id !== undefined) return { $b: x.id };
      if (x.level !== undefined && x.a !== undefined && x.b !== undefined) return { $l: x.id };
    }
    return x;
  }

  function decodeArg(s, x) {
    if (x && typeof x === 'object') {
      if (x.$b !== undefined) return s.buildings.find((o) => o.id === x.$b);
      if (x.$l !== undefined) return s.lines.find((o) => o.id === x.$l);
    }
    return x;
  }

  function instrument(s) {
    s._log = [];
    s._startMoney = s.money;
    for (const fn of MUTATORS) {
      const orig = s[fn].bind(s);
      s[fn] = (...args) => {
        const r = orig(...args);
        if (r !== null && r !== false && s._log.length < 8000) {
          s._log.push({ t: +s.time.toFixed(3), fn, args: args.map(encodeArg) });
        }
        return r;
      };
    }
  }

  function applyAction(s, a) {
    if (a.fn === '__cheat') { s.money += 1000; return; }
    s[a.fn](...a.args.map((x) => decodeArg(s, x)));
  }

  /* ---------- plánovací režim (blueprint) ----------
     Stínová kopie simulace: stavíš na zkoušku (čas stojí), vidíš cenu,
     a teprve potvrzení přehraje akce do skutečné hry. */
  let planning = false;
  let planBase = null;
  let planStartId = 0;

  function enterPlan() {
    if (planning || replaying) return;
    planning = true;
    planBase = { sim, map, speed };
    speed = 0; updateSpeedLabel();
    sim = EG.restore(EG.serialize(sim));
    map = sim.map;
    instrument(sim);
    planStartId = sim.nextId;
    EG.onTerrainChanged();
    setupMinimap();
    closePanel();
    $('#plan-bar').hidden = false;
    $('#btn-plan').classList.add('active');
    sim.msg('📐 PLÁNOVACÍ REŽIM: stav na zkoušku, zaplatí se až po potvrzení.');
  }

  function exitPlan() {
    planning = false;
    sim = planBase.sim;
    map = planBase.map;
    speed = planBase.speed || 1; updateSpeedLabel();
    planBase = null;
    EG.onTerrainChanged();
    setupMinimap();
    closePanel();
    $('#plan-bar').hidden = true;
    $('#btn-plan').classList.remove('active');
  }

  function confirmPlan() {
    if (!planning) return;
    const log = sim._log || [];
    exitPlan();
    let ok = 0, fail = 0;
    for (const a of log) {
      const r = sim[a.fn](...a.args.map((x) => decodeArg(sim, x)));
      if (r === null || r === false) fail++; else ok++;
    }
    sim.msg('📐 Plán potvrzen: ' + ok + ' akcí provedeno' + (fail ? ', ' + fail + ' neprošlo' : '') + '.');
  }

  function cancelPlan() {
    if (!planning) return;
    exitPlan();
    sim.msg('📐 Plán zrušen – nic se nestavělo.');
  }

  /* ---------- replay: přehrání záznamu hry od začátku (8×) ---------- */
  let replaying = null;

  function startReplay() {
    if (planning || replaying) return;
    if (!sim._log) { sim.msg('Replay funguje jen pro hru rozehranou v této seanci', 'warn'); return; }
    const base = { sim, map, speed };
    // importovanou mapu z osiva vyrobit nejde, startuje se z uloženého otisku
    const fresh = pristineSave ? EG.restore(pristineSave) : new EG.Sim(EG.generateMap(map.size, map.seed));
    fresh.money = sim._startMoney;
    replaying = { base, log: sim._log.slice(), i: 0, endT: sim.time };
    speed = 0; updateSpeedLabel();
    sim = fresh;
    map = fresh.map;
    EG.onTerrainChanged();
    setupMinimap();
    closePanel();
    $('#replay-bar').hidden = false;
  }

  function stopReplay() {
    if (!replaying) return;
    sim = replaying.base.sim;
    map = replaying.base.map;
    speed = replaying.base.speed || 1; updateSpeedLabel();
    replaying = null;
    EG.onTerrainChanged();
    setupMinimap();
    $('#replay-bar').hidden = true;
    sim.msg('🎬 Replay ukončen, hra pokračuje.');
  }

  function stepReplay(frameDt) {
    const r = replaying;
    let remaining = frameDt * 8; // 8× rychlost
    let guard = 0;
    while (remaining > 1e-6 && guard++ < 300) {
      const nextA = r.log[r.i];
      let chunk = Math.min(0.1, remaining, r.endT - sim.time);
      if (nextA && nextA.t > sim.time && nextA.t < sim.time + chunk) chunk = nextA.t - sim.time;
      if (chunk > 1e-6) {
        sim.tick(chunk);
        remaining -= chunk;
      }
      while (r.log[r.i] && r.log[r.i].t <= sim.time + 1e-6) {
        try { applyAction(sim, r.log[r.i]); } catch (e) { /* akce v replayi nevyšla */ }
        r.i++;
      }
      if (sim.time >= r.endT - 1e-6) { stopReplay(); return; }
    }
    $('#replay-time').textContent = Math.floor(sim.time) + ' / ' + Math.floor(r.endT) + ' s';
  }

  /* ---------- scénáře s cíli ---------- */
  const SCENARIOS = {
    1: {
      seed: 101, money: 1200, sustain: 120, name: 'Elektrifikace',
      desc: 'Napájej aspoň 8 měst na 90 %+ nepřetržitě celý den.',
      check: (s) => (s.cityAssign || []).filter((ca) => ca.sub >= 0 && (ca.city.powered || 0) > 0.9).length >= 8,
    },
    2: {
      seed: 202, money: 900, sustain: 0, name: 'Zbohatni',
      desc: 'Vydělej 30 000 € a nedluž ani euro.',
      check: (s) => s.money >= 30000 && !(s.debt > 0),
    },
    3: {
      seed: 303, money: 2500, sustain: 120, name: 'Zelená síť',
      desc: 'Dodávej přes 30 MW celý den bez uhlí a plynu.',
      check: (s) => (s.stats && s.stats.delivered > 30) &&
        !s.buildings.some((b) => (b.kind === 'coal' || b.kind === 'gas') && b.out > 0.5),
    },
  };
  let scenario = null;
  let scenarioT = 0;
  let scenarioWon = false;

  function checkScenario() {
    if (!scenario || scenarioWon || sim.gameOver) return;
    if (scenario.check(sim)) {
      scenarioT += 1;
      if (scenarioT >= scenario.sustain) {
        scenarioWon = true;
        $('#victory-text').textContent = scenario.name + ': ' + scenario.desc +
          ' Skóre ' + Math.floor(sim.score).toLocaleString('cs-CZ') + '.';
        $('#victory').hidden = false;
        sim.msg('🏆 SCÉNÁŘ „' + scenario.name + '" SPLNĚN!');
        award('scenario' + scenario.id, 'Scénář: ' + scenario.name);
      }
    } else {
      scenarioT = 0;
    }
  }

  /* ---------- seznam objektů ---------- */
  function kindGroup(k) {
    if (k === 'sub') return 'sub';
    if (EG.STORAGE[k]) return 'stor';
    if (k === 'xborder') return 'x';
    return 'gen';
  }

  /* Proužek zatížení: do 75 % je klid, do 100 % se jede na hraně,
     nad 100 % už prvek nestíhá a soustava ho začne obcházet. */
  function loadCell(load) {
    const pct = Math.round(load * 100);
    const col = load > 1 ? '#ff5340' : load > 0.75 ? '#e8c84a' : '#5dbb63';
    return '<span class="o-load" title="zatížení ' + pct + ' %">' +
      '<i style="width:' + Math.min(100, pct) + '%;background:' + col + '"></i>' +
      '<b>' + pct + ' %</b></span>';
  }

  const loadState = (load) => load > 1 ? '<span class="bad">přetíženo</span>'
    : load > 0.75 ? '<span class="warn">na hraně</span>'
    : '<span class="dim">ok</span>';

  /* Kolik prvků zrovna nestíhá. Počítá se ze stejných čísel, jaká ukazuje
     přehled zatížení, aby varování v HUD a seznam vždycky souhlasily. */
  function countOverloads() {
    let n = 0;
    for (const l of sim.lines) if ((l.load || 0) > 1) n++;
    for (const b of sim.buildings) {
      if (b.kind !== 'sub') continue;
      for (const v of Object.values(b.trafoLoad || {})) if (v > 1) n++;
    }
    return n;
  }

  /* Nejvytíženější trafo rozvodny – podle něj se pozná, jestli rozvodna
     stíhá převádět, i když samotná vedení k ní mají rezervu. */
  function worstTrafo(b) {
    let worst = 0, key = null;
    for (const [k, v] of Object.entries(b.trafoLoad || {})) {
      if (v > worst) { worst = v; key = k; }
    }
    return { load: worst, key };
  }

  function refreshObjList() {
    const filter = $('#objlist-filter').value;
    const rows = [];
    const add = (html, load) => rows.push({ html, load: load === undefined ? -1 : load });
    const all = filter === 'all';
    const load = filter === 'load';   // přehled zatížení, nejhorší nahoře
    const bad = filter === 'bad';

    // --- stavby ---
    if (filter !== 'city' && filter !== 'line') {
      for (const b of sim.buildings) {
        const grp = kindGroup(b.kind);
        const wt = b.kind === 'sub' ? worstTrafo(b) : null;
        const fieldsFull = b.kind === 'sub' && sim.fieldsUsed(b) >= sim.fieldLimit(b);
        // elektrárna, která vyrábí, ale výkon se z ní nedostane ven
        const stuck = grp === 'gen' && b.gen > 0.5 && b.out < b.gen * 0.9;
        const problem = b.broken || (EG.fuelDefOf(b) && b.fuel <= 0) ||
          (b.cond !== undefined && b.cond < 0.3) || (wt && wt.load > 1) || stuck;
        if (filter === 'gen' && grp !== 'gen') continue;
        if (filter === 'sub' && grp !== 'sub') continue;
        if (filter === 'stor' && grp !== 'stor') continue;
        if (bad && !problem) continue;
        // v přehledu zatížení mají trafa vlastní řádky, rozvodnu neopakujeme
        if (load) break;
        let state;
        if (b.broken) state = '<span class="bad">porucha</span>';
        else if (b.mothball) state = '<span class="dim">konzerv.</span>';
        else if (EG.fuelDefOf(b) && b.fuel <= 0) state = '<span class="bad">bez paliva</span>';
        else if (wt && wt.load > 1) state = '<span class="bad">trafo přetíženo</span>';
        else if (stuck) state = '<span class="warn">neodvádí výkon</span>';
        else if (fieldsFull) state = '<span class="warn">pole plná</span>';
        else if (b.cond !== undefined && b.cond < 0.3) state = '<span class="warn">zanedbaná</span>';
        else state = '<span class="dim">ok</span>';
        const perf = EG.STORAGE[b.kind]
          ? Math.round(b.charge) + ' MWs'
          : b.kind === 'sub' ? sim.fieldsUsed(b) + '/' + sim.fieldLimit(b) + ' polí'
          : (b.out || 0).toFixed(0) + ' / ' + (b.gen || 0).toFixed(0) + ' MW';
        add('<div class="obj-row" data-x="' + b.x + '" data-y="' + b.y + '" data-id="' + b.id + '">' +
          '<span class="o-name">' + EG.BUILD[b.kind].name + ' [' + b.x + ',' + b.y + ']</span>' +
          '<span class="o-val">' + perf + '</span>' +
          (wt && wt.key ? loadCell(wt.load) : '<span class="o-load"></span>') +
          state + '</div>', wt ? wt.load : -1);
      }
    }

    // --- vedení: tady se přetížení projeví nejdřív ---
    if (all || load || bad || filter === 'line') {
      for (const l of sim.lines) {
        const broken = l.broken || (l.trippedUntil && l.trippedUntil > sim.time);
        if (bad && !broken && !(l.load > 1)) continue;
        const LT = EG.LINE_TYPES[l.level];
        const a = sim.buildings.find((o) => o.id === l.a);
        const b2 = sim.buildings.find((o) => o.id === l.b);
        if (!a || !b2) continue;
        const mid = sim._lineMid(l);
        const cap = Math.round(l.effCap || l.cap);
        let state;
        if (l.broken) state = '<span class="bad">porucha</span>';
        else if (l.trippedUntil && l.trippedUntil > sim.time) state = '<span class="bad">odpojeno</span>';
        else state = loadState(l.load || 0);
        add('<div class="obj-row" data-x="' + Math.round(mid.x) + '" data-y="' + Math.round(mid.y) +
          '" data-line="' + l.id + '">' +
          '<span class="o-name">' + LT.name + (l.n > 1 ? ' ' + l.n + '×' : '') +
          ' <span class="dim">[' + a.x + ',' + a.y + ']–[' + b2.x + ',' + b2.y + ']</span></span>' +
          '<span class="o-val">' + Math.abs(l.flow || 0).toFixed(0) + ' / ' + cap + ' MW</span>' +
          loadCell(l.load || 0) + state + '</div>', l.load || 0);
      }
    }

    // --- jednotlivá trafa: v přehledu zatížení je vidět, které dokoupit ---
    if (load) {
      for (const b of sim.buildings) {
        if (b.kind !== 'sub') continue;
        for (const [key, count] of Object.entries(b.trafos || {})) {
          const t = EG.TRAFOS[key];
          if (t.coupler) continue;
          const lo = (b.trafoLoad || {})[key] || 0;
          add('<div class="obj-row" data-x="' + b.x + '" data-y="' + b.y + '" data-id="' + b.id + '">' +
            '<span class="o-name">Trafo ' + t.name + (count > 1 ? ' ' + count + '×' : '') +
            ' <span class="dim">[' + b.x + ',' + b.y + ']</span></span>' +
            '<span class="o-val">' + Math.round(lo * t.cap * count) + ' / ' + (t.cap * count) + ' MW</span>' +
            loadCell(lo) + loadState(lo) + '</div>', lo);
        }
      }
    }

    // --- města: kandidáti na městskou dopravu i přehled napájení ---
    if (all || filter === 'city' || bad) {
      map.cities.forEach((c, i) => {
        const dark = (c.powered || 0) < 0.5;
        if (bad && !dark) return;
        const tr = sim.transitList(c).map((k) => EG.TRANSIT[k].ico).join('') || '<span class="dim">bez MHD</span>';
        const state = dark ? '<span class="bad">nesvítí</span>'
          : c.transitDown ? '<span class="warn">MHD stojí</span>'
          : '<span class="dim">ok</span>';
        add('<div class="obj-row" data-x="' + c.x + '" data-y="' + c.y + '" data-city="' + i + '">' +
          '<span class="o-name">' + c.name + ' [' + c.x + ',' + c.y + ']</span>' +
          '<span class="o-val">' + c.pop + ' tis. ' + tr + '</span>' +
          '<span class="o-load"></span>' + state + '</div>');
      });
    }

    if (load) rows.sort((p, q) => q.load - p.load);
    $('#objlist-rows').innerHTML = rows.map((r) => r.html).join('') ||
      '<div class="dim" style="padding:6px">' +
      (load ? 'Zatím nic, co by se dalo zatížit – postav vedení a trafa.' : 'Nic tu není.') +
      '</div>';
  }

  /* ---------- mapa podle skutečné krajiny ----------
     Poloha se bere z odkazu (Google Mapy, OpenStreetMap i holé
     souřadnice), samotná krajina z OpenStreetMap. */
  let pristineSave = null;  // čistý stav importované mapy (replay z něj startuje)
  let importing = false;

  function setImportStatus(html, cls) {
    const el = $('#import-status');
    el.className = cls || 'dim';
    el.innerHTML = html;
  }

  function applyImportedMap(newMap, label) {
    if (planning) cancelPlan();
    if (replaying) stopReplay();
    map = newMap;
    sim = new EG.Sim(map);
    scenario = null; scenarioT = 0; scenarioWon = false;
    lineFrom = null;
    undoStack.length = 0;
    history.length = 0;
    lastSample = 0;
    EG.onTerrainChanged();
    setupMinimap();
    closePanel();
    $('#gameover').hidden = true;
    $('#victory').hidden = true;
    instrument(sim);
    // replay nejde přehrát z osiva – importovaná mapa se z něj nedá vyrobit
    pristineSave = EG.serialize(sim);
    const c0 = map.cities[0];
    if (c0) {
      const [wx, wy] = renderer.tileToWorld(c0.x, c0.y);
      renderer.cam.x = wx; renderer.cam.y = wy; renderer.cam.zoom = 0.9;
    }
    $('#seed-label').title = 'Mapa podle skutečné krajiny (' + label +
      ') · data © přispěvatelé OpenStreetMap';
  }

  async function runImport() {
    if (importing) return;
    const place = EG.parsePlace($('#import-url').value);
    if (!place) {
      setImportStatus('Z toho polohu nevyčtu. Potřebuju odkaz s <b>@šířka,délka</b> (Google Mapy), ' +
        '<b>#map=…</b> (OpenStreetMap), nebo rovnou <b>50.0755, 14.4378</b>.', 'bad');
      return;
    }
    const km = +$('#import-km').value || 25;
    const bbox = EG.bboxAround(place.lat, place.lon, km);
    const coords = place.lat.toFixed(4) + ', ' + place.lon.toFixed(4);
    importing = true;
    $('#import-go').disabled = true;
    try {
      setImportStatus('Beru území ' + km + ' km kolem ' + coords + '…', 'busy');
      const osm = await EG.fetchOSM(bbox, {
        onProgress: (m) => setImportStatus(m + ' <span class="dim">(velké území může trvat i minutu)</span>', 'busy'),
      });
      // výškopis je bonus – když se nestáhne, výšky se odvodí z vodstva
      let elevation = null;
      try {
        elevation = await EG.fetchElevation(bbox, MAP_SIZE, {
          onProgress: (m) => setImportStatus(m, 'busy'),
        });
      } catch (e) { elevation = null; }
      setImportStatus('Stavím krajinu z ' + osm.elements.length.toLocaleString('cs-CZ') + ' prvků…', 'busy');
      // krátká pauza, ať prohlížeč stihne hlášku vykreslit před výpočtem
      await new Promise((r) => setTimeout(r, 30));
      // osivo z polohy: stejné místo dá vždycky stejné doplňky
      const seed = Math.abs((Math.round(place.lat * 10000) * 73856093) ^
        (Math.round(place.lon * 10000) * 19349663)) % 1000000000 || 1;
      const built = EG.buildMapFromOSM(osm, { size: MAP_SIZE, bbox, seed, elevation });
      const s = built.osm;
      if (s.cities === 0) {
        setImportStatus('V tomhle území nejsou žádná sídla ani souš k zastavění. ' +
          'Zkus jiné místo nebo větší výřez.', 'bad');
        return;
      }
      applyImportedMap(built, coords + ' · ' + km + ' km');
      $('#import-dlg').hidden = true;
      sim.msg('🌍 Mapa postavená podle skutečné krajiny (' + coords + ', ' + km + ' km).');
      sim.msg('Města: ' + s.cities + (s.citiesFromOSM < s.cities ? ' (z toho ' + s.citiesFromOSM + ' skutečných)' : '') +
        ' · podniky: ' + s.industries + ' · tratě: ' + s.railways +
        (s.railsFromOSM === 0 ? ' (dogenerované)' : '') +
        ' · vodní plochy: ' + s.waterTiles + ' dlaždic · koryta řek: ' + s.riverTiles);
      sim.msg(s.realElevation
        ? '⛰ Výškopis ze skutečného modelu terénu, převýšení ' + s.relief + ' m.'
        : '⛰ Výškopis se nestáhl – výšky odvozené z vodstva.', s.realElevation ? 'info' : 'warn');
      sim.msg('Data © přispěvatelé OpenStreetMap (ODbL).');
      setImportStatus('Hotovo.', 'ok');
    } catch (e) {
      if (e && e.name === 'AbortError') setImportStatus('Zrušeno.', 'dim');
      else {
        setImportStatus('Nepovedlo se: ' + e.message + '<br>' +
          '<span class="dim">Overpass bývá občas přetížený – zkus to za chvíli, ' +
          'nebo si vyber menší území.</span>', 'bad');
      }
    } finally {
      importing = false;
      $('#import-go').disabled = false;
    }
  }

  /* ---------- načtení uložené hry ---------- */
  function loadSave() {
    const data = localStorage.getItem('eg_save');
    if (!data) { sim.msg('Žádná uložená hra', 'warn'); return false; }
    if (planning) cancelPlan();
    if (replaying) stopReplay();
    try {
      sim = EG.restore(data);
      sim._log = null; // replay funguje jen od začátku seance
      map = sim.map;
      EG.onTerrainChanged();
      setupMinimap();
      closePanel();
      lineFrom = null;
      undoStack.length = 0; // staré undo záznamy patří předchozí hře
      $('#gameover').hidden = !sim.gameOver;
      sim.msg('📂 Hra načtena (den ' + (sim.day || 1) + ')');
      return true;
    } catch (e) {
      sim.msg('Načtení selhalo: ' + e.message, 'warn');
      return false;
    }
  }

  /* ---------- rekordy a achievementy ---------- */
  let achievements = {};
  try { achievements = JSON.parse(localStorage.getItem('eg_ach') || '{}'); } catch (e) { /* ignoruj */ }
  function award(key, label) {
    if (achievements[key]) return;
    achievements[key] = Date.now();
    try { localStorage.setItem('eg_ach', JSON.stringify(achievements)); } catch (e) { /* ignoruj */ }
    sim.msg('🏆 ACHIEVEMENT: ' + label);
  }

  function checkAchievements() {
    const st = sim.stats || {};
    if (sim.time > sim.dayLen * 12 && sim.blackouts === 0) award('year_ok', 'Rok bez blackoutu');
    if ((st.exported || 0) >= 60) award('exporter', 'Exportní velmoc (60+ MW za hranice)');
    if ((st.delivered || 0) > 30) {
      const fossil = sim.buildings.some((b) => (b.kind === 'coal' || b.kind === 'gas') && b.out > 0.5);
      if (!fossil) award('green', '100 % bez fosilní výroby při zátěži');
    }
    const inds = sim.indAssign || [];
    if (inds.length >= 5 && inds.every((ia) => (ia.ind.powered || 0) > 0.95)) award('industry', 'Celý průmysl běží');
    if ((sim.debt || 0) === 0 && sim.money > 20000) award('rich', 'Kapitál 20 000 € bez dluhů');
  }

  function updateRecord() {
    const key = 'eg_best_' + map.seed;
    let best = 0;
    try { best = +(localStorage.getItem(key) || 0); } catch (e) { /* ignoruj */ }
    if (sim.score > best) {
      best = Math.floor(sim.score);
      try { localStorage.setItem(key, best); } catch (e) { /* ignoruj */ }
    }
    return best;
  }

  /* ---------- grafy ---------- */
  function drawChart() {
    const cv = $('#chart');
    const g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    if (history.length < 2) return;
    const W = cv.width, H = cv.height;
    let maxV = 10;
    for (const s of history) maxV = Math.max(maxV, s.p, s.d);
    const series = [
      { k: 'p', col: '#7ed087', label: 'výroba' },
      { k: 'd', col: '#e8c84a', label: 'dodávka' },
      { k: 'l', col: '#ff6a5a', label: 'ztráty' },
    ];
    for (const s of series) {
      g.strokeStyle = s.col; g.lineWidth = 1.5;
      g.beginPath();
      history.forEach((pt, i) => {
        const x = i / (history.length - 1) * (W - 10) + 5;
        const y = H - 18 - (pt[s.k] / maxV) * (H - 30);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.stroke();
    }
    // spot cena (pravá osa 0–2×)
    g.strokeStyle = '#7ec8ff'; g.lineWidth = 1; g.setLineDash([3, 3]);
    g.beginPath();
    history.forEach((pt, i) => {
      const x = i / (history.length - 1) * (W - 10) + 5;
      const y = H - 18 - (pt.s / 2) * (H - 30);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    });
    g.stroke(); g.setLineDash([]);
    g.font = '10px sans-serif';
    let lx = 8;
    for (const s of series.concat([{ col: '#7ec8ff', label: 'spot' }])) {
      g.fillStyle = s.col; g.fillText(s.label, lx, H - 5);
      lx += 52;
    }
    g.fillStyle = '#8b98a5';
    g.fillText(Math.round(maxV) + ' MW', W - 46, 12);
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
      hoverF = renderer.screenToTileF(mouse.x, mouse.y);
      hover = [Math.round(hoverF[0]), Math.round(hoverF[1])];
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

    // dotykové ovládání: tažení = posun, pinch = zoom, ťuknutí = klik
    let touchState = null;
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (e.touches.length === 1) {
        const t = e.touches[0];
        touchState = { mode: 'pan', x: t.clientX, y: t.clientY, sx: t.clientX, sy: t.clientY, moved: false };
      } else if (e.touches.length === 2) {
        const [a, b] = e.touches;
        touchState = { mode: 'pinch', dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) };
      }
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (!touchState) return;
      if (touchState.mode === 'pan' && e.touches.length === 1) {
        const t = e.touches[0];
        renderer.cam.x -= (t.clientX - touchState.x) / renderer.cam.zoom;
        renderer.cam.y -= (t.clientY - touchState.y) / renderer.cam.zoom;
        if (Math.abs(t.clientX - touchState.sx) + Math.abs(t.clientY - touchState.sy) > 8) touchState.moved = true;
        touchState.x = t.clientX; touchState.y = t.clientY;
      } else if (touchState.mode === 'pinch' && e.touches.length === 2) {
        const [a, b] = e.touches;
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        renderer.cam.zoom = Math.min(3.2, Math.max(0.18, renderer.cam.zoom * (d / touchState.dist)));
        touchState.dist = d;
      }
    }, { passive: false });
    canvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      if (touchState && touchState.mode === 'pan' && !touchState.moved) {
        const rect = canvas.getBoundingClientRect();
        hoverF = renderer.screenToTileF(touchState.sx - rect.left, touchState.sy - rect.top);
        hover = [Math.round(hoverF[0]), Math.round(hoverF[1])];
        click();
      }
      if (e.touches.length === 0) touchState = null;
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      // psaní do formuláře (odkaz na mapu) nesmí přepínat nástroje
      const el = document.activeElement;
      if (el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undoLast(); return; }
      // cheat: napiš „funds" a dostaneš 1 000 €
      if (k.length === 1) {
        cheatBuf = (cheatBuf + k).slice(-16);
        if (cheatBuf.endsWith('funds')) {
          cheatBuf = '';
          sim.money += 1000;
          if (sim._log) sim._log.push({ t: +sim.time.toFixed(3), fn: '__cheat', args: [] });
          sim.msg('Cheat aktivován: +1 000 €');
        }
      }
      const byHotkey = Object.entries(EG.BUILD).find(([, v]) => v.hotkey === k);
      if (byHotkey) {
        if (byHotkey[0] === 'line' && tool === 'line') {
          // opakovaný stisk 7 cykluje napěťové úrovně v pořadí, v jakém
          // jsou v liště – ať klávesa a klikání jdou stejnou cestou
          const i = LINE_ORDER.indexOf(lineLevel);
          setLineLevel(LINE_ORDER[(i + 1) % LINE_ORDER.length]);
        } else setTool(byHotkey[0]);
      }
      else if (k === 'escape') { if (selected || selectedLine || selectedCity) closePanel(); else setTool('pan'); }
      else if (k === 'q') setTool('pan');
      else if (k === 'x') setTool('demolish');
      else if (k === 'p') document.body.classList.toggle('photo'); // fotorežim
      else if (k === 'b') { if (planning) cancelPlan(); else enterPlan(); } // plán
      else if (k === ' ') { e.preventDefault(); speed = speed === 0 ? 1 : 0; updateSpeedLabel(); }
      else if (k === '+' || k === '=') { speed = Math.min(4, (speed || 1) * 2); updateSpeedLabel(); }
      else if (k === '-') { speed = Math.max(1, speed / 2) * (speed === 0 ? 0 : 1); updateSpeedLabel(); }
    });
  }

  function click() {
    if (replaying) return; // při přehrávání záznamu se nezasahuje
    const [gx, gy] = hover;
    if (tool === 'pan') {
      const b = sim.buildingAt(gx, gy);
      if (b) { selectBuilding(b); return; }
      const l = lineNear(hoverF[0], hoverF[1]);
      if (l) { selectLine(l); return; }
      const c = cityAt(gx, gy);
      if (c) { selectCity(c); return; }
      closePanel();
      return;
    }
    if (tool === 'demolish') {
      // klik na vedení? – přesná pozice myši, nejbližší segment do 0.6 dlaždice
      const l = lineNear(hoverF[0], hoverF[1]);
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
      const mL = sim.money;
      const l = sim.connect(lineFrom, b, lineLevel, lineCable);
      if (l) undoStack.push({ t: 'line', id: l.id, cost: mL - sim.money, wasN: l.n });
      lineFrom = b; // řetězení vedení
      return;
    }
    // stavba budovy
    const mB = sim.money;
    const b = sim.place(tool, gx, gy);
    if (b) undoStack.push({ t: 'b', id: b.id, cost: mB - sim.money });
    if (undoStack.length > 30) undoStack.shift();
  }

  /* undo poslední stavby (Ctrl+Z) – plná vratka */
  function undoLast() {
    if (planning || replaying) { sim.msg('V plánu/replayi undo nefunguje – použij Zrušit', 'warn'); return; }
    if (sim.gameOver) { sim.msg('Hra skončila – undo už nepomůže', 'warn'); return; }
    const a = undoStack.pop();
    if (!a) { sim.msg('Není co vracet', 'warn'); return; }
    if (a.t === 'b') {
      const b = sim.buildings.find((o) => o.id === a.id);
      if (!b) { sim.msg('Stavba už neexistuje', 'warn'); return; }
      if (b === selected) closePanel();
      if (b.kind === 'dam') sim._revertDam(b); // vrátit nádrž a průtoky
      // plná vratka i za vedení, která se stavbou zmizí
      let lineRefund = 0;
      for (const l of sim.lines) {
        if (l.a !== b.id && l.b !== b.id) continue;
        const LT = EG.LINE_TYPES[l.level];
        lineRefund += Math.ceil(l.len * LT.cost * (l.cable ? 2.5 : 1)) +
          Math.max(0, (l.n || 1) - 1) * Math.ceil(l.len * LT.cost * 0.7);
      }
      sim.buildings = sim.buildings.filter((o) => o !== b);
      sim.lines = sim.lines.filter((l) => l.a !== b.id && l.b !== b.id);
      sim.money += a.cost + lineRefund;
      sim.msg('↩ Stavba vrácena (+' + (a.cost + lineRefund) + ')');
    } else {
      const l = sim.lines.find((o) => o.id === a.id);
      if (!l) { sim.msg('Vedení už neexistuje', 'warn'); return; }
      if (l.n > 1 && l.n === a.wasN) {
        l.n--;
        l.cap = EG.LINE_TYPES[l.level].cap * l.n;
      } else {
        sim.lines = sim.lines.filter((o) => o !== l);
      }
      sim.money += a.cost;
      sim.msg('↩ Vedení vráceno (+' + a.cost + ')');
    }
  }

  function lineNear(gx, gy) {
    let best = null, bestD = 0.6;
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
    // ikonka nástroje „Vedení" nese barvu zvolené napěťové úrovně
    const c = LEVEL_COLOR[lv] || [0.7, 0.75, 0.8];
    document.documentElement.style.setProperty('--line-col',
      'rgb(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ')');
    document.querySelectorAll('.linelvl').forEach((el) => {
      el.classList.toggle('active', +el.dataset.level === lv);
    });
    const LT = EG.LINE_TYPES[lv];
    sim.msg('Vedení: ' + LT.name + ' (kapacita ' + LT.cap + ' MW, max ' + LT.maxLen + ' dl.)');
  }

  /* Napěťové úrovně po třídách. Vedle sebe je pak vidět, co která
     hladina umí – v jednom seznamu deseti položek se to ztrácelo. */
  const LINE_GROUPS = [
    { name: 'Velmi vysoké napětí', levels: [800, 400, 220, 110] },
    { name: 'Vysoké napětí', levels: [22, 11] },
    { name: 'Nízké napětí', levels: [0.4] },
    { name: 'Stejnosměrné', levels: [500, 1.5, 0.5] },
  ];
  const LINE_ORDER = LINE_GROUPS.reduce((a, g) => a.concat(g.levels), []);

  const rgbOf = (lv) => {
    const [r, g, b] = LEVEL_COLOR[lv] || [0.7, 0.75, 0.8];
    return 'rgb(' + Math.round(r * 255) + ',' + Math.round(g * 255) + ',' + Math.round(b * 255) + ')';
  };

  function setupLinebar() {
    const bar = $('#linebar');
    for (const grp of LINE_GROUPS) {
      const head = document.createElement('div');
      head.className = 'line-group';
      head.textContent = grp.name;
      bar.appendChild(head);
      for (const lv of grp.levels) {
        const LT = EG.LINE_TYPES[lv];
        const el = document.createElement('button');
        el.className = 'linelvl';
        el.dataset.level = lv;
        // tloušťka proužku napovídá, kolik hladina unese
        const thick = LT.cap >= 400 ? 6 : LT.cap >= 80 ? 4 : LT.cap >= 30 ? 3 : 2;
        el.innerHTML =
          '<span class="swatch"><i style="background:' + rgbOf(lv) + ';height:' + thick + 'px"></i></span>' +
          '<span class="lv-name">' + LT.name.replace(/^(VVN|VN|NN) /, '') + '</span>' +
          '<span class="lv-cap">' + LT.cap + ' MW</span>' +
          '<span class="lv-len">' + LT.maxLen + ' dl</span>' +
          '<span class="lv-cost">' + LT.cost + ' €/dl</span>';
        el.title = LT.name + ': kapacita ' + LT.cap + ' MW, max. délka ' + LT.maxLen +
          ' dlaždic, cena ' + LT.cost + ' € za dlaždici, ztráty ' +
          (LT.loss * 100).toFixed(2) + ' %/dl při plném zatížení.' +
          (LT.dc ? '\nStejnosměrná hladina – nemá jalový výkon, ale unese jen krátké trasy.' : '');
        el.addEventListener('click', () => setLineLevel(lv));
        bar.appendChild(el);
      }
    }
    // přepínač podzemního kabelu – není to napěťová úroveň, tak stojí zvlášť
    const cbl = document.createElement('button');
    cbl.className = 'linelvl cable-toggle';
    cbl.id = 'btn-cable';
    cbl.innerHTML = '<span class="tick">✓</span><span class="lv-name">Podzemní kabel</span>' +
      '<span class="lv-cost">2,5× cena</span>';
    cbl.title = 'Kabel je dražší, ale odolá bouřkám, má nižší ztráty a netrpí na jalový výkon.';
    cbl.addEventListener('click', () => {
      lineCable = !lineCable;
      cbl.classList.toggle('active', lineCable);
      sim.msg('Vedení se staví jako ' + (lineCable ? 'podzemní kabel (2,5×)' : 'venkovní linka'));
    });
    bar.appendChild(cbl);
    setLineLevel(lineLevel);
  }

  /* Nástroje po skupinách: v jednom dlouhém sloupci se hledalo špatně.
     Pořadí míří na to, co se používá nejčastěji – nejdřív prohlížení
     a bourání, pak síť, zdroje a nakonec úložiště. */
  const TOOL_GROUPS = [
    { name: 'Nástroje', tools: ['pan', 'demolish'] },
    { name: 'Síť', tools: ['sub', 'line'] },
    { name: 'Zdroje', tools: ['hydro', 'dam', 'coal', 'gas', 'nuclear', 'solar', 'wind', 'owind', 'geo', 'bio', 'waste'] },
    { name: 'Úložiště', tools: ['battery', 'bess', 'psh', 'h2', 'tesla'] },
  ];

  const TOOL_EXTRA = {
    pan: { label: 'Prohlížet', key: 'Q', glyph: '🔍',
      desc: 'Klikni na stavbu, vedení nebo město a otevře se jeho panel.' },
    demolish: { label: 'Zbourat', key: 'X', glyph: '🗑',
      desc: 'Bourá budovy (vrátí 40 % ceny) i vedení – klikni přímo na linku; ' +
        'vícenásobné trasy se odpojují po jednom systému.' },
  };

  let atlasUrl = '';

  /* Ikonky nástrojů jsou výřezy z herního atlasu, takže vypadají přesně
     jako to, co se postaví, a repozitář nepotřebuje žádné obrázky.
     Vedení má místo spritu proužek v barvě zvoleného napětí. */
  function toolIcon(t, extra) {
    const el = document.createElement('i');
    el.className = 'ico';
    if (t === 'line') { el.classList.add('ico-line'); return el; }
    if (extra.glyph) { el.classList.add('ico-glyph'); el.textContent = extra.glyph; return el; }
    const sprite = kindSprite(t);
    if (sprite === undefined) return el;
    const A = EG.atlas;
    const s = 0.62;                                   // zmenšení buňky atlasu
    const cw = A.CELL_W * s, ch = A.CELL_H * s;
    const col = sprite % A.COLS, row = Math.floor(sprite / A.COLS);
    el.style.backgroundImage = 'url(' + atlasUrl + ')';
    el.style.backgroundSize = (A.COLS * cw) + 'px ' + (A.ROWS * ch) + 'px';
    // výřez kolem stavby: kotva (základna) je dole uprostřed buňky
    el.style.backgroundPosition = (-(col * cw + 6)) + 'px ' + (-(row * ch + 25)) + 'px';
    return el;
  }

  function setupToolbar() {
    const bar = $('#toolbar');
    atlasUrl = renderer.atlasCanvas.toDataURL();
    for (const grp of TOOL_GROUPS) {
      const head = document.createElement('div');
      head.className = 'tool-group';
      head.textContent = grp.name;
      bar.appendChild(head);
      for (const t of grp.tools) {
        const def = EG.BUILD[t];
        const extra = TOOL_EXTRA[t] || {};
        if (!def && !extra.label) continue;
        const el = document.createElement('button');
        el.className = 'tool';
        el.dataset.tool = t;
        el.appendChild(toolIcon(t, extra));
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = extra.label || def.name;
        el.appendChild(name);
        const key = extra.key || (def && def.hotkey ? def.hotkey.toUpperCase() : '');
        if (key) {
          const k = document.createElement('span');
          k.className = 'key';
          k.textContent = key;
          el.appendChild(k);
        }
        if (def && def.cost) {
          const c = document.createElement('span');
          c.className = 'cost';
          c.dataset.kind = t;
          c.textContent = def.cost;
          el.appendChild(c);
        }
        el.title = (extra.desc || (def && def.desc) || '') +
          (def && def.cost ? '\n\nCena ' + def.cost + ' €.' : '');
        el.addEventListener('click', () => setTool(t));
        bar.appendChild(el);
      }
    }
    setTool('pan');
    $('#btn-speed').addEventListener('click', () => {
      speed = speed === 0 ? 1 : speed >= 4 ? 0 : speed * 2;
      updateSpeedLabel();
    });
  }

  /* Co si právě nemůžeš dovolit, ať je poznat na první pohled –
     a když běží dotace, cena u soláru a větrníku sama zlevní. */
  function updateToolPrices() {
    for (const el of document.querySelectorAll('#toolbar .cost')) {
      const cost = sim.buildCost(el.dataset.kind);
      if (el._cost !== cost) { el._cost = cost; el.textContent = cost; }
      const cheap = cost < EG.BUILD[el.dataset.kind].cost;
      el.classList.toggle('sale', cheap);
      el.parentElement.classList.toggle('cant', sim.money < cost);
    }
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
        const name = ((l.n || 1) > 1 ? l.n + '× ' : '') +
          EG.BUILD[other.kind].name + ' [' + other.x + ',' + other.y + ']';
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
        if (t.hi !== lv || t.coupler) continue;
        const flow = (b.trafoFlow || {})[key] || 0; // kladné = hi -> lo
        rows.push({
          type: 'trafo', key,
          dir: flow >= 0 ? 'down' : 'up',
          mw: Math.abs(flow), load: (b.trafoLoad || {})[key] || 0,
          label: t.name + (count > 1 ? ' ×' + count : ''), lo: t.lo,
          reg: (b.trafoReg || {})[key] || null,
        });
      }
    }
    return rows;
  }
  EG.schemaData = schemaData;

  /* grafické jednopólové schéma rozvodny (SVG): vodorovné přípojnice
     po hladinách, svislé odbočky se šipkami toku, trafa jako značka
     dvou kružnic mezi přípojnicemi */
  function renderSchema(b) {
    const rows = schemaData(sim, b);
    const sections = [];
    let cur = null;
    for (const r of rows) {
      if (r.type === 'bus') { cur = { lv: r.lv, label: r.label, feeders: [], trafos: [] }; sections.push(cur); }
      else if (r.type === 'trafo') cur.trafos.push(r);
      else cur.feeders.push(r);
    }
    if (!sections.some((s) => s.feeders.length || s.trafos.length)) {
      return '<div class="bp-trafo-none">Žádné toky – připoj vedení a kup trafa.</div>';
    }
    const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const rgb = (lv) => {
      const c = LEVEL_COLOR[lv] || [0.6, 0.6, 0.6];
      return 'rgb(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ')';
    };
    const dirCol = { in: '#7ed087', out: '#e8c84a', idle: '#6d7a87' };
    const loadCol = (load) => load > 1 ? '#ff6a5a' : load > 0.75 ? '#f0c040' : '#9fb2c2';

    const W = 252, busX0 = 6, busX1 = 246, fx = 14;
    // rozvrh: Y jednotlivých přípojnic
    const busY = new Map();
    let y = 14;
    for (const s of sections) {
      busY.set(s.lv, y);
      y += 10 + s.feeders.length * 15 + 8;
    }
    const H = y - 2;
    let svg = '';

    // přípojnice + odbočky (vedení a odběry)
    for (const s of sections) {
      const by = busY.get(s.lv);
      svg += '<line x1="' + busX0 + '" y1="' + by + '" x2="' + busX1 + '" y2="' + by +
        '" stroke="' + rgb(s.lv) + '" stroke-width="3.5"/>';
      svg += '<text x="' + busX0 + '" y="' + (by - 4) + '" fill="#dfe6ef" font-size="9.5" font-weight="700">' +
        esc(s.label) + '</text>';
      let fy = by + 16;
      for (const f of s.feeders) {
        const col = f.load > 1 ? '#ff6a5a' : dirCol[f.dir];
        // svislá odbočka z přípojnice
        svg += '<line x1="' + fx + '" y1="' + (by + 2) + '" x2="' + fx + '" y2="' + (fy - 3) +
          '" stroke="' + col + '" stroke-width="1.6"/>';
        // šipka směru: dovnitř (k přípojnici) / ven
        if (f.dir === 'in') {
          svg += '<polygon points="' + (fx - 4) + ',' + (by + 9) + ' ' + (fx + 4) + ',' + (by + 9) + ' ' + fx + ',' + (by + 3) +
            '" fill="' + col + '"/>';
        } else if (f.dir === 'out') {
          svg += '<polygon points="' + (fx - 4) + ',' + (fy - 9) + ' ' + (fx + 4) + ',' + (fy - 9) + ' ' + fx + ',' + (fy - 3) +
            '" fill="' + col + '"/>';
        }
        // symbol odběru (šipka do trojúhelníku = zátěž) vs. vedení (kruh)
        if (f.type === 'load') {
          svg += '<polygon points="' + (fx - 4) + ',' + (fy - 3) + ' ' + (fx + 4) + ',' + (fy - 3) + ' ' + fx + ',' + (fy + 3) +
            '" fill="none" stroke="' + col + '" stroke-width="1.2"/>';
        } else {
          svg += '<circle cx="' + fx + '" cy="' + (fy - 1) + '" r="2.2" fill="' + col + '"/>';
        }
        svg += '<text x="' + (fx + 10) + '" y="' + (fy + 2) + '" fill="' + col + '" font-size="9">' +
          esc(f.label) + ' · ' + f.mw.toFixed(1) + ' MW' + (f.load > 1 ? ' ⚠' : '') + '</text>';
        fy += 15;
      }
    }

    // trafa: svislé spoje mezi přípojnicemi se značkou dvou kružnic
    let tIdx = 0;
    for (const s of sections) {
      for (const t of s.trafos) {
        const x = 234 - tIdx * 22;
        tIdx++;
        const y1 = busY.get(s.lv), y2 = busY.get(t.lo);
        if (y2 === undefined) continue;
        const col = loadCol(t.load);
        const ym = (y1 + y2) / 2;
        svg += '<g><title>trafo ' + esc(t.label) + ' · ' + t.mw.toFixed(1) + ' MW · ' +
          Math.round(t.load * 100) + ' %' + (t.reg ? ' · regulace: ' + t.reg : '') + '</title>';
        svg += '<line x1="' + x + '" y1="' + (y1 + 2) + '" x2="' + x + '" y2="' + (ym - 8) +
          '" stroke="' + col + '" stroke-width="1.6"/>';
        svg += '<line x1="' + x + '" y1="' + (ym + 8) + '" x2="' + x + '" y2="' + (y2 - 2) +
          '" stroke="' + col + '" stroke-width="1.6"/>';
        svg += '<circle cx="' + x + '" cy="' + (ym - 3.5) + '" r="5.5" fill="none" stroke="' + col + '" stroke-width="1.6"/>';
        svg += '<circle cx="' + x + '" cy="' + (ym + 3.5) + '" r="5.5" fill="none" stroke="' + col + '" stroke-width="1.6"/>';
        // šipka směru toku
        if (t.mw > 0.05) {
          if (t.dir === 'down') {
            svg += '<polygon points="' + (x - 4) + ',' + (y2 - 8) + ' ' + (x + 4) + ',' + (y2 - 8) + ' ' + x + ',' + (y2 - 2) +
              '" fill="' + col + '"/>';
          } else {
            svg += '<polygon points="' + (x - 4) + ',' + (y1 + 8) + ' ' + (x + 4) + ',' + (y1 + 8) + ' ' + x + ',' + (y1 + 2) +
              '" fill="' + col + '"/>';
          }
        }
        svg += '<text x="' + (x + 8) + '" y="' + (ym + 2) + '" fill="' + col + '" font-size="8">' +
          Math.round(t.load * 100) + '%</text>';
        if (t.reg) {
          svg += '<text x="' + (x + 8) + '" y="' + (ym + 11) + '" fill="#9fb2c2" font-size="8">' +
            ({ auto: 'A', boost: '▲', limit: '▼' }[t.reg]) + '</text>';
        }
        svg += '</g>';
      }
    }

    return '<svg class="bp-svg" viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '">' + svg + '</svg>';
  }

  /* ---------- panel správy budovy ---------- */
  function selectBuilding(b) {
    selected = b;
    selectedLine = null;
    $('#bpanel').hidden = false;
    buildPanelActions();
    updatePanel();
  }

  function selectLine(l) {
    selectedLine = l;
    selected = null;
    selectedCity = null;
    $('#bpanel').hidden = false;
    buildPanelActions();
    updatePanel();
  }

  function selectCity(c) {
    selectedCity = c;
    selected = null;
    selectedLine = null;
    $('#bpanel').hidden = false;
    buildPanelActions();
    updatePanel();
  }

  function closePanel() {
    selected = null;
    selectedLine = null;
    selectedCity = null;
    $('#bpanel').hidden = true;
  }

  /* město pod kurzorem: střed, jeho okolí nebo některá dlaždice zástavby */
  function cityAt(gx, gy) {
    return map.cities.find((c) => (Math.abs(c.x - gx) <= 2 && Math.abs(c.y - gy) <= 2) ||
      c.houses.some(([hx, hy]) => hx === gx && hy === gy)) || null;
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

    // panel města: stavba městské elektrické dopravy
    if (selectedCity) {
      const c = selectedCity;
      const sec = document.createElement('div');
      sec.className = 'bp-sec';
      sec.style.borderTop = 'none';
      sec.style.marginTop = '0';
      sec.style.paddingTop = '0';
      sec.textContent = 'Městská elektrická doprava';
      sec.title = 'Trakce je stálý odběratel mimo večerní špičku a přinese tržby z jízdného. ' +
        'Dobrá doprava město zatraktivní, takže rychleji roste a unese víc obyvatel.';
      box.appendChild(sec);
      if (sim.transitList(c).length === EG.TRANSIT_KEYS.length) {
        const done = document.createElement('div');
        done.className = 'bp-trafo-none';
        done.textContent = 'Město má kompletní elektrickou dopravu – trolejbusy, tramvaje i metro.';
        box.appendChild(done);
      }
      for (const key of EG.TRANSIT_KEYS) {
        const def = EG.TRANSIT[key];
        if (sim.hasTransit(c, key)) continue;
        const el = bpButton(def.ico + ' Postavit ' + def.name.toLowerCase() +
          '<span class="cost" id="bp-tr-cost-' + key + '"></span>', '',
          () => sim.buyTransit(c, key));
        el.dataset.transit = key;
        el.title = def.desc + '\n\nTrakce ' + def.volts + ' V DC, rekuperace ' +
          Math.round(def.regen * 100) + ' %, od ' + def.minPop + ' tis. obyvatel.' +
          (def.needs ? '\nVyžaduje: ' + EG.TRANSIT[def.needs].name.toLowerCase() + '.' : '');
      }
      return;
    }

    // panel vedení: servis a odpojení
    if (selectedLine) {
      const l = selectedLine;
      const svc = bpButton('🔧 Servis vedení <span class="cost" id="bp-lsvc-cost"></span>', l.broken ? 'danger' : '',
        () => sim.serviceLine(l));
      svc.id = 'bp-btn-lsvc';
      svc.title = 'Výměna izolátorů a vodičů: stav zpět na 100 %. Vedení kryje i servisní smlouva rozvodny na konci trasy.';
      bpButton('🗑 Odpojit systém / odstranit', 'danger', () => {
        sim.removeLine(l);
        if (!sim.lines.includes(l)) closePanel();
      });
      return;
    }
    if (!b) return;

    // přeshraniční bod: jen sjednávání smluv (nákup/prodej po 10 MW)
    if (b.kind === 'xborder') {
      const mk = (dir, ico, label) => {
        const row = document.createElement('div');
        row.className = 'bp-xrow';
        const span = document.createElement('span');
        span.innerHTML = ico + ' ' + label;
        row.appendChild(span);
        for (const d of [-EG.XTRADE.step, EG.XTRADE.step]) {
          const btn = document.createElement('button');
          btn.className = 'reg-btn';
          btn.textContent = (d > 0 ? '+' : '−') + Math.abs(d);
          btn.addEventListener('click', () => { sim.adjustXContract(b, dir, d); updatePanel(); });
          row.appendChild(btn);
        }
        box.appendChild(row);
      };
      mk('import', '⬅', 'Nákup (import)');
      mk('export', '➡', 'Prodej (export)');
      return;
    }

    const svc = bpButton('🔧 Servis' + (b.broken ? ' (oprava poruchy)' : '') +
      '<span class="cost" id="bp-svc-cost"></span>', b.broken ? 'danger' : '',
      () => sim.service(b));
    svc.id = 'bp-btn-svc';

    const contract = bpButton('📋 Servisní smlouva <span class="cost" id="bp-contract-cost"></span>',
      b.contract ? 'on' : '',
      () => sim.setContract(b, !b.contract));
    contract.id = 'bp-btn-contract';
    contract.title = 'Paušální údržba: zařízení se neopotřebovává ani neporouchá (spraví i stávající ' +
      'poškození). Stojí 20 % ceny zařízení ročně – za 5 let jako výměna za nové. U rozvodny včetně traf. ' +
      'Modernizace paušál snižuje o 15 % za úroveň.';

    if (EG.fuelDefOf(b)) {
      const fd = EG.fuelDefOf(b);
      const fuel = bpButton('⛽ Koupit ' + fd.name + ' <span class="cost" id="bp-fuel-cost"></span>', '',
        () => sim.buyFuel(b));
      fuel.id = 'bp-btn-fuel';
      fuel.title = 'Doplní sklad (' + fd.cap + ' ' + fd.unit + ') za ' + fd.price + '/' + fd.unit +
        '. Bez paliva elektrárna stojí!';
      const fc = bpButton('🚚 Smlouva na palivo <span class="cost">+15 % k ceně</span>',
        b.fuelContract ? 'on' : '',
        () => sim.setFuelContract(b, !b.fuelContract));
      fc.id = 'bp-btn-fuelcontract';
      fc.title = 'Palivo se dokupuje samo: první dodávka hned s podpisem, další vždy když zásoba klesne pod 50 %.';
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

      if (!b.compensator) {
        const comp = bpButton('🔋 Kompenzace jalového výkonu <span class="cost">−90</span>', '',
          () => sim.buyCompensator(b));
        comp.title = 'Kondenzátorová baterie: dlouhá střídavá vedení z této rozvodny neztrácí 20 % kapacity.';
      }

      // makro: celá kaskáda 110 -> NN jedním kliknutím
      const kask = bpButton('⚡ Kaskáda 110→NN <span class="cost">−180</span>', '',
        () => { sim.buyTrafo(b, 't110_22'); sim.buyTrafo(b, 't22_04'); });
      kask.title = 'Koupí najednou trafo 110⇄22 kV a distribuční 22⇄0,4 kV.';

      // --- trafa: instalovaná + nákup + regulace (přepínač odboček) ---
      const sec = document.createElement('div');
      sec.className = 'bp-sec';
      sec.textContent = 'Trafa';
      box.appendChild(sec);
      const list = document.createElement('div');
      list.id = 'bp-trafo-list';
      // delegovaně (řádky se každý snímek přestavují): nákup regulace a přepínání režimu
      list.addEventListener('mousedown', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        if (btn.dataset.regbuy) sim.buyTrafoReg(b, btn.dataset.regbuy);
        else if (btn.dataset.mode) sim.setTrafoReg(b, btn.dataset.key, btn.dataset.mode);
      });
      box.appendChild(list);
      for (const [key, t] of Object.entries(EG.TRAFOS)) {
        if (t.coupler) continue;
        const el = bpButton('➕ ' + t.name + '<span class="cost">' + t.cap + ' MW · −' + t.cost + '</span>', 'trafo-buy',
          () => sim.buyTrafo(b, key));
        el.dataset.trafo = key;
        el.title = 'Převádí obousměrně ' + EG.LINE_TYPES[t.hi].name + ' ⇄ ' + EG.LINE_TYPES[t.lo].name +
          ' (i nahoru, např. 220→400), kapacita ' + t.cap + ' MW. Více kusů se sčítá.';
      }

      // --- propojovací pole: prodloužení trasy na stejné hladině ---
      const sec2 = document.createElement('div');
      sec2.className = 'bp-sec';
      sec2.textContent = 'Propojovací pole (prodloužení)';
      sec2.title = 'Přidá rozvodně přípojnici dané hladiny bez převodu – trasa jde prodloužit dalším vedením.';
      box.appendChild(sec2);
      for (const [key, t] of Object.entries(EG.TRAFOS)) {
        if (!t.coupler) continue;
        const el = bpButton('➕ ' + t.name + '<span class="cost">−' + t.cost + '</span>', 'trafo-buy',
          () => sim.buyTrafo(b, key));
        el.dataset.trafo = key;
        el.title = 'Přípojnice ' + EG.LINE_TYPES[t.hi].name + ' bez převodu – na řetězení vedení (prodloužení trasy).';
      }
    }

    // retrofit uhelné na biomasu
    if (b.kind === 'coal' && !b.bioRetrofit) {
      const rf = bpButton('🌿 Retrofit na biomasu <span class="cost">−300</span>', '',
        () => sim.retrofitBiomass(b));
      rf.title = 'Přestavba kotle na štěpku: 70 MW místo 90, ale levnější a čistší palivo (bez emisních povolenek).';
    }

    // konzervace (mothball) – jen výrobny a zásobníky
    if (b.kind !== 'sub' && b.kind !== 'xborder') {
      const mb = bpButton('⏻ Konzervace <span class="cost">provoz 25 %</span>', b.mothball ? 'on' : '',
        () => sim.setMothball(b, !b.mothball));
      mb.id = 'bp-btn-mothball';
      mb.title = 'Odstavené zařízení nevyrábí, neopotřebovává se a platí jen čtvrtinový provoz.';
    }

    if (b.kind !== 'dam') {
      bpButton('🗑 Zbourat <span class="cost">+' + Math.floor(EG.BUILD[b.kind].cost * 0.4) + '</span>', 'danger',
        () => { if (sim.demolish(b.x, b.y)) closePanel(); });
    }
  }

  function updatePanel() {
    // panel města: obyvatelstvo, odběr a městská doprava
    if (selectedCity) {
      const c = selectedCity;
      // město mohlo zaniknout s načtením jiné hry
      if (!map.cities.includes(c)) { closePanel(); return; }
      const kindName = { res: 'obytné', ind: 'průmyslové', mix: 'smíšené' }[c.kind] || '';
      const ca = (sim.cityAssign || []).find((a) => a.city === c);
      const tb = sim.transitBonus(c);
      $('#bp-title').textContent = c.name + ' [' + c.x + ',' + c.y + ']';
      $('#bp-cond-row').hidden = true;
      $('#bp-schema').hidden = true;

      let rows = 'Charakter: <span class="val">' + kindName + '</span> · obyvatel <span class="val">' +
        c.pop + ' tis.</span> <span class="dim">(strop ' + (60 + tb.cap) + ')</span><br>';
      rows += 'Odběr: <span class="val">' + (ca ? ca.demand.toFixed(1) : '?') + ' MW</span> · dodávka <span class="val">' +
        (ca ? ca.served.toFixed(1) : '?') + ' MW</span> (' + Math.round((c.powered || 0) * 100) + ' %)<br>';
      rows += 'Připojení: <span class="' + (ca && ca.sub >= 0 ? 'val' : 'bad') + '">' +
        (ca && ca.sub >= 0 ? 'rozvodna v dosahu ✓' : 'bez rozvodny v dosahu!') + '</span><br>';
      rows += 'Spokojenost: <span class="val">' + Math.round((c.satisfaction || 0) * 100) +
        ' %</span> · prestiž <span class="val">' + Math.round((c.reliab === undefined ? 1 : c.reliab) * 100) + ' %</span><br>';
      const trSub = sim.tractionSubOf(c);
      rows += 'Trakční měnírna: <span class="' + (trSub ? 'val' : 'bad') + '">' +
        (trSub ? 'z VN rozvodny [' + trSub.x + ',' + trSub.y + '] ✓' : 'chybí VN přípojnice v dosahu') +
        '</span><br>';

      const list = sim.transitList(c);
      if (list.length === 0) {
        rows += '<span class="dim">Bez městské dopravy – lidé jezdí auty.</span><br>';
      } else {
        const trMw = sim.transitDemand(c, sim.dayPhase || 0);
        rows += 'Doprava: <span class="val">' + list.map((k) => EG.TRANSIT[k].ico + ' ' +
          EG.TRANSIT[k].name.toLowerCase()).join(', ') + '</span><br>';
        rows += 'Trakční odběr: <span class="val">' + trMw.toFixed(1) + ' MW</span>' +
          (c.transitDown ? ' <span class="bad">⚠ STOJÍ – výpadek napájení</span>' : '') + '<br>';
        rows += 'Růst města: <span class="val">+' + Math.round(tb.growth * 100) + ' %</span><br>';
      }
      $('#bp-stats').innerHTML = rows;

      for (const key of EG.TRANSIT_KEYS) {
        const el = $('#bp-tr-cost-' + key);
        if (!el) continue;
        const def = EG.TRANSIT[key];
        const chk = sim.canBuyTransit(c, key);
        const cost = sim.transitCost(c, key);
        if (chk.ok) el.textContent = '−' + cost;
        else if (c.pop < def.minPop) el.textContent = 'od ' + def.minPop + ' tis.';
        else if (def.needs && !sim.hasTransit(c, def.needs)) {
          el.textContent = 'nejdřív ' + EG.TRANSIT[def.needs].name.toLowerCase();
        } else el.textContent = 'chybí VN';
        const btn = el.closest('button');
        if (btn) {
          btn.disabled = !chk.ok || sim.money < cost;
          btn.dataset.why = chk.ok ? '' : chk.why;
        }
      }
      return;
    }

    // panel vedení
    if (selectedLine) {
      const l = selectedLine;
      if (!sim.lines.includes(l)) { closePanel(); return; }
      const LT = EG.LINE_TYPES[l.level];
      $('#bp-title').textContent = 'Vedení ' + LT.name + (l.n > 1 ? ' ' + l.n + '×' : '') + (l.cable ? ' (kabel)' : '');
      $('#bp-cond-row').hidden = false;
      let rows = 'Délka: <span class="val">' + l.len.toFixed(1) + ' dlaždic</span><br>';
      rows += 'Tok: <span class="val">' + Math.abs(l.flow).toFixed(1) + ' MW</span> · zatížení <span class="val">' +
        Math.round(l.load * 100) + ' %</span><br>';
      rows += 'Kapacita: <span class="val">' + Math.round(l.effCap || l.cap) + ' / ' + l.cap + ' MW</span>';
      if ((l.effCap || l.cap) < l.cap) rows += ' <span class="dim">(penalizace: stáří/jalový výkon/počasí)</span>';
      rows += '<br>';
      if (l.broken) rows += '<span class="bad">⚠ PORUCHA – zestárlé vedení čeká na servis!</span><br>';
      if (l.trippedUntil && l.trippedUntil > sim.time) rows += '<span class="bad">⛈ odpojeno bouřkou</span><br>';
      if (sim._lineUnderContract(l)) rows += 'Údržba: <span class="val">smlouva rozvodny ✓</span><br>';
      $('#bp-stats').innerHTML = rows;
      const pct = Math.round((l.cond === undefined ? 1 : l.cond) * 100);
      $('#bp-cond-pct').textContent = pct + ' %';
      const fill = $('#bp-cond-fill');
      fill.style.width = pct + '%';
      fill.style.background = l.broken ? '#ff5340' : pct > 60 ? '#5dbb63' : pct > 30 ? '#e8c84a' : '#ff8c40';
      $('#bp-schema').hidden = true;
      const lsBtn = $('#bp-btn-lsvc');
      if (lsBtn) {
        const c = sim.lineServiceCost(l);
        $('#bp-lsvc-cost').textContent = '−' + c;
        lsBtn.disabled = (!l.broken && (l.cond === undefined || l.cond > 0.97)) || sim.money < c;
      }
      return;
    }
    const b = selected;
    if (!b) return;
    // budova mohla mezitím zaniknout
    if (!sim.buildings.includes(b)) { closePanel(); return; }
    const def = EG.BUILD[b.kind];
    $('#bp-title').textContent = def.name + ' [' + b.x + ',' + b.y + ']';
    $('#bp-cond-row').hidden = b.kind === 'xborder';

    // přeshraniční bod: smlouvy, plnění a sankce
    if (b.kind === 'xborder') {
      $('#bp-title').textContent = 'Soused: ' + b.name + ' [' + b.x + ',' + b.y + ']';
      const connected = sim.lines.some((l) => l.a === b.id || l.b === b.id);
      const short = Math.max(0, b.xExport - (b.xServed || 0));
      let xr = 'Připojení: <span class="val">' + (connected ? '400 kV ✓' : '<span class="bad">nepřipojeno!</span>') + '</span><br>';
      xr += 'Nákup (import): <span class="val">' + b.xImport + ' MW</span> · platíš ' +
        (b.xImport * EG.XTRADE.importPrice * 60).toFixed(0) + '/min <span class="dim">(take-or-pay)</span><br>';
      xr += 'Prodej (export): <span class="val">' + b.xExport + ' MW</span> · dodáváš <span class="val">' +
        (b.xServed || 0).toFixed(1) + ' MW</span> (+' + ((b.xServed || 0) * EG.XTRADE.exportPrice * 60).toFixed(0) + '/min)<br>';
      if (short > 0.5) {
        xr += '<span class="bad">⚠ SANKCE: nedodáváš ' + short.toFixed(0) + ' MW → −' +
          (short * EG.XTRADE.penalty * 60).toFixed(0) + '/min</span><br>';
      }
      xr += '<span class="dim">Krok smlouvy ' + EG.XTRADE.step + ' MW, strop ' + EG.XTRADE.max + ' MW na směr.</span>';
      $('#bp-stats').innerHTML = xr;
      $('#bp-schema').hidden = true;
      return;
    }

    let rows = '';
    if (b.kind === 'sub') {
      rows += 'Přípojnice: <span class="val">' +
        sim.levelsOf(b).map((lv) => EG.LINE_TYPES[lv].name.replace(/^(VVN|VN|NN) /, '')).join(', ') + '</span><br>';
      rows += 'Dosah NN: <span class="val">' + sim.subRange(b) + ' dlaždic</span> · pole: <span class="val">' +
        sim.fieldsUsed(b) + ' / ' + sim.fieldLimit(b) + '</span><br>';
      if (b.compensator) rows += 'Kompenzace jalového výkonu: <span class="val">✓</span><br>';
      rows += 'Odběr přes rozvodnu: <span class="val">' +
        (sim.cityAssign || []).filter((ca) => ca.sub >= 0 && sim.buildings[ca.sub] === b)
          .reduce((s, ca) => s + ca.served, 0).toFixed(0) + ' MW</span><br>';
    } else if (EG.STORAGE[b.kind]) {
      const sd = EG.STORAGE[b.kind];
      const pct = Math.round(b.charge / sd.cap * 100);
      rows += 'Zásoba: <span class="val">' + Math.round(b.charge) + ' / ' + sd.cap + ' MWs (' + pct + ' %)</span><br>';
      rows += 'Režim: <span class="val">' + b.storMode +
        (Math.abs(b.out) > 0.05 ? ' (' + Math.abs(b.out).toFixed(1) + ' MW)' : '') + '</span><br>';
      rows += 'Max. výkon: <span class="val">±' + Math.round(sd.maxP * EG.levelMult(b.level)) +
        ' MW</span> · účinnost <span class="val">' + Math.round(sd.eff * 100) + ' %</span><br>';
      rows += 'Připojení: <span class="val">' + EG.LINE_TYPES[EG.GEN_LEVEL[b.kind]].name + '</span><br>';
    } else {
      rows += 'Výkon: <span class="val">' + b.out.toFixed(1) + ' / ' + b.gen.toFixed(1) + ' MW</span><br>';
      rows += 'Výstupní napětí: <span class="val">' + EG.LINE_TYPES[EG.GEN_LEVEL[b.kind]].name + '</span><br>';
      // proč výkon kolísá: sezónní a denní vlivy zdroje
      const fx = sim.seasonFx || {};
      const seasonPct = (v) => (v >= 1 ? '+' : '') + Math.round((v - 1) * 100) + ' %';
      if (b.kind === 'hydro' || b.kind === 'dam') {
        rows += 'Průtok řeky: <span class="val">' +
          (map.flow[map.idx(b.x, b.y)] * (fx.hydro || 1)).toFixed(1) +
          '</span> · sezóna <span class="val">' + seasonPct(fx.hydro || 1) + '</span>' +
          ' <span class="dim">(' + (sim.seasonName || '') + ')</span><br>';
      } else if (b.kind === 'solar') {
        rows += 'Slunce: <span class="val">' + Math.round((sim.sun || 0) * 100) + ' %</span>' +
          ' · sezóna <span class="val">' + seasonPct(fx.solar || 1) + '</span>' +
          ' <span class="dim">(' + (sim.seasonName || '') + ')</span><br>';
      } else if (b.kind === 'wind' || b.kind === 'owind') {
        // u turbíny je rozhodující místní rychlost větru a poloha na křivce
        const W = EG.WIND;
        const v = b.windSpeed !== undefined ? b.windSpeed : sim.windAt(b);
        let why;
        if (b.wcut) why = '<span class="bad">bezpečnostní odstavení (nad ' + W.cutOut + ' m/s)</span>';
        else if (v < W.cutIn) why = '<span class="bad">stojí – pod rozběhovou rychlostí ' + W.cutIn + ' m/s</span>';
        else if (v >= W.rated) why = '<span class="val">plný výkon (od ' + W.rated + ' m/s)</span>';
        else why = '<span class="val">' + Math.round(EG.windCurve(v) * 100) + ' % štítkového výkonu</span>';
        rows += 'Vítr v místě: <span class="val">' + v.toFixed(1) + ' m/s</span> · ' + why + '<br>';
        rows += 'Sezóna: <span class="val">' + seasonPct(fx.wind || 1) + '</span>' +
          ' <span class="dim">(' + (sim.seasonName || '') + ')</span>' +
          (sim.calmActive ? ' · <span class="bad">🌫 bezvětří</span>' : '') + '<br>';
      }
      const fd = EG.fuelDefOf(b);
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
    if (EG.sizeOf(b.kind) > 1) {
      const f = EG.footprintOf(b.kind, b.x, b.y);
      rows += 'Areál: <span class="val">' + f.s + '×' + f.s + ' dlaždic</span> ' +
        '<span class="dim">[' + f.x0 + ',' + f.y0 + ']–[' + f.x1 + ',' + f.y1 + ']</span><br>';
    }
    if (b.mothball) rows += '<span class="bad">⏻ KONZERVOVÁNA – nevyrábí</span><br>';
    if (b.bioRetrofit) rows += 'Palivo po retrofitu: <span class="val">biomasa (štěpka)</span><br>';
    rows += 'Úroveň: <span class="val">' + b.level + ' / ' + EG.MAX_LEVEL + '</span>';
    if (b.kind === 'sub') rows += ' · dosah <span class="val">+' + (b.rangeLevel || 0) * 2 + '</span>';
    // skutečně účtovaný provoz (ekonomika násobí upkeep 0,01 a inflací)
    const upkeepRate = def.upkeep * EG.levelMult(b.level) * (b.mothball ? 0.25 : 1) *
      0.01 * Math.pow(1.02, sim.yearIdx || 0);
    rows += '<br>Provoz: <span class="val">' + (upkeepRate * 60).toFixed(1) + '/min</span>';
    if (b.contract) rows += ' · <span class="val">smlouva ✓ −' + sim.contractYearCost(b) + '/rok</span>';
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
    if (cBtn) {
      cBtn.classList.toggle('on', !!b.contract);
      const cc = $('#bp-contract-cost');
      if (cc) cc.textContent = '−' + sim.contractYearCost(b) + '/rok (' + Math.round(sim.contractRate(b) * 100) + ' %)';
    }
    const fuelBtn = $('#bp-btn-fuel');
    if (fuelBtn && EG.fuelDefOf(b)) {
      const c = sim.fuelCost(b);
      $('#bp-fuel-cost').textContent = c === 0 ? 'plný sklad' : '−' + c;
      fuelBtn.disabled = c === 0 || sim.money < EG.fuelDefOf(b).price;
    }
    const fcBtn = $('#bp-btn-fuelcontract');
    if (fcBtn) fcBtn.classList.toggle('on', !!b.fuelContract);
    const mbBtn = $('#bp-btn-mothball');
    if (mbBtn) mbBtn.classList.toggle('on', !!b.mothball);

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
            if (t.coupler) {
              return '<div class="bp-trafo-item">pole ' + t.name + (count > 1 ? ' ×' + count : '') +
                ' <span class="dim">přípojnice bez převodu</span></div>';
            }
            const load = (b.trafoLoad || {})[key] || 0;
            const pct = Math.round(load * 100);
            const cls = load > 1 ? 'bad' : load > 0.75 ? 'warn' : '';
            const reg = (b.trafoReg || {})[key];
            let regHtml;
            if (!reg) {
              const rc = sim.trafoRegCost(key);
              regHtml = '<button class="reg-btn" data-regbuy="' + key + '" title="Regulační trafo (přepínač odboček): umožní tok posílit či škrtit."' +
                (sim.money < rc ? ' disabled' : '') + '>🎛 −' + rc + '</button>';
            } else {
              regHtml = ['auto', 'boost', 'limit'].map((m) =>
                '<button class="reg-btn' + (reg === m ? ' on' : '') + '" data-key="' + key + '" data-mode="' + m +
                '" title="' + { auto: 'automatika', boost: 'přednostní tok (posílit)', limit: 'škrcení toku (omezit)' }[m] + '">' +
                { auto: 'A', boost: '▲', limit: '▼' }[m] + '</button>').join('');
            }
            return '<div class="bp-trafo-item">' + t.name + ' ×' + count +
              ' <span class="' + cls + '">' + pct + ' %</span>' +
              ' <span class="dim">z ' + t.cap * count + ' MW</span>' +
              '<span class="reg-box">' + regHtml + '</span></div>';
          }).join('');
      }
      document.querySelectorAll('.trafo-buy').forEach((el) => {
        el.disabled = sim.money < EG.TRAFOS[el.dataset.trafo].cost;
      });
    }
  }

  /* Cenovka u kurzoru. U vedení je to hlavní věc, kterou hráč potřebuje
     vidět ještě před druhým klikem – cena roste s délkou trasy a u
     kabelu je dvaapůlkrát vyšší. */
  function updateBuildCost() {
    const el = $('#build-cost');
    if (tool === 'pan' || tool === 'demolish' || replaying || sim.gameOver) { el.hidden = true; return; }
    const [gx, gy] = hover;
    if (gx < 0 || gy < 0 || gx >= map.size || gy >= map.size) { el.hidden = true; return; }
    let text = '', bad = false;

    if (tool === 'line') {
      const LT = EG.LINE_TYPES[lineLevel];
      const perTile = Math.round(LT.cost * (lineCable ? 2.5 : 1));
      if (!lineFrom) {
        text = LT.name + (lineCable ? ' · kabel' : '') + ' · ' + perTile + ' €/dl · klikni na začátek';
      } else {
        const to = sim.buildingAt(gx, gy);
        const len = Math.hypot(lineFrom.x - gx, lineFrom.y - gy);
        const q = to ? sim.lineQuote(lineFrom, to, lineLevel, lineCable) : null;
        if (q && q.ok) {
          text = LT.name + ' · ' + q.len.toFixed(1) + ' dl · −' + q.cost + ' €' +
            (q.note ? ' · ' + q.note : '');
          if (sim.money < q.cost) { text += ' · nemáš dost'; bad = true; }
        } else if (q) {
          text = q.why;
          bad = true;
        } else {
          // ještě nemíříme na stavbu: aspoň odhad podle vzdušné čáry
          text = LT.name + ' · ' + len.toFixed(1) + ' dl · ~' + Math.ceil(len * LT.cost * (lineCable ? 2.5 : 1)) + ' €';
          if (len > LT.maxLen) { text += ' · PŘÍLIŠ DALEKO (max ' + LT.maxLen + ' dl)'; bad = true; }
          else text += ' · veď na stavbu';
        }
      }
    } else {
      const def = EG.BUILD[tool];
      if (!def) { el.hidden = true; return; }
      const cost = sim.buildCost(tool);
      const chk = sim.canPlace(tool, gx, gy);
      if (!chk.ok) { text = def.name + ' · ' + chk.why; bad = true; }
      else {
        text = def.name + ' · −' + cost + ' €' + (cost < def.cost ? ' (dotace)' : '');
        if (sim.money < cost) { text += ' · nemáš dost'; bad = true; }
      }
    }

    el.hidden = false;
    el.classList.toggle('bad', bad);
    el.textContent = text;
    // u pravého či dolního okraje se cenovka překlopí, ať nevyjede z obrazu
    const w = el.offsetWidth || 200, h = el.offsetHeight || 24;
    el.style.left = Math.min(mouse.x + 18, window.innerWidth - w - 8) + 'px';
    el.style.top = Math.min(mouse.y + 20, window.innerHeight - h - 8) + 'px';
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
      /* Výkon dává smysl jen u výroben. Rozvodna ani hraniční bod nic
         nevyrábí, takže by u nich věčně svítilo „0/0 MW"; místo toho
         je zajímavější, co jimi teče a co mají za přípojnice. */
      const sd = EG.STORAGE[b.kind];
      s += ' · ' + EG.BUILD[b.kind].name;
      if (b.kind === 'sub') {
        s += ' · přípojnice ' + sim.levelsOf(b)
          .map((lv) => EG.LINE_TYPES[lv].name.replace(/^(VVN|VN|NN) /, '')).join(', ');
        const thru = (sim.cityAssign || [])
          .filter((ca) => ca.sub >= 0 && sim.buildings[ca.sub] === b)
          .reduce((sum, ca) => sum + ca.served, 0);
        s += ' · odběr ' + thru.toFixed(0) + ' MW · pole ' + sim.fieldsUsed(b) + '/' + sim.fieldLimit(b);
      } else if (b.kind === 'xborder') {
        s += ' · ' + b.name + ' · import ' + b.xImport + ' MW · export ' +
          (b.xServed || 0).toFixed(0) + '/' + b.xExport + ' MW';
      } else if (sd) {
        s += ' (' + EG.LINE_TYPES[EG.GEN_LEVEL[b.kind]].name + ') · ' + b.storMode + ' ' +
          Math.abs(b.out).toFixed(0) + ' MW · zásoba ' + Math.round(b.charge / sd.cap * 100) + ' %';
      } else {
        s += ' (' + EG.LINE_TYPES[EG.GEN_LEVEL[b.kind]].name + ') · ' +
          b.out.toFixed(0) + ' / ' + b.gen.toFixed(0) + ' MW';
      }
      if (b.kind !== 'xborder') {
        s += b.broken ? ' · PORUCHA' : ' · stav ' + Math.round((b.cond === undefined ? 1 : b.cond) * 100) + ' %';
      }
      const fd = EG.fuelDefOf(b);
      if (fd) s += b.fuel > 0 ? ' · ' + fd.name + ' ' + Math.round(b.fuel / fd.cap * 100) + ' %' : ' · BEZ PALIVA';
    }
    const ind = (map.industries || []).find((o) => Math.abs(o.x - gx) <= 1 && Math.abs(o.y - gy) <= 1);
    if (ind) {
      const ia = (sim.indAssign || []).find((a) => a.ind === ind);
      const src = ind.type === 'trakce' ? 'ze 110 kV' : 'z VN';
      s += ' · ' + ind.name + ' (' + (ind.type === 'trakce' ? 'železnice' : 'průmysl') +
        ', potřeba ' + (ia ? ia.demand.toFixed(0) : ind.demand.toFixed(0)) +
        ' MW ' + src + ', napájení ' + Math.round((ind.powered || 0) * 100) + ' %)';
    }
    if (!ind) {
      const rw = (map.railways || []).find((r) => r.path.some(([px2, py2]) => px2 === gx && py2 === gy));
      if (rw) s += ' · ' + rw.name + ' (' + rw.from + ' – ' + rw.to + ')';
    }
    const city = map.cities.find((c) => Math.abs(c.x - gx) <= 2 && Math.abs(c.y - gy) <= 2);
    if (city) {
      const kindName = { res: 'obytné', ind: 'průmyslové', mix: 'smíšené' }[city.kind] || '';
      const ca = (sim.cityAssign || []).find((a) => a.city === city);
      const tr = sim.transitList(city).map((k) => EG.TRANSIT[k].ico).join('');
      s += ' · ' + city.name + ' (' + kindName + ', ' + city.pop + ' tis., potřeba ' +
        (ca ? ca.demand.toFixed(0) : '?') + ' MW, napájení ' + Math.round((city.powered || 0) * 100) + ' %' +
        (tr ? ', MHD ' + tr + (city.transitDown ? ' STOJÍ' : '') : '') + ') – klikni pro dopravu';
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
    // železniční koridory
    g.strokeStyle = '#4a4038'; g.lineWidth = 1.2;
    for (const rw of map.railways || []) {
      g.beginPath();
      for (let i = 0; i < rw.path.length; i += 6) {
        const [x, y] = rw.path[i];
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    }
    for (const ind of map.industries || []) {
      g.fillStyle = (ind.powered || 0) > 0.9 ? '#c77dff' : '#ff5340';
      g.fillRect(ind.x - 1.5, ind.y - 1.5, 4, 4);
    }
    for (const b of sim.buildings) {
      if (EG.sizeOf(b.kind) > 1) {
        const f = EG.footprintOf(b.kind, b.x, b.y);
        g.fillStyle = '#f0f4f8';
        g.fillRect(f.x0, f.y0, f.s, f.s);
        g.strokeStyle = '#c9302c'; g.lineWidth = 1;
        g.strokeRect(f.x0 + 0.5, f.y0 + 0.5, f.s - 1, f.s - 1);
      } else if (b.kind === 'xborder') {
        g.fillStyle = '#7ec8ff';
        g.fillRect(b.x - 2, b.y - 2, 5, 5);
      } else {
        g.fillStyle = b.kind === 'sub' ? '#e8c84a' : '#ffffff';
        g.fillRect(b.x - 1, b.y - 1, 2.5, 2.5);
      }
    }
    // rámeček kamery
    const z = renderer.cam.zoom;
    const cw = renderer.canvas.clientWidth / z, ch = renderer.canvas.clientHeight / z;
    const gx = (renderer.cam.x / EG.iso.HW + renderer.cam.y / EG.iso.HH) / 2;
    const gy = (renderer.cam.y / EG.iso.HH - renderer.cam.x / EG.iso.HW) / 2;
    g.strokeStyle = 'rgba(255,255,255,0.6)';
    g.strokeRect(gx - cw / 130, gy - ch / 70, cw / 65, ch / 35);
  }

  /* Daňový ukazatel: rozjetý hospodářský výsledek a odhad odvodů,
     které přijdou na konci herního roku. */
  function updateTaxHud() {
    const eur = (v) => Math.round(v).toLocaleString('cs-CZ');
    const profit = sim.yearProfit || 0;
    const el = $('#tax');
    el.textContent = (profit >= 0 ? '+' : '−') + eur(Math.abs(profit)) + ' €';
    el.style.color = profit < 0 ? '#ff6a5a' : '';
    const est = sim.taxReport(sim.yearIdx || 0);
    const last = sim.lastTax;
    $('#tax-item').title =
      'Hospodářský výsledek za rok ' + ((sim.yearIdx || 0) + 1) + ': ' + eur(profit) + ' €\n' +
      'Majetek ' + eur(est.assets) + ' € · roční odpis ' + eur(est.depreciation) + ' €\n' +
      'Odhad odvodů na Silvestra: ' + eur(est.total) + ' € = daň z příjmu ' + eur(est.incomeTax) +
      (est.windfall > 0.5 ? ' + windfall ' + eur(est.windfall) : '') +
      ' + z majetku ' + eur(est.property) + ' + licence ' + eur(est.license) + '\n' +
      'Windfall daň se platí ze základu nad ' + eur(est.windfallFrom) + ' €\n' +
      'Zálohy zaplacené letos: ' + eur(sim.taxAdvance || 0) + ' € → doplatek ' +
      eur(est.total - (sim.taxAdvance || 0)) + ' €' +
      (last ? '\nLoni celkem: ' + eur(last.total) + ' €' : '');
  }

  /* ---------- HUD ---------- */
  function updateHUD() {
    $('#money').textContent = Math.floor(sim.money).toLocaleString('cs-CZ') + ' €';
    const st = sim.stats;
    $('#power').textContent = st.delivered.toFixed(0) + ' / ' + st.demand.toFixed(0) + ' MW';
    $('#power').className = st.demand > 0 && st.delivered / st.demand < 0.7 ? 'bad' : (st.delivered / Math.max(1, st.demand) < 0.98 ? 'warn' : '');
    $('#losses').textContent = (st.losses || 0).toFixed(1) + ' MW';
    $('#losses').style.color = (st.losses || 0) > 0.15 * Math.max(1, st.delivered) ? '#ff6a5a' : '';
    $('#freq').textContent = (sim.freq || 50).toFixed(1) + ' Hz';
    $('#freq').style.color = (sim.freq || 50) < 49.5 ? '#ff6a5a' : (sim.freq || 50) < 49.9 ? '#f0c040' : '';

    if (planning && planBase) {
      $('#plan-cost').textContent = Math.round(planBase.sim.money - sim.money).toLocaleString('cs-CZ') + ' €';
    }
    $('#spot').textContent = (sim.spotK || 1).toFixed(2) + '×';
    $('#spot').style.color = (sim.spotK || 1) > 1.25 ? '#f0c040' : '';
    $('#debt-item').hidden = !(sim.debt > 0);
    if (sim.debt > 0) $('#debt').textContent = Math.round(sim.debt).toLocaleString('cs-CZ') + ' €';
    // kolik vedení a traf zrovna nestíhá; klikem se otevře přehled zatížení
    const over = countOverloads();
    $('#overload-item').hidden = over === 0;
    $('#overload').textContent = over;
    updateTaxHud();
    if (sim.gameOver && $('#gameover').hidden) {
      $('#gameover').hidden = false;
      speed = 0;
      updateSpeedLabel();
    }

    // snímky za sekundu a kolik dlaždic terénu se z mapy opravdu kreslí
    const rs = renderer.stats;
    $('#fps').textContent = Math.round(fps);
    $('#fps').style.color = fps < 30 ? '#ff6a5a' : fps < 50 ? '#f0c040' : '';
    $('#fps-item').title = 'Snímky za sekundu · terén ' + rs.terrain.toLocaleString('cs-CZ') +
      ' z ' + rs.terrainTotal.toLocaleString('cs-CZ') + ' dlaždic · sprity ' + rs.sprites +
      ' · záře ' + rs.glows + ' · vedení ' + rs.lines + ' · kreslení ' + rs.draws + '×';
    $('#income').textContent = (st.income >= 0 ? '+' : '') + (st.income * 60).toFixed(1) + '/min';
    $('#score').textContent = Math.floor(sim.score).toLocaleString('cs-CZ');
    const best = updateRecord();
    $('#seed-label').textContent = (map.osm
      ? '🌍 ' + map.osm.bbox.lat.toFixed(3) + ', ' + map.osm.bbox.lon.toFixed(3) +
        ' · ' + Math.round(map.osm.bbox.km) + ' km'
      : 'seed ' + map.seed) + (best > 0 ? ' · rekord ' + best.toLocaleString('cs-CZ') : '');
    const ph = sim.dayPhase || 0;
    const hours = Math.floor(6 + ph * 24) % 24;
    const seasonIco = { 'jaro': '🌱', 'léto': '☀️', 'podzim': '🍂', 'zima': '❄️' }[sim.seasonName] || '';
    $('#clock').innerHTML = 'den ' + (sim.day || 1) + ' · ' + seasonIco + (sim.seasonName || '') + ' · ' +
      String(hours).padStart(2, '0') + ':00 ' +
      (sim.sun > 0.05 ? '☀' + Math.round(sim.sun * 100) + '%' : '☾') + ' ' + windLabel();

    if (sim.messages.length !== lastMsgCount) {
      lastMsgCount = sim.messages.length;
      const log = $('#log');
      log.innerHTML = sim.messages.slice(-6).map((m) => {
        const loc = m.x !== undefined;
        return '<div class="' + m.kind + (loc ? ' loc' : '') + '"' +
          (loc ? ' data-x="' + m.x + '" data-y="' + m.y + '" title="Klikni – skok na místo"' : '') + '>' +
          (loc ? '📍 ' : '') + m.text + '</div>';
      }).join('');
      log.scrollTop = log.scrollHeight;
    }
  }

  /* ---------- osvětlení scény ----------
     Barvu dne řeší shader, ne plachta přes celý obraz: poledne je skoro
     bílé, svítání a soumrak táhnou do oranžova, noc je tmavě modrá a
     skoro bez barev (oko za šera barvy nerozezná). Bouřka sebere jas
     i kontrast. Vrací „temnotu" 0..1 pro rozsvěcení světel. */
  const LIGHT_NIGHT = [0.34, 0.42, 0.66];
  const LIGHT_DUSK = [1.06, 0.74, 0.52];
  const LIGHT_DAY = [1.00, 1.00, 0.98];
  const SKY_NIGHT = [0.03, 0.05, 0.10];
  const SKY_DAY = [0.09, 0.12, 0.16];

  const mix3 = (a, b, t) => [
    a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t,
  ];

  function applySceneLight() {
    const sun = Math.max(0, Math.min(1, sim.sun || 0));
    const storm = (sim.activeEvents && sim.activeEvents('storm').length > 0) ? 1 : 0;
    const col = sun < 0.22
      ? mix3(LIGHT_NIGHT, LIGHT_DUSK, sun / 0.22)
      : mix3(LIGHT_DUSK, LIGHT_DAY, Math.min(1, (sun - 0.22) / 0.45));
    const dim = 1 - 0.28 * storm;
    const desat = Math.min(0.85, 0.55 * (1 - Math.min(1, sun * 3)) + 0.3 * storm);
    renderer.setLight(col[0] * dim, col[1] * dim, col[2] * dim, desat);
    const sky = mix3(SKY_NIGHT, SKY_DAY, Math.min(1, sun * 2));
    renderer.setClearColor(sky[0], sky[1], sky[2]);
    return 1 - Math.min(1, sun * 2.6);
  }

  /* Noční světla: rozsvícená okna napájených měst, provozy průmyslu
     a běžící stroje. Kreslí se aditivně, takže je bloom rozzáří. */
  function pushNightLights(night) {
    if (night < 0.03) return;
    for (const c of map.cities) {
      const lit = Math.min(1, (c.powered || 0) * 1.6);
      if (lit < 0.15) continue;
      const a = night * lit;
      renderer.pushGlow(c.x, c.y, S.GLOW, 1.0, 0.88, 0.62, 0.6 * a);
      for (const [hx, hy] of c.houses) {
        if (hx === c.x && hy === c.y) continue;
        renderer.pushGlow(hx, hy, S.GLOW, 1.0, 0.85, 0.58, 0.24 * a);
      }
    }
    for (const ind of map.industries || []) {
      const lit = Math.min(1, (ind.powered || 0) * 1.6);
      if (lit < 0.15) continue;
      renderer.pushGlow(ind.x, ind.y, S.GLOW, 0.85, 0.93, 1.0, 0.42 * night * lit);
    }
    for (const b of sim.buildings) {
      if (b.broken || b.mothball) continue;
      if (b.kind === 'sub') {
        renderer.pushGlow(b.x, b.y, S.GLOW, 0.9, 0.95, 1.0, 0.3 * night);
      } else if (b.out > 0.5) {
        renderer.pushGlow(b.x, b.y, S.GLOW, 1.0, 0.92, 0.7, 0.38 * night);
      }
    }
  }

  /* ---------- vykreslení scény ---------- */
  function pushScene() {
    renderer.beginDynamic();
    const night = applySceneLight();
    const id2b = new Map();
    for (const b of sim.buildings) id2b.set(b.id, b);

    // železniční koridory (pod elektrickým vedením): dvě souběžné kolejnice
    for (const rw of map.railways || []) {
      const p = rw.path;
      for (let i = 3; i < p.length; i += 3) {
        const [x1, y1] = p[i - 3], [x2, y2] = p[i];
        const dl = Math.hypot(x2 - x1, y2 - y1) || 1;
        const px = -(y2 - y1) / dl, py = (x2 - x1) / dl;
        for (const o of [-0.09, 0.09]) {
          renderer.pushLine(x1 + px * o, y1 + py * o, x2 + px * o, y2 + py * o,
            0.16, 0.13, 0.11, 0.8, 0, 0);
        }
      }
    }

    // vedení – barva podle napěťové úrovně, přetížení červeně/oranžově;
    // paralelní systémy se kreslí vedle sebe (společné stožáry)
    for (const l of sim.lines) {
      const a = id2b.get(l.a), b = id2b.get(l.b);
      if (!a || !b) continue;
      const lc = LEVEL_COLOR[l.level] || [0.25, 0.25, 0.28];
      let r = lc[0] * 0.45, g = lc[1] * 0.45, bl = lc[2] * 0.45;
      if (mapLayer === 2) {
        // vrstva zatížení: zelená -> žlutá -> červená
        const t = Math.min(1, l.load);
        r = 0.15 + 0.8 * t; g = 0.8 - 0.6 * Math.max(0, t - 0.5) * 2; bl = 0.15;
      }
      if (l.load > 1) { r = 0.95; g = 0.2; bl = 0.15; }
      else if (l.load > 0.75 && mapLayer !== 2) { r = 0.95; g = 0.6; bl = 0.1; }
      const dir = l.flow > 0.5 ? 1 : (l.flow < -0.5 ? -1 : 0);
      // N-1 analýza: kritická vedení blikají bíle
      if (sim._n1Critical && sim._n1Until > sim.time && sim._n1Critical.has(l.id)) {
        const bl2 = (Math.sin(performance.now() * 0.012) + 1) / 2;
        r = 0.6 + 0.4 * bl2; g = 0.6 + 0.4 * bl2; bl = 0.9;
      }
      if (l.broken || (l.trippedUntil && l.trippedUntil > sim.time)) {
        // odpojené vedení: tmavé s blikáním
        const bl3 = (Math.sin(performance.now() * 0.008) + 1) / 2;
        r = 0.35 + 0.3 * bl3; g = 0.12; bl = 0.1;
      }
      if (l === selectedLine) { r = Math.min(1, r + 0.4); g = Math.min(1, g + 0.4); bl = Math.min(1, bl + 0.3); }
      let alpha = l.cable ? 0.55 : 0.95; // kabel je nenápadný (vede pod zemí)
      if (planning && l.id >= planStartId) { alpha = 0.5; bl = Math.min(1, bl + 0.5); } // plánované vedení
      const n = l.n || 1;
      const dl = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const px = -(b.y - a.y) / dl, py = (b.x - a.x) / dl;
      for (let k = 0; k < n; k++) {
        const o = (k - (n - 1) / 2) * 0.18;
        renderer.pushLine(a.x + px * o, a.y + py * o, b.x + px * o, b.y + py * o,
          r, g, bl, alpha, Math.min(1, l.load), dir);
      }
    }
    // rozestavěné vedení – barvou zvolené úrovně, červeně když je moc dlouhé
    if (tool === 'line' && lineFrom) {
      const tooLong = Math.hypot(lineFrom.x - hover[0], lineFrom.y - hover[1]) > EG.LINE_TYPES[lineLevel].maxLen;
      const lc = tooLong ? [1, 0.2, 0.15] : LEVEL_COLOR[lineLevel];
      renderer.pushLine(lineFrom.x, lineFrom.y, hover[0], hover[1], lc[0], lc[1], lc[2], 0.6, 0, 0);
    }

    // města (seřazení podle hloubky řeší pořadí přidání – kreslíme po diagonálách zjednodušeně dle y)
    const spr = [];
    const TRANSIT_SPR = { trolley: S.TROLLEY, tram: S.TRAM, metro: S.METRO };
    for (const c of map.cities) {
      // městská doprava: pár dlaždic zástavby ustoupí trati a zastávce.
      // Vybírají se nízké indexy, protože ubývající zástavba mizí od konce.
      const onTile = {};
      const trList = sim.transitList(c);
      if (trList.length > 0) {
        const built = c.houses.filter(([hx, hy]) => !(hx === c.x && hy === c.y));
        for (let t = 0; t < trList.length && built.length > 0; t++) {
          const h = built[(1 + t * 2) % built.length];
          onTile[h[0] + ',' + h[1]] = TRANSIT_SPR[trList[t]];
        }
      }
      for (let i = 0; i < c.houses.length; i++) {
        const [hx, hy] = c.houses[i];
        if (hx === c.x && hy === c.y) continue;
        const tr = onTile[hx + ',' + hy];
        spr.push([hx, hy, tr || ((hx * 7 + hy * 13) % 3 === 0 ? S.HOUSE2 : S.HOUSE), c]);
      }
      spr.push([c.x, c.y, S.CENTER, c]);
    }
    for (const g of map.geoFields || []) {
      if (!sim.buildingAt(g.x, g.y)) renderer.pushSprite(g.x, g.y, S.GEOFIELD, 1, 1, 1, 0.9);
    }
    for (const ind of map.industries || []) {
      spr.push([ind.x, ind.y, ind.type === 'trakce' ? S.TRACT : S.FACTORY, null, null, ind]);
    }
    // animace rotorů: otáčky rostou s rychlostí větru; turbína bez výkonu
    // (bezvětří, bouřkové odstavení, konzervace) stojí úplně
    const t2 = performance.now() * 0.001;
    for (const b of sim.buildings) {
      let sId = kindSprite(b.kind);
      if (b.kind === 'wind' || b.kind === 'owind') {
        const v = b.windSpeed || 0;
        const spinning = b.gen > 0.5 && !b.mothball && !b.wcut;
        if (spinning && Math.floor(t2 * (0.8 + v * 0.42)) % 2 === 1) {
          sId = b.kind === 'wind' ? S.WIND2 : S.OWIND2;
        }
      }
      // víceplošná stavba: plochu vyplní betonový areál s řadami bloků,
      // na kotvě stojí měnírna (dekorace se kreslí jen k ní)
      if (EG.sizeOf(b.kind) > 1) {
        const f = EG.footprintOf(b.kind, b.x, b.y);
        for (let ty = f.y0; ty <= f.y1; ty++) for (let tx = f.x0; tx <= f.x1; tx++) {
          if (tx === b.x && ty === b.y) continue;
          const edge = tx === f.x0 || tx === f.x1 || ty === f.y0 || ty === f.y1;
          spr.push([tx, ty, edge ? S.MPAD : S.MPACK, null, b, null, true]);
        }
      }
      spr.push([b.x, b.y, sId, null, b]);
    }
    spr.sort((p, q) => (p[0] + p[1]) - (q[0] + q[1]));
    for (const [x, y, sId, city, b, ind, plain] of spr) {
      let dim = 1;
      if (city && (city.powered || 0) < 0.5 && sim.sun < 0.15) dim = 0.55; // blackout v noci
      if (ind && (ind.powered || 0) < 0.5) dim = 0.62; // stojící podnik potemní
      let tintR = dim, tintG = dim, tintB = dim;
      if (b && b.kind !== 'sub' && b.gen > 0.5 && b.out < 0.1) { tintG = 0.75; tintB = 0.7; } // odpojená elektrárna
      if (b && !b.broken && b.cond < 0.7) {
        // zanedbaná budova viditelně reziví/tmavne
        const f = 0.55 + 0.45 * (b.cond / 0.7);
        tintR *= 0.9 + 0.1 * f; tintG *= f; tintB *= f * 0.95;
      }
      if (b && b.broken) { tintR = 1; tintG = 0.35; tintB = 0.3; } // porucha
      // výstavba: nová budova se první ~3 s „staví" (průhledná a šedá)
      let alpha = 1;
      if (b && b.builtAt !== undefined) {
        const age = sim.time - b.builtAt;
        if (age < 3 && !planning) {
          alpha = 0.35 + 0.65 * (age / 3);
          tintR *= 0.8; tintG *= 0.8; tintB *= 0.8;
        }
      }
      // plánované stavby: modravý průhledný duch
      if (planning && b && b.id >= planStartId) {
        alpha = 0.55;
        tintR *= 0.6; tintG *= 0.8; tintB = Math.min(1, tintB + 0.5);
      }
      renderer.pushSprite(x, y, sId, tintR, tintG, tintB, alpha);

      if (plain) continue; // dlaždice areálu: bez hvězd a ukazatele nabití

      // hvězdy modernizace nad budovou (úroveň 2 = ★, úroveň 3 = ★★)
      if (b && b.level > 1) {
        const nStars = b.level - 1;
        for (let k = 0; k < nStars; k++) {
          const d = (k - (nStars - 1) / 2) * 0.32;
          renderer.pushSprite(x - 0.52 + d, y - 0.52 - d, S.STAR, 1, 1, 1, 0.95);
        }
      }
      // ukazatel nabití zásobníku (3 tečky: zelená = plná, šedá = prázdná)
      if (b && EG.STORAGE[b.kind]) {
        const filled = Math.round((b.charge / EG.STORAGE[b.kind].cap) * 3);
        for (let k = 0; k < 3; k++) {
          const on = k < filled;
          renderer.pushSprite(x + 0.5 - k * 0.24, y + 0.14 - k * 0.24, S.PIP,
            on ? 0.35 : 0.5, on ? 0.95 : 0.55, on ? 0.4 : 0.55, on ? 0.95 : 0.55);
        }
      }
    }

    // vybrané město: zvýrazněný střed a obtažená zástavba
    if (selectedCity && map.cities.includes(selectedCity)) {
      renderer.pushSprite(selectedCity.x, selectedCity.y, S.SEL, 1, 1, 1, 0.9);
      for (const [hx, hy] of selectedCity.houses) {
        if (hx === selectedCity.x && hy === selectedCity.y) continue;
        renderer.pushSprite(hx, hy, S.CITYRING, 1, 0.9, 0.4, 0.4);
      }
    }

    // vybraná budova: zvýraznění + dosah rozvodny
    if (selected && sim.buildings.includes(selected)) {
      renderer.pushSprite(selected.x, selected.y, S.SEL, 1, 1, 1, 0.9);
      // víceplošná stavba: obtáhnout obvod areálu
      if (EG.sizeOf(selected.kind) > 1) {
        const f = EG.footprintOf(selected.kind, selected.x, selected.y);
        for (let tx = f.x0; tx <= f.x1; tx++) {
          renderer.pushSprite(tx, f.y0, S.CITYRING, 1, 0.9, 0.4, 0.7);
          renderer.pushSprite(tx, f.y1, S.CITYRING, 1, 0.9, 0.4, 0.7);
        }
        for (let ty = f.y0 + 1; ty < f.y1; ty++) {
          renderer.pushSprite(f.x0, ty, S.CITYRING, 1, 0.9, 0.4, 0.7);
          renderer.pushSprite(f.x1, ty, S.CITYRING, 1, 0.9, 0.4, 0.7);
        }
      }
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

    // vrstva dosahů: kruhy všech rozvoden
    if (mapLayer === 1) {
      for (const b of sim.buildings) {
        if (b.kind !== 'sub') continue;
        const R = sim.subRange(b);
        for (let k = 0; k < 20; k++) {
          const a2 = k / 20 * Math.PI * 2;
          renderer.pushSprite(b.x + Math.cos(a2) * R, b.y + Math.sin(a2) * R, S.CITYRING, 1, 1, 1, 0.35);
        }
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
      if (tool === 'demolish') ok = !!sim.buildingAt(gx, gy) || !!lineNear(hoverF[0], hoverF[1]);
      else if (tool === 'line') ok = !!sim.buildingAt(gx, gy);
      else ok = sim.canPlace(tool, gx, gy).ok;
      // víceplošná stavba: ukázat celou plochu a označit vadné dlaždice
      const size = EG.BUILD[tool] ? EG.sizeOf(tool) : 1;
      if (size > 1) {
        const f = EG.footprintOf(tool, gx, gy);
        for (let ty = f.y0; ty <= f.y1; ty++) for (let tx = f.x0; tx <= f.x1; tx++) {
          const tileOk = sim._canPlaceTile(tool, tx, ty).ok;
          renderer.pushSprite(tx, ty, tileOk ? S.SEL : S.BAD, 1, 1, 1, tileOk ? 0.5 : 0.8);
        }
      } else {
        renderer.pushSprite(gx, gy, ok ? S.SEL : S.BAD);
      }
      if (ok && tool !== 'demolish' && tool !== 'line') {
        renderer.pushSprite(gx, gy, kindSprite(tool), 1, 1, 1, 0.55);
      }
    }

    // zóny aktivních událostí (bouřka, námraza): prstenec + blikající střed
    for (const e of (sim.events || [])) {
      if (e.until === undefined || sim.time < e.start || sim.time >= e.until) continue;
      if (e.type !== 'storm' && e.type !== 'ice') continue;
      const tint = e.type === 'storm' ? [0.55, 0.45, 1] : [0.6, 0.85, 1];
      for (let k = 0; k < 16; k++) {
        const a = k / 16 * Math.PI * 2;
        renderer.pushSprite(e.x + Math.cos(a) * e.r, e.y + Math.sin(a) * e.r, S.CITYRING,
          tint[0], tint[1], tint[2], 0.5);
      }
      const bl = (Math.sin(performance.now() * 0.01) + 1) / 2;
      renderer.pushSprite(e.x, e.y, S.BAD, tint[0], tint[1], tint[2], 0.3 + 0.4 * bl);
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
      // elektrárna bez paliva bliká oranžově
      if (EG.fuelDefOf(b) && b.fuel <= 0 && !b.mothball) {
        renderer.pushSprite(b.x, b.y, S.BAD, 1, 0.75, 0.1, 0.25 + 0.45 * blink);
      }
    }
    for (const ind of map.industries || []) {
      if ((ind.powered || 0) < 0.9) {
        renderer.pushSprite(ind.x, ind.y, S.BAD, 1, 1, 1, 0.2 + 0.45 * blink);
      }
    }

    pushNightLights(night);
  }

  /* ---------- smyčka ---------- */
  let lastT = 0;
  function loop(t) {
    const dt = Math.min(0.1, (t - lastT) / 1000 || 0.016);
    lastT = t;
    if (dt > 0) fps += (1 / dt - fps) * 0.08;
    if (replaying) stepReplay(dt);
    else if (speed > 0 && !sim.gameOver) sim.tick(dt * speed);
    // vzorky pro grafy (1× za herní sekundu)
    if (sim.time - lastSample >= 1) {
      lastSample = sim.time;
      const st = sim.stats || {};
      history.push({ p: st.produced || 0, d: st.delivered || 0, l: st.losses || 0, s: sim.spotK || 1 });
      if (history.length > 240) history.shift();
      checkAchievements();
      checkScenario();
      if (!$('#objlist').hidden) refreshObjList();
    }
    pushScene();
    renderer.render(t / 1000);
    drawMinimap();
    updateHUD();
    updateToolPrices();
    updateBuildCost();
    if (chartOn) drawChart();
    if (selected || selectedLine || selectedCity) updatePanel();
    requestAnimationFrame(loop);
  }

  window.addEventListener('DOMContentLoaded', init);
})();
