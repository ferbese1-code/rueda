'use strict';
/* Métricas de la salida, archivo TCX y conexión con Strava */
(function () {
  const R = window.R;

  /* Muestras a 1 Hz guardadas en columnas: t (s desde el inicio), p, c, hr, v (km/h), d (m), alt (m) */
  R.newSamples = () => ({ t: [], p: [], c: [], hr: [], v: [], d: [], alt: [] });

  R.metrics = (S, ftp) => {
    const n = S.p.length;
    const m = { n, dur: n, dist: n ? S.d[n - 1] : 0, avgP: 0, maxP: 0, np: 0, ifac: 0, tss: 0, avgHr: 0, maxHr: 0, avgCad: 0, kj: 0, gain: 0, best60: 0, best300: 0, best1200: 0 };
    if (!n) return m;
    let sp = 0, sh = 0, nh = 0, sc = 0, nc = 0;
    for (let i = 0; i < n; i++) {
      sp += S.p[i]; m.maxP = Math.max(m.maxP, S.p[i]);
      if (S.hr[i] > 0) { sh += S.hr[i]; nh++; m.maxHr = Math.max(m.maxHr, S.hr[i]); }
      if (S.c[i] > 0) { sc += S.c[i]; nc++; }
      if (i) { const dy = S.alt[i] - S.alt[i - 1]; if (dy > 0) m.gain += dy; }
    }
    m.avgP = sp / n; m.kj = sp / 1000; m.avgHr = nh ? sh / nh : 0; m.avgCad = nc ? sc / nc : 0;
    // Potencia normalizada (media móvil de 30 s)
    if (n >= 30) {
      let roll = 0, acc = 0, cnt = 0;
      for (let i = 0; i < n; i++) { roll += S.p[i]; if (i >= 30) roll -= S.p[i - 30]; if (i >= 29) { acc += Math.pow(roll / 30, 4); cnt++; } }
      m.np = Math.pow(acc / cnt, 0.25);
    } else m.np = m.avgP;
    m.ifac = ftp ? m.np / ftp : 0;
    m.tss = ftp ? (n * m.np * m.ifac) / (ftp * 3600) * 100 : 0;
    const best = w => { if (n < w) return 0; let s = 0, b = 0; for (let i = 0; i < n; i++) { s += S.p[i]; if (i >= w) s -= S.p[i - w]; if (i >= w - 1) b = Math.max(b, s / w); } return b; };
    m.best60 = best(60); m.best300 = best(300); m.best1200 = best(1200);
    return m;
  };

  const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  R.tcx = ride => {
    const S = ride.samples, n = S.p.length, m = ride.summary || R.metrics(S, ride.ftp);
    const pts = [];
    for (let i = 0; i < n; i++) {
      let tp = `<Trackpoint><Time>${iso(ride.start + S.t[i] * 1000)}</Time><AltitudeMeters>${S.alt[i].toFixed(1)}</AltitudeMeters><DistanceMeters>${S.d[i].toFixed(1)}</DistanceMeters>`;
      if (S.hr[i] > 0) tp += `<HeartRateBpm><Value>${Math.round(S.hr[i])}</Value></HeartRateBpm>`;
      tp += `<Cadence>${Math.min(254, Math.round(S.c[i]))}</Cadence>`;
      tp += `<Extensions><ns3:TPX><ns3:Speed>${(S.v[i] / 3.6).toFixed(2)}</ns3:Speed><ns3:Watts>${Math.round(S.p[i])}</ns3:Watts></ns3:TPX></Extensions></Trackpoint>`;
      pts.push(tp);
    }
    const hrBlock = m.avgHr ? `<AverageHeartRateBpm><Value>${Math.round(m.avgHr)}</Value></AverageHeartRateBpm><MaximumHeartRateBpm><Value>${Math.round(m.maxHr)}</Value></MaximumHeartRateBpm>` : '';
    return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<Activities><Activity Sport="Biking"><Id>${iso(ride.start)}</Id>
<Lap StartTime="${iso(ride.start)}"><TotalTimeSeconds>${n}</TotalTimeSeconds><DistanceMeters>${(m.dist || 0).toFixed(1)}</DistanceMeters><Calories>${Math.round(m.kj)}</Calories>${hrBlock}<Intensity>Active</Intensity><Cadence>${Math.round(m.avgCad)}</Cadence><TriggerMethod>Manual</TriggerMethod>
<Track>
${pts.join('\n')}
</Track></Lap>
<Creator xsi:type="Device_t"><Name>Rueda</Name><UnitId>0</UnitId><ProductID>0</ProductID><Version><VersionMajor>1</VersionMajor><VersionMinor>0</VersionMinor></Version></Creator>
</Activity></Activities></TrainingCenterDatabase>`;
  };

  R.rideDescription = ride => {
    const m = ride.summary;
    const parts = [];
    if (ride.workoutName) parts.push('Entrenamiento: ' + ride.workoutName);
    parts.push('Ruta: ' + ride.routeName);
    parts.push(`NP ${Math.round(m.np)} W · IF ${m.ifac.toFixed(2)} · TSS ${Math.round(m.tss)}`);
    parts.push('Grabado con Rueda en rodillo');
    return parts.join('\n');
  };

  /* ---------- Strava ---------- */
  const S = R.strava = {};
  const AUTH = 'https://www.strava.com/oauth/authorize', TOKEN = 'https://www.strava.com/oauth/token', API = 'https://www.strava.com/api/v3';
  S.cfg = () => R.store.get('strava', { clientId: '', clientSecret: '', autoUpload: true });
  S.save = c => R.store.set('strava', c);
  S.connected = () => { const c = S.cfg(); return !!(c.refreshToken && c.clientId); };
  S.redirectUri = () => location.origin + location.pathname;
  S.canRedirect = () => /^https?:$/.test(location.protocol) && window.top === window.self;

  S.authorize = () => {
    const c = S.cfg();
    if (!c.clientId || !c.clientSecret) throw new Error('Escribe el Client ID y el Client Secret de tu app de Strava');
    const state = Math.random().toString(36).slice(2, 10);
    R.store.set('stravaState', state);
    const q = new URLSearchParams({ client_id: c.clientId, redirect_uri: S.redirectUri(), response_type: 'code', approval_prompt: 'auto', scope: 'read,activity:write', state });
    location.href = AUTH + '?' + q.toString();
  };

  async function tokenRequest(params) {
    const c = S.cfg();
    let res;
    try {
      res = await fetch(TOKEN, { method: 'POST', body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...params }) });
    } catch (e) { throw new Error('No se pudo contactar con Strava. Revisa la conexión a internet.'); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.message === 'Bad Request' ? 'Strava rechazó la petición: revisa Client ID, Client Secret y el dominio de autorización.' : (j.message || 'Error de Strava ' + res.status));
    const nc = { ...S.cfg(), accessToken: j.access_token, refreshToken: j.refresh_token || c.refreshToken, expiresAt: j.expires_at };
    if (j.athlete) nc.athlete = { id: j.athlete.id, name: [j.athlete.firstname, j.athlete.lastname].filter(Boolean).join(' ') };
    S.save(nc); return nc;
  }

  S.exchange = async (code, scope) => {
    const nc = await tokenRequest({ code, grant_type: 'authorization_code' });
    if (scope && !/activity:write/.test(scope)) { nc.noWrite = true; S.save(nc); throw new Error('Has conectado Strava sin permiso para subir actividades. Vuelve a conectar y deja marcada esa casilla.'); }
    delete nc.noWrite; S.save(nc); return nc;
  };

  /* Al volver de Strava: ?code=...&scope=...&state=... */
  S.handleRedirect = async () => {
    const q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return null;
    const clean = () => { try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) { /* nada */ } };
    if (q.get('error')) { clean(); throw new Error('Has cancelado la conexión con Strava'); }
    const code = q.get('code'), scope = q.get('scope') || '';
    clean();
    const c = S.cfg();
    if (!c.clientId || !c.clientSecret) {
      R.store.set('stravaPendingCode', { code, scope, at: Date.now() });
      throw new Error('Strava ha vuelto a un navegador sin tus claves. Copia esta dirección y pégala en Ajustes › Strava desde Bluefy.');
    }
    return S.exchange(code, scope);
  };

  /* Pegar a mano la dirección de vuelta (si se abrió en otro navegador) */
  S.fromPasted = async text => {
    let code = '', scope = '';
    try { const u = new URL(text.trim()); code = u.searchParams.get('code') || ''; scope = u.searchParams.get('scope') || ''; } catch (e) { code = text.trim(); }
    if (!code) throw new Error('No encuentro el código en lo que has pegado');
    return S.exchange(code, scope);
  };

  S.token = async () => {
    const c = S.cfg();
    if (!c.refreshToken) throw new Error('Strava no está conectado');
    if (c.accessToken && c.expiresAt && c.expiresAt - 120 > Date.now() / 1000) return c.accessToken;
    const nc = await tokenRequest({ grant_type: 'refresh_token', refresh_token: c.refreshToken });
    return nc.accessToken;
  };

  S.disconnect = () => { const c = S.cfg(); delete c.accessToken; delete c.refreshToken; delete c.expiresAt; delete c.athlete; S.save(c); };

  /* Sube la salida como VirtualRide y espera a que Strava la procese */
  S.upload = async (ride, onStatus) => {
    const tok = await S.token();
    const fd = new FormData();
    fd.append('file', new Blob([R.tcx(ride)], { type: 'application/vnd.garmin.tcx+xml' }), `rueda-${ride.id}.tcx`);
    fd.append('data_type', 'tcx');
    fd.append('name', ride.name || 'Rodillo');
    fd.append('description', R.rideDescription(ride));
    fd.append('trainer', '1');
    fd.append('sport_type', 'VirtualRide');
    fd.append('external_id', 'rueda-' + ride.id);
    onStatus && onStatus('Enviando a Strava…');
    let res;
    try { res = await fetch(API + '/uploads', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: fd }); }
    catch (e) { throw new Error('No se pudo enviar a Strava. Revisa la conexión a internet.'); }
    let j = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('Strava ha rechazado el permiso. Vuelve a conectar Strava en Ajustes.');
    if (!res.ok) throw new Error(j.error || j.message || 'Strava respondió con error ' + res.status);
    const id = j.id_str || j.id;
    for (let i = 0; i < 40 && !j.activity_id && !j.error; i++) {
      onStatus && onStatus('Strava está procesando la actividad…');
      await R.sleep(2500);
      const r2 = await fetch(API + '/uploads/' + id, { headers: { Authorization: 'Bearer ' + tok } });
      j = await r2.json().catch(() => ({}));
    }
    if (j.error) {
      const dup = /duplicate/i.test(j.error); const m = (j.error.match(/activities\/(\d+)/) || [])[1];
      if (dup && m) return { activityId: m, url: 'https://www.strava.com/activities/' + m, duplicate: true };
      throw new Error(dup ? 'Esta salida ya estaba en Strava' : j.error.replace(/<[^>]+>/g, ''));
    }
    if (!j.activity_id) throw new Error('Strava sigue procesando. Mírala en Strava en unos minutos.');
    return { activityId: String(j.activity_id), url: 'https://www.strava.com/activities/' + j.activity_id };
  };
})();
