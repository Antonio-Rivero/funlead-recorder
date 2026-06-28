# Migración yoom-desktop → funlead-recorder (OSS)

Decidido 2026-06-28 (Antonio): el OSS es la app de verdad. Llevar TODA la
funcionalidad madura de yoom-desktop al OSS desktop hasta paridad, y luego jubilar
yoom-desktop. yoom-desktop = app madura (cámara real, subida, ajustes); OSS desktop
= esqueleto (graba pantalla + editor + render local + transcripción local), con
cámara placeholder y SIN subida.

Regla dura del OSS: público MIT, gate de privacidad. La subida NO puede ir
hardcodeada a funlead.app: en el OSS es self-host (baseUrl configurable por el
usuario). Sin secretos ni datos de clientes.

## Fases

- [~] Fase 0 — base: mergear a main del OSS el fix de CPU+recorte (rama
      port/cpu-videotoolbox, commit 3c6e832). Gate clippy en curso.
- [x] Fase 1 — cámara funcional (COMPLETA):
      - [x] 1a: camera.tsx (450 líneas, getUserMedia + robustez cámara externa +
            blur MediaPipe + espejo + resize) + camera.css, portados de yoom y
            DESACOPLADOS de settings (espejo fijo on). camera.rs del OSS ya pasa
            deviceId por URL → cámara funcional default. Build verde. commit 58e7314.
      - [x] 1b: selección de cámara en App.tsx (enumerar videoinput, dropdown,
            cambio close+reopen, listener camera:error, toggle con deviceId). commit.
            Pendiente menor: control del blur por EV_SET_BLUR (toggle en UI) → Fase 3.
- [~] Fase 2 — subida self-host (auth por token, decidido por Antonio):
      - [x] 2a (web): nuevo RECORDING_DESKTOP_TOKEN aceptado como Authorization:
            Bearer en /api/recordings (POST) y /api/recordings/upload (handshake),
            vía guard requireOwnerOrDesktop + isValidDesktopToken (timing-safe,
            env-gated, aditivo). tsc verde. commit 63e94ff.
      - [ ] 2b (desktop): settings (AÑADIR plugin-store al OSS: baseUrl de la
            instancia + token) + upload.ts (Bearer, endpoints /api/recordings +
            /api/recordings/upload, con el fix red-vs-token + reintento) + UI de
            subir en App.tsx (tras grabar/editar → subir → mostrar link /v/<token>).
      NOTA tooling: el `next lint` del OSS web está roto (Invalid project directory);
      verificación del web = tsc (eslint no ejecutable desde aquí). Arreglar aparte.
- [ ] Fase 3 — paridad de ajustes: cuenta atrás, mirror, showTimer, calidad (ya),
      lo que falte de yoom.
- [ ] Fase 4 — jubilar yoom-desktop cuando el OSS tenga paridad.

## Estado de los 4 fixes del loop en el OSS
- CPU captura + recorte (videotoolbox + 1080p): portado (Fase 0, mergeando).
- Robustez cámara externa: llega con Fase 1 (la cámara aún no existe en el OSS).
- Robustez subida: llega con Fase 2 (la subida aún no existe en el OSS).

## Notas de divergencia (no es copiar yoom encima)
- OSS usa app:&AppHandle en ffmpeg::command/spawn_capture/trim; prefijo FunLead-.
- OSS tiene editor con manifest, render local, ffmpeg estático bundled, transcripción
  local: NO tocar, son del OSS.
- Verificar cada fase: tsc local (node_modules/.bin/tsc) + cargo check + clippy.
