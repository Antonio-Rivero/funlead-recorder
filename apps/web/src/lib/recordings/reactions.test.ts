import { describe, it, expect } from "vitest";
import {
  isReactionEmoji,
  parseReactionAtSec,
  emptyReactionCounts,
  tallyReactions,
  totalReactions,
  REACTION_EMOJIS,
} from "./reactions";

describe("isReactionEmoji", () => {
  it("accepts palette emojis", () => {
    expect(isReactionEmoji("👍")).toBe(true);
  });
  it("rejects anything outside the palette", () => {
    expect(isReactionEmoji("🔥")).toBe(false);
    expect(isReactionEmoji("<script>")).toBe(false);
    expect(isReactionEmoji(42)).toBe(false);
  });
});

describe("parseReactionAtSec", () => {
  it("floors a valid second", () => {
    expect(parseReactionAtSec(12.9)).toBe(12);
  });
  it("returns null for negatives / non-numbers", () => {
    expect(parseReactionAtSec(-1)).toBeNull();
    expect(parseReactionAtSec("3")).toBeNull();
    expect(parseReactionAtSec(undefined)).toBeNull();
  });
});

describe("tally / counts", () => {
  it("empty counts have every emoji at 0", () => {
    const counts = emptyReactionCounts();
    for (const e of REACTION_EMOJIS) expect(counts[e]).toBe(0);
  });

  it("tally fills present emojis and ignores out-of-palette rows", () => {
    const counts = tallyReactions([
      { emoji: "👍", _count: { emoji: 3 } },
      { emoji: "🔥", _count: { emoji: 99 } },
    ]);
    expect(counts["👍"]).toBe(3);
    expect(totalReactions(counts)).toBe(3);
  });
});
