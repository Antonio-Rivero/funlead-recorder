import { describe, it, expect } from "vitest";
import { validateComment, normalizeAtSec, BODY_MAX, AUTHOR_MAX } from "./comments";

describe("validateComment", () => {
  it("rejects empty body", () => {
    const r = validateComment({ body: "  ", authorName: "Ann" });
    expect(r.ok).toBe(false);
  });

  it("rejects empty author", () => {
    const r = validateComment({ body: "hi", authorName: "" });
    expect(r.ok).toBe(false);
  });

  it("accepts and trims", () => {
    const r = validateComment({ body: " hello ", authorName: " Ann ", atSec: 5 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.body).toBe("hello");
      expect(r.authorName).toBe("Ann");
      expect(r.atSec).toBe(5);
    }
  });

  it("caps body and author length", () => {
    const r = validateComment({ body: "x".repeat(BODY_MAX + 50), authorName: "y".repeat(AUTHOR_MAX + 50) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.body.length).toBe(BODY_MAX);
      expect(r.authorName.length).toBe(AUTHOR_MAX);
    }
  });
});

describe("normalizeAtSec", () => {
  it("floors valid, nulls invalid", () => {
    expect(normalizeAtSec(9.9)).toBe(9);
    expect(normalizeAtSec(-1)).toBeNull();
    expect(normalizeAtSec("3")).toBeNull();
  });
});
