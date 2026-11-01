'use strict';
/* Física potencia → velocidad y ciclistas virtuales con rebufo */
(function () {
  const R = window.R;
  const G = 9.81, RHO = 1.2, CRR = 0.004, CDA = 0.32, ETA = 0.976;

  /* Avanza un ciclista: r = { v (m/s), d (m), mass (kg) } */
  R.stepRider = (r, P, grade, dt, cdaMul = 1) => {
    const th = Math.atan(grade / 100), v = Math.max(0, r.v);
    const Fg = r.mass * G * Math.sin(th);
    const Fr = v > 0.05 ? r.mass * G * CRR * Math.cos(th) : 0;
    const Fa = 0.5 * RHO * CDA * cdaMul * v * v;
    const Fp = (P * ETA) / Math.max(v, 1.2);
    const a = (Fp - Fg - Fr - Fa) / (r.mass * 1.04);
    r.v = Math.max(0, v + a * dt);
    r.d += r.v * dt;
  };

  /* Velocidad estable para una potencia dada (para colocar bots) */
  R.steadySpeed = (P, grade, mass) => {
    let v = 8;
    for (let i = 0; i < 40; i++) {
      const th = Math.atan(grade / 100);
      const need = (0.5 * RHO * CDA * v * v + mass * G * (CRR * Math.cos(th) + Math.sin(th))) * v - P * ETA;
      const dv = (1.5 * RHO * CDA * v * v + mass * G * (CRR * Math.cos(th) + Math.sin(th)));
      v = R.clamp(v - need / (dv || 1), 0.5, 25);
    }
    return v;
  };

  const NAMES = [
    ['C. Soler', '🇪🇸'], ['R. Llorens', '🇪🇸'], ['T. Becker', '🇩🇪'], ['S. Ivanova', '🇧🇬'], ['J. Moreau', '🇫🇷'],
    ['K. Nakamura', '🇯🇵'], ['D. O\'Brien', '🇮🇪'], ['L. Rossi', '🇮🇹'], ['M. Andersen', '🇩🇰'], ['E. Kowalski', '🇵🇱'],
    ['F. Duarte', '🇵🇹'], ['H. Laine', '🇫🇮'], ['A. Vidal', '🇪🇸'], ['N. Okafor', '🇬🇧'], ['P. Jansen', '🇳🇱'], ['I. Moreno', '🇲🇽']
  ];
  const JERSEYS = ['#2f7de1', '#e2483d', '#21a37a', '#f2c230', '#8a4fe0', '#ffffff', '#1f2a36', '#ff8fb1', '#14b8c4', '#c9e04a', '#ef7d22', '#5b6b7a'];
  const LANES = [-2.7, -1.6, -0.5, 0.4, 2.9, 3.3, -2.1, 1.1];

  class Bots {
    constructor(count, seed) {
      this.rnd = R.rng(seed || 7); this.list = []; this.t = 0;
      for (let i = 0; i < count; i++) {
        const [name, flag] = NAMES[i % NAMES.length];
        this.list.push({
          id: i, name, flag, jersey: JERSEYS[i % JERSEYS.length],
          wkg: 1.6 + this.rnd() * 2.0, kg: 58 + this.rnd() * 26,
          lane: LANES[i % LANES.length], d: 0, v: 8, mass: 0, phase: this.rnd() * 6.28, period: 30 + this.rnd() * 60,
          crank: this.rnd() * 6.28, wheel: 0, power: 0, cad: 85 + this.rnd() * 10
        });
      }
    }
    place(route, playerD, playerWkg) {
      this.list.forEach((b, i) => {
        b.d = playerD + (i % 2 ? 1 : -1) * (40 + this.rnd() * 650);
        if (i < 3) b.d = playerD + 8 + i * 22 + this.rnd() * 10; // algunos cerca al empezar
        if (playerWkg) b.wkg = R.clamp(playerWkg + (this.rnd() - 0.5) * 1.2, 1.2, 4.6);
        b.mass = b.kg + 8;
        b.v = R.steadySpeed(b.wkg * b.kg, route.grade(b.d), b.mass);
      });
    }
    update(dt, route, player, playerWkg) {
      this.t += dt;
      const all = this.list.concat([player]);
      for (const b of this.list) {
        const grade = route.grade(b.d);
        let f = 1 + 0.07 * Math.sin(this.t / b.period * 6.28 + b.phase);
        f *= 1 + R.clamp(grade, -4, 9) * 0.022;
        if (grade < -3) f *= 0.45;
        b.power = Math.max(0, b.wkg * b.kg * f);
        let draft = 1;
        for (const o of all) { if (o === b) continue; const gap = o.d - b.d; if (gap > 1.4 && gap < 7) { draft = 0.68; break; } }
        R.stepRider(b, b.power, grade, dt, draft);
        b.cad = b.power > 30 ? 84 + 8 * Math.sin(this.t / 17 + b.phase) : 0;
        b.crank -= (b.cad / 60) * Math.PI * 2 * dt;
        b.wheel -= (b.v * dt) / 0.34;
        // Mantener gente alrededor: si alguien se aleja demasiado, reaparece cerca
        if (Math.abs(b.d - player.d) > 1600) {
          const ahead = this.rnd() < 0.5;
          b.d = player.d + (ahead ? 1 : -1) * (220 + this.rnd() * 380);
          b.wkg = R.clamp((playerWkg || 2.5) + (this.rnd() - 0.45) * 1.0, 1.2, 4.6);
          b.v = Math.max(3, player.v * (0.9 + this.rnd() * 0.2));
        }
      }
    }
    draftFor(player) {
      for (const b of this.list) { const gap = b.d - player.d; if (gap > 1.4 && gap < 7) return true; }
      return false;
    }
    nearest(player, n) {
      return this.list
        .map(b => ({ b, gap: b.d - player.d }))
        .filter(o => Math.abs(o.gap) < 1500)
        .sort((a, c) => Math.abs(a.gap) - Math.abs(c.gap))
        .slice(0, n)
        .sort((a, c) => c.gap - a.gap);
    }
  }
  R.Bots = Bots;
})();
