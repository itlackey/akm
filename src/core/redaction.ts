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
  "actortoken",
  "apikey",
  "assertion",
  "authorization",
  "authorizationcode",
  "authreqid",
  "clientassertion",
  "clientsecret",
  "code",
  "codeverifier",
  "credential",
  "devicecode",
  "googleaccessid",
  "idtoken",
  "idtokenhint",
  "initialaccesstoken",
  "key",
  "loginhinttoken",
  "logouthint",
  "logouttoken",
  "nonce",
  "oauthcode",
  "oauthtoken",
  "oauthverifier",
  "password",
  "refreshtoken",
  "registrationaccesstoken",
  "requesturi",
  "response",
  "secret",
  "sessiontoken",
  "sharedaccesssignature",
  "sig",
  "signature",
  "softwarestatement",
  "state",
  "subjecttoken",
  "token",
  "usercode",
  "verifier",
  "xamzcredential",
  "xamzsecuritytoken",
  "xamzsignature",
  "xgoogcredential",
  "xgoogsignature",
]);

function normalizedQueryKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function collectCredentialParameters(params: URLSearchParams, values?: Set<string>): boolean {
  let found = false;
  for (const [key, value] of params) {
    if (!SIGNED_QUERY_KEYS.has(normalizedQueryKey(key))) continue;
    found = true;
    if (value) values?.add(value);
  }
  return found;
}

function collectCredentialFragment(fragment: string, values?: Set<string>): boolean {
  let found = fragment.includes("=") && collectCredentialParameters(new URLSearchParams(fragment), values);
  const nestedQuery = fragment.indexOf("?");
  if (nestedQuery >= 0) {
    found = collectCredentialParameters(new URLSearchParams(fragment.slice(nestedQuery + 1)), values) || found;
  }
  return found;
}

function inspectCredentialBearingUrl(value: string, values?: Set<string>): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    let found = false;
    for (const userInfo of [url.username, url.password]) {
      if (!userInfo) continue;
      found = true;
      try {
        values?.add(decodeURIComponent(userInfo));
      } catch {
        values?.add(userInfo);
      }
    }
    found = collectCredentialParameters(url.searchParams, values) || found;
    return collectCredentialFragment(url.hash.slice(1), values) || found;
  } catch {
    // Fail closed for malformed URL-like values carrying the same credential shapes.
    let found = /^[a-z][a-z0-9+.-]*:\/\/[^/\s?#]*@/i.test(trimmed);
    const query = trimmed.indexOf("?");
    const fragment = trimmed.indexOf("#");
    if (query >= 0) {
      const queryText = trimmed.slice(query + 1, fragment >= 0 ? fragment : undefined);
      found = collectCredentialParameters(new URLSearchParams(queryText), values) || found;
    }
    if (fragment >= 0) {
      const fragmentText = trimmed.slice(fragment + 1);
      found = collectCredentialFragment(fragmentText, values) || found;
    }
    return found;
  }
}

/** Collect exact secrets plus decoded values embedded in credential-bearing URLs. */
export function collectSensitiveValues(rawValues: Iterable<string | undefined>): string[] {
  const values = new Set<string>();
  for (const value of rawValues) {
    if (value === undefined || value.length === 0) continue;
    values.add(value);
    const trimmed = value.trim();
    if (inspectCredentialBearingUrl(value, values) && trimmed) values.add(trimmed);
  }
  return [...values];
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
      return !inspectCredentialBearingUrl(value);
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
