import { describe, it, expect } from "vitest";
import { parseEditManifest } from "./edit-manifest";

const base = {
  version: 1,
  canvas: { w: 1920, h: 1080, fps: 30 },
  background: { type: "color", color: "0x1e3a5f" },
  frame: { padding: 40, radius: 16 },
};

describe("parseEditManifest", () => {
  it("accepts a minimal valid manifest and defaults arrays", () => {
    const r = parseEditManifest(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.trims).toEqual([]);
      expect(r.data.speed).toEqual([]);
    }
  });

  it("rejects a non-hex color", () => {
    const r = parseEditManifest({ ...base, background: { type: "color", color: "#1e3a5f" } });
    expect(r.ok).toBe(false);
  });

  it("rejects an unsupported fps", () => {
    const r = parseEditManifest({ ...base, canvas: { w: 1920, h: 1080, fps: 25 } });
    expect(r.ok).toBe(false);
  });

  it("rejects padding out of range", () => {
    const r = parseEditManifest({ ...base, frame: { padding: 9999, radius: 0 } });
    expect(r.ok).toBe(false);
  });

  it("rejects a trim with t1 <= t0", () => {
    const r = parseEditManifest({ ...base, trims: [{ t0: 5, t1: 5 }] });
    expect(r.ok).toBe(false);
  });

  it("accepts a valid trim", () => {
    const r = parseEditManifest({ ...base, trims: [{ t0: 0, t1: 3 }] });
    expect(r.ok).toBe(true);
  });

  it("rejects a speed factor out of range", () => {
    const r = parseEditManifest({ ...base, speed: [{ t0: 0, t1: 2, factor: 10 }] });
    expect(r.ok).toBe(false);
  });

  it("rejects a zoom level out of range", () => {
    const r = parseEditManifest({ ...base, zoom: [{ t0: 0, t1: 2, level: 99, cx: 0.5, cy: 0.5, ramp: 0.5 }] });
    expect(r.ok).toBe(false);
  });

  it("rejects empty text content", () => {
    const r = parseEditManifest({ ...base, text: [{ t0: 0, t1: 2, content: "", x: "center", y: 0.5, size: 32, color: "white", fade: 0.2 }] });
    expect(r.ok).toBe(false);
  });

  it("accepts a valid text overlay", () => {
    const r = parseEditManifest({ ...base, text: [{ t0: 0, t1: 2, content: "hola", x: "center", y: 0.5, size: 32, color: "white", fade: 0.2 }] });
    expect(r.ok).toBe(true);
  });

  it("requires https for an image background (rejects http)", () => {
    const r = parseEditManifest({ ...base, background: { type: "image", image: "http://example.com/x.png" } });
    expect(r.ok).toBe(false);
  });

  it("rejects an image background with no image url", () => {
    const r = parseEditManifest({ ...base, background: { type: "image" } });
    expect(r.ok).toBe(false);
  });
});
