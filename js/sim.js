/* Herní simulace: elektrárny, vedení, rozvodny, města, toky energie.
   Toky v síti se počítají zjednodušeným DC power-flow modelem:
   uzlová injekce P (výroba − spotřeba), Laplacián sítě, iterační
   Gauss–Seidel řešení fázových úhlů, tok hranou = rozdíl úhlů. */
(function () {
  'use strict';
  const EG = window.EG;
  const T = () => EG.T;

  const BUILD = {
    hydro: {
      name: 'Vodní elektrárna', cost: 220, upkeep: 2,
      desc: 'Jen na řece. Výkon dle průtoku. Přehrada nad ní průtok posílí.',
      hotkey: '1',
    },
    dam: {
      name: 'Přehrada', cost: 520, upkeep: 4,
      desc: 'Jen na řece. Vytvoří nádrž, velký stabilní výkon a posílí průtok níže.',
      hotkey: '2',
    },
    coal: {
      name: 'Uhelná elektrárna', cost: 380, upkeep: 14,
      desc: 'Kdekoli na pevnině. Stabilních 90 MW, ale drahý provoz.',
      hotkey: '3',
    },
    solar: {
      name: 'Solární park', cost: 160, upkeep: 1,
      desc: 'Na trávě. Až 35 MW, jen ve dne.',
      hotkey: '4',
    },
    wind: {
      name: 'Větrná turbína', cost: 130, upkeep: 1,
      desc: 'Na kopcích nejvíc. Až 30 MW, kolísá s větrem.',
      hotkey: '5',
    },
    sub: {
      name: 'Rozvodna', cost: 90, upkeep: 1,
      desc: 'Napájí města do vzdálenosti 6 dlaždic. Bez ní města nesvítí.',
      hotkey: '6',
    },
    psh: {
      name: 'Přečerpávací elektrárna', cost: 650, upkeep: 5,
      desc: 'Na kopci u vody. Zásobník 300 MWs: čerpá přebytky, turbínuje při deficitu (účinnost 75 %). Připojení 110 kV.',
      hotkey: '8',
    },
    battery: {
      name: 'Zásobník energie', cost: 260, upkeep: 1.5,
      desc: 'Bateriové úložiště 80 MWs: nabíjí se z přebytků, vybíjí při deficitu (účinnost 90 %). Připojení 22 kV.',
      hotkey: '9',
    },
    xborder: {
      name: 'Přeshraniční bod', cost: 0, upkeep: 0, hidden: true,
      desc: 'Napojení na sousední soustavu (400 kV). Klikni a sjednej smlouvy na nákup/prodej energie.',
    },
    line: {
      name: 'Vedení', cost: 0, upkeep: 0,
      desc: 'Spojuje stavby. Vyber napěťovou úroveň – liší se kapacitou, cenou i max. délkou.',
      hotkey: '7',
    },
  };

  /* Napěťové úrovně vedení: VVN (800/400/220/110 kV), VN (22/11 kV), NN (400 V).
     Vyšší napětí = větší kapacita, delší trasy a menší ztráty, ale dražší dlaždice.
     `loss` je podíl ztrát na dlaždici délky při plném zatížení; skutečná ztráta
     roste kvadraticky s tokem (I²R): P_ztr = |P|·(|P|/cap)·loss·délka. */
  const LEVELS = [800, 400, 220, 110, 22, 11, 0.4];
  const LINE_TYPES = {
    800: { name: 'VVN 800 kV', cls: 'VVN', cap: 800, cost: 34, maxLen: 60, loss: 0.0016 },
    400: { name: 'VVN 400 kV', cls: 'VVN', cap: 400, cost: 20, maxLen: 48, loss: 0.0020 },
    220: { name: 'VVN 220 kV', cls: 'VVN', cap: 200, cost: 11, maxLen: 36, loss: 0.0026 },
    110: { name: 'VVN 110 kV', cls: 'VVN', cap: 80,  cost: 6,  maxLen: 28, loss: 0.0034 },
    22:  { name: 'VN 22 kV',   cls: 'VN',  cap: 30,  cost: 3,  maxLen: 14, loss: 0.0060 },
    11:  { name: 'VN 11 kV',   cls: 'VN',  cap: 14,  cost: 2,  maxLen: 10, loss: 0.0080 },
    0.4: { name: 'NN 400 V',   cls: 'NN',  cap: 5,   cost: 1,  maxLen: 5,  loss: 0.0120 },
  };

  /* výstupní napětí elektráren – vedení k nim musí mít stejnou úroveň */
  const GEN_LEVEL = { dam: 400, coal: 220, hydro: 110, solar: 22, wind: 22, psh: 110, battery: 22, xborder: 400 };

  /* Přeshraniční obchod: smlouvy v obou směrech, krok 10 MW, strop 120 MW.
     Import je „take-or-pay" – platíš sjednaný výkon, i když ho nevyužiješ.
     Nedodaný export se sankcionuje. */
  const XTRADE = {
    step: 10, max: 120,
    importPrice: 0.075,  // platíš za sjednanou MW·s importu
    exportPrice: 0.050,  // dostáváš za skutečně dodanou MW·s exportu
    penalty: 0.12,       // sankce za nedodanou MW·s sjednaného exportu
  };

  /* Zásobníky energie: kapacita (MW·s), max. výkon a round-trip účinnost.
     Nabíjí se automaticky z přebytků své sítě, vybíjí při deficitu. */
  const STORAGE = {
    psh: { cap: 300, maxP: 70, eff: 0.75 },
    battery: { cap: 80, maxP: 25, eff: 0.90 },
  };

  /* regulační trafo (přepínač odboček): násobí „vodivost" trafa v power flow */
  const TRAFO_REG = { auto: 1, boost: 3, limit: 0.25 };

  /* Trafa do rozvoden: převádí mezi dvěma úrovněmi, mají kapacitu a cenu.
     Rozvodna bez příslušného trafa danou úroveň vůbec nepřipojí.
     Města se napájí z NN (400 V) strany – tu má každá rozvodna. */
  const TRAFOS = {
    t800_400: { hi: 800, lo: 400, cap: 600, cost: 700, name: '800/400 kV' },
    t400_220: { hi: 400, lo: 220, cap: 350, cost: 420, name: '400/220 kV' },
    t400_110: { hi: 400, lo: 110, cap: 250, cost: 380, name: '400/110 kV' },
    t220_110: { hi: 220, lo: 110, cap: 180, cost: 260, name: '220/110 kV' },
    t110_22:  { hi: 110, lo: 22,  cap: 60,  cost: 120, name: '110/22 kV' },
    t22_11:   { hi: 22,  lo: 11,  cap: 25,  cost: 45,  name: '22/11 kV' },
    t22_04:   { hi: 22,  lo: 0.4, cap: 30,  cost: 60,  name: '22/0,4 kV (distribuční)' },
    t11_04:   { hi: 11,  lo: 0.4, cap: 12,  cost: 30,  name: '11/0,4 kV (distribuční)' },
  };

  /* Palivo klasických elektráren: sklad, spotřeba na vyrobenou MW·s a cena.
     Bez paliva elektrárna stojí – nakupuje se v panelu (nebo smlouvou). */
  const FUEL = {
    coal: { name: 'uhlí', unit: 't', cap: 240, perMW: 0.0045, price: 4 },
  };

  const SUB_RANGE = 6;        // dosah rozvodny k městu (NN distribuce)
  const PRICE_PER_MWH = 0.055; // příjem za dodanou MW za sekundu hry

  const MAX_LEVEL = 3;        // max. úroveň modernizace
  const MAX_RANGE_LEVEL = 2;  // max. rozšíření dosahu rozvodny (+2 dlaždice / úroveň)
  /* rychlost opotřebení – ztráta stavu za herní sekundu při plném vytížení */
  const WEAR = { hydro: 0.0011, dam: 0.0006, coal: 0.0018, solar: 0.0008, wind: 0.0014, sub: 0.0007, psh: 0.0008, battery: 0.0012 };

  const SEASONS = ['jaro', 'léto', 'podzim', 'zima'];
  const YEAR_DAYS = 12;       // herních dní v roce (3 na sezónu)

  function Sim(map) {
    this.map = map;
    this.buildings = [];      // {id,kind,x,y,out,node}
    this.lines = [];          // {a,b,id,flow,load}
    this.money = 900;
    this.time = 0;            // herní sekundy
    this.dayLen = 120;        // délka dne
    this.score = 0;
    this.nextId = 1;
    this.blackouts = 0;
    this.messages = [];
    this.stats = { produced: 0, delivered: 0, demand: 0 };
    this._noiseT = Math.random() * 1000;

    // přeshraniční předávací body jako pevné (nezbouratelné) uzly sítě
    for (const cr of map.crossings || []) {
      this.buildings.push({
        id: this.nextId++, kind: 'xborder', x: cr.x, y: cr.y,
        name: cr.name, out: 0, gen: 0,
        level: 1, cond: 1, broken: false, contract: false, rangeLevel: 0,
        xImport: 0, xExport: 0,  // sjednané smlouvy v MW
        xServed: 0,              // skutečně dodaný export
      });
    }
  }

  Sim.prototype.msg = function (text, kind) {
    this.messages.push({ text, kind: kind || 'info', t: this.time });
    if (this.messages.length > 60) this.messages.shift();
  };

  Sim.prototype.buildingAt = function (x, y) {
    return this.buildings.find((b) => b.x === x && b.y === y) || null;
  };

  Sim.prototype.canPlace = function (kind, x, y) {
    const m = this.map;
    if (x < 0 || y < 0 || x >= m.size || y >= m.size) return { ok: false, why: 'Mimo mapu' };
    const t = m.type[m.idx(x, y)];
    if (this.buildingAt(x, y)) return { ok: false, why: 'Obsazeno' };
    for (const c of m.cities) {
      if (Math.abs(c.x - x) <= 1 && Math.abs(c.y - y) <= 1) return { ok: false, why: 'Centrum města' };
      if (c.houses.some(([hx, hy]) => hx === x && hy === y)) return { ok: false, why: 'Zástavba' };
    }
    for (const ind of m.industries || []) {
      if (ind.x === x && ind.y === y) return { ok: false, why: 'Průmyslový areál' };
    }
    const TT = T();
    switch (kind) {
      case 'hydro':
      case 'dam':
        if (t !== TT.RIVER) return { ok: false, why: 'Jen na řece' };
        return { ok: true };
      case 'coal':
        if (t === TT.WATER || t === TT.RIVER || t === TT.MOUNTAIN) return { ok: false, why: 'Jen na pevnině' };
        return { ok: true };
      case 'solar':
        if (t !== TT.GRASS && t !== TT.SAND) return { ok: false, why: 'Jen na rovině' };
        return { ok: true };
      case 'wind':
        if (t === TT.WATER || t === TT.RIVER) return { ok: false, why: 'Ne na vodě' };
        return { ok: true };
      case 'sub':
      case 'battery':
        if (t === TT.WATER || t === TT.RIVER || t === TT.MOUNTAIN) return { ok: false, why: 'Jen na pevnině' };
        return { ok: true };
      case 'psh': {
        if (t !== TT.HILL) return { ok: false, why: 'Jen na kopci' };
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= m.size || ny >= m.size) continue;
          const nt = m.type[m.idx(nx, ny)];
          if (nt === TT.WATER || nt === TT.RIVER || nt === 7) return { ok: true };
        }
        return { ok: false, why: 'Kopec musí být do 3 dlaždic od vody' };
      }
    }
    return { ok: false, why: '?' };
  };

  Sim.prototype.place = function (kind, x, y) {
    const chk = this.canPlace(kind, x, y);
    if (!chk.ok) { this.msg(chk.why, 'warn'); return null; }
    const cost = BUILD[kind].cost;
    if (this.money < cost) { this.msg('Nedostatek peněz', 'warn'); return null; }
    this.money -= cost;
    const b = {
      id: this.nextId++, kind, x, y, out: 0, gen: 0,
      level: 1,          // úroveň modernizace (násobí výkon)
      rangeLevel: 0,     // jen rozvodna: rozšíření dosahu
      cond: 1,           // technický stav 0..1
      broken: false,     // porucha – mimo provoz do servisu
      contract: false,   // servisní smlouva (automatická údržba za přirážku)
    };
    if (kind === 'sub') {
      b.trafos = {};     // klíč z TRAFOS -> počet kusů
      b.trafoLoad = {};  // klíč -> aktuální zatížení 0..1+
      b.trafoFlow = {};  // klíč -> tok v MW (kladný = z vyšší na nižší hladinu)
      b.trafoReg = {};   // klíč -> 'auto' | 'boost' | 'limit' (jen s koupenou regulací)
    }
    if (STORAGE[kind]) {
      b.charge = 0;      // uložená energie (MW·s)
      b.storMode = 'klid';
    }
    if (FUEL[kind]) {
      b.fuel = FUEL[kind].cap * 0.5; // startovní zásoba na rozjezd
      b.fuelContract = false;        // automatické dodávky za přirážku
    }
    this.buildings.push(b);
    if (kind === 'dam') this._applyDam(b);
    this.msg(BUILD[kind].name + ' postavena (−' + cost + ')');
    return b;
  };

  /* Přehrada: zaplaví pár dlaždic řeky proti proudu (nádrž)
     a zvýší průtok po proudu. */
  Sim.prototype._applyDam = function (b) {
    const m = this.map;
    const TT = T();
    // po proudu +60 % průtoku
    let x = b.x, y = b.y;
    for (let i = 0; i < m.size; i++) {
      const j = m.idx(x, y);
      const d = m.flowDir[j];
      if (i > 0) m.flow[j] *= 1.6;
      if (d < 0) break;
      x += EG.DIRS[d][0]; y += EG.DIRS[d][1];
      if (x < 0 || y < 0 || x >= m.size || y >= m.size) break;
      if (m.type[m.idx(x, y)] !== TT.RIVER) break;
    }
    // proti proudu vytvoř nádrž (RESERVOIR = 7)
    const visited = new Set([m.idx(b.x, b.y)]);
    let frontier = [[b.x, b.y]];
    let flooded = 0;
    while (frontier.length && flooded < 14) {
      const next = [];
      for (const [fx, fy] of frontier) {
        for (const [dx, dy] of EG.DIRS) {
          const nx = fx + dx, ny = fy + dy;
          if (nx < 0 || ny < 0 || nx >= m.size || ny >= m.size) continue;
          const j = m.idx(nx, ny);
          if (visited.has(j)) continue;
          // je to řeka tekoucí SEM? (její flowDir ukazuje na [fx,fy])
          const d = m.flowDir[j];
          if (m.type[j] === TT.RIVER && d >= 0 &&
              nx + EG.DIRS[d][0] === fx && ny + EG.DIRS[d][1] === fy) {
            visited.add(j);
            m.type[j] = 7; // RESERVOIR
            flooded++;
            next.push([nx, ny]);
          }
        }
      }
      frontier = next;
    }
    b.reservoir = flooded;
    if (EG.onTerrainChanged) EG.onTerrainChanged();
  };

  Sim.prototype.demolish = function (x, y) {
    const b = this.buildingAt(x, y);
    if (!b) {
      // smazat vedení procházející bodem? – mažeme vedení klikem na koncový uzel
      return false;
    }
    if (b.kind === 'dam') { this.msg('Přehradu nelze zbourat (nádrž je napuštěná)', 'warn'); return false; }
    if (b.kind === 'xborder') { this.msg('Předávací bod sousední soustavy zbourat nejde', 'warn'); return false; }
    this.buildings = this.buildings.filter((o) => o !== b);
    this.lines = this.lines.filter((l) => l.a !== b.id && l.b !== b.id);
    let refund = BUILD[b.kind].cost;
    for (const [key, count] of Object.entries(b.trafos || {})) refund += TRAFOS[key].cost * count;
    refund = Math.floor(refund * 0.4);
    this.money += refund;
    this.msg(BUILD[b.kind].name + ' zbourána (+' + refund + ')');
    return true;
  };

  /* ---------- napěťové úrovně a trafa ---------- */

  /* úrovně, na které se dá u stavby připojit vedení */
  Sim.prototype.levelsOf = function (b) {
    if (b.kind !== 'sub') return [GEN_LEVEL[b.kind]];
    const set = new Set([0.4]); // NN přípojnici má každá rozvodna
    for (const key of Object.keys(b.trafos || {})) {
      if (b.trafos[key] > 0) { set.add(TRAFOS[key].hi); set.add(TRAFOS[key].lo); }
    }
    return LEVELS.filter((lv) => set.has(lv));
  };

  Sim.prototype.supportsLevel = function (b, lv) {
    return this.levelsOf(b).includes(lv);
  };

  Sim.prototype.buyTrafo = function (b, key) {
    if (b.kind !== 'sub') { this.msg('Trafo lze koupit jen do rozvodny', 'warn'); return false; }
    const t = TRAFOS[key];
    if (!t) return false;
    if (this.money < t.cost) { this.msg('Nedostatek peněz na trafo', 'warn'); return false; }
    this.money -= t.cost;
    b.trafos[key] = (b.trafos[key] || 0) + 1;
    this.msg('Trafo ' + t.name + ' instalováno (−' + t.cost + ')');
    return true;
  };

  /* regulační trafo: přepínač odboček – umožní tok trafem posílit či škrtit */
  Sim.prototype.trafoRegCost = function (key) {
    return Math.ceil(TRAFOS[key].cost * 0.5);
  };

  Sim.prototype.buyTrafoReg = function (b, key) {
    if (b.kind !== 'sub' || !(b.trafos || {})[key]) { this.msg('Nejdřív kup samotné trafo', 'warn'); return false; }
    if (b.trafoReg[key]) { this.msg('Regulace už je instalovaná', 'warn'); return false; }
    const cost = this.trafoRegCost(key);
    if (this.money < cost) { this.msg('Nedostatek peněz na regulaci', 'warn'); return false; }
    this.money -= cost;
    b.trafoReg[key] = 'auto';
    this.msg('Regulační trafo ' + TRAFOS[key].name + ': přepínač odboček instalován (−' + cost + ')');
    return true;
  };

  Sim.prototype.setTrafoReg = function (b, key, mode) {
    if (!(b.trafoReg || {})[key] || !TRAFO_REG[mode]) return false;
    b.trafoReg[key] = mode;
    const label = { auto: 'automatika', boost: 'přednostní tok', limit: 'škrcení toku' }[mode];
    this.msg('Trafo ' + TRAFOS[key].name + ': ' + label);
    return true;
  };

  /* level = napěťová úroveň (klíč LINE_TYPES); bez udání se vybere
     nejvyšší úroveň, kterou podporují obě stavby */
  Sim.prototype.connect = function (b1, b2, level) {
    if (b1 === b2) return null;
    if (level === undefined) {
      level = LEVELS.find((lv) => this.supportsLevel(b1, lv) && this.supportsLevel(b2, lv));
      if (level === undefined) { this.msg('Stavby nemají společnou napěťovou úroveň (chybí trafo?)', 'warn'); return null; }
    }
    const LT = LINE_TYPES[level];
    if (!LT) return null;
    for (const b of [b1, b2]) {
      if (!this.supportsLevel(b, level)) {
        this.msg(BUILD[b.kind].name + ' nemá přípojnici ' + LT.name +
          (b.kind === 'sub' ? ' – kup příslušné trafo' : ' (vyrábí na ' + LINE_TYPES[GEN_LEVEL[b.kind]].name + ')'), 'warn');
        return null;
      }
    }
    if (this.lines.some((l) => l.level === level &&
        ((l.a === b1.id && l.b === b2.id) || (l.a === b2.id && l.b === b1.id)))) {
      this.msg('Už propojeno (' + LT.name + ')', 'warn'); return null;
    }
    const dist = Math.hypot(b1.x - b2.x, b1.y - b2.y);
    if (dist > LT.maxLen) { this.msg(LT.name + ': příliš daleko (max ' + LT.maxLen + ' dlaždic)', 'warn'); return null; }
    const cost = Math.ceil(dist * LT.cost);
    if (this.money < cost) { this.msg('Nedostatek peněz', 'warn'); return null; }
    this.money -= cost;
    const l = { id: this.nextId++, a: b1.id, b: b2.id, level, cap: LT.cap, flow: 0, load: 0, len: dist };
    this.lines.push(l);
    this.msg(LT.name + ' nataženo (−' + cost + ')');
    return l;
  };

  Sim.prototype.removeLine = function (line) {
    this.lines = this.lines.filter((l) => l !== line);
    this.msg('Vedení odstraněno');
  };

  /* ---------- správa budov (servis, smlouva, vylepšení) ---------- */

  Sim.prototype.subRange = function (b) {
    return SUB_RANGE + 2 * (b.rangeLevel || 0);
  };

  /* efektivita dle technického stavu – zanedbaná budova ztrácí výkon */
  Sim.prototype.condFactor = function (b) {
    if (b.broken) return 0;
    return 0.35 + 0.65 * Math.min(1, Math.max(0, b.cond));
  };

  Sim.prototype.serviceCost = function (b) {
    return Math.ceil(8 + BUILD[b.kind].cost * 0.3 * (1 - b.cond) + (b.broken ? BUILD[b.kind].cost * 0.15 : 0));
  };

  Sim.prototype.service = function (b, auto) {
    const base = this.serviceCost(b);
    const cost = auto ? Math.ceil(base * 1.2) : base; // smlouva má přirážku 20 %
    if (this.money < cost) { if (!auto) this.msg('Nedostatek peněz na servis', 'warn'); return false; }
    this.money -= cost;
    b.cond = 1;
    b.broken = false;
    this.msg((auto ? 'Smluvní servis: ' : 'Servis: ') + BUILD[b.kind].name + ' (−' + cost + ')');
    return true;
  };

  Sim.prototype.setContract = function (b, on) {
    b.contract = !!on;
    this.msg('Servisní smlouva ' + (b.contract ? 'uzavřena' : 'vypovězena') + ' – ' + BUILD[b.kind].name);
  };

  Sim.prototype.upgradeCost = function (b) {
    if (b.level >= MAX_LEVEL) return null;
    return Math.ceil(BUILD[b.kind].cost * 0.6 * b.level);
  };

  /* modernizace: +25 % výkonu za úroveň (u rozvodny +25 % kapacity připojených vedení) */
  Sim.prototype.upgrade = function (b) {
    const cost = this.upgradeCost(b);
    if (cost === null) { this.msg('Už na maximální úrovni', 'warn'); return false; }
    if (this.money < cost) { this.msg('Nedostatek peněz na modernizaci', 'warn'); return false; }
    this.money -= cost;
    b.level++;
    this.msg(BUILD[b.kind].name + ' modernizována na úroveň ' + b.level + ' (−' + cost + ')');
    return true;
  };

  /* nákup paliva: doplní sklad (nebo kolik peníze dovolí) */
  Sim.prototype.fuelCost = function (b, auto) {
    const fd = FUEL[b.kind];
    if (!fd) return null;
    const missing = fd.cap - b.fuel;
    if (missing < 1) return 0;
    return Math.ceil(missing * fd.price * (auto ? 1.15 : 1));
  };

  Sim.prototype.buyFuel = function (b, auto) {
    const fd = FUEL[b.kind];
    if (!fd) { this.msg('Tahle stavba palivo nepotřebuje', 'warn'); return false; }
    const unitPrice = fd.price * (auto ? 1.15 : 1);
    const missing = fd.cap - b.fuel;
    if (missing < 1) { if (!auto) this.msg('Sklad paliva je plný', 'warn'); return false; }
    const affordable = Math.min(missing, Math.floor(this.money / unitPrice));
    if (affordable < 1) { if (!auto) this.msg('Nedostatek peněz na palivo', 'warn'); return false; }
    const cost = Math.ceil(affordable * unitPrice);
    this.money -= cost;
    b.fuel += affordable;
    this.msg((auto ? 'Smluvní dodávka: ' : 'Nákup paliva: ') + Math.round(affordable) + ' ' + fd.unit +
      ' ' + fd.name + ' (−' + cost + ')' + (affordable < missing ? ' – jen na co byly peníze' : ''));
    return true;
  };

  Sim.prototype.setFuelContract = function (b, on) {
    if (!FUEL[b.kind]) return;
    b.fuelContract = !!on;
    this.msg('Smlouva na dodávky paliva ' + (b.fuelContract ? 'uzavřena' : 'vypovězena') +
      ' – ' + BUILD[b.kind].name);
  };

  /* sjednání přeshraniční smlouvy: dir = 'import' | 'export', delta v MW */
  Sim.prototype.adjustXContract = function (b, dir, delta) {
    if (b.kind !== 'xborder') return false;
    const field = dir === 'import' ? 'xImport' : 'xExport';
    const next = Math.max(0, Math.min(XTRADE.max, b[field] + delta));
    if (next === b[field]) return false;
    b[field] = next;
    this.msg(b.name + ': smlouva na ' + (dir === 'import' ? 'nákup (import)' : 'prodej (export)') +
      ' ' + next + ' MW');
    return true;
  };

  Sim.prototype.rangeUpgradeCost = function (b) {
    if (b.kind !== 'sub' || b.rangeLevel >= MAX_RANGE_LEVEL) return null;
    return 80 * (b.rangeLevel + 1);
  };

  Sim.prototype.upgradeRange = function (b) {
    const cost = this.rangeUpgradeCost(b);
    if (cost === null) { this.msg('Dosah už nelze zvětšit', 'warn'); return false; }
    if (this.money < cost) { this.msg('Nedostatek peněz na transformátor', 'warn'); return false; }
    this.money -= cost;
    b.rangeLevel++;
    this.msg('Rozvodna: silnější transformátor, dosah ' + this.subRange(b) + ' dlaždic (−' + cost + ')');
    return true;
  };

  /* okamžitý výkon elektrárny (bez vlivu stavu a modernizace) */
  Sim.prototype._baseGenOf = function (b, sun, wind) {
    const m = this.map;
    const fx = this.seasonFx || { hydro: 1, solar: 1 };
    switch (b.kind) {
      case 'hydro': {
        const f = m.flow[m.idx(b.x, b.y)] * fx.hydro;
        return Math.min(80, 6 + f * 6);
      }
      case 'dam': {
        const f = m.flow[m.idx(b.x, b.y)] * fx.hydro;
        return Math.min(150, 30 + f * 7 + (b.reservoir || 0) * 3);
      }
      case 'coal': return (b.fuel === undefined || b.fuel > 0) ? 90 : 0; // bez uhlí stojí
      case 'xborder': return b.xImport || 0; // sjednaný import = dostupný zdroj
      case 'solar': return 35 * sun * fx.solar;
      case 'wind': {
        const TT = T();
        const t = m.type[m.idx(b.x, b.y)];
        const bonus = (t === TT.HILL || t === TT.MOUNTAIN) ? 1.35 : 1;
        return Math.max(0, 30 * wind * bonus);
      }
      default: return 0;
    }
  };

  /* skutečný výkon: základ × modernizace × technický stav */
  Sim.prototype._genOf = function (b, sun, wind) {
    return this._baseGenOf(b, sun, wind) * (1 + 0.25 * (b.level - 1)) * this.condFactor(b);
  };

  /* Poptávka města v MW – každé město má vlastní potřebu: roste s populací,
     spotřeba na obyvatele a denní profil se liší podle charakteru města. */
  Sim.prototype._cityDemand = function (c, dayPhase) {
    // sezónní zátěž: v zimě topení a osvětlení, v létě útlum
    const base = c.pop * (c.needPerCap || 1.15) * ((this.seasonFx || {}).demand || 1);
    const h = (6 + dayPhase * 24) % 24;
    let curve;
    if (c.kind === 'ind') {
      // průmysl: směnný provoz, přes den naplno, v noci útlum
      curve = (h >= 6 && h < 22) ? 1 : 0.7;
    } else if (c.kind === 'res') {
      // obytné: ranní a večerní špička, v noci minimum
      const morning = Math.exp(-Math.pow(h - 7.5, 2) / 4.5);
      const evening = Math.exp(-Math.pow(h - 19.5, 2) / 6);
      curve = 0.45 + 0.55 * Math.max(morning, evening);
    } else {
      // smíšené: pozvolný denní oblouk
      curve = 0.6 + 0.4 * Math.max(0, Math.sin((dayPhase - 0.2) * Math.PI * 2) * 0.5 + 0.5);
    }
    return base * curve;
  };

  /* Poptávka podniku v MW – huť a chemička jedou nepřetržitě,
     důl a pila mají denní směny. */
  Sim.prototype._industryDemand = function (ind, dayPhase) {
    const h = (6 + dayPhase * 24) % 24;
    const shift = (ind.type === 'hut' || ind.type === 'chemicka')
      ? 0.85 + 0.15 * ((h >= 6 && h < 22) ? 1 : 0)
      : ((h >= 6 && h < 22) ? 1 : 0.3);
    // průmysl je na sezónu citlivý zhruba z poloviny oproti městům
    const season = 1 + 0.5 * (((this.seasonFx || {}).demand || 1) - 1);
    return ind.demand * shift * season;
  };

  /* --- pomalý růst měst: s populací přibývá zástavba na mapě --- */
  Sim.prototype._syncHouses = function (c) {
    if (c.housesBase === undefined) c.housesBase = c.houses.length;
    const target = Math.max(3, c.housesBase + Math.floor((c.pop - c.popBase) / 3));
    while (c.houses.length > target) c.houses.pop();
    let guard = 0;
    while (c.houses.length < target && guard++ < 50) {
      if (!this._addHouse(c)) break;
    }
  };

  Sim.prototype._addHouse = function (c) {
    const m = this.map;
    const TT = T();
    const occupied = new Set();
    for (const cc of m.cities) for (const [hx, hy] of cc.houses) occupied.add(hx + ',' + hy);
    let best = null, bestD = Infinity;
    for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) {
      const x = c.x + dx, y = c.y + dy;
      if (x < 1 || y < 1 || x >= m.size - 1 || y >= m.size - 1) continue;
      const t = m.type[m.idx(x, y)];
      if (t !== TT.GRASS && t !== TT.FOREST && t !== TT.SAND) continue;
      if (occupied.has(x + ',' + y)) continue;
      if (this.buildingAt(x, y)) continue;
      // nejblíž centru, s trochou šumu ať zástavba není čtvercová
      const d = Math.abs(dx) + Math.abs(dy) + EG.rng.hash2(x, y, m.seed + 5) * 1.5;
      if (d < bestD) { bestD = d; best = [x, y]; }
    }
    if (!best) return false;
    c.houses.push(best);
    return true;
  };

  /* hlavní tick simulace – dt v herních sekundách */
  Sim.prototype.tick = function (dt) {
    this.time += dt;
    const dayPhase = (this.time % this.dayLen) / this.dayLen; // 0..1, 0 = ráno (6:00)

    /* --- roční období: plynulé sezónní koeficienty (kosinus po roce) ---
       rok = 12 dní, jaro [0;0,25) … zima [0,75;1). V zimě vyšší spotřeba
       a krátké dny, v létě silné slunce, na jaře tání (průtoky), na podzim vítr. */
    const yearLen = this.dayLen * YEAR_DAYS;
    const yp = (this.time % yearLen) / yearLen;
    const cosAt = (center) => Math.cos(2 * Math.PI * (yp - center));
    this.yearPhase = yp;
    this.day = Math.floor(this.time / this.dayLen) + 1;
    this.seasonIdx = Math.floor(yp * 4) % 4;
    this.seasonName = SEASONS[this.seasonIdx];
    this.seasonFx = {
      demand: 1 + 0.20 * cosAt(0.875),   // zima 1,2× · léto 0,8×
      solar: 1 + 0.35 * cosAt(0.375),    // léto 1,35× · zima 0,65×
      wind: 1 + 0.18 * cosAt(0.625),     // podzim 1,18× · jaro 0,82×
      hydro: 1 + 0.30 * cosAt(0.125),    // jarní tání 1,3× · pozdní léto 0,7×
      daylight: 12 + 4.5 * cosAt(0.375), // délka dne v hodinách: léto 16,5 · zima 7,5
    };

    // slunce: půlvlna kolem 13:00, šířka podle sezónní délky dne
    const h = (6 + dayPhase * 24) % 24;
    const dh = Math.min(Math.abs(h - 13), 24 - Math.abs(h - 13));
    const sun = dh <= this.seasonFx.daylight / 2
      ? Math.cos(Math.PI * dh / this.seasonFx.daylight) : 0;
    const wind = Math.max(0, Math.min(1.6,
      (0.35 + 0.65 * EG.rng.fbm(this.time * 0.01 + this._noiseT, 3.7, 42, 3)) * this.seasonFx.wind));
    this.sun = sun; this.wind = wind; this.dayPhase = dayPhase;

    // --- sestavit přípojnice: bus = (stavba, napěťová úroveň) ---
    // Elektrárna má jednu přípojnici (výstupní napětí). Rozvodna má NN
    // a úrovně svých traf; trafa jsou hrany mezi přípojnicemi téže rozvodny.
    const nodes = this.buildings;
    const id2i = new Map();
    nodes.forEach((b, i) => id2i.set(b.id, i));
    const n = nodes.length;
    const wantGen = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      wantGen[i] = this._genOf(nodes[i], sun, wind);
      nodes[i].gen = wantGen[i];
    }

    const buses = [];        // {bi: index stavby, lv: úroveň}
    const busOf = new Map(); // "bi:lv" -> index busu
    for (let i = 0; i < n; i++) {
      const b = nodes[i];
      if (b.kind === 'sub' && b.broken) continue; // porouchaná rozvodna je celá odpojená
      for (const lv of this.levelsOf(b)) {
        busOf.set(i + ':' + lv, buses.length);
        buses.push({ bi: i, lv });
      }
    }
    const nb = buses.length;

    // hrany: vedení (na své úrovni) + trafa (mezi úrovněmi rozvodny)
    const edges = [];
    for (const l of this.lines) {
      const ai = id2i.get(l.a), bi = id2i.get(l.b);
      const a = ai === undefined ? undefined : busOf.get(ai + ':' + l.level);
      const b = bi === undefined ? undefined : busOf.get(bi + ':' + l.level);
      l.flow = 0; l.load = 0; l.loss = 0;
      if (a === undefined || b === undefined) continue;
      edges.push({ a, b, w: 1 / Math.max(1, l.len * 0.25), line: l }); // delší vedení = větší „odpor"
    }
    for (let i = 0; i < n; i++) {
      const b = nodes[i];
      if (b.kind !== 'sub') continue;
      b.trafoLoad = {};
      b.trafoFlow = {};
      if (b.broken) continue;
      for (const [key, count] of Object.entries(b.trafos)) {
        if (!count) continue;
        const t = TRAFOS[key];
        const a = busOf.get(i + ':' + t.hi), bb = busOf.get(i + ':' + t.lo);
        const regW = TRAFO_REG[(b.trafoReg || {})[key]] || 1; // regulace mění vodivost
        edges.push({ a, b: bb, w: 2 * regW, trafo: { sub: b, key, cap: t.cap * count } });
      }
    }

    // města -> nejbližší funkční rozvodna v dosahu (NN distribuce)
    const subs = nodes.map((b, i) => (b.kind === 'sub' && !b.broken ? i : -1)).filter((i) => i >= 0);
    const cityAssign = [];
    let totalDemand = 0;
    for (const c of this.map.cities) {
      const d = this._cityDemand(c, dayPhase);
      totalDemand += d;
      let best = -1, bestD = Infinity;
      for (const si of subs) {
        const b = nodes[si];
        const dist = Math.hypot(b.x - c.x, b.y - c.y);
        if (dist <= this.subRange(b) && dist < bestD) { bestD = dist; best = si; }
      }
      cityAssign.push({ city: c, sub: best, demand: d, served: 0 });
    }

    // průmysl -> nejbližší rozvodna s VN přípojnicí (22 nebo 11 kV) v dosahu
    const indAssign = [];
    for (const ind of this.map.industries || []) {
      const d = this._industryDemand(ind, dayPhase);
      totalDemand += d;
      let best = -1, bestD = Infinity, bestBus = -1, bestLv = 0;
      for (const si of subs) {
        const b = nodes[si];
        const dist = Math.hypot(b.x - ind.x, b.y - ind.y);
        if (dist > this.subRange(b) || dist >= bestD) continue;
        const bus22 = busOf.get(si + ':22'), bus11 = busOf.get(si + ':11');
        const bus = bus22 !== undefined ? bus22 : bus11;
        if (bus === undefined) continue; // rozvodna bez VN trafa průmysl nenapojí
        bestD = dist; best = si; bestBus = bus; bestLv = bus22 !== undefined ? 22 : 11;
      }
      indAssign.push({ ind, sub: best, bus: bestBus, level: bestLv, demand: d, served: 0 });
    }

    // sjednaný export do zahraničí = odběr na 400kV busu předávacího bodu
    const xAssign = [];
    for (let i = 0; i < n; i++) {
      const b = nodes[i];
      if (b.kind !== 'xborder') continue;
      b.xServed = 0;
      if (!(b.xExport > 0)) continue;
      const bus = busOf.get(i + ':400');
      totalDemand += b.xExport;
      xAssign.push({ b, bi: i, bus: bus === undefined ? -1 : bus, demand: b.xExport, served: 0 });
    }

    // --- komponenty souvislosti přes hrany (vedení + trafa) ---
    const adj = Array.from({ length: nb }, () => []);
    for (const e of edges) {
      adj[e.a].push({ to: e.b, e });
      adj[e.b].push({ to: e.a, e });
    }
    const comp = new Int32Array(nb).fill(-1);
    let nc = 0;
    for (let i = 0; i < nb; i++) {
      if (comp[i] >= 0) continue;
      const stack = [i]; comp[i] = nc;
      while (stack.length) {
        const u = stack.pop();
        for (const e of adj[u]) if (comp[e.to] < 0) { comp[e.to] = nc; stack.push(e.to); }
      }
      nc++;
    }

    // bus elektrárny a NN bus rozvodny
    const genBus = new Int32Array(n).fill(-1);
    const nnBus = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const b = nodes[i];
      if (b.kind === 'sub') { const v = busOf.get(i + ':0.4'); if (v !== undefined) nnBus[i] = v; }
      else { const v = busOf.get(i + ':' + GEN_LEVEL[b.kind]); if (v !== undefined) genBus[i] = v; }
    }

    // --- na komponentu: nabídka vs. poptávka ---
    const compGen = new Float64Array(nc);
    const compDem = new Float64Array(nc);
    for (let i = 0; i < n; i++) if (genBus[i] >= 0) compGen[comp[genBus[i]]] += wantGen[i];
    for (const ca of cityAssign) {
      if (ca.sub >= 0 && nnBus[ca.sub] >= 0) compDem[comp[nnBus[ca.sub]]] += ca.demand;
    }
    for (const ia of indAssign) {
      if (ia.bus >= 0) compDem[comp[ia.bus]] += ia.demand;
    }
    for (const xa of xAssign) {
      if (xa.bus >= 0) compDem[comp[xa.bus]] += xa.demand;
    }

    /* --- zásobníky energie (baterie, přečerpávačky): dispečink ---
       Přebytek v komponentě nabíjí (zásobník = dodatečný odběr),
       deficit vybíjí (zásobník = zdroj). Výkon omezuje stav zařízení. */
    const storP = new Float64Array(n); // + vybíjí (výroba) / − nabíjí (odběr)
    for (let i = 0; i < n; i++) {
      const b = nodes[i];
      const sd = STORAGE[b.kind];
      if (!sd || genBus[i] < 0) continue;
      b.storMode = 'klid';
      const c = comp[genBus[i]];
      const maxP = sd.maxP * this.condFactor(b) * (1 + 0.25 * (b.level - 1));
      if (maxP <= 0) continue;
      const bal = compGen[c] - compDem[c];
      if (bal > 0.5 && b.charge < sd.cap - 0.1) {
        const p = Math.min(maxP, bal, (sd.cap - b.charge) / Math.max(1e-6, sd.eff * dt));
        storP[i] = -p;
        compDem[c] += p;
        b.storMode = 'nabíjí';
      } else if (bal < -0.5 && b.charge > 0.1) {
        const p = Math.min(maxP, -bal, b.charge / Math.max(1e-6, dt));
        storP[i] = p;
        compGen[c] += p;
        b.storMode = 'vybíjí';
      }
    }

    // --- DC power flow: L·θ = P, sdružené gradienty (CG) ---
    // Injekce jsou v každé komponentě bilancované, takže je systém řešitelný;
    // CG na Laplacián konverguje řádově rychleji než Gauss–Seidel.
    const theta = this._theta && this._theta.length === nb ? this._theta : new Float64Array(nb);
    this._theta = theta;
    const applyL = (v, out) => {
      for (let u = 0; u < nb; u++) {
        let s = 0;
        for (const e of adj[u]) s += e.e.w * (v[u] - v[e.to]);
        out[u] = s;
      }
    };
    const solveCG = (inj) => {
      const r = new Float64Array(nb), p = new Float64Array(nb), Ap = new Float64Array(nb);
      applyL(theta, Ap);
      for (let u = 0; u < nb; u++) { r[u] = inj[u] - Ap[u]; p[u] = r[u]; }
      let rs = 0;
      for (let u = 0; u < nb; u++) rs += r[u] * r[u];
      const maxIt = Math.min(500, 2 * nb + 20);
      for (let it = 0; it < maxIt && rs > 1e-8; it++) {
        applyL(p, Ap);
        let pAp = 0;
        for (let u = 0; u < nb; u++) pAp += p[u] * Ap[u];
        if (pAp <= 1e-12) break;
        const alpha = rs / pAp;
        let rs2 = 0;
        for (let u = 0; u < nb; u++) {
          theta[u] += alpha * p[u];
          r[u] -= alpha * Ap[u];
          rs2 += r[u] * r[u];
        }
        const beta = rs2 / rs;
        rs = rs2;
        for (let u = 0; u < nb; u++) p[u] = r[u] + beta * p[u];
      }
    };

    /* --- fáze 1: bilance bez ztrát, předběžné toky --- */
    {
      const inj1 = new Float64Array(nb);
      for (const ca of cityAssign) {
        if (ca.sub < 0 || nnBus[ca.sub] < 0) continue;
        const c = comp[nnBus[ca.sub]];
        const r1 = compDem[c] > 0 ? Math.min(1, compGen[c] / compDem[c]) : 0;
        inj1[nnBus[ca.sub]] -= ca.demand * r1;
      }
      for (const ia of indAssign) {
        if (ia.bus < 0) continue;
        const c = comp[ia.bus];
        const r1 = compDem[c] > 0 ? Math.min(1, compGen[c] / compDem[c]) : 0;
        inj1[ia.bus] -= ia.demand * r1;
      }
      for (const xa of xAssign) {
        if (xa.bus < 0) continue;
        const c = comp[xa.bus];
        const r1 = compDem[c] > 0 ? Math.min(1, compGen[c] / compDem[c]) : 0;
        inj1[xa.bus] -= xa.demand * r1;
      }
      for (let i = 0; i < n; i++) {
        if (genBus[i] < 0) continue;
        const c = comp[genBus[i]];
        const u1 = compGen[c] > 0 ? Math.min(1, compDem[c] / compGen[c]) : 0;
        inj1[genBus[i]] += wantGen[i] * u1 + storP[i];
      }
      solveCG(inj1);
    }

    /* --- ztráty na vedení z předběžných toků: P_ztr = |P|·(|P|/cap)·loss·délka.
       Ztráta se rozdělí napůl mezi koncové přípojnice jako dodatečný odběr,
       výroba ji musí pokrýt navíc nad spotřebu měst. --- */
    const lossAt = new Float64Array(nb);
    const compLoss = new Float64Array(nc);
    for (const e of edges) {
      if (!e.line) continue;
      const l = e.line;
      const flow = (theta[e.a] - theta[e.b]) * e.w;
      const loss = Math.abs(flow) * (Math.abs(flow) / l.cap) * LINE_TYPES[l.level].loss * l.len;
      l.loss = loss;
      lossAt[e.a] += loss / 2;
      lossAt[e.b] += loss / 2;
      compLoss[comp[e.a]] += loss;
    }
    // komponenta, kterou by ztráty položily, nedodává nic (a bez toků neztrácí)
    for (let c = 0; c < nc; c++) {
      if (compLoss[c] > 0 && compGen[c] - compLoss[c] <= 0) compLoss[c] = -1; // značka
    }
    for (const e of edges) {
      if (!e.line) continue;
      if (compLoss[comp[e.a]] < 0) e.line.loss = 0;
    }
    for (let u = 0; u < nb; u++) if (compLoss[comp[u]] < 0) lossAt[u] = 0;
    for (let c = 0; c < nc; c++) if (compLoss[c] < 0) compLoss[c] = 0;

    /* --- fáze 2: finální bilance – dodávka měst a průmyslu + krytí ztrát --- */
    let produced = 0, delivered = 0, indDelivered = 0, totalLoss = 0;
    const gen = new Float64Array(n);
    const demandAt = new Float64Array(n); // odběr přes rozvodnu (index stavby)
    const inj = new Float64Array(nb);     // MW injekce na busu
    for (const ca of cityAssign) {
      if (ca.sub < 0 || nnBus[ca.sub] < 0) continue;
      const c = comp[nnBus[ca.sub]];
      // dodávka se krátí tak, aby výroba pokryla i ztráty
      const ratio = compDem[c] > 0 ? Math.min(1, Math.max(0, compGen[c] - compLoss[c]) / compDem[c]) : 0;
      ca.served = ca.demand * ratio;
      demandAt[ca.sub] += ca.served;
      inj[nnBus[ca.sub]] -= ca.served;
      delivered += ca.served;
    }
    for (const ia of indAssign) {
      if (ia.bus < 0) continue;
      const c = comp[ia.bus];
      const ratio = compDem[c] > 0 ? Math.min(1, Math.max(0, compGen[c] - compLoss[c]) / compDem[c]) : 0;
      ia.served = ia.demand * ratio;
      demandAt[ia.sub] += ia.served;
      inj[ia.bus] -= ia.served;
      delivered += ia.served;
      indDelivered += ia.served;
    }
    for (const xa of xAssign) {
      if (xa.bus < 0) continue;
      const c = comp[xa.bus];
      const ratio = compDem[c] > 0 ? Math.min(1, Math.max(0, compGen[c] - compLoss[c]) / compDem[c]) : 0;
      xa.served = xa.demand * ratio;
      xa.b.xServed = xa.served;
      inj[xa.bus] -= xa.served;
    }
    const compServed = new Float64Array(nc);
    for (const ca of cityAssign) {
      if (ca.sub >= 0 && nnBus[ca.sub] >= 0) compServed[comp[nnBus[ca.sub]]] += ca.served;
    }
    for (const ia of indAssign) {
      if (ia.bus >= 0) compServed[comp[ia.bus]] += ia.served;
    }
    for (const xa of xAssign) {
      if (xa.bus >= 0) compServed[comp[xa.bus]] += xa.served;
    }
    // nabíjení zásobníků se krátí stejně jako ostatní odběry (kvůli ztrátám)
    const compCharge = new Float64Array(nc);
    for (let i = 0; i < n; i++) {
      if (storP[i] < 0) {
        const c = comp[genBus[i]];
        const ratio = compDem[c] > 0 ? Math.min(1, Math.max(0, compGen[c] - compLoss[c]) / compDem[c]) : 0;
        storP[i] *= ratio;
        compCharge[c] += -storP[i];
      }
    }
    for (let i = 0; i < n; i++) {
      if (genBus[i] < 0) { nodes[i].out = 0; continue; }
      const c = comp[genBus[i]];
      // elektrárny kryjí odběr měst a průmyslu + nabíjení zásobníků + ztráty
      const useRatio = compGen[c] > 0
        ? Math.min(1, (compServed[c] + compCharge[c] + compLoss[c]) / compGen[c]) : 0;
      gen[i] = wantGen[i] * useRatio;
      produced += gen[i];
      inj[genBus[i]] += gen[i] + storP[i];
      nodes[i].out = gen[i];
    }
    for (let u = 0; u < nb; u++) inj[u] -= lossAt[u];
    for (let c = 0; c < nc; c++) totalLoss += compLoss[c];
    solveCG(inj);

    // --- zásobníky: aktualizace uložené energie (účinnost při nabíjení) ---
    for (let i = 0; i < n; i++) {
      const sd = STORAGE[nodes[i].kind];
      if (!sd) continue;
      const b = nodes[i];
      if (storP[i] < 0) b.charge = Math.min(sd.cap, b.charge + (-storP[i]) * sd.eff * dt);
      else if (storP[i] > 0) { b.charge = Math.max(0, b.charge - storP[i] * dt); produced += storP[i]; }
      b.out = storP[i];
      if (Math.abs(storP[i]) < 0.05) b.storMode = 'klid';
    }

    // toky hranami + přetížení vedení a traf
    let overloaded = 0, overloadedTrafos = 0;
    for (const e of edges) {
      const flow = (theta[e.a] - theta[e.b]) * e.w;
      if (e.line) {
        e.line.flow = flow;
        e.line.load = Math.abs(flow) / e.line.cap;
        if (e.line.load > 1) overloaded++;
      } else {
        const load = Math.abs(flow) / e.trafo.cap;
        e.trafo.sub.trafoLoad[e.trafo.key] = load;
        e.trafo.sub.trafoFlow[e.trafo.key] = flow; // kladný = hi -> lo
        if (load > 1) overloadedTrafos++;
      }
    }
    if ((overloaded > 0 || overloadedTrafos > 0) && Math.floor(this.time) % 5 === 0 &&
        this._lastOverloadWarn !== Math.floor(this.time)) {
      this._lastOverloadWarn = Math.floor(this.time);
      if (overloaded > 0) this.msg('Vedení přetíženo! Postav paralelní trasu nebo vyšší napětí.', 'warn');
      if (overloadedTrafos > 0) this.msg('Trafo přetíženo! Přikup další kus do rozvodny.', 'warn');
    }

    // --- průmysl: stav napájení, hlášení odstávek ---
    for (const ia of indAssign) {
      const ind = ia.ind;
      const ratio = ia.demand > 0 ? ia.served / ia.demand : 0;
      ind.powered = ratio;
      if (ratio < 0.9) {
        ind.downTime += dt;
        if (ind.downTime > 15 && !ind._warned) {
          ind._warned = true;
          this.msg(ind.name + ' stojí bez proudu! (potřebuje VN přípojku z rozvodny)', 'warn');
        }
      } else {
        ind.downTime = 0;
        ind._warned = false;
      }
    }

    // --- města: spokojenost, pomalý růst, výpadky ---
    for (const ca of cityAssign) {
      const c = ca.city;
      const ratio = ca.demand > 0 ? ca.served / ca.demand : 0;
      c.powered = ratio;
      if (ratio > 0.95) {
        c.satisfaction = Math.min(1, c.satisfaction + dt * 0.02);
        c.unhappyTime = 0;
        // pomalý růst: jen spokojená města, a čím větší, tím pomaleji
        const growRate = 0.008 * c.satisfaction * (1 - c.pop / 80);
        if (Math.random() < dt * growRate && c.pop < 60) {
          c.pop += 1;
          this._syncHouses(c);
          this.msg(c.name + ' se rozrostlo na ' + c.pop + ' tis. obyvatel');
        }
      } else {
        c.satisfaction = Math.max(0, c.satisfaction - dt * (0.05 + 0.1 * (1 - ratio)));
        c.unhappyTime += dt;
        if (c.unhappyTime > 20 && Math.random() < dt * 0.03 && c.pop > 4) {
          c.pop -= 1;
          this._syncHouses(c);
          this.blackouts++;
        }
      }
    }

    // --- palivo: spotřeba dle vyrobených MW, došlé palivo zastaví výrobu ---
    for (let i = 0; i < n; i++) {
      const b = nodes[i];
      const fd = FUEL[b.kind];
      if (!fd) continue;
      if (b.fuel > 0 && gen[i] > 0) {
        b.fuel = Math.max(0, b.fuel - fd.perMW * gen[i] * dt);
        if (b.fuel === 0) {
          this.msg('DOŠLO PALIVO: ' + BUILD[b.kind].name + ' [' + b.x + ',' + b.y + '] stojí!', 'warn');
        } else if (b.fuel < fd.cap * 0.2 && !b._fuelWarned) {
          b._fuelWarned = true;
          this.msg(BUILD[b.kind].name + ' [' + b.x + ',' + b.y + ']: palivo pod 20 %', 'warn');
        } else if (b.fuel >= fd.cap * 0.2) {
          b._fuelWarned = false;
        }
      }
      // smluvní dodávky: doplní sklad pod čtvrtinou
      if (b.fuelContract && b.fuel < fd.cap * 0.25) {
        if (!this.buyFuel(b, true) && this._fuelWarnT !== Math.floor(this.time)) {
          this._fuelWarnT = Math.floor(this.time);
          this.msg('Smluvní dodávka paliva čeká – nedostatek peněz', 'warn');
        }
      }
    }

    // --- opotřebení, poruchy a servisní smlouvy ---
    for (let i = 0; i < n; i++) {
      const b = nodes[i];
      if (!WEAR[b.kind]) continue; // předávací body se neopotřebovávají
      if (!b.broken) {
        // elektrárny se opotřebovávají podle vytížení, rozvodny podle přenášeného odběru
        let util;
        if (b.kind === 'sub') util = demandAt[i] > 0 ? 1 : 0.3;
        else util = wantGen[i] > 0 ? gen[i] / Math.max(1e-6, wantGen[i]) : 0;
        // modernizovaná budova se opotřebovává pomaleji
        const wear = WEAR[b.kind] / (1 + 0.35 * (b.level - 1));
        b.cond = Math.max(0, b.cond - wear * (0.35 + 0.65 * util) * dt);
        // zanedbaná budova může selhat úplně
        if (b.cond < 0.2 && Math.random() < dt * (0.2 - b.cond) * 0.6) {
          b.broken = true;
          this.msg('PORUCHA: ' + BUILD[b.kind].name + ' [' + b.x + ',' + b.y + '] je mimo provoz!', 'warn');
        }
      }
      // smluvní servis: technici vyjíždějí automaticky
      if (b.contract && (b.broken || b.cond < 0.5)) {
        if (!this.service(b, true) && this._contractWarnT !== Math.floor(this.time)) {
          this._contractWarnT = Math.floor(this.time);
          this.msg('Smluvní servis čeká – nedostatek peněz', 'warn');
        }
      }
    }

    // --- ekonomika ---
    let upkeep = 0;
    for (const b of this.buildings) {
      upkeep += BUILD[b.kind].upkeep * (1 + 0.25 * (b.level - 1));
      for (const [key, count] of Object.entries(b.trafos || {})) upkeep += TRAFOS[key].cost * 0.004 * count;
    }
    for (const l of this.lines) upkeep += l.len * LINE_TYPES[l.level].cost * 0.01;
    // --- přeshraniční obchod: import take-or-pay, export za dodané, sankce za nedodané ---
    let xIncome = 0, xCost = 0, xPenalty = 0, exported = 0, imported = 0;
    for (const b of this.buildings) {
      if (b.kind !== 'xborder') continue;
      if (b.xImport > 0) {
        xCost += b.xImport * XTRADE.importPrice; // platíš plnou smlouvu, i nevyužitou
        imported += b.out;
      }
      if (b.xExport > 0) {
        xIncome += b.xServed * XTRADE.exportPrice;
        exported += b.xServed;
        const short = b.xExport - b.xServed;
        if (short > 0.5) {
          xPenalty += short * XTRADE.penalty;
          if (this._xPenWarnT !== Math.floor(this.time / 7)) {
            this._xPenWarnT = Math.floor(this.time / 7);
            this.msg('SANKCE: ' + b.name + ' – nedodáváš sjednaný export (' +
              b.xServed.toFixed(0) + '/' + b.xExport + ' MW)!', 'warn');
          }
        }
      }
    }

    // průmysl platí za MWh o 40 % víc než města
    const income = (delivered - indDelivered) * PRICE_PER_MWH + indDelivered * PRICE_PER_MWH * 1.4
      + xIncome - xCost - xPenalty;
    this.money += (income - upkeep * 0.01) * dt;
    this.score += (delivered + exported) * dt * 0.01;

    this.stats = {
      produced, delivered, indDelivered, demand: totalDemand,
      losses: totalLoss,
      exported, imported, xPenalty,
      overloaded, overloadedTrafos,
      unpowered: cityAssign.filter((ca) => (ca.demand > 0 && (ca.served / ca.demand) < 0.5)).length +
        indAssign.filter((ia) => (ia.demand > 0 && (ia.served / ia.demand) < 0.5)).length,
      income: income - upkeep * 0.01,
    };
    this.cityAssign = cityAssign;
    this.indAssign = indAssign;
    this.xAssign = xAssign;
  };

  EG.Sim = Sim;
  EG.BUILD = BUILD;
  EG.FUEL = FUEL;
  EG.STORAGE = STORAGE;
  EG.TRAFO_REG = TRAFO_REG;
  EG.XTRADE = XTRADE;
  EG.LEVELS = LEVELS;
  EG.LINE_TYPES = LINE_TYPES;
  EG.GEN_LEVEL = GEN_LEVEL;
  EG.TRAFOS = TRAFOS;
  EG.SUB_RANGE = SUB_RANGE;
  EG.MAX_LEVEL = MAX_LEVEL;
  EG.MAX_RANGE_LEVEL = MAX_RANGE_LEVEL;
})();
