'use strict';
/* Rutas cerradas: trazado en planta + perfil de altitud. Todo en metros. */
(function () {
  const R = window.R;

  R.ROUTES_DEF = [
    {
      id: 'levante', name: 'Paseo de Levante', desc: 'Llano junto al mar', theme: 'coast', len: 18000, seed: 11,
      amps: [0.10, 0.05, 0.035, 0.02],
      pts: [[0, 10], [1.5, 13], [3, 8], [4.5, 16], [6, 22], [7.5, 14], [9, 8], [10.5, 12], [12, 19], [13.5, 11], [15, 7], [16.5, 12]]
    },
    {
      id: 'foia', name: 'Vuelta a la Foia', desc: 'Ondulado entre pinares', theme: 'hills', len: 24000, seed: 23,
      amps: [0.13, 0.06, 0.04, 0.025],
      pts: [[0, 650], [2, 688], [3.5, 668], [5, 718], [7, 762], [8.5, 734], [10, 700], [12, 746], [13.5, 792], [15, 760], [17, 712], [19, 682], [21, 702], [22.5, 664]]
    },
    {
      id: 'fraile', name: 'Puerto del Fraile', desc: '9 km de subida al 5,7 %', theme: 'mountain', len: 26000, seed: 37,
      amps: [0.16, 0.07, 0.05, 0.03],
      pts: [[0, 500], [2.5, 506], [5, 520], [7, 630], [9, 762], [11, 884], [13, 992], [14, 1030], [15, 1018], [17, 920], [19, 800], [21, 690], [23, 590], [24.5, 530]]
    }
  ];

  function buildRoute(def) {
    const L = def.len, STEP = 2, N = Math.round(L / STEP);
    const rnd = R.rng(def.seed);
    const ph = def.amps.map(() => rnd() * Math.PI * 2);
    // 1) Curva polar cerrada, de longitud L
    const K = 4000, raw = [];
    for (let i = 0; i <= K; i++) {
      const th = (i / K) * Math.PI * 2;
      let r = 1; def.amps.forEach((a, k) => { r += a * Math.sin((k + 2) * th + ph[k]); });
      raw.push([r * Math.cos(th), r * Math.sin(th)]);
    }
    const cum = [0];
    for (let i = 1; i <= K; i++) cum.push(cum[i - 1] + Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]));
    const scale = L / cum[K];
    const x = new Float32Array(N), z = new Float32Array(N), y = new Float32Array(N), g = new Float32Array(N), tx = new Float32Array(N), tz = new Float32Array(N);
    let j = 0;
    for (let i = 0; i < N; i++) {
      const s = (i * STEP) / scale;
      while (j < K - 1 && cum[j + 1] < s) j++;
      const t = (s - cum[j]) / (cum[j + 1] - cum[j] || 1);
      x[i] = (raw[j][0] + (raw[j + 1][0] - raw[j][0]) * t) * scale;
      z[i] = (raw[j][1] + (raw[j + 1][1] - raw[j][1]) * t) * scale;
    }
    // 2) Perfil: Hermite cúbico no uniforme y periódico
    const P = def.pts.map(p => [p[0] * 1000, p[1]]); const n = P.length;
    const pd = i => { const k = ((i % n) + n) % n; return P[k][0] + Math.floor(i / n) * L; };
    const pv = i => P[((i % n) + n) % n][1];
    const slope = i => (pv(i + 1) - pv(i - 1)) / (pd(i + 1) - pd(i - 1));
    let seg = 0;
    for (let i = 0; i < N; i++) {
      const d = i * STEP;
      while (seg < n - 1 && pd(seg + 1) <= d) seg++;
      const d0 = pd(seg), d1 = pd(seg + 1), h = d1 - d0, t = (d - d0) / h;
      const t2 = t * t, t3 = t2 * t;
      y[i] = (2 * t3 - 3 * t2 + 1) * pv(seg) + (t3 - 2 * t2 + t) * h * slope(seg) + (-2 * t3 + 3 * t2) * pv(seg + 1) + (t3 - t2) * h * slope(seg + 1);
    }
    // 3) Pendiente (ventana ±20 m) y rumbo
    const W = 10;
    for (let i = 0; i < N; i++) {
      const a = (i - W + N) % N, b = (i + W) % N;
      g[i] = ((y[b] - y[a]) / (2 * W * STEP)) * 100;
      const a1 = (i - 2 + N) % N, b1 = (i + 2) % N;
      const dx = x[b1] - x[a1], dz = z[b1] - z[a1], m = Math.hypot(dx, dz) || 1;
      tx[i] = dx / m; tz[i] = dz / m;
    }
    // 4) Altitud regional (media móvil ±1500 m) para el terreno lejano
    const RS = 20, RN = Math.round(L / RS), reg = new Float32Array(RN), half = Math.round(1500 / RS);
    for (let i = 0; i < RN; i++) {
      let s = 0, c = 0;
      for (let k = -half; k <= half; k += 3) { s += y[(((Math.round((i * RS) / STEP) + Math.round((k * RS) / STEP)) % N) + N) % N]; c++; }
      reg[i] = s / c;
    }
    let gain = 0, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < N; i++) { const dy = y[(i + 1) % N] - y[i]; if (dy > 0) gain += dy; minY = Math.min(minY, y[i]); maxY = Math.max(maxY, y[i]); }

    const route = {
      ...def, N, STEP, x, z, y, g, tx, tz, gain, minY, maxY,
      at(d) {
        d = ((d % L) + L) % L; const f = d / STEP; const i = Math.floor(f) % N, k = (i + 1) % N, t = f - Math.floor(f);
        return {
          x: x[i] + (x[k] - x[i]) * t, z: z[i] + (z[k] - z[i]) * t, y: y[i] + (y[k] - y[i]) * t,
          grade: g[i] + (g[k] - g[i]) * t, tx: tx[i] + (tx[k] - tx[i]) * t, tz: tz[i] + (tz[k] - tz[i]) * t
        };
      },
      elev(d) { d = ((d % L) + L) % L; const f = d / STEP; const i = Math.floor(f) % N, k = (i + 1) % N, t = f - Math.floor(f); return y[i] + (y[k] - y[i]) * t; },
      grade(d) { d = ((d % L) + L) % L; const i = Math.floor(d / STEP) % N; return g[i]; },
      regional(d) { d = ((d % L) + L) % L; const f = d / RS; const i = Math.floor(f) % RN, k = (i + 1) % RN, t = f - Math.floor(f); return reg[i] + (reg[k] - reg[i]) * t; }
    };
    // Punto más alto (para el arco de cima)
    let top = 0; for (let i = 0; i < N; i++) if (y[i] > y[top]) top = i;
    route.topD = top * STEP;
    return route;
  }

  const cache = {};
  R.getRoute = id => {
    if (!cache[id]) { const def = R.ROUTES_DEF.find(r => r.id === id) || R.ROUTES_DEF[0]; cache[id] = buildRoute(def); }
    return cache[id];
  };
})();
