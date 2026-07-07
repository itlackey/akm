// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Best-effort secret-shaped-param detection (PR #714 review round 2, #13).
 *
 * ## Why params are declared NON-SECRET
 *
 * A workflow's run params are interpolated into every unit prompt
 * (`buildUnitPrompt` → `{{PARAMS_JSON}}` + `${{ params.* }}` references) and,
 * critically, are part of the unit's **input hash**. The harness-neutral driver
 * protocol (`akm workflow brief`) MUST surface the byte-identical prompt an
 * external driver has to execute — redacting a param would change the prompt the
 * driver runs, break the input-hash contract, and defeat cross-surface parity.
 * So params CANNOT be redacted and are declared **non-secret**: secrets belong
 * in **env bindings** (`env:` refs), which `brief` surfaces by NAME ONLY and
 * never resolves.
 *
 * This module is the loud, best-effort guardrail on top of that contract: it
 * scans params for values that LOOK like credentials (secret-suggesting key
 * names, long high-entropy strings, known token prefixes) and returns WARNING
 * strings. It is purely advisory — it NEVER blocks a run and NEVER mutates
 * params — and is surfaced both at `start` and in every `brief`. False positives
 * and false negatives are expected; it is a nudge, not a scanner.
 */

/**
 * Substrings that, when present in a param KEY (case-insensitive), suggest the
 * value is a credential. Deliberately specific — bare `auth` is excluded so a
 * key like `author` does not trip the heuristic.
 */
const SECRET_KEY_HINTS = [
  "secret",
  "token",
  "password",
  "passwd",
  "apikey",
  "api_key",
  "api-key",
  "accesskey",
  "access_key",
  "privatekey",
  "private_key",
  "credential",
  "bearer",
  "auth_token",
  "authtoken",
  "client_secret",
] as const;

/** Known credential value prefixes (OpenAI, GitHub, Slack, AWS, Google, PEM). */
const SECRET_VALUE_PREFIX =
  /^(sk-|rk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[baprs]-|AKIA|ASIA|AIza|ya29\.|-----BEGIN)/;

function keyLooksSecret(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_KEY_HINTS.some((hint) => lower.includes(hint));
}

/**
 * A string value is secret-shaped when it is long, whitespace-free, and either
 * carries a known credential prefix or has high character-class diversity /
 * base64-hex shape — an entropy proxy, not a real entropy computation.
 */
function valueLooksSecret(value: string): boolean {
  const s = value.trim();
  if (s.length < 20 || /\s/.test(s)) return false;
  if (SECRET_VALUE_PREFIX.test(s)) return true;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(s)).length;
  if (s.length >= 24 && classes >= 3) return true;
  if (s.length >= 32 && /^[A-Za-z0-9+/=_-]+$/.test(s)) return true;
  return false;
}

const MOVE_TO_ENV =
  "Workflow params are copied verbatim into every unit prompt shown to any driver (they are part of the unit " +
  "input hash and CANNOT be redacted) — move secrets to an env binding (`env:` ref), which `brief` surfaces by " +
  "name only and never resolves.";

/**
 * Scan run params for secret-shaped values. Returns human-readable WARNING
 * strings (best-effort; never throws, never blocks). Recurses into nested
 * objects and arrays, reporting the dotted/indexed path of each hit. A key whose
 * NAME suggests a secret is flagged regardless of value shape; any string value
 * that LOOKS like a credential is flagged regardless of key name. Each path is
 * reported at most once.
 */
export function detectSecretShapedParams(params: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();

  const push = (path: string, why: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    warnings.push(`Run param "${path}" ${why}. ${MOVE_TO_ENV} (Heuristic warning; params are declared non-secret.)`);
  };

  const walk = (value: unknown, path: string, key: string | null): void => {
    if (key !== null && keyLooksSecret(key)) push(path, "has a secret-suggesting name");
    if (typeof value === "string") {
      if (valueLooksSecret(value)) push(path, "has a secret-shaped value (long, high-entropy string)");
      return;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) walk(value[i], `${path}[${i}]`, null);
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, path ? `${path}.${k}` : k, k);
      }
    }
  };

  for (const [k, v] of Object.entries(params)) walk(v, k, k);
  return warnings;
}
