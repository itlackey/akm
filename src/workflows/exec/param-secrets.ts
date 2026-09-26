// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Best-effort secret-shaped-param detection. Run params reach every unit
 * prompt in clear and are shown by `akm workflow status`; secrets belong in
 * `env:` bindings. This scans params for credential-looking keys or values and
 * returns warnings at run start (never blocking), and feeds the same values
 * into the dispatch redaction set. `akm task explain` reuses the heuristic to
 * redact input values — best-effort there too, never a guarantee.
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
 * Scan run params (recursively) for secret-suggesting key names or
 * credential-looking string values; one warning per path. Never throws.
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
 * The flagged string values, for the dispatch redaction set (values under 8
 * characters are left out so `token_limit: "1000"` cannot blank out output).
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
