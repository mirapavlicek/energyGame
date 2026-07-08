/* Procedurální generátor mapy: terén, řeky s průtokem, města */
(function () {
  'use strict';
  const EG = window.EG;
  const { fbm, hash2, mulberry32 } = EG.rng;

  // typy terénu
  const T = {
    WATER: 0,   // jezero / moře / přehradní nádrž
    SAND: 1,    // břeh
    GRASS: 2,
    FOREST: 3,
    HILL: 4,
    MOUNTAIN: 5,
    RIVER: 6,
  };

  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  function generate(size, seed) {
    const rand = mulberry32(seed);
    const N = size;
    const areaScale = (N * N) / (160 * 160); // obsah mapy roste s plochou
    const type = new Uint8Array(N * N);
    const elev = new Float32Array(N * N);
    const flow = new Float32Array(N * N);      // průtok řeky (0 = není řeka)
    const flowDir = new Int8Array(N * N).fill(-1); // index do DIRS, kam řeka teče
    const idx = (x, y) => y * N + x;

    // --- výšková mapa + vlhkost ---
    const cx = N / 2, cy = N / 2;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let e = fbm(x / 42, y / 42, seed, 5);
        // mírné snížení k okrajům, ať vznikají jezera u krajů
        const dx = (x - cx) / cx, dy = (y - cy) / cy;
        const edge = Math.max(Math.abs(dx), Math.abs(dy));
        e -= Math.max(0, edge - 0.75) * 0.9;
        elev[idx(x, y)] = e;
      }
    }

    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = idx(x, y);
        const e = elev[i];
        const m = fbm(x / 23 + 500, y / 23 + 500, seed + 7777, 4);
        if (e < 0.335) type[i] = T.WATER;
        else if (e < 0.60) type[i] = m > 0.55 ? T.FOREST : T.GRASS;
        else if (e < 0.70) type[i] = T.HILL;
        else type[i] = T.MOUNTAIN;
      }
    }

    // --- řeky: prameny v horách, stékají po spádu do vody / za okraj ---
    const springs = [];
    const wantedSprings = Math.round(14 * Math.sqrt(areaScale)); // řeky rostou s délkou mapy
    const springTries = Math.round(4000 * areaScale);
    for (let tries = 0; tries < springTries && springs.length < wantedSprings; tries++) {
      const x = 4 + Math.floor(rand() * (N - 8));
      const y = 4 + Math.floor(rand() * (N - 8));
      if (elev[idx(x, y)] > 0.62) {
        let ok = true;
        for (const s of springs) {
          if (Math.abs(s[0] - x) + Math.abs(s[1] - y) < 26) { ok = false; break; }
        }
        if (ok) springs.push([x, y]);
      }
    }

    for (const [sx, sy] of springs) {
      let x = sx, y = sy;
      let f = 3 + rand() * 4; // počáteční průtok (MW ekvivalent na jednotku)
      const visited = new Set();
      for (let step = 0; step < N * 3; step++) {
        const i = idx(x, y);
        if (type[i] === T.WATER) break;                 // doteklo do jezera
        if (visited.has(i)) break;
        visited.add(i);
        if (type[i] === T.RIVER) {                      // soutok – posílí existující tok
          let px = x, py = y;
          while (px >= 0 && px < N && py >= 0 && py < N) {
            const j = idx(px, py);
            if (type[j] !== T.RIVER) break;
            flow[j] += f * 0.8;
            const d = flowDir[j];
            if (d < 0) break;
            px += DIRS[d][0]; py += DIRS[d][1];
          }
          break;
        }
        type[i] = T.RIVER;
        flow[i] = f;
        f += 0.12; // přítoky po cestě
        // vyber souseda s nejnižší elevací (s trochou šumu, ať meandruje)
        let best = -1, bestE = Infinity;
        for (let d = 0; d < 4; d++) {
          const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
          if (nx < 0 || ny < 0 || nx >= N || ny >= N) { best = d; bestE = -Infinity; break; }
          const j = idx(nx, ny);
          if (visited.has(j)) continue;
          const e = elev[j] + (hash2(nx, ny, seed + step) - 0.5) * 0.045;
          if (e < bestE) { bestE = e; best = d; }
        }
        if (best < 0) break;
        flowDir[i] = best;
        const nx = x + DIRS[best][0], ny = y + DIRS[best][1];
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) break; // odtéká z mapy
        // eroze – zajistí, že řeka „neteče do kopce"
        elev[idx(nx, ny)] = Math.min(elev[idx(nx, ny)], elev[i] - 0.001);
        x = nx; y = ny;
      }
    }

    // písek kolem vody
    for (let y = 1; y < N - 1; y++) {
      for (let x = 1; x < N - 1; x++) {
        const i = idx(x, y);
        if (type[i] === T.GRASS || type[i] === T.FOREST) {
          for (let d = 0; d < 4; d++) {
            if (type[idx(x + DIRS[d][0], y + DIRS[d][1])] === T.WATER) { type[i] = T.SAND; break; }
          }
        }
      }
    }

    // --- města: na rovině, daleko od sebe, radši blízko řeky ---
    const cities = [];
    const wanted = Math.round(14 * areaScale); // hustší osídlení
    let attempts = 0;
    while (cities.length < wanted && attempts++ < 40000) {
      const x = 8 + Math.floor(rand() * (N - 16));
      const y = 8 + Math.floor(rand() * (N - 16));
      const i = idx(x, y);
      if (type[i] !== T.GRASS && type[i] !== T.FOREST) continue;
      let minD = Infinity;
      for (const c of cities) {
        const d = Math.abs(c.x - x) + Math.abs(c.y - y);
        if (d < minD) minD = d;
      }
      if (minD < 30) continue;
      // bonus šance u řeky
      let nearRiver = false;
      for (let ry = -4; ry <= 4 && !nearRiver; ry++)
        for (let rx = -4; rx <= 4; rx++) {
          const nx = x + rx, ny = y + ry;
          if (nx >= 0 && ny >= 0 && nx < N && ny < N && type[idx(nx, ny)] === T.RIVER) { nearRiver = true; break; }
        }
      if (!nearRiver && rand() < 0.55) continue;
      const pop = 6 + Math.floor(rand() * 22); // tisíce obyvatel
      // charakter města: obytné / průmyslové / smíšené – liší se spotřebou
      // na obyvatele i denním profilem odběru
      const kr = rand();
      const kind = kr < 0.4 ? 'res' : kr < 0.72 ? 'mix' : 'ind';
      const needPerCap = kind === 'res' ? 0.8 + rand() * 0.3
        : kind === 'ind' ? 1.3 + rand() * 0.4
        : 1.0 + rand() * 0.3;
      cities.push({
        x, y, pop, popBase: pop, kind, needPerCap,
        name: CITY_NAMES[cities.length % CITY_NAMES.length],
        satisfaction: 1, unhappyTime: 0, houses: [],
      });
      // zabrat okolní dlaždice pro zástavbu (jen vizuál + zákaz stavění)
      const c = cities[cities.length - 1];
      const r = 2;
      for (let ry = -r; ry <= r; ry++)
        for (let rx = -r; rx <= r; rx++) {
          const nx = x + rx, ny = y + ry;
          if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
          const j = idx(nx, ny);
          if ((type[j] === T.GRASS || type[j] === T.FOREST || type[j] === T.SAND) &&
              Math.abs(rx) + Math.abs(ry) <= r && hash2(nx, ny, seed + 99) < 0.75) {
            c.houses.push([nx, ny]);
          }
        }
    }

    // --- průmysl: samostatné podniky s velkou spotřebou (napájí se z VN) ---
    const industries = [];
    const IND_DEFS = [
      { type: 'dul', label: 'Důl', demand: [18, 32], names: ['Anna', 'Barbora', 'Mayrau', 'Michal'] },
      { type: 'hut', label: 'Huť', demand: [28, 48], names: ['Vítkov', 'Poldi', 'Liskovec'] },
      { type: 'pila', label: 'Pila', demand: [8, 16], names: ['Borek', 'Javorina', 'Smrčina'] },
      { type: 'chemicka', label: 'Chemička', demand: [22, 40], names: ['Ústí', 'Zaluží', 'Semtín'] },
    ];
    const DATA_DEF = { type: 'data', label: 'Datacentrum', demand: [24, 34], names: ['Alfa', 'Beta', 'Gama', 'Delta'] };
    const STEEL_DEF = { type: 'ocelarna', label: 'Ocelárna', demand: [45, 70], names: ['Vítkovice', 'Kladno', 'Třinec'] };
    const wantedInd = Math.round(9 * areaScale); // hustší průmysl
    let indAttempts = 0;
    while (industries.length < wantedInd && indAttempts++ < 60000) {
      const x = 6 + Math.floor(rand() * (N - 12));
      const y = 6 + Math.floor(rand() * (N - 12));
      const i = idx(x, y);
      const t = type[i];
      if (t === T.WATER || t === T.RIVER || t === T.MOUNTAIN) continue;
      // dál od měst i ostatních podniků
      let tooClose = false;
      for (const c of cities) if (Math.abs(c.x - x) + Math.abs(c.y - y) < 12) { tooClose = true; break; }
      for (const ind of industries) if (Math.abs(ind.x - x) + Math.abs(ind.y - y) < 22) { tooClose = true; break; }
      if (tooClose) continue;
      // typ podle terénu v okolí
      let nearForest = false, nearHill = false, nearRiver = false;
      for (let ry = -3; ry <= 3; ry++) for (let rx = -3; rx <= 3; rx++) {
        const nx = x + rx, ny = y + ry;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const tt = type[idx(nx, ny)];
        if (tt === T.FOREST) nearForest = true;
        if (tt === T.HILL || tt === T.MOUNTAIN) nearHill = true;
        if (tt === T.RIVER) nearRiver = true;
      }
      const def = hash2(x, y, seed + 56) < 0.10 ? STEEL_DEF
        : hash2(x, y, seed + 55) < 0.15 ? DATA_DEF
        : nearHill ? IND_DEFS[0]
        : nearRiver ? IND_DEFS[3]
        : nearForest ? IND_DEFS[2]
        : IND_DEFS[1];
      const demand = def.demand[0] + rand() * (def.demand[1] - def.demand[0]);
      industries.push({
        x, y, type: def.type,
        name: def.label + ' ' + def.names[Math.floor(rand() * def.names.length)],
        demand, powered: 0, downTime: 0,
      });
    }

    // --- geotermální pole: vzácná místa pro geotermální elektrárny ---
    const geoFields = [];
    const wantedGeo = Math.max(2, Math.round(4 * Math.sqrt(areaScale)));
    let geoTries = 0;
    while (geoFields.length < wantedGeo && geoTries++ < 8000) {
      const x = 6 + Math.floor(rand() * (N - 12));
      const y = 6 + Math.floor(rand() * (N - 12));
      const t = type[idx(x, y)];
      if (t !== T.GRASS && t !== T.HILL) continue;
      if (geoFields.some((g) => Math.abs(g.x - x) + Math.abs(g.y - y) < 35)) continue;
      if (cities.some((c) => Math.abs(c.x - x) + Math.abs(c.y - y) < 8)) continue;
      geoFields.push({ x, y });
    }

    // --- přeshraniční předávací body: na okrajích mapy, napojení na sousední soustavy ---
    const crossings = [];
    const X_NAMES = ['Bavorsko', 'Sasko', 'Rakousko', 'Polsko', 'Slovensko'];
    const edges = [
      () => [3 + Math.floor(rand() * (N - 6)), 2],           // sever
      () => [N - 3, 3 + Math.floor(rand() * (N - 6))],       // východ
      () => [3 + Math.floor(rand() * (N - 6)), N - 3],       // jih
      () => [2, 3 + Math.floor(rand() * (N - 6))],           // západ
    ];
    const wantedX = Math.max(3, Math.round(3 * Math.sqrt(areaScale))); // delší hranice = víc bodů
    let xTries = 0;
    while (crossings.length < wantedX && xTries++ < 8000) {
      const [x, y] = edges[crossings.length % 4]();
      const t = type[idx(x, y)];
      if (t === T.WATER || t === T.RIVER || t === T.MOUNTAIN) continue;
      if (crossings.some((cr) => Math.abs(cr.x - x) + Math.abs(cr.y - y) < 40)) continue;
      crossings.push({ x, y, name: X_NAMES[crossings.length % X_NAMES.length] });
    }

    // --- železniční koridory: spojují vzdálená města, trakční napájecí
    //     stanice podél tratí jsou velcí odběratelé (napájení ze 110 kV) ---
    const railways = [];
    const railTiles = [];
    const wantedRail = Math.max(2, Math.round(2 * Math.sqrt(areaScale)));
    const usedCity = new Set();
    for (let k = 0; k < wantedRail && cities.length >= 2; k++) {
      let best = null, bd = -1;
      for (let a = 0; a < cities.length; a++) for (let b = a + 1; b < cities.length; b++) {
        if (usedCity.has(a) && usedCity.has(b)) continue;
        const d = Math.abs(cities[a].x - cities[b].x) + Math.abs(cities[a].y - cities[b].y);
        if (d > bd) { bd = d; best = [a, b]; }
      }
      if (!best || bd < 40) break;
      usedCity.add(best[0]); usedCity.add(best[1]);
      const A = cities[best[0]], B = cities[best[1]];
      const path = [];
      const steps = Math.ceil(Math.hypot(B.x - A.x, B.y - A.y));
      const dx = B.x - A.x, dy = B.y - A.y, dl = Math.hypot(dx, dy) || 1;
      const px = -dy / dl, py = dx / dl;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const wob = Math.sin(t * Math.PI * 3 + k * 1.7) * 4 * Math.sin(t * Math.PI); // u měst trať končí rovně
        const x = Math.round(A.x + dx * t + px * wob);
        const y = Math.round(A.y + dy * t + py * wob);
        if (x < 1 || y < 1 || x >= N - 1 || y >= N - 1) continue;
        if (path.length === 0 || path[path.length - 1][0] !== x || path[path.length - 1][1] !== y) path.push([x, y]);
      }
      if (path.length < 30) continue;
      const koridor = String.fromCharCode(65 + railways.length);
      const stations = [];
      for (let i = 18; i < path.length - 14; i += 28) {
        const [sx, sy] = path[i];
        const t = type[idx(sx, sy)];
        if (t === T.WATER || t === T.RIVER) continue;
        if (cities.some((c) => Math.abs(c.x - sx) + Math.abs(c.y - sy) < 6)) continue;
        const st = {
          x: sx, y: sy, type: 'trakce',
          name: 'Trakční stanice ' + koridor + (stations.length + 1),
          demand: 14 + rand() * 14, powered: 0, downTime: 0,
        };
        stations.push(st);
        industries.push(st);
      }
      railways.push({ name: 'Koridor ' + koridor, from: A.name, to: B.name, path });
      for (const [x, y] of path) railTiles.push(y * N + x);
    }

    return {
      size: N, type, elev, flow, flowDir, cities, industries, crossings, geoFields,
      railways, railTiles, seed, T, idx,
    };
  }

  const CITY_NAMES = [
    'Vltavín', 'Doubrava', 'Kamenice', 'Lipno', 'Bystřice', 'Orlík',
    'Střekov', 'Jeseník', 'Hluboká', 'Rožmberk', 'Světlá', 'Vranov',
    'Nechranice', 'Dalešice', 'Mohelno', 'Kružberk', 'Pastviny', 'Seč',
    'Trnávka', 'Jesenice', 'Žermanice', 'Olešná', 'Hracholusky', 'Skalka',
  ];

  EG.T = T;
  EG.DIRS = DIRS;
  EG.generateMap = generate;
})();
