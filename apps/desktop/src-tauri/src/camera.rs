use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
use tauri_nspanel::{
    tauri_panel, CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt,
};

const CAMERA_LABEL: &str = "camera";
const CAMERA_SIZE: f64 = 220.0;
const CAMERA_MARGIN: f64 = 24.0;

// Declares the NSPanel subclass the camera window is reclassed into. A real
// NSPanel is what lets the `NonactivatingPanel` style bit and the fullscreen
// collection behavior actually take effect — a plain NSWindow ignores them, so
// it never joins another app's native fullscreen Space (rekordbox/Spotify).
#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(CameraPanel {
        config: {
            can_become_key_window: false,
            can_become_main_window: false,
            is_floating_panel: true,
            // Applied by the plugin right after the class swizzle (setHidesOnDeactivate:NO).
            // Keeps the bubble on screen when our app deactivates — which is exactly what
            // happens when ANOTHER app's fullscreen takes over the display.
            hides_on_deactivate: false,
            becomes_key_only_if_needed: true
        }
    })
}

pub fn is_open(app: &AppHandle) -> bool {
    app.get_webview_window(CAMERA_LABEL).is_some()
}

pub fn toggle(app: &AppHandle, device_id: Option<String>) -> Result<bool, String> {
    // Single bubble invariant: if a camera window exists this toggle hides it.
    // Reusing/closing the existing one here is what prevents the duplicate
    // ("denegado" + live) bubbles seen when the command fires twice.
    if app.get_webview_window(CAMERA_LABEL).is_some() {
        close(app)?;
        return Ok(false);
    }

    open(app, device_id)
}

/// Cambia la cámara de la burbuja viva SIN recrear la ventana/panel: emite un
/// evento y deja que camera.tsx reinicie su getUserMedia. El close+reopen es el
/// que arriesga el use-after-free (ver `close`). Sin ventana abierta = no-op.
pub fn set_device(app: &AppHandle, device_id: Option<String>) -> Result<(), String> {
    let Some(window) = app.get_webview_window(CAMERA_LABEL) else {
        return Ok(());
    };
    window
        .emit("camera-device-changed", device_id)
        .map_err(|e| e.to_string())
}

