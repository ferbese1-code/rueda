'use strict';
/* Entrenamientos estructurados: incorporados, importación .zwo y motor ERG */
(function () {
  const R = window.R;
  const ss = (dur, p, o = {}) => ({ dur, p1: p, p2: p, ...o });
  const ramp = (dur, a, b) => ({ dur, p1: a, p2: b });
  const ssW = (dur, w) => ({ dur, p1: w, p2: w, abs: true });
  const free = dur => ({ dur, free: true });
  const rep = (n, block) => ({ rep: n, block });

  const rampTest = [ssW(300, 100)];
  for (let w = 120; w <= 600; w += 20) rampTest.push(ssW(60, w));

  R.BUILTIN_WORKOUTS = [
    { id: 'z23cv', name: 'Z2/3 · Cambios de ritmo', desc: 'Bloques de 3′ en Z2 y 3′ en Z3 con 1′ suave', steps: [ramp(300, 0.45, 0.65), rep(6, [ss(180, 0.70), ss(180, 0.83), ss(60, 0.47)]), ramp(240, 0.60, 0.40)] },
    { id: 'pam6', name: 'PAM · 6 × 2′30″', desc: 'Seis intervalos por encima del umbral', steps: [ss(300, 0.49), ss(600, 0.66), rep(2, [ss(60, 0.87), ss(120, 0.55)]), rep(6, [ss(150, 1.085), ss(120, 0.49)]), ss(300, 0.66), ramp(300, 0.55, 0.40)] },
    { id: 'vo2130', name: 'VO2 · 130 % FTP', desc: 'Tres series progresivas: 20/40, 30/30, 40/20, 50/10 y 60″', steps: [ramp(600, 0.40, 0.65), ss(120, 0.40), rep(3, [ss(20, 1.3), ss(40, 0.3), ss(30, 1.3), ss(30, 0.3), ss(40, 1.3), ss(20, 0.3), ss(50, 1.3), ss(10, 0.3), ss(60, 1.3), ss(300, 0.40)])] },
    { id: 'ss3x12', name: 'Sweet spot · 3 × 12′', desc: 'Tres bloques al 90 % con 5′ de recuperación', steps: [ramp(600, 0.45, 0.70), rep(3, [ss(720, 0.90), ss(300, 0.55)]), ramp(300, 0.55, 0.40)] },
    { id: 'z2-60', name: 'Fondo Z2 · 60′', desc: 'Una hora continua en zona 2', steps: [ramp(300, 0.45, 0.65), ss(3000, 0.68), ramp(300, 0.60, 0.40)] },
    { id: 'ramp', name: 'Test de rampa', desc: '+20 W cada minuto hasta no poder. FTP ≈ 75 % del mejor minuto', test: 'ramp', steps: rampTest }
  ];

  function flatten(steps) {
    const out = [];
    const walk = arr => arr.forEach(s => { if (s.rep) { for (let i = 0; i < s.rep; i++) walk(s.block); } else if (s.dur > 0) out.push({ ...s }); });
    walk(steps); let t = 0; out.forEach(s => { s.t0 = t; t += s.dur; });
    return out;
  }
  R.flattenWorkout = w => flatten(w.steps);

  R.workoutStats = (w, ftp) => {
    const st = flatten(w.steps); let dur = 0, tss = 0;
    st.forEach(s => {
      dur += s.dur;
      const f = s.free ? 0.6 : s.abs ? ((s.p1 + s.p2) / 2) / ftp : (s.p1 + s.p2) / 2;
      tss += (s.dur / 3600) * f * f * 100;
    });
    return { dur, tss: Math.round(tss), steps: st.length };
  };

  R.stepWatts = (s, ftp, bias = 1, frac = 0) => {
    if (!s || s.free) return null;
    const v = s.p1 + (s.p2 - s.p1) * frac;
    return Math.round(s.abs ? v : v * ftp * bias);
  };

  class WorkoutRun {
    constructor(def) { this.def = def; this.steps = flatten(def.steps); this.total = this.steps.reduce((a, s) => a + s.dur, 0); this.t = 0; this.idx = 0; this.done = false; this.bias = 1; }
    tick(dt) {
      if (this.done) return false;
      this.t += dt; const prev = this.idx;
      while (this.idx < this.steps.length && this.t >= this.steps[this.idx].t0 + this.steps[this.idx].dur) this.idx++;
      if (this.idx >= this.steps.length) { this.done = true; this.idx = this.steps.length - 1; }
      return this.idx !== prev || this.done;
    }
    skip() { if (this.done) return; const s = this.steps[this.idx]; this.t = s.t0 + s.dur + 0.001; this.tick(0); }
    finish() { this.done = true; }
    cur() { return this.done ? null : this.steps[this.idx]; }
    next() { return this.done ? null : this.steps[this.idx + 1] || null; }
    frac() { const s = this.cur(); return s ? R.clamp((this.t - s.t0) / s.dur, 0, 1) : 0; }
    left() { const s = this.cur(); return s ? s.t0 + s.dur - this.t : 0; }
    target(ftp) { return R.stepWatts(this.cur(), ftp, this.bias, this.frac()); }
  }
  R.WorkoutRun = WorkoutRun;

  /* Importar .zwo (formato de entrenamientos de Zwift) */
  R.parseZwo = (text, fname) => {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('El archivo no es un .zwo válido');
    const pick = tag => { const el = doc.getElementsByTagName(tag)[0]; return el ? el.textContent.trim() : ''; };
    const wk = doc.getElementsByTagName('workout')[0];
    if (!wk) throw new Error('El archivo no contiene un bloque <workout>');
    const steps = [];
    for (const el of Array.from(wk.children)) {
      const num = k => { for (const n of [k, k.toLowerCase()]) { const v = el.getAttribute(n); if (v != null && v !== '') return parseFloat(v); } return null; };
      const tag = el.tagName.toLowerCase(), dur = num('Duration') || 0, cad = num('Cadence');
      const extra = cad ? { cad } : {};
      if (tag === 'warmup' || tag === 'cooldown' || tag === 'ramp') {
        const lo = num('PowerLow'), hi = num('PowerHigh');
        steps.push({ dur, p1: lo != null ? lo : 0.5, p2: hi != null ? hi : 0.5, ...extra });
      } else if (tag === 'steadystate' || tag === 'solidstate') {
        let p = num('Power'); if (p == null) { const lo = num('PowerLow'), hi = num('PowerHigh'); p = lo != null && hi != null ? (lo + hi) / 2 : 0.6; }
        steps.push(ss(dur, p, extra));
      } else if (tag === 'intervalst') {
        const n = num('Repeat') || 1, on = num('OnDuration') || 0, off = num('OffDuration') || 0;
        const pon = num('OnPower') ?? num('PowerOnHigh') ?? num('PowerOnLow') ?? 1;
        const poff = num('OffPower') ?? num('PowerOffLow') ?? num('PowerOffHigh') ?? 0.5;
        const con = num('CadenceOn') || num('Cadence'), coff = num('CadenceResting');
        steps.push(rep(n, [ss(on, pon, con ? { cad: con } : {}), ss(off, poff, coff ? { cad: coff } : {})]));
      } else if (tag === 'freeride' || tag === 'maxeffort') {
        steps.push(free(dur));
      }
    }
    if (!steps.length) throw new Error('No se encontraron bloques de entrenamiento en el archivo');
    return { id: 'zwo-' + Date.now().toString(36), name: pick('name') || fname.replace(/\.zwo$/i, ''), desc: pick('description').slice(0, 140) || 'Importado de .zwo', steps, custom: true };
  };

  R.allWorkouts = () => R.BUILTIN_WORKOUTS.concat(R.store.get('customWorkouts', []));
})();
