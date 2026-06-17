//! Floating recording control bar. A small non-activating NSPanel shown only
//! while recording (Pause/Resume · Stop · camera-size presets). It is excluded
//! from the screen capture by title (see `recorder::start_recording`), so the
//! user sees the bar on screen but it never lands in the video — the Loom
//! behaviour. As a non-activating panel at screensaver level it floats over
//! everything, including another app's native fullscreen Space (verified: scap
//! still lists level-1000 panels by title, so the exclusion keeps working).

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
use tauri_nspanel::{
    tauri_panel, CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt,
};

pub const CONTROLS_LABEL: &str = "controls";
/// Distinctive title used both as the window title and as the key scap matches
/// to exclude this window from the capture. Must stay in sync with the value the
/// recorder excludes.
pub const CONTROLS_TITLE: &str = "FunLead Recorder · Controles";

const WIDTH: f64 = 340.0;
const HEIGHT: f64 = 60.0;
/// Distance from the bottom of the screen (leaves room above the Dock).
const BOTTOM_MARGIN: f64 = 96.0;

// Non-activating panel subclass (same mechanism the camera bubble uses): lets the
// bar float over another app's fullscreen Space without ever stealing focus.
// Its buttons still receive clicks — non-activating only means it won't activate
// the app, exactly like the camera bubble's resize buttons.
#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(ControlsPanel {
        config: {
            can_become_key_window: false,
            can_become_main_window: false,
            is_floating_panel: true,
            hides_on_deactivate: false,
            becomes_key_only_if_needed: true
        }
    })
}

pub fn is_open(app: &AppHandle) -> bool {
    app.get_webview_window(CONTROLS_LABEL).is_some()
}

/// Create (or re-focus) the floating control bar, anchored bottom-centre of the
/// primary monitor, then turn it into a floating non-activating panel.
pub fn show(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(CONTROLS_LABEL) {
        let _ = window.show();
        return Ok(());
    }

    let (x, y) = match app.primary_monitor() {
        Ok(Some(monitor)) => {
            let scale = monitor.scale_factor();
            let logical = monitor.size().to_logical::<f64>(scale);
            (
                (logical.width - WIDTH) / 2.0,
                logical.height - HEIGHT - BOTTOM_MARGIN,
            )
        }
        _ => (BOTTOM_MARGIN, BOTTOM_MARGIN),
    };

    let window = WebviewWindowBuilder::new(
        app,
        CONTROLS_LABEL,
        WebviewUrl::App("controls.html".into()),
    )
    .title(CONTROLS_TITLE)
    .inner_size(WIDTH, HEIGHT)
    .position(x, y)
    .decorations(false)
    .transparent(true)
    .resizable(false)
    .shadow(false)
    .skip_taskbar(true)
    .build()
    .map_err(|e| e.to_string())?;

    let _ = window.set_shadow(false);
    make_panel_overlay(&window);
    Ok(())
}

/// Close the control bar (recreated fresh on the next recording).
///
/// IMPORTANT: the bar was reclassed into an `NSPanel`. Calling `WebviewWindow::
/// close()` on it directly is a use-after-free — `NSPanel` ships
/// `releasedWhenClosed = YES` and the plugin still holds the panel in its map, so
/// AppKit deallocs it while it's referenced → NSException → tao catches it as a
/// foreign exception → `abort()` (SIGABRT on the main thread). The safe teardown
/// is: convert the panel back to a plain `NSWindow` first (`to_window()`
/// deregisters it + clears `releasedWhenClosed`), THEN close — all on the main
/// thread. Idempotent: if it isn't a registered panel, fall back to a plain close.
pub fn hide(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(CONTROLS_LABEL) else {
        return Ok(());
    };

    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        let _ = window.run_on_main_thread(move || {
            if let Ok(panel) = app.get_webview_panel(CONTROLS_LABEL) {
                // Back to a plain window (deregisters + clears releasedWhenClosed),
                // then it's safe to close.
                if let Some(plain) = panel.to_window() {
                    let _ = plain.close();
                }
            } else if let Some(window) = app.get_webview_window(CONTROLS_LABEL) {
                // Never became a panel (conversion failed) → plain close is safe.
                let _ = window.close();
            }
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        window.close().map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Reclass the bar into a non-activating NSPanel and pin it as a floating overlay
/// that follows the user across every Space (including another app's fullscreen),
/// mirroring the camera bubble's vetted setup. Main-thread only (AppKit).
#[cfg(target_os = "macos")]
fn make_panel_overlay(window: &tauri::WebviewWindow) {
    let win = window.clone();
    let _ = window.run_on_main_thread(move || {
        configure_panel(&win);
        // Re-assert level/order once on a short delay to outlast any z-order reset
        // AppKit does on show — but never re-reclass or re-style.
        let win2 = win.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            let win3 = win2.clone();
            let _ = win2.run_on_main_thread(move || repin_panel(&win3));
        });
    });
}

#[cfg(target_os = "macos")]
fn configure_panel(window: &tauri::WebviewWindow) {
    let panel = match window.to_panel::<ControlsPanel>() {
        Ok(panel) => panel,
        Err(e) => {
            eprintln!("controls to_panel() failed: {e}");
            return;
        }
    };

    // NonactivatingPanel (0x80) is the bit that lets a panel float over another
    // app's fullscreen. The bar isn't resizable, so we don't add Resizable.
    panel.set_style_mask(StyleMask::empty().nonactivating_panel().into());
    panel.set_collection_behavior(
        CollectionBehavior::new()
            .can_join_all_spaces()
            .full_screen_auxiliary()
            .stationary()
            .into(),
    );
    panel.set_level(PanelLevel::ScreenSaver.value());
    panel.set_becomes_key_only_if_needed(true);
    panel.set_hides_on_deactivate(false);
    panel.order_front_regardless();
}

#[cfg(target_os = "macos")]
fn repin_panel(window: &tauri::WebviewWindow) {
    let Ok(panel) = window.app_handle().get_webview_panel(CONTROLS_LABEL) else {
        return;
    };
    panel.set_level(PanelLevel::ScreenSaver.value());
    panel.order_front_regardless();
}

#[cfg(not(target_os = "macos"))]
fn make_panel_overlay(_window: &tauri::WebviewWindow) {}
