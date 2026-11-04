'use strict';
/* Bluetooth: rodillo (FTMS o FE-C de Tacx), pulsómetro y potenciómetro. Más un simulador para probar sin rodillo. */
(function () {
  const R = window.R;
  const FEC_SVC = '6e40fec1-b5a3-f393-e0a9-e50e24dcca9e';
  const FEC_RX = '6e40fec2-b5a3-f393-e0a9-e50e24dcca9e'; // notificaciones del rodillo
  const FEC_TX = '6e40fec3-b5a3-f393-e0a9-e50e24dcca9e'; // órdenes al rodillo
  /* UUID completos en texto: algunos navegadores (Bluefy) no aceptan los números cortos tipo 0x1826 */
  const U = n => '0000' + n.toString(16).padStart(4, '0') + '-0000-1000-8000-00805f9b34fb';
  const FTMS = U(0x1826), IBD = U(0x2ad2), FTCP = U(0x2ad9), CPS = U(0x1818), DIS = U(0x180a), CPM = U(0x2a63), HRS = U(0x180d), HRMC = U(0x2a37);

  R.bleAvailable = () => !!(navigator.bluetooth && navigator.bluetooth.requestDevice);

  function write(ch, bytes, preferNoResponse) {
    const buf = new Uint8Array(bytes);
    if (preferNoResponse && ch.properties && ch.properties.writeWithoutResponse && ch.writeValueWithoutResponse) return ch.writeValueWithoutResponse(buf);
    if (ch.writeValueWithResponse && (!ch.properties || ch.properties.write)) return ch.writeValueWithResponse(buf);
    return ch.writeValue(buf);
  }

  class Device {
    constructor(role, label) {
      this.role = role; this.label = label; this.status = 'off'; this.name = '';
      this.dev = null; this.retries = 0; this.manualOff = false; this.retrying = false;
      this.data = { power: 0, cadence: 0, speed: 0, hr: 0, ts: 0 };
    }
    setStatus(s) { this.status = s; R.emit('devices'); }
    async connect() {
      this.manualOff = false;
      this.stage = 'buscar dispositivo';
      const dev = await navigator.bluetooth.requestDevice(this.requestOptions());
      R.blog(`${this.label}: elegido «${dev.name || 'sin nombre'}»`);
      if (this.dev && this.dev !== dev) { try { this.dev.gatt.disconnect(); } catch (e) { /* nada */ } }
      this.dev = dev; this.name = dev.name || this.label;
      if (!dev._ruedaHooked) { dev.addEventListener('gattserverdisconnected', () => this.lost()); dev._ruedaHooked = true; }
      await this.open();
    }
    async open() {
      this.setStatus('connecting');
      this.stage = 'conectar'; R.blog(`${this.label}: conectando…`);
      const server = await this.dev.gatt.connect();
      try { const ss = await server.getPrimaryServices(); R.blog(`${this.label}: servicios ${ss.map(s => s.uuid.slice(0, 8)).join(', ')}`); } catch (e) { /* no todos lo permiten */ }
      await this.setup(server);
      this.retries = 0; this.setStatus('on'); R.blog(`${this.label}: conectado${this.kind ? ' (' + this.kind + ')' : ''}`);
    }
    lost() {
      if (this.manualOff) { this.setStatus('off'); return; }
      if (this.retrying) return;
      this.setStatus('lost'); this.retry();
    }
    async retry() {
      this.retrying = true;
      while (!this.manualOff && this.retries < 10) {
        this.retries++;
        await R.sleep(Math.min(8000, 1200 * this.retries));
        try { await this.open(); this.retrying = false; R.toast(`${this.label} reconectado`); return; } catch (e) { /* reintento */ }
      }
      this.retrying = false;
      if (!this.manualOff) { this.setStatus('off'); R.toast(`${this.label}: conexión perdida`, 'bad'); }
    }
    disconnect() {
      this.manualOff = true;
      try { if (this.dev && this.dev.gatt.connected) this.dev.gatt.disconnect(); } catch (e) { /* nada */ }
      this.setStatus('off');
    }
    fresh() { return this.status === 'on' && this.data.ts && performance.now() - this.data.ts < 3500; }
  }

  /* ---------- Rodillo ---------- */
  class Trainer extends Device {
    constructor() {
      super('trainer', 'Rodillo');
      this.kind = null;
      this.want = { mode: 'sim', watts: 0, grade: 0 };
      this.sent = { mode: null, watts: null, grade: null, at: 0 };
      this.busy = false; this.needControl = false; this.timer = null;
      this.profile = { weight: 62, bike: 8 };
    }
    requestOptions() {
      return {
        filters: [{ services: [FTMS] }, { services: [FEC_SVC] }, { namePrefix: 'Tacx' }],
        optionalServices: [FTMS, FEC_SVC, CPS, DIS]
      };
    }
    async setup(server) {
      this.kind = null;
      // 1) FTMS (estándar). 2) Si no está o falla, el protocolo propio de Tacx (FE-C por Bluetooth).
      let ftms = null, firstErr = null;
      this.stage = 'servicio FTMS';
      try { ftms = await server.getPrimaryService(FTMS); } catch (e) { ftms = null; R.blog(`Rodillo: sin FTMS (${R.errText(e)})`); }
      if (ftms) {
        try { await this.setupFTMS(ftms); this.kind = 'ftms'; }
        catch (e) { firstErr = `${this.stage}: ${R.errText(e)}`; R.blog(`Rodillo: FTMS falló en ${firstErr}`); }
      }
      if (!this.kind) {
        try {
          this.stage = 'servicio Tacx FE-C';
          const s = await server.getPrimaryService(FEC_SVC);
          await this.setupFEC(s); this.kind = 'fec';
        } catch (e) {
          const msg = `${this.stage}: ${R.errText(e)}`; R.blog(`Rodillo: FE-C falló en ${msg}`);
          throw new Error(firstErr ? `${firstErr} · ${msg}` : msg);
        }
      }
      this.sent = { mode: null, watts: null, grade: null, at: 0 };
      if (!this.timer) this.timer = setInterval(() => this.pump(), 300);
    }
    async setupFTMS(s) {
      this.stage = 'datos FTMS'; this.ibd = await s.getCharacteristic(IBD);
      this.stage = 'control FTMS'; this.cp = await s.getCharacteristic(FTCP);
      this._onIBD = this._onIBD || (e => this.onIBD(e.target.value));
      this._onCP = this._onCP || (e => this.onCP(e.target.value));
      this.ibd.addEventListener('characteristicvaluechanged', this._onIBD);
      this.stage = 'avisos FTMS'; await this.ibd.startNotifications();
      try { this.cp.addEventListener('characteristicvaluechanged', this._onCP); await this.cp.startNotifications(); } catch (e) { /* sin indicaciones */ }
      try { await write(this.cp, [0x00]); } catch (e) { /* algunos no responden */ }
      await R.sleep(200);
      try { await write(this.cp, [0x07]); } catch (e) { /* idem */ }
    }
    async setupFEC(s) {
      this.stage = 'datos FE-C'; this.rx = await s.getCharacteristic(FEC_RX);
      this.stage = 'control FE-C'; this.tx = await s.getCharacteristic(FEC_TX);
      this._onFEC = this._onFEC || (e => this.onFEC(e.target.value));
      this.rx.addEventListener('characteristicvaluechanged', this._onFEC);
      this.stage = 'avisos FE-C'; await this.rx.startNotifications();
      await this.sendFecUser();
    }
    /* FTMS: Indoor Bike Data */
    onIBD(dv) {
      try {
        const flags = dv.getUint16(0, true); let o = 2; const n = dv.byteLength; const d = this.data;
        if (!(flags & 0x0001) && o + 2 <= n) { d.speed = dv.getUint16(o, true) / 100; o += 2; }
        if (flags & 0x0002) o += 2;
        if ((flags & 0x0004) && o + 2 <= n) { d.cadence = dv.getUint16(o, true) / 2; o += 2; }
        if (flags & 0x0008) o += 2;
        if (flags & 0x0010) o += 3;
        if (flags & 0x0020) o += 2;
        if ((flags & 0x0040) && o + 2 <= n) { d.power = Math.max(0, dv.getInt16(o, true)); o += 2; }
        if (flags & 0x0080) o += 2;
        if (flags & 0x0100) o += 5;
        if ((flags & 0x0200) && o + 1 <= n) { const hr = dv.getUint8(o); if (hr > 0) d.hr = hr; o += 1; }
        d.ts = performance.now();
      } catch (e) { /* paquete corto */ }
    }
    onCP(dv) {
      if (dv.byteLength >= 3 && dv.getUint8(0) === 0x80) {
        const result = dv.getUint8(2);
        if (result === 0x05) { this.needControl = true; this.sent.mode = null; } // control no concedido: volver a pedirlo
      }
    }
    /* Tacx FE-C sobre BLE: mensajes ANT */
    onFEC(dv) {
      const b = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      if (b.length < 12 || b[0] !== 0xa4) return;
      const p = b.subarray(4, 12); const d = this.data;
      if (p[0] === 0x10) {
        const sp = p[4] | (p[5] << 8); if (sp !== 0xffff) d.speed = sp * 0.0036;
        if (p[6] !== 0xff && p[6] > 0) d.hr = p[6];
      } else if (p[0] === 0x19) {
        if (p[2] !== 0xff) d.cadence = p[2];
        const pw = p[5] | ((p[6] & 0x0f) << 8); if (pw !== 0xfff) d.power = pw;
      }
      d.ts = performance.now();
    }
    fecMsg(page) {
      const m = [0xa4, 0x09, 0x4f, 0x05, ...page]; let cs = 0; for (const x of m) cs ^= x; m.push(cs);
      return write(this.tx, m, true);
    }
    sendFecUser() {
      const uw = Math.round(this.profile.weight * 100), bw = Math.round(this.profile.bike / 0.05);
      return this.fecMsg([0x37, uw & 0xff, (uw >> 8) & 0xff, 0xff, ((bw & 0x0f) << 4) | 0x0f, (bw >> 4) & 0xff, 70, 0x00]).catch(() => {});
    }
    sendErg(w) {
      if (this.kind === 'ftms') return write(this.cp, [0x05, w & 0xff, (w >> 8) & 0xff]);
      const v = w * 4; return this.fecMsg([0x31, 0xff, 0xff, 0xff, 0xff, 0xff, v & 0xff, (v >> 8) & 0xff]);
    }
    sendSim(g) {
      if (this.kind === 'ftms') {
        const gi = Math.round(g * 100) & 0xffff;
        return write(this.cp, [0x11, 0x00, 0x00, gi & 0xff, (gi >> 8) & 0xff, 40, 51]);
      }
      const raw = Math.round((g + 200) * 100);
      return this.fecMsg([0x33, 0xff, 0xff, 0xff, 0xff, raw & 0xff, (raw >> 8) & 0xff, 80]);
    }
    async pump() {
      if (this.status !== 'on' || this.busy || !this.kind) return;
      const w = this.want, s = this.sent, now = Date.now();
      let job = null;
      if (this.needControl && this.kind === 'ftms') {
        job = async () => { await write(this.cp, [0x00]); this.needControl = false; };
      } else if (w.mode === 'erg') {
        const watts = Math.round(R.clamp(w.watts, 0, 1500));
        if (s.mode !== 'erg' || Math.abs(watts - s.watts) >= 1 || now - s.at > 15000)
          job = async () => { await this.sendErg(watts); s.mode = 'erg'; s.watts = watts; s.at = now; };
      } else {
        const g = Math.round(R.clamp(w.grade, -10, 20) * 10) / 10;
        if (s.mode !== 'sim' || (Math.abs(g - s.grade) >= 0.1 && now - s.at > 700) || now - s.at > 10000)
          job = async () => { await this.sendSim(g); s.mode = 'sim'; s.grade = g; s.at = now; };
      }
      if (!job) return;
      this.busy = true;
      try { await job(); } catch (e) { s.at = now; console.warn('Rodillo: escritura fallida', e); }
      finally { this.busy = false; }
    }
    setErg(watts) { this.want.mode = 'erg'; this.want.watts = watts; }
    setSim(grade) { this.want.mode = 'sim'; this.want.grade = grade; }
  }

  /* ---------- Pulsómetro ---------- */
  class HRM extends Device {
    constructor() { super('hrm', 'Pulsómetro'); }
    requestOptions() { return { filters: [{ services: [HRS] }] }; }
    async setup(server) {
      const s = await server.getPrimaryService(HRS);
      const c = await s.getCharacteristic(HRMC);
      this._h = this._h || (e => this.on(e.target.value));
      c.addEventListener('characteristicvaluechanged', this._h);
      await c.startNotifications();
    }
    on(dv) {
      const f = dv.getUint8(0);
      this.data.hr = (f & 1) ? dv.getUint16(1, true) : dv.getUint8(1);
      this.data.ts = performance.now();
    }
  }

  /* ---------- Potenciómetro (p. ej. pedales) ---------- */
  class PowerMeter extends Device {
    constructor(label) { super('pm', label || 'Potenciómetro'); this.lastRevs = null; this.lastT = 0; this.lastCadAt = 0; }
    requestOptions() { return { filters: [{ services: [CPS] }] }; }
    async setup(server) {
      const s = await server.getPrimaryService(CPS);
      const c = await s.getCharacteristic(CPM);
      this._h = this._h || (e => this.on(e.target.value));
      c.addEventListener('characteristicvaluechanged', this._h);
      await c.startNotifications();
      this.lastRevs = null;
    }
    on(dv) {
      try {
        const f = dv.getUint16(0, true); let o = 2; const now = performance.now();
        this.data.power = Math.max(0, dv.getInt16(o, true)); o += 2;
        // Reparto entre piernas: % del pedal de referencia (izquierdo si el bit 1 está activo o no se indica)
        if (f & 0x01) { const b = dv.getUint8(o); this.data.bal = b === 0xff ? null : b / 2; this.data.balLeft = !!(f & 0x02); o += 1; }
        else this.data.bal = null;
        if (f & 0x04) o += 2;
        if (f & 0x10) o += 6;
        if ((f & 0x20) && dv.byteLength >= o + 4) {
          const revs = dv.getUint16(o, true), t = dv.getUint16(o + 2, true);
          if (this.lastRevs != null) {
            const dr = (revs - this.lastRevs + 65536) % 65536, dt = (t - this.lastT + 65536) % 65536;
            if (dr > 0 && dt > 0) { this.data.cadence = R.clamp(dr * 60 * 1024 / dt, 0, 220); this.lastCadAt = now; }
          }
          this.lastRevs = revs; this.lastT = t;
        }
        if (now - this.lastCadAt > 3000) this.data.cadence = 0;
        this.data.ts = now;
      } catch (e) { /* paquete corto */ }
    }
  }

  /* ---------- Simulador (modo prueba) ---------- */
  class SimTrainer {
    constructor() {
      this.role = 'trainer'; this.label = 'Rodillo'; this.name = 'Simulador'; this.kind = 'sim'; this.status = 'off';
      this.want = { mode: 'sim', watts: 0, grade: 0 };
      this.data = { power: 0, cadence: 0, speed: 0, hr: 0, ts: 0 };
      this.p = 0; this.hr = 92; this.t = 0; this.resting = false;
    }
    connect() { this.status = 'on'; R.emit('devices'); return Promise.resolve(); }
    disconnect() { this.status = 'off'; R.emit('devices'); }
    fresh() { return this.status === 'on'; }
    setErg(w) { this.want.mode = 'erg'; this.want.watts = w; }
    setSim(g) { this.want.mode = 'sim'; this.want.grade = g; }
    tick(dt, ftp) {
      if (this.status !== 'on') return;
      this.t += dt;
      let target;
      if (this.want.mode === 'erg') target = this.want.watts;
      else {
        const g = this.want.grade;
        target = ftp * (0.64 + 0.04 * R.clamp(g, -5, 9)) + ftp * 0.06 * Math.sin(this.t / 21);
        if (g < -3.5) target *= 0.35;
      }
      if (this.resting) target = 0;
      this.p += (target - this.p) * (1 - Math.exp(-dt * 1.6));
      const noise = (Math.random() - 0.5) * 0.06 * Math.max(60, this.p);
      this.data.power = Math.max(0, Math.round(this.p + noise));
      this.data.cadence = this.data.power > 25 ? Math.round(87 + 4 * Math.sin(this.t / 13) + (Math.random() - 0.5) * 3) : 0;
      const hrT = 64 + 0.4 * this.p;
      this.hr += (hrT - this.hr) * (1 - Math.exp(-dt / 22));
      this.data.hr = Math.round(this.hr);
      this.data.ts = performance.now();
    }
  }

  R.Trainer = Trainer; R.HRM = HRM; R.PowerMeter = PowerMeter; R.SimTrainer = SimTrainer;
})();
