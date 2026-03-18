/** Strip terminal control characters from untrusted strings. */
export function sanitizeString(value: unknown, maxLength = 255): string {
  if (typeof value !== "string") return "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — strip control chars from untrusted remote data
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maxLength);
}

/** Check whether a cached timestamp has exceeded its TTL. */
export function isExpired(mtimeMs: number, ttlMs: number): boolean {
  return Date.now() - mtimeMs > ttlMs;
}