/// Cierra la burbuja de forma segura. En macOS la ventana se reclasó a NSPanel
/// (registrado en el plugin), así que `window.close()` directo es un use-after-free
/// (NSPanel libera el objeto con releasedWhenClosed=YES mientras el plugin aún lo
/// referencia) -> NSException -> abort. `to_window()` es el camino seguro y debe
/// correr en el MAIN THREAD; los comandos Tauri corren en worker -> hop a main.
pub fn close(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let Some(_window) = app.get_webview_window(CAMERA_LABEL) else {
            return Ok(());
        };
        let app = app.clone();
        _window
            .run_on_main_thread(move || close_panel_on_main(&app))
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(window) = app.get_webview_window(CAMERA_LABEL) {
            window.close().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

/// Teardown en main thread del NSPanel reclasado. Idempotente: un segundo close no
/// encuentra panel y es no-op. NUNCA caemos a window.close() directo en macOS si el
/// panel sigue registrado (ese es el camino que aborta).
#[cfg(target_os = "macos")]
fn close_panel_on_main(app: &AppHandle) {
    match app.get_webview_panel(CAMERA_LABEL) {
        Ok(panel) => match panel.to_window() {
            Some(window) => {
                let _ = window.close();
            }
            None => eprintln!("camera panel deregistered before to_window() — skipping close"),
        },
        Err(_) => {
            if let Some(window) = app.get_webview_window(CAMERA_LABEL) {
                let _ = window.close();
            }
        }
    }
}

/// Build the camera bubble window and turn it into a non-activating NSPanel.
/// Used by `toggle` and by the `FUNLEAD_RECORDER_DEBUG_CAM=1` auto-open path.
pub fn open(app: &AppHandle, device_id: Option<String>) -> Result<bool, String> {
    // Anchor to the bottom-right of the primary monitor, falling back to a
    // fixed offset when the monitor can't be queried.
    let (x, y) = match app.primary_monitor() {
        Ok(Some(monitor)) => {
            let scale = monitor.scale_factor();
            let logical = monitor.size().to_logical::<f64>(scale);
            (
                logical.width - CAMERA_SIZE - CAMERA_MARGIN,
                logical.height - CAMERA_SIZE - CAMERA_MARGIN * 3.0,
            )
        }
        _ => (CAMERA_MARGIN, CAMERA_MARGIN),
    };

    let url = match device_id {
        Some(id) => format!("camera.html?deviceId={}", urlencode(&id)),
        None => "camera.html".to_string(),
    };

    // NOTE: we intentionally do NOT call `.visible_on_all_workspaces(true)` here.
    // tao applies that flag (CanJoinAllSpaces) on the NSWindow *before* the window
    // is shown, and on macOS the collection behavior set pre-show is unreliable in
    // release builds (tauri#5566). We own the panel state ourselves in
    // `apply_overlay_window_state`, applied *after* the panel conversion.
    let window = WebviewWindowBuilder::new(app, CAMERA_LABEL, WebviewUrl::App(url.into()))
        .title("Cámara")
        .inner_size(CAMERA_SIZE, CAMERA_SIZE)
        .min_inner_size(120.0, 120.0)
        .max_inner_size(480.0, 480.0)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .resizable(true)
        .shadow(false)
        .skip_taskbar(true)
        .build()
        .map_err(|e| e.to_string())?;

    // Belt-and-suspenders on macOS: the native NSWindow keeps a shadow even with
    // shadow(false) on a transparent decorationless window, so force it off again.
    let _ = window.set_shadow(false);

    make_panel_overlay(&window);

    Ok(true)
}

/// Convert the camera window into a non-activating NSPanel and pin it as a
/// floating overlay that follows the user across every Space — including the
/// native fullscreen Space of another app.
///
/// Why a plain NSWindow wasn't enough: AppKit only honors
/// `NSWindowStyleMaskNonactivatingPanel` and lets a window co-inhabit another
/// app's fullscreen Space when the window is an actual `NSPanel`. tao gives us a
/// plain `NSWindow`, so the previous attempts (collection behavior + level 1000
/// on the NSWindow) appeared on normal desktops but never on someone else's
/// fullscreen. `to_panel` reclasses the live window into an `NSPanel` subclass
/// (the plugin's vetted mechanism), after which the same flags finally take.
#[cfg(target_os = "macos")]
fn make_panel_overlay(window: &tauri::WebviewWindow) {
    // The panel conversion and every setter are AppKit calls that MUST run on the
    // main thread. `toggle` is a Tauri command, which runs on a worker thread, so
    // hop to main before touching AppKit (the old NSWindow path got away with
    // off-main `msg_send!`, but that was UB that merely happened to work).
    let win = window.clone();
    let _ = window.run_on_main_thread(move || {
        // Full panel setup runs exactly ONCE: reclass to NSPanel + style mask +
        // collection behavior + level. Re-reclassing or re-styling on every reapply
        // (the old 300ms loop) is what risked AppKit thrashing the panel state.
        configure_panel(&win, "post-panel");

        // Re-pin once on a short delay to outlast any ordering AppKit resets on
        // show/focus — but only re-assert level + order_front, never re-reclass or
        // re-style. Spawn off-main to sleep, then hop back to main to touch AppKit.
        let win2 = win.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            let win3 = win2.clone();
            let _ = win2.run_on_main_thread(move || {
                repin_panel(&win3, "delayed-repin");
            });
        });
    });
}

