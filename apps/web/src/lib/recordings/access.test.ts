import { describe, it, expect } from "vitest";
import { accessGate, pwCookieName } from "./access";

const base = { disabledAt: null, expiresAt: null, passwordHash: null, passwordPassed: false };
const future = new Date(Date.now() + 60_000);
const past = new Date(Date.now() - 60_000);

describe("accessGate precedence", () => {
  it("returns video when nothing blocks", () => {
    expect(accessGate(base)).toBe("video");
  });

  it("disabled wins over everything", () => {
    expect(
      accessGate({ ...base, disabledAt: new Date(), expiresAt: past, passwordHash: "h" }),
    ).toBe("disabled");
  });

  it("expired wins over password", () => {
    expect(accessGate({ ...base, expiresAt: past, passwordHash: "h" })).toBe("expired");
  });

  it("password gate when hash present and cookie not passed", () => {
    expect(accessGate({ ...base, passwordHash: "h", passwordPassed: false })).toBe("password");
  });

  it("video when password passed", () => {
    expect(accessGate({ ...base, passwordHash: "h", passwordPassed: true })).toBe("video");
  });

  it("future expiry does not block", () => {
    expect(accessGate({ ...base, expiresAt: future })).toBe("video");
  });
});

describe("pwCookieName", () => {
  it("namespaces by recording id", () => {
    expect(pwCookieName("rec_123")).toBe("fl_pw_rec_123");
  });
});
