/* Import reálné krajiny na hrací plochu.

   Zdroj dat je OpenStreetMap přes Overpass API. Google Maps se použít
   nedají: jejich licence odvozování dat zakazuje a API navíc chce klíč.
   Odkaz z Google Map ale posloužit může – vytáhne se z něj poloha
   a zbytek (vodstvo, sídla, lesy, průmysl, tratě) dodá OSM.

   Modul má dvě poloviny. Síťová část (parsePlace, bboxAround,
   overpassQuery, fetchOSM) jen sáhne pro data. Převod buildMapFromOSM
   je čistá funkce: dostane odpověď Overpassu a vrátí mapu ve stejném
   tvaru, jaký dělá procedurální generátor – takže si jí hra ani
   ukládání nevšimnou. */
(function () {
  'use strict';
  const EG = window.EG;

  const OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.osm.ch/api/interpreter',
  ];

  const R_LAT_KM = 111.32; // km na stupeň zeměpisné šířky

  /* --- 1. Odkud: odkaz z Google Map, z OSM, nebo rovnou souřadnice --- */
  function parsePlace(text) {
    if (!text) return null;
    const s = String(text).trim();
    const num = '(-?\\d+(?:\\.\\d+)?)';
    const tries = [
      // google: /maps/@50.0755,14.4378,12z  i  /maps/place/.../@50.07,14.43,11z
      new RegExp('[@/]' + num + ',' + num + ',(\\d+(?:\\.\\d+)?)z'),
      // google place link: !3d50.0755!4d14.4378
      new RegExp('!3d' + num + '!4d' + num),
      // ?q=50.07,14.43 · ?query=... · ?ll=... · ?daddr=...
      new RegExp('[?&](?:q|query|ll|daddr|sll)=' + num + '%2C' + num, 'i'),
      new RegExp('[?&](?:q|query|ll|daddr|sll)=' + num + ',\\s*' + num, 'i'),
      // openstreetmap: #map=12/50.0755/14.4378
      new RegExp('#map=(\\d+(?:\\.\\d+)?)/' + num + '/' + num),
      // holé souřadnice „50.0755, 14.4378"
      new RegExp('^' + num + '\\s*[,;]\\s*' + num + '$'),
    ];
    for (let i = 0; i < tries.length; i++) {
      const m = s.match(tries[i]);
      if (!m) continue;
      let lat, lon, zoom;
      if (i === 4) { zoom = +m[1]; lat = +m[2]; lon = +m[3]; }
      else { lat = +m[1]; lon = +m[2]; zoom = m[3] !== undefined ? +m[3] : undefined; }
      if (!isFinite(lat) || !isFinite(lon)) continue;
      if (lat < -85 || lat > 85 || lon < -180 || lon > 180) continue;
      return { lat, lon, zoom };
    }
    return null;
  }

  /* Čtvercový výřez kolem bodu. Strana je v kilometrech; poledníky se
     k pólům sbíhají, takže rozsah zeměpisné délky je dělený kosinem. */
  function bboxAround(lat, lon, km) {
    const half = Math.max(2, Math.min(200, km)) / 2;
    const dLat = half / R_LAT_KM;
    const dLon = half / (R_LAT_KM * Math.max(0.05, Math.cos(lat * Math.PI / 180)));
    return {
      s: lat - dLat, n: lat + dLat,
      w: lon - dLon, e: lon + dLon,
      lat, lon, km: half * 2,
    };
  }

  /* --- 2. Dotaz na Overpass ---
     Filtruje se až v prohlížeči: serverové filtry na délku obvodu sice
     odpověď zmenší, ale Overpass na nich běžně vytimeoutuje. */
  function overpassQuery(b) {
    const box = b.s.toFixed(5) + ',' + b.w.toFixed(5) + ',' + b.n.toFixed(5) + ',' + b.e.toFixed(5);
    return '[out:json][timeout:120];(' + [
      'node["place"~"^(city|town|village)$"](' + box + ');',
      'way["natural"="water"](' + box + ');',
      'relation["natural"="water"](' + box + ');',
      'way["landuse"="reservoir"](' + box + ');',
      'way["waterway"~"^(river|canal)$"](' + box + ');',
      'way["railway"="rail"]["usage"~"^(main|branch)$"](' + box + ');',
      'way["landuse"~"^(forest|industrial)$"](' + box + ');',
      'way["natural"="wood"](' + box + ');',
    ].join('') + ');out geom;';
  }

  async function fetchOSM(bbox, opts) {
    opts = opts || {};
    const body = 'data=' + encodeURIComponent(overpassQuery(bbox));
    const endpoints = opts.endpoints || OVERPASS;
    let lastErr = null;
    for (const url of endpoints) {
      try {
        if (opts.onProgress) opts.onProgress('stahuji data z ' + new URL(url).host + '…');
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal: opts.signal,
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        if (!json || !Array.isArray(json.elements)) throw new Error('neznámý tvar odpovědi');
        return json;
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        lastErr = e;
      }
    }
    throw new Error('data se nepodařilo stáhnout (' + (lastErr ? lastErr.message : 'bez odpovědi') + ')');
  }

  /* --- 3. Výškopis ---
     Dlaždice Terrarium (AWS Terrain Tiles, volně dostupné a s CORS)
     kódují nadmořskou výšku do barvy: h = R·256 + G + B/256 − 32768 [m].
     Když se stáhnout nepodaří, výšky se odhadnou z odstupu od vody. */
  const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/';

  const lonToTileX = (lon, z) => (lon + 180) / 360 * Math.pow(2, z);
  const latToTileY = (lat, z) => {
    const r = lat * Math.PI / 180;
    return (1 - Math.asinh(Math.tan(r)) / Math.PI) / 2 * Math.pow(2, z);
  };

  /* nejjemnější přiblížení, které se ještě vejde do rozpočtu dlaždic */
  function terrainZoom(bbox, maxTiles) {
    for (let z = 13; z >= 6; z--) {
      const x0 = Math.floor(lonToTileX(bbox.w, z)), x1 = Math.floor(lonToTileX(bbox.e, z));
      const y0 = Math.floor(latToTileY(bbox.n, z)), y1 = Math.floor(latToTileY(bbox.s, z));
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= maxTiles) return z;
    }
    return 6;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('výšková dlaždice se nenačetla'));
      img.src = url;
    });
  }

  async function fetchElevation(bbox, size, opts) {
    opts = opts || {};
    const z = terrainZoom(bbox, opts.maxTiles || 16);
    const x0 = Math.floor(lonToTileX(bbox.w, z)), x1 = Math.floor(lonToTileX(bbox.e, z));
    const y0 = Math.floor(latToTileY(bbox.n, z)), y1 = Math.floor(latToTileY(bbox.s, z));
    const nx = x1 - x0 + 1, ny = y1 - y0 + 1;
    const base = opts.base || TERRAIN_TILES;
    if (opts.onProgress) opts.onProgress('stahuji výškopis (' + (nx * ny) + ' dlaždic)…');
    const cv = document.createElement('canvas');
    cv.width = nx * 256; cv.height = ny * 256;
    const g = cv.getContext('2d', { willReadFrequently: true });
    const jobs = [];
    for (let ty = 0; ty < ny; ty++) {
      for (let tx = 0; tx < nx; tx++) {
        const url = base + z + '/' + (x0 + tx) + '/' + (y0 + ty) + '.png';
        jobs.push(loadImage(url).then((img) => g.drawImage(img, tx * 256, ty * 256)));
      }
    }
    await Promise.all(jobs);
    const px = g.getImageData(0, 0, cv.width, cv.height).data;
    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      const lat = bbox.n - (y / (size - 1)) * (bbox.n - bbox.s);
      const fy = Math.max(0, Math.min(cv.height - 1, Math.round((latToTileY(lat, z) - y0) * 256)));
      for (let x = 0; x < size; x++) {
        const lon = bbox.w + (x / (size - 1)) * (bbox.e - bbox.w);
        const fx = Math.max(0, Math.min(cv.width - 1, Math.round((lonToTileX(lon, z) - x0) * 256)));
        const o = (fy * cv.width + fx) * 4;
        out[y * size + x] = px[o] * 256 + px[o + 1] + px[o + 2] / 256 - 32768;
      }
    }
    return out;
  }

  /* --- 4. Převod na hrací plochu --- */

  /* Členy multipolygonu jsou často jen kusy prstence – tenhle spojovač
     je slepí podle shodných koncových bodů do uzavřených obrysů. */
  function stitchRings(members, role) {
    const parts = members
      .filter((m) => m.role === role && Array.isArray(m.geometry) && m.geometry.length > 1)
      .map((m) => m.geometry.map((p) => [p.lon, p.lat]));
    const key = (p) => p[0].toFixed(7) + ',' + p[1].toFixed(7);
    const rings = [];
    const used = new Array(parts.length).fill(false);
    for (let i = 0; i < parts.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      const ring = parts[i].slice();
      let grew = true;
      while (grew) {
        grew = false;
        if (key(ring[0]) === key(ring[ring.length - 1])) break;
        for (let j = 0; j < parts.length; j++) {
          if (used[j]) continue;
          const p = parts[j];
          const end = key(ring[ring.length - 1]);
          if (key(p[0]) === end) { ring.push(...p.slice(1)); used[j] = true; grew = true; break; }
          if (key(p[p.length - 1]) === end) {
            for (let k = p.length - 2; k >= 0; k--) ring.push(p[k]);
            used[j] = true; grew = true; break;
          }
        }
      }
      if (ring.length > 2) rings.push(ring);
    }
    return rings;
  }

  /* Trať je v OSM rozsekaná na desítky úseků podle mostů, výhybek a
     rychlostí. Tenhle spojovač je slepí zpátky do koridorů podle
     shodných koncových uzlů, ať má hra pár dlouhých tratí místo stovky
     útržků. Ve výhybce se pokračuje prvním volným úsekem – zbytek se
     stane samostatným koridorem. */
  function chainWays(ways) {
    const key = (p) => p.lat.toFixed(7) + ',' + p.lon.toFixed(7);
    const byEnd = new Map();
    const add = (k, i) => {
      if (!byEnd.has(k)) byEnd.set(k, []);
      byEnd.get(k).push(i);
    };
    ways.forEach((w, i) => {
      add(key(w.geom[0]), i);
      add(key(w.geom[w.geom.length - 1]), i);
    });
    const used = new Array(ways.length).fill(false);
    const out = [];
    for (let i = 0; i < ways.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      let chain = ways[i].geom.slice();
      const tags = ways[i].tags || {};
      // dvakrát dopředu s otočením mezi tím = prodloužení na obou koncích
      for (let pass = 0; pass < 2; pass++) {
        let grew = true;
        while (grew) {
          grew = false;
          const tip = key(chain[chain.length - 1]);
          for (const j of byEnd.get(tip) || []) {
            if (used[j]) continue;
            const g = ways[j].geom;
            let seg = null;
            if (key(g[0]) === tip) seg = g.slice(1);
            else if (key(g[g.length - 1]) === tip) seg = g.slice(0, -1).reverse();
            if (!seg) continue;
            chain = chain.concat(seg);
            used[j] = true;
            grew = true;
            break;
          }
        }
        chain.reverse();
      }
      out.push({ geom: chain, tags });
    }
    return out;
  }

  /* 4-souvislá úsečka: každý krok mění jen jednu souřadnici, takže se dá
     z cesty odvodit směr toku (flowDir zná jen čtyři sousedy). */
  function walkLine(x0, y0, x1, y1, cb) {
    let x = x0, y = y0;
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    cb(x, y);
    let guard = 0;
    while ((x !== x1 || y !== y1) && guard++ < 100000) {
      if (2 * err > -dy) { err -= dy; x += sx; } else { err += dx; y += sy; }
      cb(x, y);
    }
  }

  /* Reálný počet obyvatel je od stovek po miliony, hra počítá v tisících
     a rozumně si hraje mezi 4 a 60. Logaritmus rozdíly zkrotí, aby
     vesnice nebyla nula a velkoměsto nepřebilo všechno ostatní. */
  function gamePop(tags) {
    const raw = parseFloat(String(tags.population || '').replace(/[^\d.]/g, ''));
    let p = isFinite(raw) && raw > 0 ? raw
      : tags.place === 'city' ? 60000 : tags.place === 'town' ? 7000 : 700;
    const v = Math.round(4 + 10 * Math.log10(Math.max(120, p) / 120));
    return Math.max(4, Math.min(58, v));
  }

  function buildMapFromOSM(osm, opts) {
    const N = opts.size;
    const b = opts.bbox;
    const seed = (opts.seed | 0) || 1;
    const T = EG.T;
    const DIRS = EG.DIRS;
    const { fbm, hash2, mulberry32 } = EG.rng;
    const rand = mulberry32(seed);
    const idx = (x, y) => y * N + x;
    const areaScale = (N * N) / (160 * 160);

    const type = new Uint8Array(N * N).fill(T.GRASS);
    const elev = new Float32Array(N * N);
    const flow = new Float32Array(N * N);
    const flowDir = new Int8Array(N * N).fill(-1);
    const isForest = new Uint8Array(N * N);
    const isIndustry = new Uint8Array(N * N);

    // --- projekce: výřez je čtverec v metrech, takže stačí lineární škála ---
    const lonSpan = b.e - b.w || 1e-9;
    const latSpan = b.n - b.s || 1e-9;
    const PX = (lon) => (lon - b.w) / lonSpan * (N - 1);
    const PY = (lat) => (b.n - lat) / latSpan * (N - 1);
    const projRing = (ring) => ring.map(([lon, lat]) => [PX(lon), PY(lat)]);
    const projGeom = (g) => g.map((p) => [PX(p.lon), PY(p.lat)]);

    // --- výplň mnohoúhelníku (sudá/lichá pravidlo, po řádcích) ---
    const xsBuf = [];
    function fillPoly(pts, cb) {
      let minY = Infinity, maxY = -Infinity;
      for (const p of pts) {
        if (p[1] < minY) minY = p[1];
        if (p[1] > maxY) maxY = p[1];
      }
      const y0 = Math.max(0, Math.ceil(minY)), y1 = Math.min(N - 1, Math.floor(maxY));
      for (let y = y0; y <= y1; y++) {
        xsBuf.length = 0;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const a = pts[j], c = pts[i];
          if ((a[1] > y) !== (c[1] > y)) {
            xsBuf.push(a[0] + (y - a[1]) / (c[1] - a[1]) * (c[0] - a[0]));
          }
        }
        xsBuf.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xsBuf.length; k += 2) {
          const xa = Math.max(0, Math.ceil(xsBuf[k]));
          const xb = Math.min(N - 1, Math.floor(xsBuf[k + 1]));
          for (let x = xa; x <= xb; x++) cb(x, y);
        }
      }
    }

    function bbox2(pts) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of pts) {
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[1] > y1) y1 = p[1];
      }
      return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 };
    }
    const onMap = (bb) => !(bb.x1 < 0 || bb.y1 < 0 || bb.x0 > N - 1 || bb.y0 > N - 1);

    /* Plocha se vyplní i obtáhne. Samotná výplň bere jen dlaždice, jejichž
       střed padne dovnitř – úzký pás lesa podél cesty nebo rybník menší
       než dlaždice by tak zmizely úplně. Obtažení je udrží. */
    function stampArea(pts, cb) {
      const bb = bbox2(pts);
      if (!onMap(bb)) return;
      if (bb.w >= 1 && bb.h >= 1) fillPoly(pts, cb);
      const put = (x, y) => { if (x >= 0 && y >= 0 && x < N && y < N) cb(x, y); };
      for (let i = 1; i < pts.length; i++) {
        walkLine(Math.round(pts[i - 1][0]), Math.round(pts[i - 1][1]),
          Math.round(pts[i][0]), Math.round(pts[i][1]), put);
      }
    }

    // --- roztřídění prvků z Overpassu ---
    const waterPolys = [], riverLines = [], forestPolys = [], indPolys = [], railLines = [];
    const places = [];
    for (const el of osm.elements || []) {
      const tags = el.tags || {};
      if (el.type === 'node') {
        if (tags.name && /^(city|town|village)$/.test(tags.place || '')) {
          places.push({ x: PX(el.lon), y: PY(el.lat), name: tags.name, tags });
        }
        continue;
      }
      if (el.type === 'relation') {
        if (tags.natural === 'water' && Array.isArray(el.members)) {
          for (const ring of stitchRings(el.members, 'outer')) waterPolys.push(projRing(ring));
        }
        continue;
      }
      if (!Array.isArray(el.geometry) || el.geometry.length < 2) continue;
      const pts = projGeom(el.geometry);
      if (tags.waterway === 'river' || tags.waterway === 'canal') riverLines.push({ pts, tags });
      else if (tags.natural === 'water' || tags.landuse === 'reservoir') waterPolys.push(pts);
      else if (tags.natural === 'wood' || tags.landuse === 'forest') forestPolys.push(pts);
      else if (tags.landuse === 'industrial') indPolys.push({ pts, name: tags.name });
      else if (tags.railway === 'rail') railLines.push({ geom: el.geometry, tags });
    }

    // --- vodní plochy, pak lesy a průmysl ---
    let waterTiles = 0;
    for (const poly of waterPolys) {
      stampArea(poly, (x, y) => {
        const i = idx(x, y);
        if (type[i] !== T.WATER) { type[i] = T.WATER; waterTiles++; }
      });
    }
    for (const poly of forestPolys) stampArea(poly, (x, y) => { isForest[idx(x, y)] = 1; });
    for (const o of indPolys) stampArea(o.pts, (x, y) => { isIndustry[idx(x, y)] = 1; });

    /* --- řeky se kreslí až po jezerech ---
       Velké toky jsou v OSM zároveň plochou (břehy) i osou. Kdyby vyhrála
       plocha, zmizela by dlaždice typu RIVER a nešlo by na řeku postavit
       elektrárnu. Takhle zůstane uprostřed jezerního pásu koryto. */
    let riverTiles = 0;
    const dirOf = (dx, dy) => {
      for (let d = 0; d < DIRS.length; d++) if (DIRS[d][0] === dx && DIRS[d][1] === dy) return d;
      return -1;
    };
    for (const r of riverLines) {
      const pts = r.pts;
      let len = 0;
      for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      // delší tok = víc vody; kanál veze míň než řeka
      const base = (r.tags.waterway === 'canal' ? 2.5 : 4) + Math.min(6, len / 45);
      let f = base, prev = null, step = 0;
      const put = (x, y) => {
        if (x < 0 || y < 0 || x >= N || y >= N) { prev = null; return; }
        const i = idx(x, y);
        if (prev && (prev[0] !== x || prev[1] !== y)) {
          const d = dirOf(x - prev[0], y - prev[1]);
          if (d >= 0) flowDir[idx(prev[0], prev[1])] = d;
        }
        if (type[i] !== T.RIVER) riverTiles++;
        type[i] = T.RIVER;
        if (f > flow[i]) flow[i] = f;
        f = Math.min(15, f + 0.02);
        step++;
        prev = [x, y];
      };
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], c = pts[i];
        walkLine(Math.round(a[0]), Math.round(a[1]), Math.round(c[0]), Math.round(c[1]), put);
      }
    }

    /* --- výškopis ---
       Nejlepší je skutečný digitální model terénu. Nadmořské metry se
       převedou na herní 0..1 podle místního převýšení: rovina zůstane
       rovinou (žádné kopce z ničeho), hornatý kraj dostane i hory.
       Když model není, výšky se odhadnou z odstupu od vody – údolí
       u řek, kopce na rozvodích. */
    const heights = opts.elevation && opts.elevation.length === N * N ? opts.elevation : null;
    let relief = 0;
    if (heights) {
      const sample = [];
      for (let i = 0; i < N * N; i += 7) if (isFinite(heights[i])) sample.push(heights[i]);
      sample.sort((a, c) => a - c);
      const lo = sample[Math.floor(sample.length * 0.03)] || 0;
      const hi = sample[Math.floor(sample.length * 0.97)] || (lo + 1);
      relief = Math.max(1, hi - lo);
      /* Rozpětí herních výšek se řídí skutečným převýšením kraje: rovina
         zůstane rovinou (nedosáhne ani na kopce), pahorkatina dostane
         kopce na hřbetech a hornatý kraj i hory. Druhá mocnina drží
         vrcholky na malé ploše, jak to v krajině bývá. */
      const span = Math.min(1, relief / 900);
      const amp = 0.26 + 0.28 * span;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const i = idx(x, y);
          const norm = Math.max(0, Math.min(1, (heights[i] - lo) / relief));
          // i drobné zvlnění se řídí převýšením – na rovině není co vlnit
          const n = fbm(x / 30, y / 30, seed, 3) - 0.5;
          let e = 0.36 + amp * norm * norm + 0.04 * span * n;
          if (type[i] === T.WATER || type[i] === T.RIVER) e = 0.28;
          elev[i] = Math.max(0.02, Math.min(0.98, e));
        }
      }
    } else {
      const dist = new Float32Array(N * N).fill(-1);
      const queue = new Int32Array(N * N);
      let qHead = 0, qTail = 0;
      for (let i = 0; i < N * N; i++) {
        if (type[i] === T.WATER || type[i] === T.RIVER) { dist[i] = 0; queue[qTail++] = i; }
      }
      const hasWater = qTail > 0;
      let maxDist = 0;
      while (qHead < qTail) {
        const i = queue[qHead++];
        const x = i % N, y = (i / N) | 0;
        const d = dist[i] + 1;
        if (d > maxDist) maxDist = d;
        for (let k = 0; k < 4; k++) {
          const nx = x + DIRS[k][0], ny = y + DIRS[k][1];
          if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
          const j = idx(nx, ny);
          if (dist[j] >= 0) continue;
          dist[j] = d;
          queue[qTail++] = j;
        }
      }
      // škála podle skutečně nalezené vzdálenosti, jinak by hustá vodní
      // síť srovnala celou mapu do roviny
      const denom = Math.max(18, Math.min(60, maxDist));
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const i = idx(x, y);
          const nd = hasWater ? Math.min(1, Math.max(0, dist[i]) / denom) : 0.5;
          const n = fbm(x / 38, y / 38, seed, 4) - 0.5;
          // bez modelu terénu se dělají nanejvýš kopce; hory si vymýšlet nebudeme
          let e = 0.34 + 0.26 * nd + 0.18 * n;
          if (type[i] === T.WATER || type[i] === T.RIVER) e = 0.28;
          elev[i] = Math.max(0.02, Math.min(0.98, e));
        }
      }
    }

    /* --- povrch souše ---
       Nad hranicí lesa je holá skála, jinak má les z OSM přednost před
       kopcem: zalesněný hřbet je ve střední Evropě pravidlo a kreslit ho
       jako holý kopec by mapu ochudilo. Sklon zůstává ve výškopisu. */
    const noForestData = forestPolys.length === 0;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = idx(x, y);
        if (type[i] === T.WATER || type[i] === T.RIVER) continue;
        const e = elev[i];
        if (e > 0.74) type[i] = T.MOUNTAIN;
        else if (isForest[i]) type[i] = T.FOREST;
        else if (e > 0.63) type[i] = T.HILL;
        else if (noForestData && fbm(x / 23 + 500, y / 23 + 500, seed + 7777, 4) > 0.58) type[i] = T.FOREST;
        else type[i] = T.GRASS;
      }
    }
    // písek kolem vody
    for (let y = 1; y < N - 1; y++) {
      for (let x = 1; x < N - 1; x++) {
        const i = idx(x, y);
        if (type[i] !== T.GRASS && type[i] !== T.FOREST) continue;
        for (let d = 0; d < 4; d++) {
          if (type[idx(x + DIRS[d][0], y + DIRS[d][1])] === T.WATER) { type[i] = T.SAND; break; }
        }
      }
    }

    /* Skutečná sídla i podniky stojí i na svazích – blokuje je jen voda
       a holé skály. (Procedurální generátor je pro jednoduchost sázel
       jen do roviny, tady by se tím ztratila reálná města.) */
    const buildable = (x, y) => {
      const t = type[idx(x, y)];
      return t !== T.WATER && t !== T.RIVER && t !== T.MOUNTAIN;
    };
    // posun z vody na nejbližší souš (sídlo může vyjít doprostřed přehrady)
    function nudgeToLand(x, y, r) {
      if (buildable(x, y)) return [x, y];
      for (let k = 1; k <= r; k++) {
        for (let dy = -k; dy <= k; dy++) for (let dx = -k; dx <= k; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== k) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 1 || ny < 1 || nx >= N - 1 || ny >= N - 1) continue;
          if (buildable(nx, ny)) return [nx, ny];
        }
      }
      return null;
    }

    // --- města: z OSM, od největších, s minimálním odstupem ---
    const cities = [];
    const maxCities = Math.round(14 * areaScale);
    places.sort((p, q) => gamePop(q.tags) - gamePop(p.tags));
    for (const p of places) {
      if (cities.length >= maxCities) break;
      let x = Math.round(p.x), y = Math.round(p.y);
      if (x < 4 || y < 4 || x >= N - 4 || y >= N - 4) continue;
      const spot = nudgeToLand(x, y, 4);
      if (!spot) continue;
      x = spot[0]; y = spot[1];
      let tooClose = false;
      for (const c of cities) if (Math.abs(c.x - x) + Math.abs(c.y - y) < 10) { tooClose = true; break; }
      if (tooClose) continue;
      // charakter podle okolí: průmyslová zóna dělá průmyslové město
      let ind = 0;
      for (let ry = -6; ry <= 6; ry++) for (let rx = -6; rx <= 6; rx++) {
        const nx = x + rx, ny = y + ry;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        if (isIndustry[idx(nx, ny)]) ind++;
      }
      const pop = gamePop(p.tags);
      const kind = ind > 24 ? 'ind' : ind > 6 ? 'mix' : 'res';
      const needPerCap = kind === 'res' ? 0.8 + rand() * 0.3
        : kind === 'ind' ? 1.3 + rand() * 0.4
        : 1.0 + rand() * 0.3;
      const c = {
        x, y, pop, popBase: pop, kind, needPerCap, name: p.name,
        satisfaction: 1, unhappyTime: 0, houses: [],
      };
      const r = 2;
      for (let ry = -r; ry <= r; ry++) for (let rx = -r; rx <= r; rx++) {
        const nx = x + rx, ny = y + ry;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        if (buildable(nx, ny) && Math.abs(rx) + Math.abs(ry) <= r && hash2(nx, ny, seed + 99) < 0.75) {
          c.houses.push([nx, ny]);
        }
      }
      cities.push(c);
    }
    const citiesFromOSM = cities.length;

    // v pustině by nebylo co napájet – doplní se pár smyšlených sídel,
    // ale jen do hratelného minima, ať mapa zůstane hlavně skutečná
    let guard = 0;
    while (cities.length < 6 && guard++ < 40000) {
      const x = 8 + Math.floor(rand() * (N - 16));
      const y = 8 + Math.floor(rand() * (N - 16));
      if (!buildable(x, y)) continue;
      if (cities.some((c) => Math.abs(c.x - x) + Math.abs(c.y - y) < 24)) continue;
      const pop = 6 + Math.floor(rand() * 22);
      const kr = rand();
      const kind = kr < 0.4 ? 'res' : kr < 0.72 ? 'mix' : 'ind';
      const c = {
        x, y, pop, popBase: pop, kind,
        needPerCap: kind === 'res' ? 0.8 + rand() * 0.3 : kind === 'ind' ? 1.3 + rand() * 0.4 : 1.0 + rand() * 0.3,
        name: EG.CITY_NAMES[cities.length % EG.CITY_NAMES.length],
        satisfaction: 1, unhappyTime: 0, houses: [],
      };
      for (let ry = -2; ry <= 2; ry++) for (let rx = -2; rx <= 2; rx++) {
        const nx = x + rx, ny = y + ry;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        if (buildable(nx, ny) && Math.abs(rx) + Math.abs(ry) <= 2 && hash2(nx, ny, seed + 99) < 0.75) {
          c.houses.push([nx, ny]);
        }
      }
      cities.push(c);
    }

    // --- průmysl: skutečné průmyslové zóny, typ podle okolní krajiny ---
    const industries = [];
    const IND_DEFS = EG.IND_DEFS;
    const maxInd = Math.round(9 * areaScale);
    // podnik jen z areálu, který má v měřítku mapy vůbec nějakou plochu
    const zones = [];
    for (const o of indPolys) {
      const bb = bbox2(o.pts);
      if (!onMap(bb) || bb.w < 2 || bb.h < 2) continue;
      let sx = 0, sy = 0;
      for (const p of o.pts) { sx += p[0]; sy += p[1]; }
      zones.push({
        x: Math.round(sx / o.pts.length), y: Math.round(sy / o.pts.length),
        name: o.name, area: bb.w * bb.h,
      });
    }
    zones.sort((a, c) => c.area - a.area);
    for (const z of zones) {
      if (industries.length >= maxInd) break;
      if (z.x < 4 || z.y < 4 || z.x >= N - 4 || z.y >= N - 4) continue;
      const spot = nudgeToLand(z.x, z.y, 4);
      if (!spot) continue;
      const [x, y] = spot;
      if (cities.some((c) => Math.abs(c.x - x) + Math.abs(c.y - y) < 5)) continue;
      if (industries.some((o) => Math.abs(o.x - x) + Math.abs(o.y - y) < 10)) continue;
      if (cities.some((c) => c.houses.some(([hx, hy]) => hx === x && hy === y))) continue;
      let nearForest = false, nearHill = false, nearRiver = false;
      for (let ry = -3; ry <= 3; ry++) for (let rx = -3; rx <= 3; rx++) {
        const nx = x + rx, ny = y + ry;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const tt = type[idx(nx, ny)];
        if (tt === T.FOREST) nearForest = true;
        if (tt === T.HILL || tt === T.MOUNTAIN) nearHill = true;
        if (tt === T.RIVER) nearRiver = true;
      }
      const def = hash2(x, y, seed + 56) < 0.10 ? EG.STEEL_DEF
        : hash2(x, y, seed + 55) < 0.15 ? EG.DATA_DEF
        : nearHill ? IND_DEFS[0]
        : nearRiver ? IND_DEFS[3]
        : nearForest ? IND_DEFS[2]
        : IND_DEFS[1];
      const demand = def.demand[0] + rand() * (def.demand[1] - def.demand[0]);
      industries.push({
        x, y, type: def.type,
        name: def.label + ' ' + (z.name || def.names[Math.floor(rand() * def.names.length)]),
        demand, powered: 0, downTime: 0,
      });
    }
    const industriesFromOSM = industries.length;

    // --- tratě: skutečné koridory, jinak se dogenerují mezi městy ---
    const railways = [];
    const railTiles = [];
    const railSeen = new Set();
    const nearestCity = (x, y) => {
      let best = null, bd = Infinity;
      for (const c of cities) {
        const d = Math.hypot(c.x - x, c.y - y);
        if (d < bd) { bd = d; best = c; }
      }
      return best ? best.name : '?';
    };
    const corridors = chainWays(railLines).map((r) => {
      const pts = projGeom(r.geom);
      const path = [];
      const push = (x, y) => {
        if (x < 1 || y < 1 || x >= N - 1 || y >= N - 1) return;
        const last = path[path.length - 1];
        if (last && last[0] === x && last[1] === y) return;
        path.push([x, y]);
      };
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], c = pts[i];
        walkLine(Math.round(a[0]), Math.round(a[1]), Math.round(c[0]), Math.round(c[1]), push);
      }
      return { path, tags: r.tags };
    }).filter((c) => c.path.length >= 20);
    corridors.sort((a, c) => c.path.length - a.path.length);

    let railBudget = 7000; // ať scéna nemá desetitisíce segmentů kolejí
    for (const c of corridors) {
      if (railBudget <= 0 || railways.length >= 14) break;
      railBudget -= c.path.length;
      const a = c.path[0], z = c.path[c.path.length - 1];
      railways.push({
        name: c.tags.name || ('Trať ' + (railways.length + 1)),
        from: nearestCity(a[0], a[1]), to: nearestCity(z[0], z[1]), path: c.path,
      });
      for (const [x, y] of c.path) {
        const i = idx(x, y);
        if (!railSeen.has(i)) { railSeen.add(i); railTiles.push(i); }
      }
    }
    const railsFromOSM = railways.length;

    if (railways.length === 0 && cities.length >= 2) {
      // žádné tratě v datech: postaví se spojnice dvou nejvzdálenějších měst
      let A = cities[0], B = cities[1], bd = -1;
      for (let i = 0; i < cities.length; i++) for (let j = i + 1; j < cities.length; j++) {
        const d = Math.abs(cities[i].x - cities[j].x) + Math.abs(cities[i].y - cities[j].y);
        if (d > bd) { bd = d; A = cities[i]; B = cities[j]; }
      }
      const path = [];
      const steps = Math.max(1, Math.ceil(Math.hypot(B.x - A.x, B.y - A.y)));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = Math.round(A.x + (B.x - A.x) * t);
        const y = Math.round(A.y + (B.y - A.y) * t);
        if (x < 1 || y < 1 || x >= N - 1 || y >= N - 1) continue;
        const last = path[path.length - 1];
        if (!last || last[0] !== x || last[1] !== y) path.push([x, y]);
      }
      if (path.length >= 20) {
        railways.push({ name: 'Koridor A', from: A.name, to: B.name, path });
        for (const [x, y] of path) {
          const i = idx(x, y);
          if (!railSeen.has(i)) { railSeen.add(i); railTiles.push(i); }
        }
      }
    }

    // trakční napájecí stanice podél nejdelších koridorů
    for (let k = 0; k < Math.min(3, railways.length); k++) {
      const path = railways[k].path;
      const koridor = String.fromCharCode(65 + k);
      let n = 0;
      for (let i = 18; i < path.length - 14; i += 34) {
        const [sx, sy] = path[i];
        const t = type[idx(sx, sy)];
        if (t === T.WATER || t === T.RIVER) continue;
        if (cities.some((c) => Math.abs(c.x - sx) + Math.abs(c.y - sy) < 6)) continue;
        if (industries.some((o) => Math.abs(o.x - sx) + Math.abs(o.y - sy) < 8)) continue;
        industries.push({
          x: sx, y: sy, type: 'trakce',
          name: 'Trakční stanice ' + koridor + (++n),
          demand: 14 + rand() * 14, powered: 0, downTime: 0,
        });
      }
    }

    // --- geotermální pole a přeshraniční body (v OSM nejsou) ---
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

    const crossings = [];
    const X_NAMES = ['Sever', 'Východ', 'Jih', 'Západ', 'Sousední soustava'];
    const edges = [
      () => [3 + Math.floor(rand() * (N - 6)), 2],
      () => [N - 3, 3 + Math.floor(rand() * (N - 6))],
      () => [3 + Math.floor(rand() * (N - 6)), N - 3],
      () => [2, 3 + Math.floor(rand() * (N - 6))],
    ];
    const wantedX = Math.max(3, Math.round(3 * Math.sqrt(areaScale)));
    let xTries = 0;
    while (crossings.length < wantedX && xTries++ < 8000) {
      const [x, y] = edges[crossings.length % 4]();
      const t = type[idx(x, y)];
      if (t === T.WATER || t === T.RIVER || t === T.MOUNTAIN) continue;
      if (crossings.some((cr) => Math.abs(cr.x - x) + Math.abs(cr.y - y) < 40)) continue;
      crossings.push({ x, y, name: X_NAMES[crossings.length % X_NAMES.length] });
    }

    return {
      size: N, type, elev, flow, flowDir, cities, industries, crossings, geoFields,
      railways, railTiles, seed, T, idx,
      osm: {
        bbox: b,
        realElevation: !!heights, relief: Math.round(relief),
        waterTiles, riverTiles,
        cities: cities.length, citiesFromOSM,
        industries: industries.length, industriesFromOSM,
        railways: railways.length, railsFromOSM,
        forests: forestPolys.length,
        elements: (osm.elements || []).length,
      },
    };
  }

  EG.parsePlace = parsePlace;
  EG.bboxAround = bboxAround;
  EG.overpassQuery = overpassQuery;
  EG.fetchOSM = fetchOSM;
  EG.fetchElevation = fetchElevation;
  EG.terrainZoom = terrainZoom;
  EG.buildMapFromOSM = buildMapFromOSM;
  EG.chainWays = chainWays;
  EG.stitchRings = stitchRings;
  EG.gamePop = gamePop;
})();
