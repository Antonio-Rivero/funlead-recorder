// Presentation of a recording: CTA on /v + configurable end-card overlay
// (FR-204). Pure logic, no DB.

// There is a CTA only if both label and url are present.
export function hasCta(ctaLabel?: string | null, ctaUrl?: string | null): boolean {
  return Boolean(ctaLabel && ctaUrl);
}

// End-card: the overlay only appears when there's a CTA and the video ended.
export function shouldShowEndCard(hasCtaValue: boolean, ended: boolean): boolean {
  return hasCtaValue && ended;
}

export interface EndCardConfig {
  title: string | null;
  label: string | null;
  url: string;
}

// Resolves which end-card to show when the video ends:
//   1. If endCardCtaUrl exists → configured end-card (with its title/label).
//   2. Otherwise fall back to the inline CTA (ctaLabel + ctaUrl).
//   3. If there's no CTA either → null (no overlay).
export function resolveEndCard(input: {
  endCardTitle?: string | null;
  endCardCtaLabel?: string | null;
  endCardCtaUrl?: string | null;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
}): EndCardConfig | null {
  if (input.endCardCtaUrl) {
    return {
      title: input.endCardTitle ?? null,
      label: input.endCardCtaLabel ?? null,
      url: input.endCardCtaUrl,
    };
  }
  if (input.ctaLabel && input.ctaUrl) {
    return { title: null, label: input.ctaLabel, url: input.ctaUrl };
  }
  return null;
}
