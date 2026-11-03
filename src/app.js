'use strict';
/* Pantallas, bucle principal, HUD, resumen, ajustes e historial */
(function () {
  const R = window.R, $ = R.$, W = R.world;
  const DEF = { name: 'Fernando', ftp: 235, weight: 62, bike: 8, jersey: '#ff7a1a', difficulty: 50, powerSource: 'trainer', powerMatch: true, quality: 'alta', beep: true };
  let set = { ...DEF, ...R.store.get('settings', {}) };
  const saveSet = () => R.store.set('settings', set);

  const dev = { trainer: new R.Trainer(), hrm: new R.HRM(), pm: new R.PowerMeter(), sim: new R.SimTrainer() };
  let demo = false;
  const trainer = () => (demo ? dev.sim : dev.trainer);

  let selMode = R.store.get('mode', 'workout');
  let selWorkout = R.store.get('workout', 'z23cv');
  let selRoute = R.store.get('route', 'foia');

  /* ---------- Datos en vivo ---------- */
  const live = {
    power() {
      if (set.powerSource === 'pm' && dev.pm.fresh()) return dev.pm.data.power;
      const t = trainer(); return t.fresh() ? t.data.power : 0;
    },
    cadence() {
      if (dev.pm.fresh() && dev.pm.data.cadence > 0) return dev.pm.data.cadence;
      const t = trainer(); return t.fresh() ? t.data.cadence : 0;
    },
    hr() {
      if (dev.hrm.fresh()) return dev.hrm.data.hr;
      const t = trainer(); return t.fresh() && t.data.hr ? t.data.hr : 0;
    }
  };

  /* ---------- Estado de la salida ---------- */
  let ride = null, lastFrame = performance.now(), hudT = 0, profT = 0, glReady = false;

  function newRide() {
    const route = R.getRoute(selRoute);
    const wdef = selMode === 'workout' ? R.allWorkouts().find(w => w.id === selWorkout) : null;
    return {
      running: true, paused: false, route, run: wdef ? new R.WorkoutRun(wdef) : null, wdef,
      player: { d: 0, v: 0, mass: set.weight + set.bike, lane: 1.8, crank: 0, wheel: 0, jersey: set.jersey },
      bots: new R.Bots(10, (Date.now() & 0xffff) + 1),
      elapsed: 0, lastSec: -1, gain: 0, kj: 0, sumP: 0, n: 0, accP: 0, accT: 0,
      pEma: 0, cad: 0, hr: 0, erg: true, pmRatio: 1, start: Date.now(), samples: R.newSamples(),
      lastLeftSec: null, savedAt: 0
    };
  }

  /* ---------- Inicio ---------- */
  function showScreen(id) { ['home', 'ride', 'summary'].forEach(s => { $('#' + s).hidden = s !== id; }); }

  function renderDevices() {
    const map = { trainer: trainer(), hrm: dev.hrm, pm: dev.pm };
    Object.entries(map).forEach(([k, d]) => {
      const el = $('#dev-' + k); if (!el) return;
      el.className = 'dev ' + (d.status || 'off');
      const st = el.querySelector('.dstate'), btn = el.querySelector('.dbtn');
      const idle = { trainer: 'Sin conectar', hrm: 'Opcional', pm: 'Opcional (pedales)' }[k];
      const txt = { on: d.name || 'Conectado', connecting: 'Conectando…', lost: 'Reconectando…', off: idle }[d.status || 'off'];
      st.textContent = k === 'trainer' && demo ? 'Simulador activo' : (k === 'trainer' && d.status === 'on' && d.kind ? `${d.name} · ${d.kind === 'ftms' ? 'FTMS' : d.kind === 'fec' ? 'FE-C' : 'prueba'}` : txt);
      btn.textContent = d.status === 'on' ? 'Desconectar' : 'Conectar';
      btn.disabled = k === 'trainer' && demo;
    });
    renderStartInfo();
  }

  function drawWorkoutThumb(cv, w) {
    const dpr = Math.min(2, window.devicePixelRatio || 1), cw = cv.clientWidth || 260, ch = cv.clientHeight || 46;
    cv.width = cw * dpr; cv.height = ch * dpr; const x = cv.getContext('2d'); x.scale(dpr, dpr);
    const st = R.flattenWorkout(w), tot = st.reduce((a, s) => a + s.dur, 0) || 1;
    const fr = s => (s.free ? 0.55 : s.abs ? s.p1 / set.ftp : s.p1), fr2 = s => (s.free ? 0.55 : s.abs ? s.p2 / set.ftp : s.p2);
    const max = Math.max(1.3, ...st.map(s => Math.max(fr(s), fr2(s))));
    let t = 0;
    st.forEach(s => {
      const x0 = (t / tot) * cw, x1 = ((t + s.dur) / tot) * cw, h0 = (fr(s) / max) * ch, h1 = (fr2(s) / max) * ch;
      x.fillStyle = s.free ? '#55606b' : R.zc((fr(s) + fr2(s)) / 2);
      x.beginPath(); x.moveTo(x0, ch); x.lineTo(x0, ch - h0); x.lineTo(Math.max(x0 + 0.6, x1 - 0.4), ch - h1); x.lineTo(Math.max(x0 + 0.6, x1 - 0.4), ch); x.fill();
      t += s.dur;
    });
  }
  function drawRouteThumb(cv, r) {
    const dpr = Math.min(2, window.devicePixelRatio || 1), cw = cv.clientWidth || 260, ch = cv.clientHeight || 46;
    cv.width = cw * dpr; cv.height = ch * dpr; const x = cv.getContext('2d'); x.scale(dpr, dpr);
    const lo = r.minY - 5, hi = Math.max(r.maxY, lo + 60), n = 160;
    x.beginPath(); x.moveTo(0, ch);
    for (let i = 0; i <= n; i++) { const d = (i / n) * r.len; x.lineTo((i / n) * cw, ch - ((r.elev(d) - lo) / (hi - lo)) * (ch - 4)); }
    x.lineTo(cw, ch); x.closePath();
    const g = x.createLinearGradient(0, 0, 0, ch); g.addColorStop(0, 'rgba(98,182,255,.85)'); g.addColorStop(1, 'rgba(98,182,255,.12)');
    x.fillStyle = g; x.fill();
  }

  function renderWorkouts() {
    const box = $('#workoutList'); box.innerHTML = '';
    R.allWorkouts().forEach(w => {
      const st = R.workoutStats(w, set.ftp);
      const c = document.createElement('button'); c.type = 'button'; c.className = 'card' + (w.id === selWorkout ? ' sel' : '');
      c.innerHTML = `<h3>${R.esc(w.name)}</h3><p>${R.esc(w.desc || '')}</p><canvas></canvas><div class="meta"><span>${Math.round(st.dur / 60)}<i>min</i></span><span>${st.tss}<i>TSS</i></span><span>${st.steps}<i>bloques</i></span></div>${w.custom ? '<span class="del" role="button" aria-label="Borrar entrenamiento">×</span>' : ''}`;
      c.addEventListener('click', e => {
        if (e.target.classList.contains('del')) {
          if (c.dataset.confirm) { R.store.set('customWorkouts', R.store.get('customWorkouts', []).filter(x => x.id !== w.id)); if (selWorkout === w.id) selWorkout = 'z23cv'; renderWorkouts(); }
          else { c.dataset.confirm = '1'; e.target.textContent = '¿Borrar?'; setTimeout(() => { delete c.dataset.confirm; e.target.textContent = '×'; }, 2500); }
          return;
        }
        selWorkout = w.id; R.store.set('workout', w.id); renderWorkouts();
      });
      box.appendChild(c); drawWorkoutThumb(c.querySelector('canvas'), w);
    });
    renderStartInfo();
  }
  function renderRoutes() {
    const box = $('#routeList'); box.innerHTML = '';
    R.ROUTES_DEF.forEach(d => {
      const r = R.getRoute(d.id);
      const c = document.createElement('button'); c.type = 'button'; c.className = 'card' + (d.id === selRoute ? ' sel' : '');
      c.innerHTML = `<h3>${R.esc(d.name)}</h3><p>${R.esc(d.desc)}</p><canvas></canvas><div class="meta"><span>${R.fmtNum(d.len / 1000, 0)}<i>km</i></span><span>${Math.round(r.gain)}<i>m desnivel</i></span><span>${Math.round(r.maxY)}<i>m cota máx.</i></span></div>`;
      c.addEventListener('click', () => { selRoute = d.id; R.store.set('route', d.id); renderRoutes(); });
      box.appendChild(c); drawRouteThumb(c.querySelector('canvas'), r);
    });
    renderStartInfo();
  }
  function setMode(m) {
    selMode = m; R.store.set('mode', m);
    $('#tabWorkout').classList.toggle('on', m === 'workout'); $('#tabFree').classList.toggle('on', m === 'free');
    $('#workoutPick').hidden = m !== 'workout'; renderStartInfo();
  }
  function renderStartInfo() {
    const el = $('#startInfo'); if (!el) return;
    const r = R.ROUTES_DEF.find(x => x.id === selRoute);
    let txt = '';
    if (selMode === 'workout') { const w = R.allWorkouts().find(x => x.id === selWorkout); if (w) txt = `${w.name} · ${Math.round(R.workoutStats(w, set.ftp).dur / 60)} min · `; }
    txt += r ? r.name : '';
    if (trainer().status !== 'on') txt = 'Conecta el rodillo o activa el modo prueba';
    el.textContent = txt;
    $('#btnStart').disabled = trainer().status !== 'on';
  }

  async function connectDev(k) {
    const d = k === 'trainer' ? dev.trainer : dev[k];
    if (d.status === 'on' || d.status === 'lost') { d.disconnect(); return; }
    if (!R.bleAvailable()) { R.toast('Este navegador no tiene Bluetooth. Usa Bluefy en iPhone o Chrome en Android.', 'bad'); return; }
    try {
      d.profile = { weight: set.weight, bike: set.bike };
      await d.connect(); R.toast(`${d.label} conectado`, 'ok');
    } catch (e) {
      d.setStatus('off');
      if (e && e.name === 'NotFoundError') return; // canceló la búsqueda
      R.toast(`${d.label}: ${e && e.message ? e.message : 'no se pudo conectar'}`, 'bad');
    }
  }

  /* ---------- Empezar ---------- */
  function startRide() {
    if (trainer().status !== 'on') { R.toast('Conecta el rodillo o activa el modo prueba', 'bad'); return; }
    R.audio.unlock(); R.audio.on = set.beep;
    showScreen('ride');
    if (!glReady) { W.init($('#gl')); glReady = true; }
    ride = newRide();
    W.setQuality(set.quality);
    W.buildRoute(ride.route);
    ride.bots.place(ride.route, 0, (set.ftp * 0.62) / set.weight);
    W.syncRiders(ride.player, ride.bots);
    W.resize(); sizeHudCanvases(); prepMap(); prepProfile();
    if (demo) dev.sim.resting = false;
    $('#hRoute').textContent = ride.route.name;
    $('#hWork').hidden = !ride.run;
    $('#mErgRow').hidden = $('#mBiasRow').hidden = $('#mSkipRow').hidden = !ride.run;
    if (ride.run) { $('#hWorkName').textContent = ride.wdef.name; renderSteps(); }
    $('#hPaused').hidden = true;
    R.wake.on();
    lastFrame = performance.now();
    updateHud();
  }

  /* ---------- Bucle ---------- */
  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - lastFrame) / 1000; lastFrame = now;
    if (!ride || !ride.running) return;
    dt = Math.min(dt, 2);
    let rem = dt; while (rem > 1e-4) { const h = Math.min(0.1, rem); step(h); rem -= h; }
    W.render(ride.player, ride.bots, Math.min(dt, 0.1));
    hudT += dt; profT += dt;
    if (hudT >= 0.25) { hudT = 0; updateHud(); }
    if (profT >= 1) { profT = 0; drawProfile(); }
  }

  function step(h) {
    const rd = ride, tr = trainer(), p = rd.player, route = rd.route;
    if (demo) dev.sim.tick(h, set.ftp);
    const P = rd.paused ? 0 : live.power();
    rd.pEma += (P - rd.pEma) * (1 - Math.exp(-h / 0.9));
    rd.cad = live.cadence(); rd.hr = live.hr();
    if (!rd.paused) {
      rd.elapsed += h; rd.accP += P * h; rd.accT += h; rd.kj += (P * h) / 1000;
      if (rd.run && !rd.run.done) {
        const changed = rd.run.tick(h);
        workoutCues();
        if (changed) onStepChange();
      }
      const grade = route.grade(p.d), a0 = route.elev(p.d);
      R.stepRider(p, P, grade, h, rd.bots.draftFor(p) ? 0.68 : 1);
      const a1 = route.elev(p.d); if (a1 > a0) rd.gain += a1 - a0;
      p.crank -= (rd.cad / 60) * Math.PI * 2 * h; p.wheel -= (p.v * h) / 0.34;
      rd.bots.update(h, route, p, rd.pEma / set.weight);
      const sec = Math.floor(rd.elapsed);
      if (sec > rd.lastSec) { rd.lastSec = sec; record(); }
    }
    control(tr);
  }

  function record() {
    const rd = ride, S = rd.samples, p = rd.player;
    const P = rd.accT > 0 ? rd.accP / rd.accT : 0; rd.accP = 0; rd.accT = 0;
    S.t.push(Math.round(rd.elapsed)); S.p.push(Math.round(P)); S.c.push(Math.round(rd.cad)); S.hr.push(Math.round(rd.hr));
    S.v.push(Math.round(p.v * 36) / 10); S.d.push(Math.round(p.d * 10) / 10); S.alt.push(Math.round(rd.route.elev(p.d) * 10) / 10);
    rd.sumP += P; rd.n++;
    // Igualar potencia (rodillo vs potenciómetro)
    if (set.powerSource === 'pm' && dev.pm.fresh() && dev.trainer.fresh() && dev.pm.data.power > 60) {
      const ratio = R.clamp(dev.trainer.data.power / dev.pm.data.power, 0.85, 1.15);
      rd.pmRatio += (ratio - rd.pmRatio) * 0.1;
    }
    // Test de rampa: fin automático cuando ya no se sostiene
    if (rd.run && !rd.run.done && rd.wdef.test === 'ramp' && rd.run.idx >= 3) {
      const n = S.p.length, k = 15; if (n > k) {
        const avg = S.p.slice(n - k).reduce((a, b) => a + b, 0) / k, tgt = rd.run.target(set.ftp);
        if (avg < tgt * 0.6) { rd.run.finish(); R.audio.beep(520, 0.5); R.toast('Test terminado: ahora a rodar suave', 'ok'); renderSteps(); }
      }
    }
    if (Date.now() - rd.savedAt > 60000) { rd.savedAt = Date.now(); R.idb.put(snapshot('live')).catch(() => {}); }
  }

  function control(tr) {
    if (!tr || tr.status !== 'on' || !ride) return;
    const rd = ride;
    if (rd.paused) { tr.setSim(0); return; }
    const s = rd.run && !rd.run.done ? rd.run.cur() : null;
    if (s && !s.free && rd.erg) {
      let t = rd.run.target(set.ftp);
      if (set.powerSource === 'pm' && set.powerMatch && !demo) t = Math.round(t * rd.pmRatio);
      tr.setErg(t);
    } else {
      tr.setSim(rd.route.grade(rd.player.d + 3) * (set.difficulty / 100));
    }
  }

  function workoutCues() {
    const run = ride.run; if (!run || run.done) return;
    const left = run.left(), sec = Math.ceil(left);
    if (sec !== ride.lastLeftSec) {
      ride.lastLeftSec = sec;
      if (sec <= 3 && sec >= 1 && run.cur().dur > 8) R.audio.beep(660, 0.09, 0.14);
    }
  }
  function onStepChange() {
    R.audio.beep(run_isDone() ? 520 : 940, 0.32, 0.2);
    renderSteps();
  }
  const run_isDone = () => !ride.run || ride.run.done;

  /* ---------- HUD ---------- */
  function renderSteps() {
    const run = ride.run, ol = $('#hSteps'); ol.innerHTML = '';
    if (!run) return;
    const from = Math.max(0, run.idx - 2), to = Math.min(run.steps.length, from + 11);
    for (let i = from; i < to; i++) {
      const s = run.steps[i], li = document.createElement('li');
      const w = R.stepWatts(s, set.ftp, run.bias, 0), w2 = R.stepWatts(s, set.ftp, run.bias, 1);
      const f = s.free ? 0.5 : ((w + w2) / 2) / set.ftp;
      li.style.setProperty('--zc', s.free ? '#55606b' : R.zc(f));
      li.textContent = s.free ? `${R.fmtStepDur(s.dur)} libre` : `${R.fmtStepDur(s.dur)} @ ${w === w2 ? w : w + '–' + w2}W`;
      if (i < run.idx || run.done) li.className = 'done'; else if (i === run.idx) li.className = 'cur';
      ol.appendChild(li);
    }
    const rest = run.steps.length - to;
    if (rest > 0) { const li = document.createElement('li'); li.style.setProperty('--zc', 'transparent'); li.textContent = `+${rest} más`; ol.appendChild(li); }
    $('#hStepCount').textContent = run.done ? 'Entrenamiento completado' : `Bloque ${run.idx + 1} de ${run.steps.length}`;
  }

  function gradeColor(g) { return g > 8 ? '#ff6b6b' : g > 5 ? '#ff9f43' : g > 2 ? '#ffd43b' : g < -2 ? '#74c0fc' : '#ffffff'; }

  function updateHud() {
    if (!ride) return;
    const rd = ride, p = rd.player, run = rd.run;
    $('#hSpeed').textContent = Math.round(p.v * 3.6);
    $('#hDist').textContent = R.fmtNum(p.d / 1000, 1);
    $('#hGain').textContent = Math.round(rd.gain);
    $('#hTime').textContent = R.fmtTime(rd.elapsed);
    $('#hPower').textContent = Math.round(rd.pEma);
    $('#hCad').textContent = Math.round(rd.cad);
    $('#hAvg').textContent = rd.n ? Math.round(rd.sumP / rd.n) : 0;
    $('#hHr').textContent = rd.hr ? Math.round(rd.hr) : '—';
    $('#hKcal').textContent = Math.round(rd.kj);
    const grade = rd.route.grade(p.d), gEl = $('#hGrade');
    gEl.textContent = `${grade >= 0 ? '' : '−'}${R.fmtNum(Math.abs(grade), 1)} %`; gEl.style.color = gradeColor(grade);
    const tBox = $('#hTarget'), fill = $('#hStepFill');
    const s = run && !run.done ? run.cur() : null;
    if (s && !s.free) {
      const w = run.target(set.ftp), f = w / set.ftp, col = R.zc(f);
      tBox.className = 'target'; tBox.style.background = col; fill.style.background = col;
      tBox.querySelector('.tl').textContent = rd.erg ? 'Pedalea a' : 'Objetivo';
      $('#hTargetW').textContent = w; $('#hTargetD').textContent = R.fmtStepDur(s.dur) + (s.cad ? ` · ${s.cad} rpm` : '');
      fill.style.width = (run.frac() * 100).toFixed(1) + '%'; $('#hStepLeft').textContent = R.fmtTime(run.left());
    } else if (s && s.free) {
      tBox.className = 'target free'; tBox.style.background = '';
      tBox.querySelector('.tl').textContent = 'Libre'; $('#hTargetW').textContent = Math.round(rd.pEma); $('#hTargetD').textContent = R.fmtStepDur(s.dur);
      fill.style.background = 'var(--z1)'; fill.style.width = (run.frac() * 100).toFixed(1) + '%'; $('#hStepLeft').textContent = R.fmtTime(run.left());
    } else {
      tBox.className = 'target free'; tBox.style.background = '';
      const L = rd.route.len, lap = Math.floor(p.d / L) + 1, toGo = L - (p.d % L);
      tBox.querySelector('.tl').textContent = 'Pendiente';
      $('#hTargetW').textContent = R.fmtNum(grade, 1).replace('W', ''); tBox.querySelector('.tw').lastChild.textContent = '%';
      $('#hTargetD').textContent = `Vuelta ${lap}`;
      fill.style.background = 'var(--sky)'; fill.style.width = (((p.d % L) / L) * 100).toFixed(1) + '%';
      $('#hStepLeft').textContent = `${R.fmtNum(toGo / 1000, 1)} km para meta`;
    }
    if (s && !s.free) tBox.querySelector('.tw').lastChild.textContent = 'W';
    else if (s && s.free) tBox.querySelector('.tw').lastChild.textContent = 'W';
    if (run) $('#hWorkLeft').textContent = R.fmtTime(Math.max(0, run.total - run.t));
    // Aviso del siguiente bloque
    const ban = $('#hBanner');
    if (run && !run.done && run.next() && run.left() <= 8 && run.cur().dur > 12) {
      const n = run.next(), w = R.stepWatts(n, set.ftp, run.bias, 0);
      ban.innerHTML = `<small>Siguiente en ${Math.ceil(run.left())} s</small>${n.free ? 'Libre ' + R.fmtStepDur(n.dur) : `${R.fmtStepDur(n.dur)} @ ${w} W`}`;
      ban.hidden = false;
    } else ban.hidden = true;
    $('#hDraft').hidden = !rd.bots.draftFor(p) || p.v < 3;
    renderNear(); drawMap();
    // Sensores
    const dots = [trainer(), dev.hrm.status !== 'off' ? dev.hrm : null, dev.pm.status !== 'off' ? dev.pm : null].filter(Boolean);
    $('#hDevs').innerHTML = dots.map(d => `<i class="${d.fresh() ? '' : 'bad'}" title="${R.esc(d.label)}"></i>`).join('');
  }

  function renderNear() {
    const rd = ride, p = rd.player, items = rd.bots.nearest(p, 6).map(o => ({
      name: o.b.name, flag: o.b.flag, gap: o.gap, wkg: o.b.power / o.b.kg
    }));
    items.push({ me: true, name: set.name || 'Tú', gap: 0, wkg: rd.pEma / set.weight });
    items.sort((a, b) => b.gap - a.gap);
    const v = Math.max(p.v, 4);
    $('#hNear').innerHTML = items.map(o => {
      const t = Math.abs(o.gap) / v, sign = o.gap > 0 ? '−' : '+';
      const g = o.me ? '' : `${sign}${R.fmtTime(t)}`;
      return `<li class="${o.me ? 'me' : ''}"><span class="g">${g}</span><span class="n">${R.esc(o.name)}</span><span class="w">${R.fmtNum(o.wkg, 1)}${o.flag ? ' ' + o.flag : ''}</span></li>`;
    }).join('');
  }

  /* Minimapa: planta + perfil completo */
  let mapCache = null;
  function sizeHudCanvases() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    [['#hMap'], ['#hProfile']].forEach(([sel]) => {
      const c = $(sel); const w = c.clientWidth, h = c.clientHeight;
      if (w && h) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    });
  }
  function prepMap() {
    const c = $('#hMap'), r = ride.route, W2 = c.width, H = c.height, planH = H * 0.66;
    const off = document.createElement('canvas'); off.width = W2; off.height = H; const x = off.getContext('2d');
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < r.N; i += 20) { minX = Math.min(minX, r.x[i]); maxX = Math.max(maxX, r.x[i]); minZ = Math.min(minZ, r.z[i]); maxZ = Math.max(maxZ, r.z[i]); }
    const pad = 10 * (W2 / 320), sc = Math.min((W2 - 2 * pad) / (maxX - minX), (planH - 2 * pad) / (maxZ - minZ));
    const ox = (W2 - (maxX - minX) * sc) / 2, oz = (planH - (maxZ - minZ) * sc) / 2;
    const P = (px, pz) => [ox + (px - minX) * sc, oz + (pz - minZ) * sc];
    x.fillStyle = 'rgba(70,110,60,.35)'; x.fillRect(0, 0, W2, planH);
    x.lineWidth = 3 * (W2 / 320); x.strokeStyle = 'rgba(255,255,255,.85)'; x.lineJoin = 'round'; x.beginPath();
    for (let i = 0; i <= r.N; i += 10) { const k = i % r.N; const [a, b] = P(r.x[k], r.z[k]); i ? x.lineTo(a, b) : x.moveTo(a, b); }
    x.closePath(); x.stroke();
    // Perfil
    const lo = r.minY - 5, hi = Math.max(r.maxY, lo + 50), ph = H - planH;
    x.beginPath(); x.moveTo(0, H);
    for (let i = 0; i <= 200; i++) { const d = (i / 200) * r.len; x.lineTo((i / 200) * W2, H - ((r.elev(d) - lo) / (hi - lo)) * (ph - 6)); }
    x.lineTo(W2, H); x.closePath(); x.fillStyle = 'rgba(60,196,106,.75)'; x.fill();
    mapCache = { img: off, P, planH, lo, hi, ph };
  }
  function drawMap() {
    if (!mapCache) return;
    const c = $('#hMap'), x = c.getContext('2d'), r = ride.route, k = c.width / 320;
    x.clearRect(0, 0, c.width, c.height); x.drawImage(mapCache.img, 0, 0);
    const dot = (d, col, rad) => { const s = r.at(d); const [a, b] = mapCache.P(s.x, s.z); x.beginPath(); x.arc(a, b, rad * k, 0, 6.29); x.fillStyle = col; x.fill(); };
    ride.bots.list.forEach(b => { if (Math.abs(b.d - ride.player.d) < 1600) dot(b.d, 'rgba(255,255,255,.75)', 2.4); });
    dot(ride.player.d, '#ffffff', 6); dot(ride.player.d, '#ffb22e', 4.2);
    const fx = ((ride.player.d % r.len) / r.len) * c.width;
    x.fillStyle = '#ffb22e'; x.fillRect(fx - 1.5 * k, mapCache.planH, 3 * k, c.height - mapCache.planH);
  }

  /* Perfil inferior: entrenamiento o próximos km de la ruta */
  let profCache = null;
  function prepProfile() {
    const c = $('#hProfile'); profCache = null;
    if (!ride.run || !c.width) return;
    const off = document.createElement('canvas'); off.width = c.width; off.height = c.height; const x = off.getContext('2d');
    const run = ride.run, tot = run.total, Wd = c.width, H = c.height;
    const maxW = Math.max(set.ftp * 1.35, ...run.steps.map(s => Math.max(R.stepWatts(s, set.ftp, run.bias, 0) || 0, R.stepWatts(s, set.ftp, run.bias, 1) || 0)));
    run.steps.forEach(s => {
      const x0 = (s.t0 / tot) * Wd, x1 = ((s.t0 + s.dur) / tot) * Wd;
      const w0 = s.free ? set.ftp * 0.5 : R.stepWatts(s, set.ftp, run.bias, 0), w1 = s.free ? set.ftp * 0.5 : R.stepWatts(s, set.ftp, run.bias, 1);
      x.fillStyle = s.free ? '#55606b' : R.zc((w0 + w1) / 2 / set.ftp);
      x.beginPath(); x.moveTo(x0, H); x.lineTo(x0, H - (w0 / maxW) * (H - 4)); x.lineTo(Math.max(x0 + 1, x1 - 1), H - (w1 / maxW) * (H - 4)); x.lineTo(Math.max(x0 + 1, x1 - 1), H); x.fill();
    });
    profCache = { img: off, maxW };
  }
  function drawProfile() {
    const c = $('#hProfile'); if (!c.width || !ride) return;
    const x = c.getContext('2d'), Wd = c.width, H = c.height; x.clearRect(0, 0, Wd, H);
    if (ride.run && profCache) {
      const run = ride.run, tot = run.total, pos = Math.min(1, run.t / tot) * Wd;
      x.globalAlpha = 0.45; x.drawImage(profCache.img, 0, 0); x.globalAlpha = 1;
      x.save(); x.beginPath(); x.rect(0, 0, pos, H); x.clip(); x.drawImage(profCache.img, 0, 0); x.restore();
      // Potencia real encima
      const S = ride.samples.p, n = S.length, wStart = ride.elapsed - run.t;
      x.strokeStyle = 'rgba(255,255,255,.9)'; x.lineWidth = Math.max(1.5, Wd / 600); x.beginPath(); let first = true;
      for (let i = Math.max(0, Math.floor(wStart)); i < n; i += 3) {
        const tt = i - wStart; if (tt < 0) continue;
        let a = 0, k = 0; for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) { a += S[j]; k++; }
        const px = (tt / tot) * Wd, py = H - Math.min(1, a / k / profCache.maxW) * (H - 4);
        if (px > Wd) break; first ? x.moveTo(px, py) : x.lineTo(px, py); first = false;
      }
      x.stroke();
      x.fillStyle = '#ffb22e'; x.fillRect(pos - 1.5, 0, 3, H);
    } else {
      // Próximos 4 km
      const r = ride.route, d0 = ride.player.d - 400, span = 4400, n = 220;
      let lo = Infinity, hi = -Infinity; const ys = [];
      for (let i = 0; i <= n; i++) { const y = r.elev(d0 + (i / n) * span); ys.push(y); lo = Math.min(lo, y); hi = Math.max(hi, y); }
      hi = Math.max(hi, lo + 40);
      for (let i = 0; i < n; i++) {
        const g = r.grade(d0 + (i / n) * span), x0 = (i / n) * Wd, x1 = ((i + 1) / n) * Wd;
        x.fillStyle = gradeColor(g); x.globalAlpha = 0.75;
        x.beginPath(); x.moveTo(x0, H); x.lineTo(x0, H - ((ys[i] - lo) / (hi - lo)) * (H - 8) - 3); x.lineTo(x1 + 0.5, H - ((ys[i + 1] - lo) / (hi - lo)) * (H - 8) - 3); x.lineTo(x1 + 0.5, H); x.fill();
      }
      x.globalAlpha = 1; const px = (400 / span) * Wd; x.fillStyle = '#ffb22e'; x.fillRect(px - 1.5, 0, 3, H);
    }
  }

  /* ---------- Controles de la salida ---------- */
  function togglePause(force) {
    if (!ride) return;
    ride.paused = force != null ? force : !ride.paused;
    if (demo) dev.sim.resting = ride.paused;
    $('#hPaused').hidden = !ride.paused; $('#btnPause').textContent = ride.paused ? '▶' : '❚❚';
  }
  function openMenu() {
    $('#mErg').checked = ride.erg; $('#mBias').textContent = Math.round((ride.run ? ride.run.bias : 1) * 100) + ' %';
    $('#mDiff').value = set.difficulty; $('#mDiffV').textContent = set.difficulty + ' %'; $('#mBeep').checked = set.beep;
    $('#rideMenu').hidden = false;
  }
  function askEnd() {
    $('#rideMenu').hidden = true;
    $('#endInfo').textContent = `${R.fmtTime(ride.elapsed)} · ${R.fmtNum(ride.player.d / 1000, 1)} km · ${ride.n ? Math.round(ride.sumP / ride.n) : 0} W de media`;
    $('#endSheet').hidden = false;
  }
  function snapshot(id) {
    const rd = ride;
    return {
      id, start: rd.start, name: rd.wdef ? rd.wdef.name : rd.route.name, routeId: rd.route.id, routeName: rd.route.name,
      workoutName: rd.wdef ? rd.wdef.name : '', workoutTest: rd.wdef ? rd.wdef.test || '' : '', ftp: set.ftp, weight: set.weight,
      samples: rd.samples, summary: null, strava: null, partial: id === 'live'
    };
  }
  async function endRide(save) {
    $('#endSheet').hidden = true;
    const rd = ride; rd.running = false; R.wake.off();
    const tr = trainer(); if (tr.status === 'on') tr.setSim(0);
    await R.idb.del('live');
    if (!save || rd.samples.p.length < 10) { ride = null; showScreen('home'); if (save) R.toast('Salida demasiado corta: no se ha guardado'); return; }
    const r = snapshot('r' + rd.start); r.partial = false; r.summary = R.metrics(r.samples, r.ftp);
    await R.idb.put(r);
    ride = null;
    openSummary(r, true);
  }

  /* ---------- Resumen ---------- */
  let current = null;
  function openSummary(r, fresh) {
    current = r; showScreen('summary');
    const m = r.summary;
    $('#sDate').textContent = R.fmtDate(r.start) + ' · ' + r.routeName;
    $('#sTitle').textContent = r.workoutName || r.routeName;
    $('#sName').value = r.name;
    const tiles = [
      [R.fmtTime(m.dur), 'Tiempo'], [R.fmtNum(m.dist / 1000, 1) + ' km', 'Distancia'], [Math.round(m.gain) + ' m', 'Desnivel'],
      [Math.round(m.avgP) + ' W', 'Potencia media'], [Math.round(m.np) + ' W', 'Normalizada'], [R.fmtNum(m.ifac, 2), 'IF'],
      [Math.round(m.tss), 'TSS'], [m.avgHr ? Math.round(m.avgHr) + ' ppm' : '—', 'FC media'], [Math.round(m.avgCad) + ' rpm', 'Cadencia'],
      [Math.round(m.kj), 'kcal'], [Math.round(m.maxP) + ' W', 'Máxima'], [m.best1200 ? Math.round(m.best1200) + ' W' : (m.best300 ? Math.round(m.best300) + ' W' : '—'), m.best1200 ? 'Mejor 20′' : 'Mejor 5′']
    ];
    $('#sGrid').innerHTML = tiles.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('');
    drawSummaryChart(r);
    const fb = $('#sFtp');
    if (r.workoutTest === 'ramp' && m.best60) {
      const est = Math.round(m.best60 * 0.75);
      fb.innerHTML = `<div><b>FTP estimado: ${est} W</b><br><span class="muted small">75 % de tu mejor minuto (${Math.round(m.best60)} W). Ahora tienes ${set.ftp} W.</span></div><button type="button" class="primary" id="sUseFtp">Usar ${est} W</button>`;
      fb.hidden = false;
      $('#sUseFtp').onclick = () => { set.ftp = est; saveSet(); renderWorkouts(); R.toast(`FTP actualizado a ${est} W`, 'ok'); fb.hidden = true; };
    } else fb.hidden = true;
    renderUploadState();
    if (fresh && R.strava.connected() && R.strava.cfg().autoUpload && !r.strava) uploadCurrent();
  }
  function renderUploadState(msg) {
    const r = current, btn = $('#sStrava'), st = $('#sUp');
    if (r.strava) { btn.textContent = 'Ver en Strava'; btn.disabled = false; st.innerHTML = `Subida a Strava${r.strava.duplicate ? ' (ya existía)' : ''}: <a href="${r.strava.url}" target="_blank" rel="noopener">abrir actividad</a>`; return; }
    btn.textContent = R.strava.connected() ? 'Subir a Strava' : 'Conectar Strava'; btn.disabled = false;
    st.textContent = msg || (R.strava.connected() ? '' : 'Conecta Strava en Ajustes para subir tus salidas.');
  }
  async function uploadCurrent() {
    const r = current; if (!r) return;
    r.name = $('#sName').value.trim() || r.name;
    const btn = $('#sStrava'); btn.disabled = true;
    try {
      const res = await R.strava.upload(r, m => { $('#sUp').textContent = m; });
      r.strava = res; await R.idb.put(r); renderUploadState(); R.toast('Subida a Strava', 'ok');
    } catch (e) { renderUploadState(e.message); R.toast(e.message, 'bad'); }
  }
  function drawSummaryChart(r) {
    const c = $('#sChart'), dpr = Math.min(2, window.devicePixelRatio || 1), cw = c.clientWidth || 900, ch = cw * (260 / 1200);
    c.width = cw * dpr; c.height = ch * dpr; const x = c.getContext('2d'); x.scale(dpr, dpr);
    const S = r.samples, n = S.p.length; if (n < 2) return;
    const padL = 34, padB = 16, Wd = cw - padL - 8, H = ch - padB - 8;
    const maxP = Math.max(r.ftp * 1.4, ...S.p) , lo = Math.min(...S.alt), hi = Math.max(lo + 30, ...S.alt);
    const X = i => padL + (i / (n - 1)) * Wd;
    // altitud de fondo
    x.beginPath(); x.moveTo(X(0), 8 + H); for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 600))) x.lineTo(X(i), 8 + H - ((S.alt[i] - lo) / (hi - lo)) * H * 0.5); x.lineTo(X(n - 1), 8 + H); x.fillStyle = 'rgba(149,165,180,.18)'; x.fill();
    // potencia suavizada por zonas
    const step = Math.max(1, Math.floor(n / 600)); let prev = null;
    for (let i = 0; i < n; i += step) {
      let a = 0, k = 0; for (let j = Math.max(0, i - 5); j <= Math.min(n - 1, i + 5); j++) { a += S.p[j]; k++; } a /= k;
      const px = X(i), py = 8 + H - (a / maxP) * H;
      if (prev) { x.fillStyle = R.zc(a / r.ftp); x.globalAlpha = 0.85; x.beginPath(); x.moveTo(prev[0], 8 + H); x.lineTo(prev[0], prev[1]); x.lineTo(px, py); x.lineTo(px, 8 + H); x.fill(); }
      prev = [px, py];
    }
    x.globalAlpha = 1;
    // FC
    if (S.hr.some(h => h > 0)) {
      const hmax = Math.max(...S.hr) + 10, hmin = Math.max(40, Math.min(...S.hr.filter(h => h > 0)) - 10);
      x.strokeStyle = '#ff6b6b'; x.lineWidth = 1.5; x.beginPath(); let f = true;
      for (let i = 0; i < n; i += step) { if (!S.hr[i]) continue; const py = 8 + H - ((S.hr[i] - hmin) / (hmax - hmin)) * H; f ? x.moveTo(X(i), py) : x.lineTo(X(i), py); f = false; }
      x.stroke();
    }
    // ejes
    x.fillStyle = '#95a5b4'; x.font = '11px "Saira Condensed", sans-serif'; x.textAlign = 'right';
    [r.ftp].forEach(v => { const py = 8 + H - (v / maxP) * H; x.fillText('FTP', padL - 4, py + 4); x.strokeStyle = 'rgba(255,255,255,.25)'; x.setLineDash([4, 4]); x.beginPath(); x.moveTo(padL, py); x.lineTo(padL + Wd, py); x.stroke(); x.setLineDash([]); });
    x.textAlign = 'center'; const tot = S.t[n - 1] || n;
    for (let k = 0; k <= 4; k++) { const tt = (tot * k) / 4; x.fillText(R.fmtTime(tt), padL + (k / 4) * Wd, ch - 3); }
  }

  /* ---------- Ajustes ---------- */
  function openSettings() {
    $('#fName').value = set.name; $('#fFtp').value = set.ftp; $('#fKg').value = set.weight; $('#fBike').value = set.bike; $('#fJersey').value = set.jersey;
    $('#fSource').value = set.powerSource; $('#fMatch').value = set.powerMatch ? '1' : '0'; $('#fDiff').value = String(set.difficulty); $('#fQuality').value = set.quality;
    renderStrava(); $('#settings').hidden = false;
  }
  function bindSettings() {
    const num = (id, key, lo, hi) => $(id).addEventListener('change', e => { const v = parseFloat(e.target.value); if (v >= lo && v <= hi) { set[key] = v; saveSet(); renderWorkouts(); } else e.target.value = set[key]; });
    num('#fFtp', 'ftp', 80, 600); num('#fKg', 'weight', 35, 150); num('#fBike', 'bike', 5, 20);
    $('#fName').addEventListener('change', e => { set.name = e.target.value.trim().slice(0, 24) || 'Tú'; saveSet(); });
    $('#fJersey').addEventListener('change', e => { set.jersey = e.target.value; saveSet(); if (glReady) W.setPlayerJersey(); });
    $('#fSource').addEventListener('change', e => { set.powerSource = e.target.value; saveSet(); });
    $('#fMatch').addEventListener('change', e => { set.powerMatch = e.target.value === '1'; saveSet(); });
    $('#fDiff').addEventListener('change', e => { set.difficulty = parseInt(e.target.value, 10); saveSet(); });
    $('#fQuality').addEventListener('change', e => { set.quality = e.target.value; saveSet(); });
  }
  function renderStrava() {
    const S = R.strava, c = S.cfg(), box = $('#stravaBox'), host = location.hostname || 'tu-dominio';
    const iframeNote = S.canRedirect() ? '' : '<p class="notice warn">Estás viendo la app dentro de otra página. Para conectar Strava ábrela desde su propia dirección.</p>';
    if (S.connected()) {
      box.innerHTML = `${iframeNote}<div class="row"><b>Conectado${c.athlete ? ' como ' + R.esc(c.athlete.name) : ''}</b></div>
        <label class="switch"><input type="checkbox" id="stAuto" ${c.autoUpload ? 'checked' : ''}><span></span>Subir automáticamente al terminar</label>
        <div class="row"><button type="button" class="ghost" id="stOff">Desconectar Strava</button></div>`;
      $('#stAuto').onchange = e => { S.save({ ...S.cfg(), autoUpload: e.target.checked }); };
      $('#stOff').onclick = () => { S.disconnect(); renderStrava(); R.toast('Strava desconectado'); };
      return;
    }
    box.innerHTML = `${iframeNote}<ol>
        <li>Entra en <a href="https://www.strava.com/settings/api" target="_blank" rel="noopener">strava.com/settings/api</a> y crea una aplicación (nombre: Rueda, categoría: Entrenamiento).</li>
        <li>En «Dominio de devolución de llamada de autorización» escribe <code>${R.esc(host)}</code>.</li>
        <li>Copia aquí el Client ID y el Client Secret y pulsa Conectar.</li>
      </ol>
      <p class="muted small">Strava exige tener suscripción para usar su API con apps propias. Si no la tienes, descarga el TCX de cada salida y súbelo a mano.</p>
      <div class="fields">
        <label class="field"><span>Client ID</span><input type="text" id="stId" inputmode="numeric" value="${R.esc(c.clientId || '')}" autocomplete="off"></label>
        <label class="field"><span>Client Secret</span><input type="password" id="stSecret" value="${R.esc(c.clientSecret || '')}" autocomplete="off"></label>
      </div>
      <div class="row"><button type="button" class="strava" id="stGo">Conectar con Strava</button></div>
      <details><summary class="muted small">¿Strava volvió a otro navegador?</summary>
        <div class="row" style="margin-top:8px"><input type="text" id="stPaste" class="field" placeholder="Pega aquí la dirección completa" style="flex:1;min-width:0;background:var(--ink-2);border:1px solid var(--line);border-radius:9px;padding:9px;color:var(--fg)"><button type="button" class="ghost" id="stPasteGo">Usar</button></div>
      </details>`;
    const persist = () => S.save({ ...S.cfg(), clientId: $('#stId').value.trim(), clientSecret: $('#stSecret').value.trim() });
    $('#stId').onchange = persist; $('#stSecret').onchange = persist;
    $('#stGo').onclick = () => { persist(); try { S.authorize(); } catch (e) { R.toast(e.message, 'bad'); } };
    $('#stPasteGo').onclick = async () => { persist(); try { await S.fromPasted($('#stPaste').value); R.toast('Strava conectado', 'ok'); renderStrava(); } catch (e) { R.toast(e.message, 'bad'); } };
  }

  /* ---------- Historial ---------- */
  async function openHistory() {
    $('#history').hidden = false;
    const list = (await R.idb.all()).filter(r => !r.partial && r.summary), box = $('#histList');
    if (!list.length) { box.innerHTML = '<p class="muted">Aún no hay salidas guardadas. Cuando termines una, aparecerá aquí con su archivo TCX y el enlace de Strava.</p>'; return; }
    box.innerHTML = '';
    list.forEach(r => {
      const m = r.summary, el = document.createElement('div'); el.className = 'hrow';
      el.innerHTML = `<div class="h1"><b>${R.esc(r.name)}</b><span class="muted small">${R.fmtDate(r.start)}</span></div>
        <div class="h2"><span>${R.fmtTime(m.dur)}</span><span>${R.fmtNum(m.dist / 1000, 1)} km</span><span>${Math.round(m.avgP)} W med</span><span>NP ${Math.round(m.np)} W</span><span>TSS ${Math.round(m.tss)}</span></div>
        <div class="h3"><button type="button" class="ghost" data-a="ver">Ver</button>${r.strava ? `<a class="sv" href="${r.strava.url}" target="_blank" rel="noopener">En Strava</a>` : '<button type="button" class="ghost" data-a="up">Subir a Strava</button>'}<button type="button" class="ghost" data-a="tcx">TCX</button><button type="button" class="ghost dangertext" data-a="del">Borrar</button></div>`;
      el.addEventListener('click', async e => {
        const a = e.target.dataset.a; if (!a) return;
        if (a === 'ver') { $('#history').hidden = true; openSummary(r, false); }
        if (a === 'up') { $('#history').hidden = true; openSummary(r, false); if (R.strava.connected()) uploadCurrent(); else R.toast('Conecta Strava en Ajustes', 'bad'); }
        if (a === 'tcx') R.saveFile(`rueda-${new Date(r.start).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.tcx`, R.tcx(r), 'application/vnd.garmin.tcx+xml');
        if (a === 'del') { if (e.target.dataset.sure) { await R.idb.del(r.id); el.remove(); } else { e.target.dataset.sure = '1'; e.target.textContent = '¿Seguro?'; } }
      });
      box.appendChild(el);
    });
  }

  /* ---------- Recuperar una salida sin terminar ---------- */
  async function checkRecover() {
    const live0 = await R.idb.get('live');
    if (!live0 || !live0.samples || live0.samples.p.length < 60) return;
    const box = $('#recover');
    box.innerHTML = `<b>Tienes una salida sin terminar</b> del ${R.fmtDate(live0.start)} (${R.fmtTime(live0.samples.p.length)}).<div class="row"><button type="button" class="primary" id="recSave">Guardarla</button><button type="button" class="ghost" id="recDrop">Descartar</button></div>`;
    box.hidden = false;
    $('#recSave').onclick = async () => {
      const r = { ...live0, id: 'r' + live0.start, partial: false }; r.summary = R.metrics(r.samples, r.ftp);
      await R.idb.put(r); await R.idb.del('live'); box.hidden = true; openSummary(r, true);
    };
    $('#recDrop').onclick = async () => { await R.idb.del('live'); box.hidden = true; };
  }

  R.debug = { ride: () => ride };

  /* ---------- Arranque ---------- */
  function boot() {
    R.cacheZoneColors();
    demo = !R.bleAvailable();
    $('#demoMode').checked = demo; $('#bleNotice').hidden = R.bleAvailable();
    if (demo) dev.sim.connect();
    $('#demoMode').addEventListener('change', e => {
      demo = e.target.checked;
      if (demo) dev.sim.connect(); else dev.sim.disconnect();
      renderDevices();
    });
    R.on('devices', renderDevices);
    R.$$('.dbtn').forEach(b => b.addEventListener('click', () => connectDev(b.dataset.dev)));
    $('#tabWorkout').onclick = () => setMode('workout'); $('#tabFree').onclick = () => setMode('free');
    $('#zwoInput').addEventListener('change', async e => {
      const files = Array.from(e.target.files || []); let ok = 0;
      for (const f of files) {
        try {
          const w = R.parseWorkoutFile(await f.text(), f.name), list = R.store.get('customWorkouts', []);
          const same = list.find(x => x.name === w.name && JSON.stringify(x.steps) === JSON.stringify(w.steps));
          if (same) { selWorkout = same.id; ok++; continue; } // ya estaba importado
          list.push(w); R.store.set('customWorkouts', list); selWorkout = w.id; ok++;
        }
        catch (err) { R.toast(`${f.name}: ${err.message}`, 'bad'); }
      }
      if (ok) { R.store.set('workout', selWorkout); renderWorkouts(); R.toast(ok === 1 ? 'Entrenamiento importado' : `${ok} entrenamientos importados`, 'ok'); }
      e.target.value = '';
    });
    $('#btnStart').onclick = startRide;
    $('#btnSettings').onclick = openSettings; $('#setClose').onclick = () => { $('#settings').hidden = true; renderStartInfo(); };
    $('#btnHistory').onclick = openHistory; $('#histClose').onclick = () => { $('#history').hidden = true; };
    bindSettings();
    // Salida
    $('#btnPause').onclick = () => togglePause();
    $('#btnCam').onclick = () => R.toast('Cámara: ' + W.cycleCamera());
    $('#gl').addEventListener('click', () => { if (ride) R.toast('Cámara: ' + W.cycleCamera()); });
    $('#btnMenu').onclick = openMenu;
    $('#mClose').onclick = () => { $('#rideMenu').hidden = true; };
    $('#mEnd').onclick = askEnd;
    $('#mErg').onchange = e => { ride.erg = e.target.checked; };
    const bias = d => { if (!ride || !ride.run) return; ride.run.bias = R.clamp(Math.round((ride.run.bias + d) * 100) / 100, 0.5, 1.5); $('#mBias').textContent = Math.round(ride.run.bias * 100) + ' %'; renderSteps(); prepProfile(); };
    $('#mBiasMinus').onclick = () => bias(-0.05); $('#mBiasPlus').onclick = () => bias(0.05);
    $('#mSkip').onclick = () => { if (ride && ride.run) { ride.run.skip(); onStepChange(); } };
    $('#mDiff').oninput = e => { set.difficulty = parseInt(e.target.value, 10); $('#mDiffV').textContent = set.difficulty + ' %'; saveSet(); };
    $('#mBeep').onchange = e => { set.beep = e.target.checked; R.audio.on = set.beep; saveSet(); };
    $('#eBack').onclick = () => { $('#endSheet').hidden = true; };
    $('#eSave').onclick = () => endRide(true);
    $('#eDiscard').onclick = e => { if (e.target.dataset.sure) endRide(false); else { e.target.dataset.sure = '1'; e.target.textContent = 'Pulsa otra vez para descartar'; } };
    // Resumen
    $('#sClose').onclick = () => { current = null; showScreen('home'); };
    $('#sName').addEventListener('change', async e => { if (current) { current.name = e.target.value.trim() || current.name; await R.idb.put(current); } });
    $('#sStrava').onclick = () => {
      if (!current) return;
      if (current.strava) { window.open(current.strava.url, '_blank', 'noopener'); return; }
      if (!R.strava.connected()) { openSettings(); return; }
      uploadCurrent();
    };
    $('#sTcx').onclick = () => { if (current) R.saveFile(`rueda-${new Date(current.start).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.tcx`, R.tcx(current), 'application/vnd.garmin.tcx+xml'); };
    // Teclado (útil en ordenador)
    document.addEventListener('keydown', e => {
      if (!ride || e.target.tagName === 'INPUT') return;
      if (e.code === 'Space') { e.preventDefault(); togglePause(); }
      if (e.key === 'c') R.toast('Cámara: ' + W.cycleCamera());
    });
    window.addEventListener('resize', () => { if (ride) { setTimeout(() => { W.resize(); sizeHudCanvases(); prepMap(); prepProfile(); drawProfile(); }, 120); } });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && ride && ride.running) R.wake.on(); });
    window.addEventListener('beforeunload', () => { if (ride && ride.running && ride.samples.p.length > 30) R.idb.put(snapshot('live')); });

    setMode(selMode); renderWorkouts(); renderRoutes(); renderDevices();
    checkRecover();
    R.strava.handleRedirect().then(nc => { if (nc) { R.toast('Strava conectado' + (nc.athlete ? ': ' + nc.athlete.name : ''), 'ok'); } }).catch(e => R.toast(e.message, 'bad'));
    if ('serviceWorker' in navigator && location.protocol === 'https:' && window.top === window.self) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    requestAnimationFrame(frame);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
