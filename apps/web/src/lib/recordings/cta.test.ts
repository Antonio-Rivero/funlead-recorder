import { describe, it, expect } from "vitest";
import { hasCta, shouldShowEndCard, resolveEndCard } from "./cta";

describe("hasCta / shouldShowEndCard", () => {
  it("hasCta needs both label and url", () => {
    expect(hasCta("Click", "https://x.com")).toBe(true);
    expect(hasCta("Click", null)).toBe(false);
    expect(hasCta(null, "https://x.com")).toBe(false);
  });
  it("end-card shows only when there's a CTA and ended", () => {
    expect(shouldShowEndCard(true, true)).toBe(true);
    expect(shouldShowEndCard(true, false)).toBe(false);
    expect(shouldShowEndCard(false, true)).toBe(false);
  });
});

describe("resolveEndCard", () => {
  it("prefers the configured end-card", () => {
    const r = resolveEndCard({
      endCardTitle: "Thanks",
      endCardCtaLabel: "Book",
      endCardCtaUrl: "https://book.com",
      ctaLabel: "Other",
      ctaUrl: "https://other.com",
    });
    expect(r).toEqual({ title: "Thanks", label: "Book", url: "https://book.com" });
  });

  it("falls back to the inline CTA", () => {
    const r = resolveEndCard({ ctaLabel: "Visit", ctaUrl: "https://visit.com" });
    expect(r).toEqual({ title: null, label: "Visit", url: "https://visit.com" });
  });

  it("null when there is no CTA at all", () => {
    expect(resolveEndCard({})).toBeNull();
  });
});
