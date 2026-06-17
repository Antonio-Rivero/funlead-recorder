// Emoji reactions on the player (FR-206). Pure logic (palette + validation),
// no DB. The palette is fixed and closed: the server only accepts these emojis
// so a client can't inject any string. atSec is optional (video second).

// Fixed palette of available reactions, in display order.
export const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "🙌", "👎"] as const;

export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

export function isReactionEmoji(value: unknown): value is ReactionEmoji {
  return typeof value === "string" && (REACTION_EMOJIS as readonly string[]).includes(value);
}

// Normalizes the atSec sent by the client: integer >= 0 or null.
export function parseReactionAtSec(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const sec = Math.floor(value);
  return sec >= 0 ? sec : null;
}

export type ReactionCounts = Record<ReactionEmoji, number>;

// Starts every emoji at 0 so the count always has the full shape.
export function emptyReactionCounts(): ReactionCounts {
  return REACTION_EMOJIS.reduce((acc, emoji) => {
    acc[emoji] = 0;
    return acc;
  }, {} as ReactionCounts);
}

// Turns a groupBy({ by: ["emoji"], _count }) result into a map with EVERY emoji
// (missing ones stay at 0). Ignores emojis outside the palette.
export function tallyReactions(
  rows: ReadonlyArray<{ emoji: string; _count: { emoji: number } }>,
): ReactionCounts {
  const counts = emptyReactionCounts();
  for (const row of rows) {
    if (isReactionEmoji(row.emoji)) counts[row.emoji] = row._count.emoji;
  }
  return counts;
}

export function totalReactions(counts: ReactionCounts): number {
  return REACTION_EMOJIS.reduce((sum, emoji) => sum + (counts[emoji] ?? 0), 0);
}
