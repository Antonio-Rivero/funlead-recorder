// Validates a Vercel Blob reference the client claims to have uploaded, before we
// trust it into the DB: HTTPS, a Vercel Blob host, an allowed path prefix, and the
// pathname inside the URL must match the declared pathname.
const ALLOWED_PATH_PREFIXES = ["recordings/videos/", "recordings/uploads/", "recordings/"];
const VERCEL_BLOB_HOST_SUFFIX = ".public.blob.vercel-storage.com";
const VERCEL_BLOB_HOST = "public.blob.vercel-storage.com";

function normalizePathname(value: string): string {
  return value.replace(/^\/+/, "");
}

function decodePathname(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function isAllowedRecordingBlobReference({
  blobUrl,
  blobPathname,
}: {
  blobUrl: string;
  blobPathname: string;
}): boolean {
  let url: URL;
  try {
    url = new URL(blobUrl);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase();
  if (!(hostname === VERCEL_BLOB_HOST || hostname.endsWith(VERCEL_BLOB_HOST_SUFFIX))) return false;

  const normalizedPathname = normalizePathname(blobPathname);
  if (!ALLOWED_PATH_PREFIXES.some((prefix) => normalizedPathname.startsWith(prefix))) return false;

  const decodedUrlPathname = decodePathname(url.pathname);
  return decodedUrlPathname != null && normalizePathname(decodedUrlPathname) === normalizedPathname;
}
