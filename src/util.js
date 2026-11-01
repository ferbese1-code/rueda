'use strict';
/* Utilidades comunes: DOM, formato, almacenamiento, audio, avisos */
const R = (window.R = window.R || {});

R.$ = (s, el = document) => el.querySelector(s);
R.$$ = (s, el = document) => Array.from(el.querySelectorAll(s));
R.clamp = (x, a, b) => Math.max(a, Math.min(b, x));
R.lerp = (a, b, t) => a + (b - a) * t;
R.smoothstep = (a, b, x) => { const t = R.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
R.sleep = ms => new Promise(r => setTimeout(r, ms));
R.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

R.fmtTime = s => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
};
R.fmtStepDur = s => {
  s = Math.round(s);
  if (s < 60) return `${s}s`;
  if (s % 60 === 0) return `${s / 60}min`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
R.fmtNum = (x, d = 0) => Number(x).toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d });
R.fmtDate = ts => new Date(ts).toLocaleString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/* Mulberry32: aleatorio con semilla (rutas siempre iguales) */
R.rng = seed => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/* Eventos */
const bus = {};
R.on = (n, f) => { (bus[n] = bus[n] || []).push(f); };
R.emit = (n, ...a) => { (bus[n] || []).forEach(f => { try { f(...a); } catch (e) { console.error(e); } }); };

/* localStorage seguro */
R.store = {
  get(k, d) { try { const v = localStorage.getItem('rueda.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('rueda.' + k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento */ } },
  del(k) { try { localStorage.removeItem('rueda.' + k); } catch (e) { /* nada */ } }
};

/* IndexedDB para las salidas (pueden ocupar bastante) */
R.idb = (() => {
  let dbp = null; const mem = new Map();
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      try {
        const r = indexedDB.open('rueda', 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('rides', { keyPath: 'id' }); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    });
    return dbp;
  }
  function tx(mode, fn) {
    return open().then(db => new Promise((res, rej) => {
      const t = db.transaction('rides', mode); const req = fn(t.objectStore('rides'));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
    }));
  }
  const byDate = (a, b) => b.start - a.start;
  return {
    async put(o) { try { await tx('readwrite', s => s.put(o)); } catch (e) { mem.set(o.id, o); } },
    async get(id) { try { const r = await tx('readonly', s => s.get(id)); return r || mem.get(id); } catch (e) { return mem.get(id); } },
    async all() {
      try { const r = await tx('readonly', s => s.getAll()); return (r || []).concat([...mem.values()]).sort(byDate); }
      catch (e) { return [...mem.values()].sort(byDate); }
    },
    async del(id) { mem.delete(id); try { await tx('readwrite', s => s.delete(id)); } catch (e) { /* nada */ } }
  };
})();

/* Pitidos para los cambios de bloque */
R.audio = {
  ctx: null, on: true,
  unlock() {
    try {
      if (!this.ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) this.ctx = new AC(); }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    } catch (e) { /* sin audio */ }
  },
  beep(f = 880, d = 0.12, v = 0.18) {
    const c = this.ctx; if (!c || !this.on) return;
    try {
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(v, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + d);
      o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + d + 0.03);
    } catch (e) { /* nada */ }
  }
};

/* Avisos breves */
R.toast = (msg, kind = '') => {
  const box = R.$('#toasts'); if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = msg; box.appendChild(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3800);
};

/* Zonas de potencia (% FTP) */
R.zone = f => (f < 0.55 ? 1 : f < 0.76 ? 2 : f < 0.91 ? 3 : f < 1.06 ? 4 : f < 1.21 ? 5 : 6);
R.zoneColor = f => getComputedStyle(document.documentElement).getPropertyValue('--z' + R.zone(f)).trim() || '#888';
R.ZC = {};
R.cacheZoneColors = () => { for (let i = 1; i <= 6; i++) R.ZC[i] = getComputedStyle(document.documentElement).getPropertyValue('--z' + i).trim(); };
R.zc = f => R.ZC[R.zone(f)] || '#888';

/* Mantener la pantalla encendida */
R.wake = {
  lock: null,
  async on() {
    try { if ('wakeLock' in navigator) { this.lock = await navigator.wakeLock.request('screen'); } } catch (e) { /* no disponible */ }
  },
  off() { try { this.lock && this.lock.release(); } catch (e) { /* nada */ } this.lock = null; }
};

/* Guardar/compartir un fichero (TCX) */
R.saveFile = async (name, text, mime) => {
  const blob = new Blob([text], { type: mime });
  try {
    const file = new File([blob], name, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return true; }
  } catch (e) { if (e && e.name === 'AbortError') return false; }
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
    return true;
  } catch (e) { R.toast('No se pudo guardar el archivo en este navegador', 'bad'); return false; }
};
