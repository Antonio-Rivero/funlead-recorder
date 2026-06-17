import ReactDOM from "react-dom/client";

// Floating camera bubble webview. Full live-camera + mirror UI is a later stage
// (T1.15b); this scaffold placeholder lets the NSPanel window load.
function CameraBubble() {
  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        margin: 0,
        borderRadius: "50%",
        background: "#1e3a5f",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#60a5fa",
        fontFamily: "system-ui, sans-serif",
        fontSize: 12,
      }}
    >
      cámara
    </div>
  );
}

ReactDOM.createRoot(
  document.getElementById("camera-root") as HTMLElement,
).render(<CameraBubble />);
