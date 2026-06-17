import { BRAND } from "./branding";

// Minimal Phase-1 shell: a window that starts. The full record → edit → export
// UI (T1.15) is written in a later stage; this is the scaffold landing screen.
export default function App() {
  return (
    <main
      style={{
        height: "100vh",
        margin: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        fontFamily: "system-ui, -apple-system, sans-serif",
        background: "#0f1f33",
        color: "#e8eef6",
      }}
    >
      <h1 style={{ margin: 0, fontSize: 22, color: "#60a5fa" }}>
        {BRAND.productName}
      </h1>
      <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>
        Local-first screen recorder.
      </p>
    </main>
  );
}
