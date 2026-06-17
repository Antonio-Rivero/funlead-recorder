import { describe, it, expect } from "vitest";
import {
  parseTitle,
  parseOptionalText,
  parseUrl,
  parsePassword,
  parseBoolean,
  DESCRIPTION_MAX,
} from "./settings";

describe("parseTitle", () => {
  it("trims and accepts a non-empty title", () => {
    expect(parseTitle("  Hello  ")).toEqual({ ok: true, value: "Hello" });
  });
  it("rejects empty / whitespace / non-string", () => {
    expect(parseTitle("   ").ok).toBe(false);
    expect(parseTitle("").ok).toBe(false);
    expect(parseTitle(42).ok).toBe(false);
    expect(parseTitle(null).ok).toBe(false);
  });
});

describe("parseOptionalText", () => {
  it("null clears the field", () => {
    expect(parseOptionalText(null, DESCRIPTION_MAX, "description")).toEqual({
      ok: true,
      value: null,
    });
  });
  it("empty string becomes null", () => {
    expect(parseOptionalText("   ", DESCRIPTION_MAX, "description")).toEqual({
      ok: true,
      value: null,
    });
  });
  it("trims and caps long text", () => {
    const long = "a".repeat(DESCRIPTION_MAX + 50);
    const r = parseOptionalText(long, DESCRIPTION_MAX, "description");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value?.length).toBe(DESCRIPTION_MAX);
  });
  it("rejects non-string non-null", () => {
    expect(parseOptionalText(7, DESCRIPTION_MAX, "description").ok).toBe(false);
  });
});

describe("parseUrl", () => {
  it("null or empty clears it", () => {
    expect(parseUrl(null, "CTA URL")).toEqual({ ok: true, value: null });
    expect(parseUrl("  ", "CTA URL")).toEqual({ ok: true, value: null });
  });
  it("accepts http and https", () => {
    expect(parseUrl("https://funlead.app", "CTA URL")).toEqual({
      ok: true,
      value: "https://funlead.app",
    });
    expect(parseUrl("http://x.test", "CTA URL").ok).toBe(true);
  });
  it("rejects non-http protocols and malformed URLs", () => {
    expect(parseUrl("javascript:alert(1)", "CTA URL").ok).toBe(false);
    expect(parseUrl("ftp://x.test", "CTA URL").ok).toBe(false);
    expect(parseUrl("not a url", "CTA URL").ok).toBe(false);
  });
});

describe("parsePassword", () => {
  it("null or empty clears", () => {
    expect(parsePassword(null)).toEqual({ ok: true, action: "clear" });
    expect(parsePassword("   ")).toEqual({ ok: true, action: "clear" });
  });
  it("non-empty sets, trimmed", () => {
    expect(parsePassword("  secret ")).toEqual({ ok: true, action: "set", value: "secret" });
  });
  it("rejects too long and non-string", () => {
    expect(parsePassword("x".repeat(201)).ok).toBe(false);
    expect(parsePassword(123).ok).toBe(false);
  });
});

describe("parseBoolean", () => {
  it("accepts booleans only", () => {
    expect(parseBoolean(true, "disabled")).toEqual({ ok: true, value: true });
    expect(parseBoolean(false, "disabled")).toEqual({ ok: true, value: false });
    expect(parseBoolean("true", "disabled").ok).toBe(false);
    expect(parseBoolean(1, "disabled").ok).toBe(false);
  });
});
