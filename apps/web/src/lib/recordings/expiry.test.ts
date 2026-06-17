import { describe, it, expect } from "vitest";
import { isExpired, parseExpiresAt } from "./expiry";

const NOW = new Date("2026-06-17T12:00:00Z");

describe("isExpired", () => {
  it("never expires when null/undefined", () => {
    expect(isExpired(null, NOW)).toBe(false);
    expect(isExpired(undefined, NOW)).toBe(false);
  });
  it("expired when now is past the date", () => {
    expect(isExpired("2026-06-17T11:00:00Z", NOW)).toBe(true);
  });
  it("not expired when the date is in the future", () => {
    expect(isExpired("2026-06-17T13:00:00Z", NOW)).toBe(false);
  });
  it("ignores invalid dates (treated as never)", () => {
    expect(isExpired("not-a-date", NOW)).toBe(false);
  });
});

describe("parseExpiresAt", () => {
  it("null clears it", () => {
    expect(parseExpiresAt(null, NOW)).toEqual({ ok: true, value: null });
  });
  it("accepts a future ISO date", () => {
    const r = parseExpiresAt("2026-06-18T12:00:00Z", NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value?.toISOString()).toBe("2026-06-18T12:00:00.000Z");
  });
  it("rejects a past or present date", () => {
    expect(parseExpiresAt("2026-06-17T11:00:00Z", NOW).ok).toBe(false);
    expect(parseExpiresAt("2026-06-17T12:00:00Z", NOW).ok).toBe(false);
  });
  it("rejects malformed and non-string", () => {
    expect(parseExpiresAt("nope", NOW).ok).toBe(false);
    expect(parseExpiresAt(123, NOW).ok).toBe(false);
  });
});
