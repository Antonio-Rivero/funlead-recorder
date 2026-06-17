import { describe, it, expect, beforeAll } from "vitest";
import { buildGateCookieValue, verifyGateCookieValue } from "./gate-cookie";

beforeAll(() => {
  process.env.RECORDING_GATE_COOKIE_SECRET = "test-secret-please-rotate";
});

describe("gate cookie round-trip", () => {
  it("a freshly built cookie verifies", () => {
    const value = buildGateCookieValue({ recordingId: "rec_1", gate: "password", maxAgeSec: 3600 });
    expect(verifyGateCookieValue(value, { recordingId: "rec_1", gate: "password" })).toBe(true);
  });

  it("fails for a different recording id", () => {
    const value = buildGateCookieValue({ recordingId: "rec_1", gate: "password", maxAgeSec: 3600 });
    expect(verifyGateCookieValue(value, { recordingId: "rec_2", gate: "password" })).toBe(false);
  });

  it("fails when expired", () => {
    const value = buildGateCookieValue({
      recordingId: "rec_1",
      gate: "password",
      maxAgeSec: 1,
      nowMs: 1000,
    });
    expect(
      verifyGateCookieValue(value, { recordingId: "rec_1", gate: "password", nowMs: 10_000 }),
    ).toBe(false);
  });

  it("rejects tampered signatures and empty values", () => {
    const value = buildGateCookieValue({ recordingId: "rec_1", gate: "password", maxAgeSec: 3600 });
    expect(verifyGateCookieValue(`${value}x`, { recordingId: "rec_1", gate: "password" })).toBe(false);
    expect(verifyGateCookieValue(undefined, { recordingId: "rec_1", gate: "password" })).toBe(false);
    expect(verifyGateCookieValue("1", { recordingId: "rec_1", gate: "password" })).toBe(false);
  });
});
