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
- [ ] Fase 1 — cámara funcional: portar camera.tsx de yoom (470 líneas:
      getUserMedia con el fix de robustez de cámara externa, blur MediaPipe,
      espejo, resize, eventos) + camera.css + la selección de cámara en App.tsx
      (refreshCameras/handleSelectCamera/toggle/EV_CAM_ERROR) + camera.rs si
      difiere. Reemplaza el placeholder de 29 líneas. Verificar tsc + cargo.
- [ ] Fase 2 — subida self-host: portar upload.ts (con el fix red-vs-token +
      reintento) ADAPTADO a self-host (baseUrl del usuario, no funlead.app) + la
      UI de subida en App.tsx (saved → trim → subir) + token/endpoint en settings.
      Es la W4 del OSS ("subir a mi servidor"). Respetar gate de privacidad.
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
