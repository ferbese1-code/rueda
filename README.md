# Rueda · rodillo virtual

App web tipo Zwift para el rodillo Tacx: mundo 3D, entrenamientos en modo ERG, rutas con pendiente simulada, ciclistas virtuales con rebufo y subida de cada salida a Strava.

## Usarla
- **iPhone**: abre la dirección de la app en **Bluefy** (Safari no permite Bluetooth).
- **Android**: ábrela en **Chrome**; puedes instalarla desde el menú (Añadir a pantalla de inicio).
- Conecta el rodillo (FTMS o FE-C de Tacx), y si quieres el pulsómetro y los pedales Assioma.
- Sin rodillo: activa **Modo prueba**.

## Strava
1. Crea una aplicación en https://www.strava.com/settings/api
2. En «Authorization Callback Domain» pon el dominio de la app (p. ej. `usuario.github.io`).
3. En la app: Ajustes › Strava › pega Client ID y Client Secret › Conectar.
Las claves se guardan solo en el navegador del móvil. Las salidas se suben como *VirtualRide* desde un TCX con potencia, cadencia y pulso.

## Desarrollo
El código está en `src/`. `python3 build.py` genera `index.html` (un único archivo) en la raíz.

| Archivo | Qué hace |
|---|---|
| `src/ble.js` | Bluetooth: Tacx por FTMS o FE-C, pulsómetro, potenciómetro y simulador |
| `src/world.js` | Mundo 3D (Three.js r128) y ciclistas |
| `src/routes.js` | Rutas cerradas con perfil |
| `src/sim.js` | Física potencia→velocidad y bots |
| `src/workouts.js` | Entrenamientos, importación `.zwo` y motor ERG |
| `src/data.js` | Métricas (NP, IF, TSS), TCX y Strava |
| `src/app.js` | Pantallas, bucle, HUD, resumen, ajustes e historial |
