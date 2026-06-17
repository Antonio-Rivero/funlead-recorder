/**
 * FunLead Recorder — edit manifest schema (clean-room editor).
 *
 * Single source of truth for the post-recording edit manifest. Validated with
 * this exact schema at every boundary (when saving in the UI, and again before
 * the renderer builds the ffmpeg command line).
 *
 * Security rule: every number is finite and range-bounded; colors are strict hex;
 * t0 < t1. Anything that fails here NEVER reaches ffmpeg (anti-injection).
 *
 * Two time domains:
 *  - t_src: seconds of the original clip (trims, speed)
 *  - t_out: seconds of the final timeline (zoom, text)
 */
import { z } from "zod";

const HEX = /^0x[0-9a-fA-F]{6}$/;
const HEX_ALPHA = /^0x[0-9a-fA-F]{6}@(?:0(?:\.\d+)?|1(?:\.0+)?)$/; // 0xRRGGBB@0..1

const hexColor = z.string().regex(HEX, "invalid hex color (0xRRGGBB)");
const httpsUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith("https://"), "image must be https");

const canvas = z.object({
  w: z.number().int().min(320).max(3840),
  h: z.number().int().min(320).max(2160),
  fps: z.union([z.literal(24), z.literal(30), z.literal(60)]),
});

const background = z
  .object({
    type: z.enum(["color", "gradient", "image"]),
    color: hexColor.optional(),
    gradient: z
      .object({
        c0: hexColor,
        c1: hexColor,
        angle: z.number().int().min(0).max(360),
      })
      .optional(),
    image: httpsUrl.optional(),
  })
  .superRefine((b, ctx) => {
    if (b.type === "color" && !b.color)
      ctx.addIssue({ code: "custom" as const, message: "background.color required" });
    if (b.type === "gradient" && !b.gradient)
      ctx.addIssue({ code: "custom" as const, message: "background.gradient required" });
    if (b.type === "image" && !b.image)
      ctx.addIssue({ code: "custom" as const, message: "background.image required" });
  });

const shadow = z.object({
  dx: z.number().int().min(-100).max(100),
  dy: z.number().int().min(0).max(100),
  blur: z.number().int().min(0).max(100),
  opacity: z.number().min(0).max(1),
  color: hexColor,
});

const frame = z.object({
  padding: z.number().int().min(0).max(400),
  radius: z.number().int().min(0).max(200),
  shadow: shadow.optional(),
});

const range = <T extends z.ZodRawShape>(extra: T) =>
  z
    .object({ t0: z.number().min(0), t1: z.number().min(0), ...extra })
    .refine((r) => r.t1 != null && r.t0 != null && r.t1 > r.t0, "t1 must be greater than t0");

const trim = range({});
const speed = range({ factor: z.number().min(0.25).max(4.0) });
const zoom = range({
  level: z.number().min(1.0).max(5.0),
  cx: z.number().min(0).max(1),
  cy: z.number().min(0).max(1),
  ramp: z.number().min(0.1).max(2.0),
});
const text = range({
  content: z.string().min(1).max(200),
  x: z.union([z.literal("center"), z.number().min(0).max(1)]),
  y: z.number().min(0).max(1),
  size: z.number().int().min(12).max(128),
  color: z.union([z.literal("white"), hexColor]),
  box: z.string().regex(HEX_ALPHA).nullable().optional(),
  fade: z.number().min(0).max(1.0),
});

export const editManifestSchema = z.object({
  version: z.literal(1),
  canvas,
  background,
  frame,
  trims: z.array(trim).max(100).optional().default([]),
  speed: z.array(speed).max(100).optional().default([]),
  zoom: z.array(zoom).max(100).optional().default([]),
  text: z.array(text).max(100).optional().default([]),
});

export type EditManifest = z.infer<typeof editManifestSchema>;

/** Validate an unknown object; returns {ok,data} or {ok:false,error}. */
export function parseEditManifest(
  input: unknown,
): { ok: true; data: EditManifest } | { ok: false; error: string } {
  const r = editManifestSchema.safeParse(input);
  if (r.success) return { ok: true, data: r.data };
  const first = r.error.issues[0];
  return { ok: false, error: first ? `${first.path.join(".")}: ${first.message}` : "invalid manifest" };
}
