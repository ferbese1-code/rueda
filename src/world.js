'use strict';
/* Mundo 3D con Three.js: carretera, terreno, vegetación, arcos y ciclistas */
(function () {
  const R = window.R;
  const W = (R.world = {});
  const THEMES = {
    coast: {
      sky: [0x2f7fd6, 0xbfe2f7], fog: 0xcfe8f6, near: 5, mid: 22, far: 80, far2: 170, s: 1.3,
      grass: [0x8fae5a, 0x6f9a48], shoulder: 0xc8b48a, rock: 0x9b8f80, coast: true, snow: 1e9,
      trees: 1200, houses: 180, palms: 260
    },
    hills: {
      sky: [0x3a86d8, 0xcfe6f5], fog: 0xd6e9f3, near: 9, mid: 38, far: 130, far2: 280, s: 2.7,
      grass: [0x7fa04c, 0x5f8a3c], shoulder: 0xc2ad84, rock: 0x9a8d7c, coast: false, snow: 1e9,
      trees: 2600, houses: 90, palms: 0
    },
    mountain: {
      sky: [0x2a6fc9, 0xd2e7f6], fog: 0xd8e8f2, near: 16, mid: 70, far: 260, far2: 560, s: 4.1,
      grass: [0x6f9446, 0x557c38], shoulder: 0xb9a37c, rock: 0x8c8378, coast: false, snow: 1350,
      trees: 2800, houses: 25, palms: 0
    }
  };
  const OFFS = [-1200, -700, -400, -260, -140, -70, -30, -14, -6, 6, 14, 30, 70, 140, 260, 400, 700, 1200];

  let renderer, scene, camera, sky, routeGroup, route, theme, quality = 'alta';
  let camPos = null;
  const FOV = 58, AHEAD = 10, LOOKY = 0.8;
  let fitD = 4.8, fitH = 2.0, frame = null; // zona libre (px desde arriba) entre los paneles
  const riders = new Map();
  const UP = new THREE.Vector3(0, 1, 0);
  const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3();

  W.init = canvas => {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(60, 1, 0.3, 4200);
    scene.add(new THREE.HemisphereLight(0xdcecff, 0x4a5f36, 0.62));
    const sun = new THREE.DirectionalLight(0xfff0d6, 0.62); sun.position.set(-0.6, 1, 0.35); scene.add(sun);
    W.setQuality(R.store.get('settings', {}).quality || 'alta');
    window.addEventListener('resize', W.resize);
  };
  W.setQuality = q => {
    quality = q;
    if (renderer) renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q === 'alta' ? 2 : q === 'media' ? 1.5 : 1));
    W.resize();
  };
  W.resize = () => {
    if (!renderer) return;
    const c = renderer.domElement, w = c.clientWidth || window.innerWidth, h = c.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false); fitCamera();
  };
  W.setFrame = (top, bottom) => { frame = { top, bottom }; fitCamera(); };
  W.debugCam = () => ({ fitD, fitH, frame, fov: camera.fov, aspect: camera.aspect, view: camera.view && { ...camera.view } });

  /* Metas volantes (dos como máximo: la que acabas de cruzar y la siguiente).
     Como el horizonte queda bajo el panel central, lo importante va en el asfalto: una franja a cuadros
     en el punto exacto del cambio y, antes, el siguiente bloque pintado en el suelo y alargado como una
     marca vial. El arco es bajo y se ve al acercarte. */
  const gatePool = [];
  const BASIS = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0));
  function flat(across, along, mat) { const g = new THREE.PlaneGeometry(across, along); g.applyMatrix4(BASIS); const m = new THREE.Mesh(g, mat); m.rotation.order = 'YZX'; return m; }
  function decal(tex) { return new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }); }
  /* La carretera pintada del color del siguiente bloque a partir de la línea (sigue las curvas) */
  const STRIP_L = 80, STRIP_N = 40;
  function makeStrip(tex) {
    const pos = new Float32Array((STRIP_N + 1) * 6), uv = new Float32Array((STRIP_N + 1) * 4), idx = [];
    for (let i = 0; i <= STRIP_N; i++) { const v = i / STRIP_N; uv.set([0, v, 1, v], i * 4); if (i < STRIP_N) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); } }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx);
    const m = new THREE.Mesh(g, decal(tex)); m.frustumCulled = false; m.renderOrder = 1; return m;
  }
  function placeStrip(m, d0) {
    const pos = m.geometry.attributes.position.array;
    for (let i = 0; i <= STRIP_N; i++) {
      const s = route.at(d0 + (i / STRIP_N) * STRIP_L), nx = -s.tz, nz = s.tx;
      pos.set([s.x - nx * 3.95, s.y + 0.03, s.z - nz * 3.95, s.x + nx * 3.95, s.y + 0.03, s.z + nz * 3.95], i * 6);
    }
    m.geometry.attributes.position.needsUpdate = true; m.visible = true;
  }
  function makeGate() {
    const mk = (w, h) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const tex = new THREE.CanvasTexture(cv); tex.anisotropy = 8; return { cv, tex }; };
    const beamC = mk(1024, 160), bandC = mk(512, 64), textC = mk(1024, 220), stripC = mk(4, 256);
    const arch = new THREE.Group(); arch.rotation.order = 'YZX';
    const postM = new THREE.MeshLambertMaterial({ color: 0x1d2630 }), postG = new THREE.BoxGeometry(0.35, 4.0, 0.35);
    [-4.7, 4.7].forEach(z => { const p = new THREE.Mesh(postG, postM); p.position.set(0, 2.0, z); arch.add(p); });
    const side = new THREE.MeshLambertMaterial({ color: 0xffffff }), face = new THREE.MeshBasicMaterial({ map: beamC.tex });
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.3, 9.75), [face, face, side, side, side, side]);
    beam.position.set(0, 3.55, 0); arch.add(beam);
    const band = flat(8.2, 1.8, decal(bandC.tex)), text = flat(7.0, 13, decal(textC.tex)), strip = makeStrip(stripC.tex);
    band.renderOrder = 2; text.renderOrder = 3;
    [arch, band, text, strip].forEach(o => { o.visible = false; scene.add(o); });
    return { arch, band, text, strip, beamC, bandC, textC, stripC, side, key: '' };
  }
  function drawGate(gt, label, color) {
    let x = gt.beamC.cv.getContext('2d'), W2 = 1024, H = 160;
    x.fillStyle = color; x.fillRect(0, 0, W2, H);
    x.fillStyle = 'rgba(10,15,20,.88)'; x.fillRect(0, 0, W2, 50);
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = '#fff'; x.font = 'italic 800 38px "Saira Condensed", "Arial Narrow", sans-serif'; x.fillText('META VOLANTE', W2 / 2, 27);
    x.fillStyle = '#0a0f14'; x.font = '800 92px "Saira Condensed", "Arial Narrow", sans-serif'; x.fillText(label, W2 / 2, 50 + (H - 50) / 2 + 4);
    gt.beamC.tex.needsUpdate = true; gt.side.color.set(color);
    // Franja a cuadros
    x = gt.bandC.cv.getContext('2d');
    for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) { x.fillStyle = (i + j) % 2 ? '#ffffff' : color; x.fillRect(i * 32, j * 32, 32, 32); }
    gt.bandC.tex.needsUpdate = true;
    // Texto en el asfalto
    x = gt.textC.cv.getContext('2d'); x.clearRect(0, 0, 1024, 220);
    x.textAlign = 'center'; x.textBaseline = 'middle'; x.font = '800 150px "Saira Condensed", "Arial Narrow", sans-serif';
    x.lineJoin = 'round'; x.lineWidth = 18; x.strokeStyle = 'rgba(10,15,20,.75)'; x.strokeText(label, 512, 116);
    x.fillStyle = '#ffffff'; x.fillText(label, 512, 116);
    gt.textC.tex.needsUpdate = true;
    // Degradado del color de la zona: fuerte en la línea, se desvanece a lo lejos
    x = gt.stripC.cv.getContext('2d'); x.clearRect(0, 0, 4, 256);
    const gr = x.createLinearGradient(0, 0, 0, 256); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,1)');
    x.fillStyle = color; x.fillRect(0, 0, 4, 256); x.globalCompositeOperation = 'destination-in'; x.fillStyle = gr; x.fillRect(0, 0, 4, 256); x.globalCompositeOperation = 'source-over';
    gt.strip.material.opacity = 0.62; gt.stripC.tex.needsUpdate = true;
  }
  function placeAt(o, d, lift) {
    const s = route.at(d);
    o.position.set(s.x, s.y + lift, s.z); o.rotation.set(0, Math.atan2(-s.tz, s.tx), Math.atan(s.grade / 100)); o.visible = true;
  }
  W.setGates = list => {
    if (!scene || !route) return;
    while (gatePool.length < list.length) gatePool.push(makeGate());
    gatePool.forEach((gt, i) => {
      const it = list[i];
      if (!it) { gt.arch.visible = gt.band.visible = gt.text.visible = gt.strip.visible = false; return; }
      if (gt.key !== it.key) { drawGate(gt, it.text, it.color); gt.key = it.key; }
      placeAt(gt.arch, it.d, 0); placeAt(gt.band, it.d, 0.045); placeStrip(gt.strip, it.d + 0.9);
      if (it.passed) gt.text.visible = false; else placeAt(gt.text, it.d + 9, 0.05);
    });
  };


  /* Encuadre fijo: el horizonte justo bajo el panel central, el ciclista abajo (más cerca de ti) y,
     entre los dos, la carretera que viene, donde se ve llegar la meta volante. Se busca la distancia y
     la altura de la cámara que lo consiguen y se coloca con un desplazamiento de óptica. */
  function fitCamera() {
    if (!renderer) return;
    const c = renderer.domElement, w = c.clientWidth || window.innerWidth, h = Math.max(1, c.clientHeight || window.innerHeight);
    camera.fov = FOV; camera.aspect = w / h; camera.clearViewOffset();
    if (!frame || frame.bottom - frame.top < 60) { fitD = 4.8; fitH = 2.0; camera.updateProjectionMatrix(); return; }
    const box = frame.bottom - frame.top, wantRider = box * 0.68, wantSpan = box * 0.95;
    const cam = new THREE.PerspectiveCamera(FOV, w / h, 0.3, 5000), head = new THREE.Vector3(), foot = new THREE.Vector3(), far = new THREE.Vector3();
    const Y = v => (1 - v.y) / 2 * h;
    let best = null;
    for (let D = 2.6; D <= 14; D += 0.2) {
      for (let H = 1.6; H <= 6; H += 0.1) {
        cam.position.set(-D, H, 0); cam.lookAt(AHEAD, LOOKY, 0); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
        const hy = Y(head.set(0.42, 1.6, 0).project(cam)), fy = Y(foot.set(-0.6, 0, 0).project(cam)), zy = Y(far.set(4000, H, 0).project(cam));
        const err = Math.abs(fy - hy - wantRider) + Math.abs(fy - zy - wantSpan);
        if (!best || err < best.err) best = { D, H, err, fy };
      }
    }
    fitD = best.D; fitH = best.H;
    const s = R.clamp(frame.bottom - box * 0.03 - best.fy, -0.45 * h, 0.45 * h), a = Math.abs(s), full = h + 2 * a;
    camera.fov = 2 * Math.atan(Math.tan(FOV * Math.PI / 360) * full / h) * 180 / Math.PI;
    camera.aspect = w / full;
    camera.setViewOffset(w, full, 0, s >= 0 ? 0 : 2 * a, w, h);
    camera.updateProjectionMatrix();
  }

  function noise(d, off, s) {
    return 0.5 + 0.25 * Math.sin(d / 310 + off / 170 + s) + 0.15 * Math.sin(d / 97 - off / 53 + s * 2.1) + 0.1 * Math.sin(d / 41 + off / 29 + s * 3.7);
  }
  function terrainH(d, off) {
    const a = Math.abs(off);
    const road = route.elev(d);
    if (a < 6.5) return road - 0.1;
    const w = R.smoothstep(260, 700, a);
    const base = R.lerp(road, route.regional(d), w);
    let amp;
    if (a < 140) amp = theme.near * R.smoothstep(6, 140, a);
    else if (a < 260) amp = R.lerp(theme.near, theme.mid, (a - 140) / 120);
    else if (a < 700) amp = R.lerp(theme.mid, theme.far, (a - 260) / 440);
    else amp = R.lerp(theme.far, theme.far2, R.clamp((a - 700) / 500, 0, 1));
    let h = base + amp * noise(d, off, theme.s) - 0.1;
    if (theme.coast && off < 0) h = R.lerp(h, -9 - 0.012 * a, R.smoothstep(14, 150, a));
    return h;
  }

  function ensureUp(geom) {
    geom.computeVertexNormals();
    const n = geom.attributes.normal.array; let sum = 0;
    for (let i = 1; i < n.length; i += 3 * 50) sum += n[i];
    if (sum < 0) {
      const idx = geom.index.array;
      for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
      geom.index.needsUpdate = true; geom.computeVertexNormals();
    }
    return geom;
  }

  function ribbon(step, offA, offB, yOff, color, polyOff) {
    const n = Math.ceil(route.len / step);
    const pos = new Float32Array((n + 1) * 6), idx = [];
    for (let i = 0; i <= n; i++) {
      const s = route.at(i * step), nx = -s.tz, nz = s.tx;
      pos.set([s.x + nx * offA, s.y + yOff, s.z + nz * offA, s.x + nx * offB, s.y + yOff, s.z + nz * offB], i * 6);
      if (i < n) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(idx); ensureUp(g);
    const m = new THREE.MeshLambertMaterial({ color });
    if (polyOff) { m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -2; }
    return new THREE.Mesh(g, m);
  }

  function buildTerrain() {
    const step = 10, n = Math.ceil(route.len / step), C = OFFS.length;
    const pos = new Float32Array((n + 1) * C * 3), col = new Float32Array((n + 1) * C * 3), idx = [];
    const cA = new THREE.Color(theme.grass[0]), cB = new THREE.Color(theme.grass[1]), cS = new THREE.Color(theme.shoulder),
      cR = new THREE.Color(theme.rock), cSand = new THREE.Color(0xe2cd98), cWet = new THREE.Color(0xa99067), cSnow = new THREE.Color(0xf4f7fa), c = new THREE.Color();
    for (let i = 0; i <= n; i++) {
      const d = i * step, s = route.at(d), nx = -s.tz, nz = s.tx;
      for (let k = 0; k < C; k++) {
        const off = OFFS[k], a = Math.abs(off), h = terrainH(d, off), p = (i * C + k) * 3;
        pos[p] = s.x + nx * off; pos[p + 1] = h; pos[p + 2] = s.z + nz * off;
        const nn = noise(d * 1.7, off * 1.3, theme.s + 5);
        c.copy(cA).lerp(cB, nn);
        const rel = h - s.y;
        if (rel > theme.far * 0.45) c.lerp(cR, R.smoothstep(theme.far * 0.45, theme.far * 0.9, rel));
        if (h > theme.snow) c.lerp(cSnow, R.smoothstep(theme.snow, theme.snow + 120, h));
        if (a < 15) c.lerp(cS, 0.75);
        if (theme.coast && off < 0) { if (h < 0.4) c.copy(cWet); else if (h < 3) c.copy(cSand); }
        col[p] = c.r; col[p + 1] = c.g; col[p + 2] = c.b;
        if (i < n && k < C - 1) { const a0 = i * C + k; idx.push(a0, a0 + C, a0 + 1, a0 + 1, a0 + C, a0 + C + 1); }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx); ensureUp(g);
    return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
  }

  function buildSky() {
    const g = new THREE.SphereGeometry(3800, 24, 12), top = new THREE.Color(theme.sky[0]), hor = new THREE.Color(theme.sky[1]);
    const p = g.attributes.position, col = new Float32Array(p.count * 3), c = new THREE.Color();
    for (let i = 0; i < p.count; i++) { const t = R.clamp(p.getY(i) / 3800, 0, 1); c.copy(hor).lerp(top, Math.pow(t, 0.55)); col.set([c.r, c.g, c.b], i * 3); }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    m.renderOrder = -1; return m;
  }

  function instanced(geo, mat, count) {
    const n = Math.max(1, count), m = new THREE.InstancedMesh(geo, mat, n);
    const col = new Float32Array(n * 3).fill(1); m.instanceColor = new THREE.InstancedBufferAttribute(col, 3);
    m.count = 0; return m;
  }

  function scatter() {
    const rnd = R.rng(route.seed * 97 + 3), mult = quality === 'baja' ? 0.45 : quality === 'media' ? 0.75 : 1;
    const nT = Math.round(theme.trees * mult), nH = Math.round(theme.houses * mult), nP = Math.round(theme.palms * mult);
    const coneG = new THREE.ConeGeometry(1, 1, 7); coneG.translate(0, 0.5, 0);
    const trunkG = new THREE.CylinderGeometry(0.1, 0.16, 1, 5); trunkG.translate(0, 0.5, 0);
    const ballG = new THREE.IcosahedronGeometry(1, 0);
    const white = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const pines = instanced(coneG, white, nT), trunks = instanced(trunkG, new THREE.MeshLambertMaterial({ color: 0x6b4d33 }), nT + nP), balls = instanced(ballG, white, nT + nP);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3(), E = new THREE.Euler(), C = new THREE.Color();
    const put = (mesh, x, y, z, sx, sy, sz, yaw, color) => {
      E.set(0, yaw || 0, 0); Q.setFromEuler(E); P.set(x, y, z); S.set(sx, sy, sz); M.compose(P, Q, S);
      mesh.setMatrixAt(mesh.count, M); if (color != null) mesh.setColorAt(mesh.count, C.set(color)); mesh.count++;
    };
    const posAt = (d, off) => { const s = route.at(d); return [s.x - s.tz * off, terrainH(d, off), s.z + s.tx * off, s]; };
    for (let i = 0; i < nT; i++) {
      const d = rnd() * route.len, side = rnd() < 0.5 ? -1 : 1;
      if (theme.coast && side < 0) continue;
      const off = side * (9 + Math.pow(rnd(), 2.3) * 190);
      const [x, y, z] = posAt(d, off); const sc = 0.7 + rnd() * 0.9;
      if (rnd() < (theme.coast ? 0.35 : 0.68)) {
        put(trunks, x, y, z, sc, 2.2 * sc, sc, 0);
        put(pines, x, y + 1.4 * sc, z, 1.9 * sc, 6.5 * sc, 1.9 * sc, rnd() * 6, [0x2f5a2c, 0x3a6b33, 0x284e27][i % 3]);
      } else {
        put(trunks, x, y, z, sc, 1.8 * sc, sc, 0);
        put(balls, x, y + 2.6 * sc, z, 2.2 * sc, 1.9 * sc, 2.2 * sc, rnd() * 6, [0x6d8f3a, 0x7d9a45, 0x5d7f33, 0x8a9a4a][i % 4]);
      }
    }
    for (let i = 0; i < nP; i++) { // palmeras junto al paseo
      const d = rnd() * route.len, off = -(7.5 + rnd() * 5);
      const [x, y, z] = posAt(d, off); const sc = 0.9 + rnd() * 0.5;
      put(trunks, x, y, z, 0.7 * sc, 7 * sc, 0.7 * sc, 0);
      put(balls, x, y + 7 * sc, z, 2.6 * sc, 0.9 * sc, 2.6 * sc, rnd() * 6, 0x4f8a3a);
    }
    routeGroup.add(pines, trunks, balls);
    if (nH > 0) {
      const boxG = new THREE.BoxGeometry(1, 1, 1); boxG.translate(0, 0.5, 0);
      const roofG = new THREE.ConeGeometry(0.75, 0.45, 4); roofG.rotateY(Math.PI / 4); roofG.translate(0, 0.225, 0);
      const walls = instanced(boxG, white, nH), roofs = instanced(roofG, new THREE.MeshLambertMaterial({ color: 0xffffff }), nH);
      for (let i = 0; i < nH; i++) {
        const d = rnd() * route.len, off = 22 + rnd() * 70;
        const [x, y, z, s] = posAt(d, off); const yaw = Math.atan2(-s.tz, s.tx);
        const w = 7 + rnd() * 6, dp = 7 + rnd() * 5, h = 3 + Math.floor(rnd() * 2) * 3;
        put(walls, x, y - 0.3, z, w, h, dp, yaw, [0xf6f1e7, 0xf3e6cf, 0xffffff, 0xeedcc0][i % 4]);
        put(roofs, x, y - 0.3 + h, z, w * 1.12, 3.2, dp * 1.12, yaw, [0xb5532f, 0xa8492b, 0xc0623a][i % 3]);
      }
      routeGroup.add(walls, roofs);
    }
    routeGroup.children.filter(o => o.isInstancedMesh).forEach(m => { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; });
  }

  function textTexture(text, bg, fg) {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 128;
    const x = c.getContext('2d'); x.fillStyle = bg; x.fillRect(0, 0, 1024, 128);
    x.fillStyle = fg; x.font = '800 84px "Saira Condensed", "Arial Narrow", sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(text, 512, 68);
    const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return t;
  }
  function arch(d, text, bg, fg) {
    const s = route.at(d), g = new THREE.Group();
    const postM = new THREE.MeshLambertMaterial({ color: 0x23303c });
    const postG = new THREE.BoxGeometry(0.7, 6.6, 0.7);
    [-5.4, 5.4].forEach(zz => { const p = new THREE.Mesh(postG, postM); p.position.set(0, 3.3, zz); g.add(p); });
    const tex = textTexture(text, bg, fg), plain = new THREE.MeshLambertMaterial({ color: new THREE.Color(bg) });
    const faceA = new THREE.MeshLambertMaterial({ map: tex }), faceB = new THREE.MeshLambertMaterial({ map: tex });
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.5, 11.6), [faceA, faceB, plain, plain, plain, plain]);
    beam.position.set(0, 6.4, 0); g.add(beam);
    tex.center.set(0.5, 0.5);
    g.position.set(s.x, s.y, s.z); g.rotation.set(0, Math.atan2(-s.tz, s.tx), 0);
    routeGroup.add(g);
  }

  W.buildRoute = r => {
    route = r; theme = THEMES[r.theme] || THEMES.hills;
    if (routeGroup) { scene.remove(routeGroup); routeGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
    routeGroup = new THREE.Group(); scene.add(routeGroup);
    scene.background = new THREE.Color(theme.fog);
    scene.fog = new THREE.Fog(theme.fog, 320, 2600);
    if (sky) scene.remove(sky);
    sky = buildSky(); scene.add(sky);
    routeGroup.add(buildTerrain());
    routeGroup.add(ribbon(4, -4.1, 4.1, 0, 0x3b4048));
    routeGroup.add(ribbon(4, -0.24, -0.11, 0.02, 0xf2c230, true));
    routeGroup.add(ribbon(4, 0.11, 0.24, 0.02, 0xf2c230, true));
    routeGroup.add(ribbon(4, -3.85, -3.7, 0.02, 0xf4f4f0, true));
    routeGroup.add(ribbon(4, 3.7, 3.85, 0.02, 0xf4f4f0, true));
    if (theme.coast) {
      const water = new THREE.Mesh(new THREE.PlaneGeometry(16000, 16000), new THREE.MeshPhongMaterial({ color: 0x2c84b8, shininess: 80, specular: 0x9ac8e6 }));
      water.rotation.x = -Math.PI / 2; water.position.y = 0; routeGroup.add(water);
    }
    scatter();
    arch(30, 'SALIDA · META', '#1b2530', '#ffb22e');
    if (r.maxY - r.minY > 150) arch(r.topD, 'CIMA · ' + Math.round(r.maxY) + ' m', '#ffffff', '#c8232c');
    camPos = null;
  };

  /* ---------- Ciclista ---------- */
  function limb(mat, r) { const g = new THREE.CylinderGeometry(r, r * 0.85, 1, 6); return new THREE.Mesh(g, mat); }
  function placeLimb(mesh, a, b) {
    tmpV.subVectors(b, a); const len = tmpV.length();
    mesh.position.copy(a).addScaledVector(tmpV, 0.5); mesh.scale.set(1, len, 1);
    mesh.quaternion.setFromUnitVectors(UP, tmpV.normalize());
  }
  function makeRider(jersey, label) {
    const g = new THREE.Group(); g.rotation.order = 'YZX';
    const body = new THREE.Group(); g.add(body);
    const M = c => new THREE.MeshLambertMaterial({ color: c });
    const mJ = M(jersey), mBlack = M(0x15191e), mSkin = M(0xd9a27c), mFrame = M(0x1c242c), mTire = M(0x111111), mHelm = M(0xf3f3f3), mShoe = M(0xf5f5f5);
    const wheels = [];
    [[-0.5, 0.34], [0.5, 0.34]].forEach(([x, y]) => {
      const w = new THREE.Group(); w.position.set(x, y, 0);
      w.add(new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.025, 6, 24), mTire));
      for (let k = 0; k < 3; k++) { const sp = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.012, 0.012), M(0xb8c0c8)); sp.rotation.z = (k * Math.PI) / 3; w.add(sp); }
      body.add(w); wheels.push(w);
    });
    const V = (x, y, z = 0) => new THREE.Vector3(x, y, z);
    const tube = (a, b, r = 0.022) => { const m = limb(mFrame, r); placeLimb(m, a, b); body.add(m); };
    const BB = V(0, 0.3), RA = V(-0.5, 0.34), ST = V(-0.13, 0.86), HT = V(0.42, 0.9), HB = V(0.45, 0.76), FA = V(0.5, 0.34);
    tube(BB, RA); tube(BB, ST); tube(ST, RA, 0.016); tube(ST, HT); tube(BB, HB, 0.03); tube(HB, FA, 0.02); tube(HB, HT, 0.03);
    const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.04, 0.12), mBlack); saddle.position.set(-0.15, 0.94, 0); body.add(saddle);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.42, 6), mFrame); bar.rotation.x = Math.PI / 2; bar.position.set(0.48, 0.93, 0); body.add(bar);
    // Torso, cabeza y brazos
    const HIP = V(-0.1, 0.99), SH = V(0.3, 1.3);
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1, 0.36), mJ); placeLimb(torso, HIP, SH); body.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), mSkin); head.position.set(0.43, 1.42, 0); body.add(head);
    const helm = new THREE.Mesh(new THREE.SphereGeometry(0.125, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), mHelm); helm.position.set(0.42, 1.45, 0); helm.rotation.z = -0.35; body.add(helm);
    [0.18, -0.18].forEach(zz => {
      const up = limb(mJ, 0.045); placeLimb(up, V(0.3, 1.28, zz), V(0.42, 1.08, zz * 1.05)); body.add(up);
      const fo = limb(mSkin, 0.035); placeLimb(fo, V(0.42, 1.08, zz * 1.05), V(0.5, 0.94, 0.2 * Math.sign(zz))); body.add(fo);
    });
    // Piernas (IK de dos segmentos)
    const legs = [0.11, -0.11].map(zz => {
      const thigh = limb(mBlack, 0.06), shin = limb(mSkin, 0.042), shoe = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 0.08), mShoe);
      body.add(thigh, shin, shoe); return { zz, thigh, shin, shoe };
    });
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.75, 16), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2; shadow.scale.set(1.5, 0.55, 1); shadow.position.y = 0.03; g.add(shadow);
    let tag = null;
    if (label) {
      const c = document.createElement('canvas'); c.width = 256; c.height = 64; const x = c.getContext('2d');
      x.fillStyle = 'rgba(12,18,24,.75)'; x.fillRect(0, 8, 256, 48); x.fillStyle = '#fff'; x.font = '700 30px "Saira Condensed", sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(label, 128, 33);
      tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: true, transparent: true }));
      tag.scale.set(1.6, 0.4, 1); tag.position.set(0, 2.05, 0); g.add(tag);
    }
    const L1 = 0.43, L2 = 0.45, CR = 0.17, hip = new THREE.Vector3(), knee = new THREE.Vector3(), foot = new THREE.Vector3();
    return {
      group: g, tag,
      pose(crank, wheel) {
        wheels.forEach(w => { w.rotation.z = wheel; });
        legs.forEach((l, i) => {
          const a = crank + (i ? Math.PI : 0);
          foot.set(BB.x + CR * Math.cos(a), BB.y + CR * Math.sin(a), l.zz);
          hip.set(HIP.x, HIP.y, l.zz);
          const dx = foot.x - hip.x, dy = foot.y - hip.y; let d = Math.hypot(dx, dy); d = Math.min(d, L1 + L2 - 0.001);
          const phi = Math.atan2(dy, dx), al = Math.acos(R.clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
          knee.set(hip.x + L1 * Math.cos(phi + al), hip.y + L1 * Math.sin(phi + al), l.zz);
          placeLimb(l.thigh, hip, knee); placeLimb(l.shin, knee, foot);
          l.shoe.position.set(foot.x + 0.03, foot.y - 0.02, l.zz);
        });
      }
    };
  }

  W.syncRiders = (player, bots) => {
    const want = new Set(['me', ...bots.list.map(b => 'b' + b.id)]);
    for (const [k, v] of riders) if (!want.has(k)) { scene.remove(v.group); riders.delete(k); }
    if (!riders.has('me')) { const r = makeRider(player.jersey || '#ff7a1a', null); riders.set('me', r); scene.add(r.group); }
    bots.list.forEach(b => { const k = 'b' + b.id; if (!riders.has(k)) { const r = makeRider(b.jersey, b.name); riders.set(k, r); scene.add(r.group); } });
  };
  W.setPlayerJersey = color => { const r = riders.get('me'); if (r) { scene.remove(r.group); riders.delete('me'); } };

  function placeRider(r, d, off, crank, wheel) {
    const s = route.at(d);
    r.group.position.set(s.x - s.tz * off, s.y, s.z + s.tx * off);
    r.group.rotation.set(0, Math.atan2(-s.tz, s.tx), Math.atan(s.grade / 100));
    r.pose(crank, wheel);
  }

  W.render = (player, bots, dt) => {
    if (!renderer || !route) return;
    const me = riders.get('me');
    if (me) placeRider(me, player.d, player.lane, player.crank, player.wheel);
    bots.list.forEach(b => {
      const r = riders.get('b' + b.id); if (!r) return;
      const gap = b.d - player.d, vis = Math.abs(gap) < 420;
      r.group.visible = vis;
      if (vis) { placeRider(r, b.d, b.lane, b.crank, b.wheel); if (r.tag) r.tag.visible = Math.abs(gap) < 60 && Math.abs(gap) > 2; }
    });
    const lane = player.lane, s = route.at(player.d - fitD), t = route.at(player.d + AHEAD);
    tmpV2.set(s.x - s.tz * lane, s.y + fitH, s.z + s.tx * lane);
    if (!camPos) camPos = tmpV2.clone(); else camPos.copy(tmpV2);
    camera.position.copy(camPos); camera.lookAt(t.x - t.tz * lane, t.y + LOOKY, t.z + t.tx * lane);
    if (sky) sky.position.copy(camera.position);
    renderer.render(scene, camera);
  };
})();
