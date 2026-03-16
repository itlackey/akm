export const GITHUB_API_BASE = "https://api.github.com";

const GITHUB_TOKEN_DOMAINS = new Set(["api.github.com", "github.com", "uploads.github.com"]);

/**
 * Build headers for GitHub API requests.
 * When a `url` is provided, the Authorization header is only included if the
 * URL points to a known GitHub domain, preventing token leakage on redirects
 * to third-party hosts.
 */
export function githubHeaders(url?: string): HeadersInit {
  const token = process.env.GITHUB_TOKEN?.trim();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "akm-registry",
  };
  if (token) {
    let includeToken = true;
    if (url) {
      try {
        const hostname = new URL(url).hostname;
        includeToken = GITHUB_TOKEN_DOMAINS.has(hostname);
      } catch {
        includeToken = false;
      }
    }
    if (includeToken) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
