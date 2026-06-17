import ReactDOM from "react-dom/client";

// Floating control bar webview (pause/stop). Full controls wiring is a later
// stage (T1.15); this scaffold placeholder lets the NSPanel window load.
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
