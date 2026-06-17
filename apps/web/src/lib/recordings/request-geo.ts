// Best-effort geo/network metadata from request headers, populated by Vercel's
// edge network when available. Nothing is fetched from any third party — these
// are read-only headers. Used for the owner's analytics dashboard only (GDPR).

function clean(value: string | null | undefined, max: number): string | null {
  const v = value?.trim();
  if (!v) return null;
  return v.slice(0, max);
}

function firstForwarded(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim();
  return first || null;
}

export type RequestGeo = {
  ip: string | null;
  country: string | null;
  city: string | null;
};

export function extractRequestGeo(headers: Headers): RequestGeo {
  const ip = clean(firstForwarded(headers.get("x-forwarded-for")) ?? headers.get("x-real-ip"), 64);
  const country = clean(headers.get("x-vercel-ip-country"), 8);
  // x-vercel-ip-city arrives URL-encoded.
  let city = headers.get("x-vercel-ip-city");
  if (city) {
    try {
      city = decodeURIComponent(city);
    } catch {
      // keep raw value if it isn't valid encoding
    }
  }
  return { ip, country, city: clean(city, 120) };
}
