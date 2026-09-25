// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Best-effort secret-shaped-param detection (PR #714 review round 2, #13).
 *
 * ## Params are not a secret channel
 *
 * A workflow's run params are attached to every unit prompt as structured
 * context (`buildUnitPrompt` substitutes them into the engine preamble's
 * `{{PARAMS_JSON}}` placeholder — prose instructions are never interpolated),
 * so a unit sees them in clear, and they are stored on the run row and shown
 * by `akm workflow status`. Secrets belong in **env bindings** (`env:` refs),
 * which are carried by NAME ONLY through the plan and resolved from the
 * process environment at dispatch.
 *
 * This module is the loud, best-effort guardrail on top of that contract: it
 * scans params for values that LOOK like credentials (secret-suggesting key
 * names, long high-entropy strings, known token prefixes) and returns WARNING
 * strings surfaced when a run starts — it NEVER blocks a run and NEVER mutates
 * params. {@link secretShapedParamValues} feeds the same heuristic into the
 * dispatch redaction set, so a unit result or diagnostic that echoes such a
 * value is scrubbed before it is journaled. False positives and false
 * negatives are expected; it is a nudge, not a scanner.
 *
 * ## Reused as `akm task explain`'s redaction check
 *
 * `src/commands/tasks/explain.ts` reuses this same heuristic (via its own
 * `isSecretShapedValue` wrapper) to decide which task-input values to print
 * as `"<redacted>"` instead of in full. That reuse does NOT upgrade this
 * detector into a hard guarantee: `explain`'s redaction is exactly as
 * best-effort as the warnings above — a short, low-entropy, or
 * unusually-named credential that this function does not flag prints
 * UNREDACTED there too. Do not describe either surface as "secret-free by
 * construction"; describe it as "secret-shaped values are redacted on a
 * best-effort basis."
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
  "Workflow params are copied verbatim into every native unit execution context and returned in `akm workflow run` and " +
  "`akm workflow status` output — move secrets to an env binding (`env:` ref), whose value native execution resolves " +
  "only at dispatch instead of storing it as a run param.";

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
  walkSecretShaped(params, (path, why) => {
    if (seen.has(path)) return;
    seen.add(path);
    warnings.push(`Run param "${path}" ${why}. ${MOVE_TO_ENV} (Heuristic warning; params are declared non-secret.)`);
  });
  return warnings;
}

/**
 * The string param values {@link detectSecretShapedParams} flags, for the
 * dispatch redaction set: a unit still receives its params in clear, but a
 * result or diagnostic echoing one of these is scrubbed before it reaches the
 * journal. Values under 8 characters are left out so a secret-NAMED param
 * holding something trivial (`token_limit: "1000"`) cannot blank out ordinary
 * output.
 */
export function secretShapedParamValues(params: Record<string, unknown>): string[] {
  const values = new Set<string>();
  walkSecretShaped(params, (_path, _why, value) => {
    if (typeof value === "string" && value.trim().length >= 8) values.add(value);
  });
  return [...values];
}

function walkSecretShaped(
  params: Record<string, unknown>,
  hit: (path: string, why: string, value: unknown) => void,
): void {
  const walk = (value: unknown, path: string, key: string | null): void => {
    if (key !== null && keyLooksSecret(key)) hit(path, "has a secret-suggesting name", value);
    if (typeof value === "string") {
      if (valueLooksSecret(value)) hit(path, "has a secret-shaped value (long, high-entropy string)", value);
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
}