/// Apply the non-activating panel mask + fullscreen collection behavior + level,
/// then log the read-back. Main-thread only.
#[cfg(target_os = "macos")]
fn configure_panel(window: &tauri::WebviewWindow, phase: &str) {
    let panel = match window.to_panel::<CameraPanel>() {
        Ok(panel) => panel,
        Err(e) => {
            eprintln!("to_panel() failed ({phase}): {e}");
            return;
        }
    };

    // Non-activating panel so clicking the bubble never steals focus / activates the
    // app. This bit (NSWindowStyleMaskNonactivatingPanel, 0x80) is what the plugin's
    // fullscreen example uses and is REQUIRED to float over another app's fullscreen.
    //
    // We intentionally do NOT chain `.borderless()` here: the plugin's `borderless()`
    // builder ASSIGNS the mask (self.0 = Borderless) instead of OR-ing it, so calling
    // it after `nonactivating_panel()` wiped the 0x80 bit — that's why the read-back
    // was styleMask=0x8 (only Resizable) instead of 0x88. Borderless is 0x0 anyway,
    // and the window is already decoration-less via `decorations(false)` at build time.
    // Add only Resizable (0x8) so window-edge resizing keeps working. Result = 0x88.
    panel.set_style_mask(StyleMask::empty().nonactivating_panel().resizable().into());

    // CanJoinAllSpaces => visible on every Space; FullScreenAuxiliary => may float
    // over a fullscreen window; Stationary => doesn't get swept by Space-switch
    // animations. Together with the panel reclass this is what reaches another
    // app's fullscreen.
    panel.set_collection_behavior(
        CollectionBehavior::new()
            .can_join_all_spaces()
            .full_screen_auxiliary()
            .stationary()
            .into(),
    );

    // NSScreenSaverWindowLevel (1000): above other apps' fullscreen, like Loom/Zoom.
    panel.set_level(PanelLevel::ScreenSaver.value());
    panel.set_becomes_key_only_if_needed(true);
    // Belt-and-suspenders over the `panel!` config: explicitly keep the bubble visible
    // when our app deactivates (the fullscreen-app case). Example does the same.
    panel.set_hides_on_deactivate(false);
    panel.order_front_regardless();

    apply_overlay_window_state(window, phase);
}

/// Re-assert ONLY ordering/level on the already-converted panel, without
/// re-reclassing or re-applying the style mask. Used by the single delayed pass to
/// outlast any z-order reset AppKit does on show/focus. Main-thread only.
#[cfg(target_os = "macos")]
fn repin_panel(window: &tauri::WebviewWindow, phase: &str) {
    let Some(panel) = window.app_handle().get_webview_panel(CAMERA_LABEL).ok() else {
        eprintln!("get_webview_panel() missing ({phase}) — skipping repin");
        return;
    };
    panel.set_level(PanelLevel::ScreenSaver.value());
    panel.order_front_regardless();
    apply_overlay_window_state(window, phase);
}

/// Read back the live NSPanel state and log it so a terminal run can verify the
/// overlay applied and stuck. Uses the cocoa/objc 0.2 `msg_send!` path on the
/// raw `ns_window()` pointer on purpose — mixing it with objc2's retain
/// semantics for a read-only probe is needless risk.
#[cfg(target_os = "macos")]
fn apply_overlay_window_state(window: &tauri::WebviewWindow, phase: &str) {
    use cocoa::base::id;
    use objc::{class, msg_send, sel, sel_impl};

    // Wanted collection behavior, kept here only so the log can show want=/got=.
    // CanJoinAllSpaces (1<<0) | FullScreenAuxiliary (1<<8) | Stationary (1<<4).
    const WANT_BEHAVIOR: u64 = (1 << 0) | (1 << 8) | (1 << 4);
    const NS_SCREEN_SAVER_WINDOW_LEVEL: i64 = 1000;

    let ptr = match window.ns_window() {
        Ok(ptr) => ptr,
        Err(e) => {
            eprintln!("ns_window() error ({phase}): {e}");
            return;
        }
    };
    if ptr.is_null() {
        eprintln!("ns_window() returned null ({phase})");
        return;
    }

    let ns_window = ptr as id;
    unsafe {
        let behavior: u64 = msg_send![ns_window, collectionBehavior];
        let level: i64 = msg_send![ns_window, level];
        let style_mask: u64 = msg_send![ns_window, styleMask];
        let is_panel: bool = msg_send![ns_window, isKindOfClass: class!(NSPanel)];
        let hides_on_deactivate: bool = msg_send![ns_window, hidesOnDeactivate];
        // NSApplicationActivationPolicy: 0=Regular, 1=Accessory, 2=Prohibited.
        let app: id = msg_send![class!(NSApplication), sharedApplication];
        let activation_policy: i64 = msg_send![app, activationPolicy];
        eprintln!(
            "apply_overlay_window_state ({phase}) is_panel={is_panel} \
             want={WANT_BEHAVIOR} got={behavior} level={level} (want_level={NS_SCREEN_SAVER_WINDOW_LEVEL}) \
             styleMask={style_mask:#x} hides_on_deactivate={hides_on_deactivate} \
             activation_policy={activation_policy}"
        );
    }
}

#[cfg(not(target_os = "macos"))]
fn make_panel_overlay(_window: &tauri::WebviewWindow) {}

fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{:02X}", other),
        })
        .collect()
}
