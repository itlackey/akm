// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const ENV_PASSTHROUGH_REDACTION_POLICY = {
  HOME: "path",
  PATH: "path",
  USER: "identifier",
  LANG: "identifier",
  LC_ALL: "identifier",
  TERM: "identifier",
  TMPDIR: "path",
  SYSTEMROOT: "path",
  COMSPEC: "path",
  PATHEXT: "path",
  WINDIR: "path",
  TEMP: "path",
  TMP: "path",
  AKM_EVENT_SOURCE: "identifier",
  OPENCODE_CONFIG: "path",
  CLAUDE_CONFIG: "path",
  CODEX_CONFIG: "path",
  AWS_PROFILE: "identifier",
  AWS_REGION: "identifier",
  LLM_MODEL: "identifier",
  LLM_BASE_URL: "url",
} as const;

type EnvPassthroughRedactionPolicy =
  (typeof ENV_PASSTHROUGH_REDACTION_POLICY)[keyof typeof ENV_PASSTHROUGH_REDACTION_POLICY];

/** Environment names whose ordinary values identify runtime configuration rather than credentials. */
export const ENV_PASSTHROUGH_REDACTION_ALLOWLIST: ReadonlySet<string> = new Set(
  Object.keys(ENV_PASSTHROUGH_REDACTION_POLICY),
);

const SIGNED_QUERY_KEYS = new Set([
  "accesskey",
  "accesskeyid",
  "accesstoken",
  "apikey",
  "authorization",
  "clientsecret",
  "code",
  "credential",
  "googleaccessid",
  "idtoken",
  "key",
  "oauthcode",
  "oauthtoken",
  "oauthverifier",
  "password",
  "refreshtoken",
  "secret",
  "sessiontoken",
  "sharedaccesssignature",
  "sig",
  "signature",
  "token",
  "xamzcredential",
  "xamzsecuritytoken",
  "xamzsignature",
  "xgoogcredential",
  "xgoogsignature",
]);

function normalizedQueryKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function hasCredentialParameter(params: URLSearchParams): boolean {
  for (const key of params.keys()) {
    if (SIGNED_QUERY_KEYS.has(normalizedQueryKey(key))) return true;
  }
  return false;
}

function hasCredentialFragment(fragment: string): boolean {
  if (fragment.includes("=") && hasCredentialParameter(new URLSearchParams(fragment))) return true;
  const nestedQuery = fragment.indexOf("?");
  return nestedQuery >= 0 && hasCredentialParameter(new URLSearchParams(fragment.slice(nestedQuery + 1)));
}

function hasCredentialBearingUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    if (url.username || url.password) return true;
    if (hasCredentialParameter(url.searchParams)) return true;
    return hasCredentialFragment(url.hash.slice(1));
  } catch {
    // Fail closed for malformed URL-like values carrying the same credential shapes.
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s?#]*@/i.test(trimmed)) return true;
    const query = trimmed.indexOf("?");
    const fragment = trimmed.indexOf("#");
    if (query >= 0) {
      const queryText = trimmed.slice(query + 1, fragment >= 0 ? fragment : undefined);
      if (hasCredentialParameter(new URLSearchParams(queryText))) return true;
    }
    if (fragment >= 0) {
      const fragmentText = trimmed.slice(fragment + 1);
      if (hasCredentialFragment(fragmentText)) return true;
    }
    return false;
  }
}

/**
 * Decide whether an allowlisted passthrough value may cross an output boundary.
 * The name allowlist never overrides value inspection: URL userinfo and signed
 * query credentials remain secret even under ordinarily non-secret names.
 */
export function isEnvPassthroughValueSafeToExpose(name: string, value: string | undefined): boolean {
  if (value === undefined) return true;
  const policy = ENV_PASSTHROUGH_REDACTION_POLICY[name as keyof typeof ENV_PASSTHROUGH_REDACTION_POLICY];
  if (!policy) return false;
  const classifiedPolicy: EnvPassthroughRedactionPolicy = policy;
  switch (classifiedPolicy) {
    case "identifier":
    case "path":
    case "url":
      return !hasCredentialBearingUrl(value);
    default: {
      const exhaustive: never = classifiedPolicy;
      return exhaustive;
    }
  }
}

/**
 * Replace exact sensitive values in text. Longer values are replaced first so
 * an overlapping prefix cannot expose the suffix of a longer credential.
 */
export function redactSensitiveText(text: string, sensitiveValues: Iterable<string>): string {
  const values = [...new Set(sensitiveValues)]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  let redacted = text;
  for (const value of values) redacted = redacted.replaceAll(value, "[REDACTED]");
  return redacted;
}

/** Recursively redact string leaves before a structured value crosses a durable/output boundary. */
export function redactSensitiveValue<T>(value: T, sensitiveValues: Iterable<string>): T {
  const values = [...sensitiveValues];
  const redact = (entry: unknown): unknown => {
    if (typeof entry === "string") return redactSensitiveText(entry, values);
    if (Array.isArray(entry)) return entry.map(redact);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry).map(([key, child]) => [redactSensitiveText(key, values), redact(child)]),
      );
    }
    return entry;
  };
  return redact(value) as T;
}
