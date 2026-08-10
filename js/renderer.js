/* WebGL2 izometrický renderer.
   Vše se kreslí na GPU instancovaně:
   - statický buffer terénu (nahraje se jednou, ~desítky tisíc instancí),
     ze kterého se každý snímek kreslí jen viditelný výřez
   - dynamický buffer budov/overlay (pár set instancí za snímek)
   - aditivní vrstva záře (světla měst v noci)
   - elektrická vedení jako instancované segmenty s animovaným tokem

   Barvu scény řeší shader: denní světlo, soumrak, noc i bouřka jsou
   jeden násobič a odbarvení, ne plachta přes celý obraz. Ve vysoké
   kvalitě jde obraz přes multisamplovaný framebuffer a bloom, takže
   světla a energetické pakety ve vedení opravdu září. */
(function () {
  'use strict';
  const EG = window.EG;
  const A = EG.atlas;

  const HW = 32, HH = 16; // iso poloosy v pixelech
  const MAX_DPR = 2;      // nad dvojnásobek už je to jen palivo pro GPU
  const BLOOM_DIV = 4;    // bloom se počítá ve čtvrtinovém rozlišení

  const SPRITE_VS = `#version 300 es
  layout(location=0) in vec2 aCorner;      // 0..1 roh quadu
  layout(location=1) in vec3 aPos;         // world px x, y, depth
  layout(location=2) in float aSprite;     // index do atlasu
  layout(location=3) in vec4 aTint;
  uniform vec2 uView;                      // velikost viewportu v px
  uniform vec2 uCam;                       // pozice kamery ve world px
  uniform float uZoom;
  uniform vec2 uCell;                      // velikost buňky atlasu v px
  uniform vec2 uAtlasGrid;                 // sloupce, řádky
  out vec2 vUV;
  out vec4 vTint;
  out vec2 vWorld;
  out float vWater;
  void main() {
    vec2 anchor = vec2(${A.AX}.0, ${A.AY}.0);
    vec2 local = aCorner * uCell - anchor;
    vec2 world = aPos.xy + local;
    vec2 screen = (world - uCam) * uZoom + uView * 0.5;
    vec2 clip = screen / uView * 2.0 - 1.0;
    gl_Position = vec4(clip.x, -clip.y, aPos.z, 1.0);
    float col = mod(aSprite, uAtlasGrid.x);
    float row = floor(aSprite / uAtlasGrid.x);
    vUV = (vec2(col, row) + aCorner) / uAtlasGrid;
    vTint = aTint;
    vWorld = world;
    // vodní hladiny se v pixel shaderu vlní; indexy bere z atlasu
    vWater = (aSprite == ${A.S.WATER}.0 || aSprite == ${A.S.RIVER}.0 ||
              aSprite == ${A.S.RESERVOIR}.0) ? 1.0 : 0.0;
  }`;

  const SPRITE_FS = `#version 300 es
  precision mediump float;
  in vec2 vUV;
  in vec4 vTint;
  in vec2 vWorld;
  in float vWater;
  uniform sampler2D uTex;
  uniform vec3 uLight;      // barva a síla světla (poledne ~1, noc modrá a tmavá)
  uniform float uDesat;     // za šera oko barvy nerozezná
  uniform float uTime;
  uniform float uWaterFx;   // třpyt hladiny (jen ve vysoké kvalitě)
  out vec4 outColor;
  void main() {
    vec4 t = texture(uTex, vUV);
    if (t.a < 0.01) discard;
    vec3 col = t.rgb * vTint.rgb;
    if (vWater > 0.5 && uWaterFx > 0.5) {
      // dvě interferující vlny -> nepravidelný třpyt, který se neopakuje
      float w = sin(vWorld.x * 0.055 + vWorld.y * 0.11 + uTime * 1.6)
              + sin(vWorld.x * 0.021 - vWorld.y * 0.043 + uTime * 0.9);
      col += vec3(0.045, 0.062, 0.085) * w;
    }
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(lum), uDesat);
    outColor = vec4(col * uLight, t.a * vTint.a);
  }`;

  // segment vedení: quad natažený mezi dva body, s animovanými „paketami" energie
  const LINE_VS = `#version 300 es
  layout(location=0) in vec2 aCorner;      // x: 0..1 podél, y: -1..1 napříč
  layout(location=1) in vec4 aSeg;         // x1,y1,x2,y2 world px
  layout(location=2) in vec4 aColor;
  layout(location=3) in vec2 aInfo;        // load 0..1, flowDir (-1/0/1)
  uniform vec2 uView;
  uniform vec2 uCam;
  uniform float uZoom;
  out vec4 vColor;
  out vec2 vInfo;
  out float vDist;                          // px podél segmentu
  out float vAcross;
  void main() {
    vec2 p1 = aSeg.xy, p2 = aSeg.zw;
    vec2 dir = normalize(p2 - p1);
    vec2 nrm = vec2(-dir.y, dir.x);
    float len = length(p2 - p1);
    float halfW = 2.2 / uZoom + 1.2;
    vec2 world = mix(p1, p2, aCorner.x) + nrm * aCorner.y * halfW;
    vec2 screen = (world - uCam) * uZoom + uView * 0.5;
    vec2 clip = screen / uView * 2.0 - 1.0;
    gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
    vColor = aColor;
    vInfo = aInfo;
    vDist = aCorner.x * len;
    vAcross = aCorner.y;
  }`;

  const LINE_FS = `#version 300 es
  precision mediump float;
  in vec4 vColor;
  in vec2 vInfo;
  in float vDist;
  in float vAcross;
  uniform float uTime;
  out vec4 outColor;
  void main() {
    float core = 1.0 - smoothstep(0.35, 1.0, abs(vAcross));
    vec4 c = vColor;
    // animované pakety energie ve směru toku
    if (vInfo.y != 0.0 && vInfo.x > 0.001) {
      float speed = 46.0 + 90.0 * vInfo.x;
      float ph = fract((vDist * vInfo.y - uTime * speed * vInfo.y) / 34.0);
      float pulse = smoothstep(0.22, 0.0, abs(ph - 0.5) - 0.08);
      c.rgb += pulse * vec3(0.9, 0.9, 0.5) * (0.35 + vInfo.x);
    }
    c.a *= (0.55 + 0.45 * core);
    outColor = c;
  }`;

  /* Celoobrazovkový trojúhelník bez bufferu – rohy se dopočítají
     z gl_VertexID, takže postprocess nepotřebuje žádná data. */
  const FULL_VS = `#version 300 es
  out vec2 vUV;
  void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    vUV = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  const BRIGHT_FS = `#version 300 es
  precision mediump float;
  in vec2 vUV;
  uniform sampler2D uTex;
  uniform float uThreshold;
  out vec4 outColor;
  void main() {
    vec3 c = texture(uTex, vUV).rgb;
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    float k = max(0.0, l - uThreshold) / max(0.0001, 1.0 - uThreshold);
    outColor = vec4(c * k, 1.0);
  }`;

  const BLUR_FS = `#version 300 es
  precision mediump float;
  in vec2 vUV;
  uniform sampler2D uTex;
  uniform vec2 uStep;        // texel krát směr rozmazání
  out vec4 outColor;
  const float W[5] = float[5](0.227027, 0.194595, 0.121622, 0.054054, 0.016216);
  void main() {
    vec3 c = texture(uTex, vUV).rgb * W[0];
    for (int i = 1; i < 5; i++) {
      c += texture(uTex, vUV + uStep * float(i)).rgb * W[i];
      c += texture(uTex, vUV - uStep * float(i)).rgb * W[i];
    }
    outColor = vec4(c, 1.0);
  }`;

  const COMPOSITE_FS = `#version 300 es
  precision mediump float;
  in vec2 vUV;
  uniform sampler2D uScene;
  uniform sampler2D uBloom;
  uniform float uStrength;
  out vec4 outColor;
  void main() {
    vec3 s = texture(uScene, vUV).rgb;
    vec3 b = texture(uBloom, vUV).rgb;
    outColor = vec4(s + b * uStrength, 1.0);
  }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('Shader: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('Program: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  function isoX(x, y) { return (x - y) * HW; }
  function isoY(x, y) { return (x + y) * HH; }

  /* Vrstva instancovaných spritů: osm floatů na kus (pozice, hloubka,
     index do atlasu, barva). Roste podle potřeby. */
  function SpriteLayer(cap) {
    this.data = new Float32Array(8 * cap);
    this.count = 0;
  }

  SpriteLayer.prototype.push = function (wx, wy, sprite, r, g, b, a) {
    if (this.count * 8 >= this.data.length) {
      const bigger = new Float32Array(this.data.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    const o = this.count * 8;
    const d = this.data;
    d[o] = wx; d[o + 1] = wy; d[o + 2] = 0;
    d[o + 3] = sprite;
    d[o + 4] = r === undefined ? 1 : r;
    d[o + 5] = g === undefined ? 1 : g;
    d[o + 6] = b === undefined ? 1 : b;
    d[o + 7] = a === undefined ? 1 : a;
    this.count++;
  };

  function Renderer(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 není k dispozici');
    this.gl = gl;
    this.canvas = canvas;
    this.cam = { x: 0, y: 0, zoom: 1 };
    this.quality = 'high';
    this.light = { r: 1, g: 1, b: 1, desat: 0 };
    this.clearColor = [0.09, 0.12, 0.16];
    this.frame = 0; // počítadlo vykreslených snímků
    this.stats = { terrain: 0, sprites: 0, glows: 0, lines: 0, draws: 0, terrainTotal: 0 };

    // atlas -> textura
    const atlasCanvas = A.build();
    this.atlasCanvas = atlasCanvas;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.tex = tex;

    this.spriteProg = program(gl, SPRITE_VS, SPRITE_FS);
    this.lineProg = program(gl, LINE_VS, LINE_FS);
    this.uS = {
      view: gl.getUniformLocation(this.spriteProg, 'uView'),
      cam: gl.getUniformLocation(this.spriteProg, 'uCam'),
      zoom: gl.getUniformLocation(this.spriteProg, 'uZoom'),
      cell: gl.getUniformLocation(this.spriteProg, 'uCell'),
      grid: gl.getUniformLocation(this.spriteProg, 'uAtlasGrid'),
      tex: gl.getUniformLocation(this.spriteProg, 'uTex'),
      light: gl.getUniformLocation(this.spriteProg, 'uLight'),
      desat: gl.getUniformLocation(this.spriteProg, 'uDesat'),
      time: gl.getUniformLocation(this.spriteProg, 'uTime'),
      waterFx: gl.getUniformLocation(this.spriteProg, 'uWaterFx'),
    };
    this.uL = {
      view: gl.getUniformLocation(this.lineProg, 'uView'),
      cam: gl.getUniformLocation(this.lineProg, 'uCam'),
      zoom: gl.getUniformLocation(this.lineProg, 'uZoom'),
      time: gl.getUniformLocation(this.lineProg, 'uTime'),
    };

    // sdílený quad
    const quad = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    this.quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

    const lineQuad = new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]);
    this.lineQuadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineQuadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, lineQuad, gl.STATIC_DRAW);

    // VAO statického terénu
    this.terrainVAO = gl.createVertexArray();
    this.terrainBuf = gl.createBuffer();
    this.terrainCount = 0;
    this.terrainDiag = null;
    this._setupSpriteVAO(this.terrainVAO, this.terrainBuf);

    // VAO dynamických spritů
    this.dynVAO = gl.createVertexArray();
    this.dynBuf = gl.createBuffer();
    this._setupSpriteVAO(this.dynVAO, this.dynBuf);
    this.dyn = new SpriteLayer(4096);

    // VAO aditivní záře (světla v noci)
    this.glowVAO = gl.createVertexArray();
    this.glowBuf = gl.createBuffer();
    this._setupSpriteVAO(this.glowVAO, this.glowBuf);
    this.glow = new SpriteLayer(2048);

    // VAO vedení
    this.lineVAO = gl.createVertexArray();
    this.lineBuf = gl.createBuffer();
    gl.bindVertexArray(this.lineVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineQuadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    const lstride = 10 * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, lstride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, lstride, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, lstride, 32);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
    this.lineData = new Float32Array(10 * 4096);
    this.lineCount = 0;

    this._initPost();

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  /* Postprocess: programy, prázdné VAO pro celoobrazovkový trojúhelník
     a zjištění, kolik vzorků multisamplingu karta zvládne. */
  Renderer.prototype._initPost = function () {
    const gl = this.gl;
    this.postVAO = gl.createVertexArray();
    this.brightProg = program(gl, FULL_VS, BRIGHT_FS);
    this.blurProg = program(gl, FULL_VS, BLUR_FS);
    this.compProg = program(gl, FULL_VS, COMPOSITE_FS);
    this.uB = {
      tex: gl.getUniformLocation(this.brightProg, 'uTex'),
      threshold: gl.getUniformLocation(this.brightProg, 'uThreshold'),
    };
    this.uBl = {
      tex: gl.getUniformLocation(this.blurProg, 'uTex'),
      step: gl.getUniformLocation(this.blurProg, 'uStep'),
    };
    this.uC = {
      scene: gl.getUniformLocation(this.compProg, 'uScene'),
      bloom: gl.getUniformLocation(this.compProg, 'uBloom'),
      strength: gl.getUniformLocation(this.compProg, 'uStrength'),
    };
    const maxSamples = gl.getParameter(gl.MAX_SAMPLES) || 0;
    this.samples = Math.min(4, maxSamples);
    this.targets = null;
    this.bloomStrength = 1.05;
    this.bloomThreshold = 0.70;
  };

  Renderer.prototype.setQuality = function (q) {
    this.quality = q === 'low' ? 'low' : 'high';
    if (this.quality === 'low') this._freeTargets();
    return this.quality;
  };

  Renderer.prototype.setLight = function (r, g, b, desat) {
    this.light.r = r; this.light.g = g; this.light.b = b;
    this.light.desat = desat;
  };

  Renderer.prototype.setClearColor = function (r, g, b) {
    this.clearColor[0] = r; this.clearColor[1] = g; this.clearColor[2] = b;
  };

  Renderer.prototype._setupSpriteVAO = function (vao, instBuf) {
    const gl = this.gl;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    const stride = 8 * 4; // x,y,depth,sprite,r,g,b,a
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 12);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
  };

  /* Nahraje terén jako statické instance, seřazené podle hloubky.
     Vedle dat se ukládá i rejstřík diagonál (x+y): instance jedné
     diagonály leží v bufferu za sebou a uvnitř diagonály klesá
     world X, takže viditelný výřez je vždycky souvislý úsek. */
  Renderer.prototype.uploadTerrain = function (map, tintFn) {
    const gl = this.gl;
    const N = map.size;
    const S = A.S;
    const T = EG.T;
    const data = new Float32Array(8 * N * N);
    const nDiag = 2 * N - 1;
    const start = new Int32Array(nDiag);
    const len = new Int32Array(nDiag);
    let n = 0;
    // pořadí kreslení podle (x+y) => procházet diagonály
    for (let s = 0; s <= 2 * (N - 1); s++) {
      const y0 = Math.max(0, s - (N - 1));
      const y1 = Math.min(N - 1, s);
      start[s] = n;
      len[s] = y1 - y0 + 1;
      for (let y = y0; y <= y1; y++) {
        const x = s - y;
        const t = map.type[map.idx(x, y)];
        let sprite;
        switch (t) {
          case T.WATER: sprite = S.WATER; break;
          case T.SAND: sprite = S.SAND; break;
          case T.GRASS: sprite = S.GRASS; break;
          case T.FOREST: sprite = S.FOREST; break;
          case T.HILL: sprite = S.HILL; break;
          case T.MOUNTAIN: sprite = S.MOUNTAIN; break;
          case T.RIVER: sprite = S.RIVER; break;
          default: sprite = S.RESERVOIR;
        }
        const o = n * 8;
        data[o] = isoX(x, y); data[o + 1] = isoY(x, y); data[o + 2] = 0;
        data[o + 3] = sprite;
        const tint = tintFn ? tintFn(x, y) : 1;
        data[o + 4] = tint; data[o + 5] = tint; data[o + 6] = tint; data[o + 7] = 1;
        n++;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.terrainCount = n;
    this.terrainDiag = { start, len, n: nDiag, size: N };
  };

  /* Viditelný výřez ve world px. Sprity mimo něj se vůbec neposílají na
     GPU – při velkých mapách jde o stovky zbytečných quadů za snímek,
     u terénu o desetitisíce dlaždic. Rezerva pokrývá vysoké sprity
     (kotva je 80 px nad spodním okrajem buňky) i dekorace kreslené
     s posunem o zlomek dlaždice. */
  Renderer.prototype._updateCull = function () {
    const halfW = this.canvas.clientWidth / 2 / this.cam.zoom;
    const halfH = this.canvas.clientHeight / 2 / this.cam.zoom;
    this.cull = {
      x0: this.cam.x - halfW - 64, x1: this.cam.x + halfW + 64,
      y0: this.cam.y - halfH - 48, y1: this.cam.y + halfH + 112,
    };
  };

  Renderer.prototype.beginDynamic = function () {
    this.dyn.count = 0; this.glow.count = 0; this.lineCount = 0;
    this._updateCull();
  };

  Renderer.prototype._pushTo = function (layer, gx, gy, sprite, r, g, b, a) {
    const wx = isoX(gx, gy), wy = isoY(gx, gy);
    const c = this.cull;
    if (c && (wx < c.x0 || wx > c.x1 || wy < c.y0 || wy > c.y1)) return;
    layer.push(wx, wy, sprite, r, g, b, a);
  };

  Renderer.prototype.pushSprite = function (gx, gy, sprite, r, g, b, a) {
    this._pushTo(this.dyn, gx, gy, sprite, r, g, b, a);
  };

  /* Záře se kreslí aditivně a bez ohledu na denní světlo – lampa svítí
     stejně silně, ať je kolem tma jakákoli. Bloom si ji pak rozmaže. */
  Renderer.prototype.pushGlow = function (gx, gy, sprite, r, g, b, a) {
    this._pushTo(this.glow, gx, gy, sprite, r, g, b, a);
  };

  Renderer.prototype.pushLine = function (gx1, gy1, gx2, gy2, r, g, b, a, load, flowDir) {
    const x1 = isoX(gx1, gy1), y1 = isoY(gx1, gy1);
    const x2 = isoX(gx2, gy2), y2 = isoY(gx2, gy2);
    // segment mimo výřez se nekreslí – železniční koridory jdou přes celou mapu
    const c = this.cull;
    if (c && (Math.max(x1, x2) < c.x0 || Math.min(x1, x2) > c.x1 ||
              Math.max(y1, y2) < c.y0 || Math.min(y1, y2) > c.y1)) return;
    if (this.lineCount * 10 >= this.lineData.length) {
      const bigger = new Float32Array(this.lineData.length * 2);
      bigger.set(this.lineData); this.lineData = bigger;
    }
    const o = this.lineCount * 10;
    const d = this.lineData;
    d[o] = x1; d[o + 1] = y1;
    d[o + 2] = x2; d[o + 3] = y2;
    d[o + 4] = r; d[o + 5] = g; d[o + 6] = b; d[o + 7] = a;
    d[o + 8] = load; d[o + 9] = flowDir;
    this.lineCount++;
  };

  /* --- postprocess: cíle vykreslování --- */

  Renderer.prototype._freeTargets = function () {
    const gl = this.gl;
    const t = this.targets;
    if (!t) return;
    for (const fb of [t.msFbo, t.sceneFbo, t.fboA, t.fboB]) if (fb) gl.deleteFramebuffer(fb);
    for (const tx of [t.sceneTex, t.texA, t.texB]) if (tx) gl.deleteTexture(tx);
    if (t.msColor) gl.deleteRenderbuffer(t.msColor);
    this.targets = null;
  };

  Renderer.prototype._makeTex = function (w, h) {
    const gl = this.gl;
    const tx = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tx);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tx, 0);
    return { tex: tx, fbo: fb };
  };

  Renderer.prototype._ensureTargets = function (w, h) {
    const t = this.targets;
    if (t && t.w === w && t.h === h) return t;
    this._freeTargets();
    const gl = this.gl;
    const bw = Math.max(1, Math.floor(w / BLOOM_DIV));
    const bh = Math.max(1, Math.floor(h / BLOOM_DIV));
    const scene = this._makeTex(w, h);
    const a = this._makeTex(bw, bh);
    const b = this._makeTex(bw, bh);
    const out = {
      w, h, bw, bh,
      sceneTex: scene.tex, sceneFbo: scene.fbo,
      texA: a.tex, fboA: a.fbo,
      texB: b.tex, fboB: b.fbo,
      msFbo: null, msColor: null,
    };
    // multisampling: hrany diagonálních vedení bez něj kostrbatí
    if (this.samples > 1) {
      const rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.RGBA8, w, h);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
        out.msFbo = fb; out.msColor = rb;
      } else {
        gl.deleteFramebuffer(fb); gl.deleteRenderbuffer(rb);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.targets = out;
    return out;
  };

  /* --- kreslení --- */

  /* Terén: kreslí se jen diagonály (x+y), které zasahují do výřezu,
     a uvnitř každé jen souvislý úsek dlaždic ve vodorovném okně.
     Z ~100 tisíc instancí tak zbude řádově tisíc. */
  Renderer.prototype._drawTerrain = function () {
    const gl = this.gl;
    const dg = this.terrainDiag;
    this.stats.terrain = 0;
    this.stats.terrainTotal = this.terrainCount;
    if (!dg || this.terrainCount === 0) return;
    const c = this.cull;
    const N = dg.size;
    // svislý rozsah -> rozsah diagonál (world Y = (x+y) * HH)
    let s0 = Math.floor(c.y0 / HH) - 1;
    let s1 = Math.ceil(c.y1 / HH) + 1;
    if (s0 < 0) s0 = 0;
    if (s1 > dg.n - 1) s1 = dg.n - 1;
    if (s1 < s0) return;

    gl.bindVertexArray(this.terrainVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainBuf);
    const stride = 8 * 4;
    let drawn = 0, draws = 0;
    for (let s = s0; s <= s1; s++) {
      const y0 = Math.max(0, s - (N - 1));
      // world X = (s - 2y) * HW klesá s rostoucím y -> okno v y
      let ya = Math.ceil((s - c.x1 / HW) / 2);
      let yb = Math.floor((s - c.x0 / HW) / 2);
      if (ya < y0) ya = y0;
      const yMax = y0 + dg.len[s] - 1;
      if (yb > yMax) yb = yMax;
      if (yb < ya) continue;
      const first = dg.start[s] + (ya - y0);
      const count = yb - ya + 1;
      const off = first * stride;
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, off);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, off + 12);
      gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, off + 16);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      drawn += count;
      draws++;
    }
    this.stats.terrain = drawn;
    this.stats.draws += draws;
  };

  Renderer.prototype._drawScene = function (w, h, time) {
    const gl = this.gl;
    const zoom = this.cam.zoom * this._dpr;
    const L = this.light;
    const hq = this.quality === 'high';

    gl.clearColor(this.clearColor[0], this.clearColor[1], this.clearColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.stats.draws = 0;

    gl.useProgram(this.spriteProg);
    gl.uniform2f(this.uS.view, w, h);
    gl.uniform2f(this.uS.cam, this.cam.x, this.cam.y);
    gl.uniform1f(this.uS.zoom, zoom);
    gl.uniform2f(this.uS.cell, A.CELL_W, A.CELL_H);
    gl.uniform2f(this.uS.grid, A.COLS, A.ROWS);
    gl.uniform1f(this.uS.time, time);
    gl.uniform1f(this.uS.waterFx, hq ? 1 : 0);
    gl.uniform3f(this.uS.light, L.r, L.g, L.b);
    gl.uniform1f(this.uS.desat, L.desat);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.uS.tex, 0);

    this._drawTerrain();

    // vedení (pod budovami)
    this.stats.lines = this.lineCount;
    if (this.lineCount > 0) {
      gl.useProgram(this.lineProg);
      gl.uniform2f(this.uL.view, w, h);
      gl.uniform2f(this.uL.cam, this.cam.x, this.cam.y);
      gl.uniform1f(this.uL.zoom, zoom);
      gl.uniform1f(this.uL.time, time);
      gl.bindVertexArray(this.lineVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.lineData.subarray(0, this.lineCount * 10), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.lineCount);
      this.stats.draws++;
    }

    // dynamické sprity
    this.stats.sprites = this.dyn.count;
    if (this.dyn.count > 0) {
      gl.useProgram(this.spriteProg);
      gl.bindVertexArray(this.dynVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.dynBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.dyn.data.subarray(0, this.dyn.count * 8), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.dyn.count);
      this.stats.draws++;
    }

    // záře: aditivně a bez denního světla, ať lampa svítí i v poledne
    this.stats.glows = this.glow.count;
    if (this.glow.count > 0) {
      gl.useProgram(this.spriteProg);
      gl.uniform3f(this.uS.light, 1, 1, 1);
      gl.uniform1f(this.uS.desat, 0);
      gl.uniform1f(this.uS.waterFx, 0);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.bindVertexArray(this.glowVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.glowBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.glow.data.subarray(0, this.glow.count * 8), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.glow.count);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      this.stats.draws++;
    }
    gl.bindVertexArray(null);
  };

  Renderer.prototype._blit = function (prog) {
    const gl = this.gl;
    gl.useProgram(prog);
    gl.bindVertexArray(this.postVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.stats.draws++;
  };

  Renderer.prototype.render = function (time) {
    const gl = this.gl;
    const canvas = this.canvas;
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    this._dpr = dpr;
    const w = Math.floor(canvas.clientWidth * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
    }
    if (w === 0 || h === 0) return;
    this._updateCull();
    this.frame++;

    if (this.quality !== 'high') {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      this._drawScene(w, h, time);
      return;
    }

    const t = this._ensureTargets(w, h);
    // 1) scéna do (multisamplovaného) framebufferu
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.msFbo || t.sceneFbo);
    gl.viewport(0, 0, w, h);
    this._drawScene(w, h, time);
    if (t.msFbo) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.msFbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.sceneFbo);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }

    // 2) jasné pixely do čtvrtinového rozlišení
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fboA);
    gl.viewport(0, 0, t.bw, t.bh);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.sceneTex);
    gl.useProgram(this.brightProg);
    gl.uniform1i(this.uB.tex, 0);
    gl.uniform1f(this.uB.threshold, this.bloomThreshold);
    this._blit(this.brightProg);

    // 3) separabilní rozmazání (vodorovně, pak svisle)
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fboB);
    gl.bindTexture(gl.TEXTURE_2D, t.texA);
    gl.useProgram(this.blurProg);
    gl.uniform1i(this.uBl.tex, 0);
    gl.uniform2f(this.uBl.step, 1 / t.bw, 0);
    this._blit(this.blurProg);

    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fboA);
    gl.bindTexture(gl.TEXTURE_2D, t.texB);
    gl.uniform2f(this.uBl.step, 0, 1 / t.bh);
    this._blit(this.blurProg);

    // 4) složení na plátno
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.compProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.sceneTex);
    gl.uniform1i(this.uC.scene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, t.texA);
    gl.uniform1i(this.uC.bloom, 1);
    gl.uniform1f(this.uC.strength, this.bloomStrength);
    this._blit(this.compProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.BLEND);
    gl.bindVertexArray(null);
  };

  // převod obrazovka -> dlaždice
  /* přesná (neceločíselná) pozice v dlaždicích – např. pro trefu na vedení */
  Renderer.prototype.screenToTileF = function (px, py) {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const wx = (px - w / 2) / this.cam.zoom + this.cam.x;
    const wy = (py - h / 2) / this.cam.zoom + this.cam.y;
    const gx = (wx / HW + wy / HH) / 2;
    const gy = (wy / HH - wx / HW) / 2;
    return [gx, gy];
  };

  Renderer.prototype.screenToTile = function (px, py) {
    const [gx, gy] = this.screenToTileF(px, py);
    return [Math.round(gx), Math.round(gy)];
  };

  Renderer.prototype.tileToWorld = function (gx, gy) {
    return [isoX(gx, gy), isoY(gx, gy)];
  };

  EG.Renderer = Renderer;
  EG.iso = { isoX, isoY, HW, HH };
  EG.MAX_DPR = MAX_DPR;
  EG.BLOOM_DIV = BLOOM_DIV;
})();
