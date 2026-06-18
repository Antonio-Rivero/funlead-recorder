import ReactDOM from "react-dom/client";

// Floating control bar webview (pause/stop). Full controls wiring is a later
// stage (T1.15); this scaffold placeholder lets the NSPanel window load.
//
// When wiring the real ■ stop button, make stop IDEMPOTENT: disable the button
// after the first click AND guard the orchestrator's handleStop against re-entry.
// The bar gives no immediate feedback (the main window is hidden until stop
// completes), so a double-click otherwise fires a second stop_recording that finds
// the session already consumed and surfaces "No hay ninguna grabación en curso",
// clobbering the saved state. (Real bug seen in the yoom-desktop predecessor.)
function ControlBar() {
  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        margin: 0,
        borderRadius: 14,
        background: "#1e3a5f",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        color: "#e8eef6",
        fontFamily: "system-ui, sans-serif",
        fontSize: 12,
      }}
    >
      controles
    </div>
  );
}

ReactDOM.createRoot(
  document.getElementById("controls-root") as HTMLElement,
).render(<ControlBar />);
