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
  XDG_CONFIG_HOME: "path",
  XDG_DATA_HOME: "path",
  XDG_CACHE_HOME: "path",
  XDG_STATE_HOME: "path",
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

function addEncodedCredentialVariants(rawValue: string, values?: Set<string>): void {
  if (!rawValue || !values) return;
  values.add(rawValue);
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawValue.replaceAll("+", " "));
  } catch {
    return;
  }
  if (!decoded) return;
  values.add(decoded);
  const encoded = encodeURIComponent(decoded);
  values.add(encoded);
  values.add(encoded.replaceAll("%20", "+"));
  values.add(encoded.replace(/%[0-9A-F]{2}/g, (sequence) => sequence.toLowerCase()));
}

function collectEncodedCredentialParameters(raw: string, values?: Set<string>): boolean {
  let found = false;
  for (const part of raw.split("&")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const rawKey = part.slice(0, separator);
    const rawValue = part.slice(separator + 1);
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey.replaceAll("+", " "));
    } catch {
      // Keep the raw key so malformed credential-shaped input still fails closed.
    }
    if (!SIGNED_QUERY_KEYS.has(normalizedQueryKey(key))) continue;
    found = true;
    addEncodedCredentialVariants(rawValue, values);
  }
  return found;
}

function collectCredentialFragment(fragment: string, values?: Set<string>): boolean {
  const directDecoded = fragment.includes("=") && collectCredentialParameters(new URLSearchParams(fragment), values);
  const directEncoded = fragment.includes("=") && collectEncodedCredentialParameters(fragment, values);
  let found = directDecoded || directEncoded;
  const nestedQuery = fragment.indexOf("?");
  if (nestedQuery >= 0) {
    const query = fragment.slice(nestedQuery + 1);
    const decoded = collectCredentialParameters(new URLSearchParams(query), values);
    const encoded = collectEncodedCredentialParameters(query, values);
    found = decoded || encoded || found;
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
      values?.add(userInfo);
      try {
        values?.add(decodeURIComponent(userInfo));
      } catch {
        values?.add(userInfo);
      }
    }
    const decodedQuery = collectCredentialParameters(url.searchParams, values);
    const encodedQuery = collectEncodedCredentialParameters(url.search.slice(1), values);
    found = decodedQuery || encodedQuery || found;
    return collectCredentialFragment(url.hash.slice(1), values) || found;
  } catch {
    // Fail closed for malformed URL-like values carrying the same credential shapes.
    let found = /^[a-z][a-z0-9+.-]*:\/\/[^/\s?#]*@/i.test(trimmed);
    const query = trimmed.indexOf("?");
    const fragment = trimmed.indexOf("#");
    if (query >= 0) {
      const queryText = trimmed.slice(query + 1, fragment >= 0 ? fragment : undefined);
      const decodedQuery = collectCredentialParameters(new URLSearchParams(queryText), values);
      const encodedQuery = collectEncodedCredentialParameters(queryText, values);
      found = decodedQuery || encodedQuery || found;
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

interface NormalizedText {
  text: string;
  starts: Int32Array;
  sourceLength: number;
}

function utf8SequenceLength(firstByte: number): number {
  if (firstByte <= 0x7f) return 1;
  if (firstByte >= 0xc2 && firstByte <= 0xdf) return 2;
  if (firstByte >= 0xe0 && firstByte <= 0xef) return 3;
  if (firstByte >= 0xf0 && firstByte <= 0xf4) return 4;
  return 0;
}

function normalizeEncodedText(value: string, plusAsSpace: boolean): NormalizedText {
  let text = "";
  const starts = new Int32Array(value.length);
  let mappingLength = 0;
  const append = (decoded: string, start: number): void => {
    text += decoded;
    for (let index = 0; index < decoded.length; index++) {
      starts[mappingLength] = start;
      mappingLength++;
    }
  };

  for (let index = 0; index < value.length; ) {
    if (value[index] === "%" && /^[0-9a-f]{2}$/i.test(value.slice(index + 1, index + 3))) {
      const start = index;
      const firstByte = Number.parseInt(value.slice(index + 1, index + 3), 16);
      const sequenceLength = utf8SequenceLength(firstByte);
      if (sequenceLength > 0) {
        const bytes = [firstByte];
        let cursor = index + 3;
        while (
          bytes.length < sequenceLength &&
          value[cursor] === "%" &&
          /^[0-9a-f]{2}$/i.test(value.slice(cursor + 1, cursor + 3))
        ) {
          bytes.push(Number.parseInt(value.slice(cursor + 1, cursor + 3), 16));
          cursor += 3;
        }
        if (bytes.length === sequenceLength) {
          try {
            const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
            index = cursor;
            append(decoded, start);
            continue;
          } catch {
            // Treat invalid UTF-8 percent sequences as literal text.
          }
        }
      }
    }

    const start = index;
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    index += character.length;
    append(plusAsSpace && character === "+" ? " " : character, start);
  }

  return { text, starts, sourceLength: value.length };
}

function addMappedMatches(coverageDelta: Int32Array, haystack: NormalizedText, needle: string): void {
  if (!needle) return;
  let offset = 0;
  while (offset <= haystack.text.length - needle.length) {
    const match = haystack.text.indexOf(needle, offset);
    if (match < 0) break;
    const start = haystack.starts[match]!;
    const normalizedEnd = match + needle.length;
    const end = normalizedEnd < haystack.text.length ? haystack.starts[normalizedEnd]! : haystack.sourceLength;
    coverageDelta[start] = coverageDelta[start]! + 1;
    coverageDelta[end] = coverageDelta[end]! - 1;
    offset = match + Math.max(needle.length, 1);
  }
}

/**
 * Mark every occurrence of `needle` in `text` — no encoding normalization, for
 * text that contains neither `%` nor `+` and so cannot carry an encoded form.
 *
 * Matching against the ORIGINAL text (rather than an accumulator being rewritten
 * in place) is the whole point: see {@link redactSensitiveText}.
 */
function addPlainMatches(coverageDelta: Int32Array, text: string, needle: string): void {
  if (!needle) return;
  let offset = 0;
  while (offset <= text.length - needle.length) {
    const match = text.indexOf(needle, offset);
    if (match < 0) break;
    coverageDelta[match] = coverageDelta[match]! + 1;
    coverageDelta[match + needle.length] = coverageDelta[match + needle.length]! - 1;
    offset = match + needle.length;
  }
}

/**
 * Name components (after splitting an identifier on `_`/`-` and camelCase
 * boundaries) that mark a `NAME=value` / `NAME: value` pair as
 * credential-shaped regardless of length — the free-text-pattern sibling of
 * `isInferredSecretName` in `src/tasks/log-redaction.ts`, which does the same
 * job for environment variable names. Bare-word matching only: this
 * deliberately does NOT flag "author" ("auth" is not a whole word/component
 * of "author", the same anchoring reasoning `isInferredSecretName` documents)
 * nor prose like "token budget" (no `=`/`:` for the pattern below to anchor
 * on in the first place).
 */
const CREDENTIAL_KEY_WORDS = new Set(["password", "passwd", "secret", "token", "auth", "credential", "credentials"]);

/** Split an identifier into lowercase words at `_`/`-` and camelCase boundaries. */
function identifierWords(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_-]+/)
    .filter(Boolean);
}

/**
 * True when `identifier` names a credential by shape: a whole word from
 * {@link CREDENTIAL_KEY_WORDS}, or `api[_-]?key` / `private[_-]?key` in any
 * of their glued, snake_case, kebab-case or camelCase spellings.
 */
function isCredentialLikeKeyName(identifier: string): boolean {
  const lower = identifier.toLowerCase();
  if (lower.includes("apikey") || lower.includes("privatekey")) return true;
  const words = identifierWords(identifier);
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (CREDENTIAL_KEY_WORDS.has(word)) return true;
    if ((word === "api" || word === "private") && words[i + 1] === "key") return true;
  }
  return false;
}

/**
 * `NAME=value` / `NAME: value`, name captured in group 1, separator in group
 * 2. Source string (not a shared `RegExp`, which would carry `lastIndex`
 * state across calls) for {@link redactNamedCredentialValues} to instantiate
 * fresh each call.
 */
const NAMED_CREDENTIAL_VALUE_SOURCE = String.raw`\b([A-Za-z][A-Za-z0-9_-]*)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;"']+)`;

/**
 * Redact `NAME=value` / `NAME: value` pairs whose name is credential-shaped
 * (see {@link isCredentialLikeKeyName}).
 *
 * Not a plain `input.replace(re, fn)`: the greedy unquoted-value alternative
 * happily matches straight through a NESTED assignment when a non-credential
 * name comes first with no separator of its own — `"config: DB_PASSWORD=…"`
 * matches name `config` with value `DB_PASSWORD=…` (one contiguous
 * whitespace-free run), and a plain global replace treats that as ONE
 * consumed, non-matching span and never revisits `DB_PASSWORD=…` on its own,
 * silently leaking the credential. Rejecting a non-credential candidate here
 * instead rewinds the scan to one character past where IT started, so the
 * engine keeps looking and still finds the real assignment nested inside.
 */
function redactNamedCredentialValues(input: string): string {
  const re = new RegExp(NAMED_CREDENTIAL_VALUE_SOURCE, "g");
  let result = "";
  let cursor = 0;
  let match: RegExpExecArray | null = re.exec(input);
  while (match !== null) {
    const [full, name, sep] = match as unknown as [string, string, string];
    if (isCredentialLikeKeyName(name)) {
      result += `${input.slice(cursor, match.index)}${name}${sep}[REDACTED]`;
      cursor = match.index + full.length;
      re.lastIndex = cursor;
    } else {
      re.lastIndex = match.index + 1;
    }
    match = re.exec(input);
  }
  return result + input.slice(cursor);
}

/**
 * Redact credential-shaped substrings from arbitrary text by pattern alone —
 * unlike {@link redactSensitiveText}, which requires the exact secret value
 * up front, this catches credentials no caller ever knew to list. No
 * truncation is applied; callers that need a length cap (e.g.
 * {@link redactErrorBody}) apply it themselves.
 *
 * Targets:
 *  - `Bearer <token>` headers echoed back by a provider
 *  - `sk-…` / `sk_…` style API keys (OpenAI / Anthropic-shaped)
 *  - `key-…` / `key_…` shorthand keys
 *  - `"api_key": "…"` / `"apiKey": "…"` JSON fields
 *  - Discord webhook URLs (`discord.com/api/webhooks/<id>/<token>`) — the id
 *    is kept, only the token segment is redacted
 *  - Slack incoming-webhook URLs (`hooks.slack.com/services/<team>/<channel>/<token>`)
 *    — the team/channel ids are kept, only the trailing token is redacted
 *  - PEM private-key blocks (`-----BEGIN … PRIVATE KEY-----…-----END … PRIVATE KEY-----`)
 *    — the BEGIN/END markers are kept, only the body is redacted
 *  - JWTs (`eyJ…….…….…`)
 *  - GitHub tokens (`ghp_`/`gho_`/`ghs_`/`ghu_`/`ghr_…`)
 *  - Slack tokens (`xoxa-`/`xoxb-`/`xoxp-`/`xoxr-…`)
 *  - AWS access key ids (`AKIA…`)
 *  - `scheme://user:pass@host` URLs — the scheme and host are kept, only the
 *    userinfo is redacted
 *  - `NAME=value` / `NAME: value` where `NAME` names a credential by shape
 *    (password, passwd, secret, token, auth, credential(s), api/private key
 *    — see {@link isCredentialLikeKeyName}) — the name is kept, only the
 *    value is redacted
 */
export function redactCredentialPatterns(input: string): string {
  if (!input) return "";
  const patterned = input
    // Bearer tokens (case-insensitive)
    .replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+/gi, "Bearer [REDACTED]")
    // sk-/sk_ style keys
    .replace(/\bsk[-_][A-Za-z0-9._-]{6,}/g, "[REDACTED]")
    // key-/key_ shorthand keys
    .replace(/\bkey[-_][A-Za-z0-9._-]{6,}/g, "[REDACTED]")
    // JSON-style "api_key": "...", "apiKey": "...", "api-key": "..."
    .replace(/("(?:api[_-]?key|apiKey|authorization|token)"\s*:\s*")([^"]*)(")/gi, "$1[REDACTED]$3")
    // Discord webhook URLs: keep the webhook id, redact the token segment.
    .replace(/(discord(?:app)?\.com\/api\/webhooks\/\d+\/)[A-Za-z0-9_-]+/gi, "$1[REDACTED]")
    // Slack incoming-webhook URLs: keep the team/channel ids, redact the token.
    .replace(/(hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/)[A-Za-z0-9]+/gi, "$1[REDACTED]")
    // PEM private-key blocks: keep the BEGIN/END markers, redact the body.
    .replace(/(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----)/g, "$1[REDACTED]$2")
    // JWTs: three dot-separated base64url segments; the header always
    // starts "eyJ" (base64 of `{"`).
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    // GitHub tokens (ghp_/gho_/ghs_/ghu_/ghr_...)
    .replace(/\bgh[posur]_[A-Za-z0-9]{20,255}\b/g, "[REDACTED]")
    // Slack tokens (xoxa-/xoxb-/xoxp-/xoxr-...)
    .replace(/\bxox[abpr]-[A-Za-z0-9-]+\b/g, "[REDACTED]")
    // AWS access key ids
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    // URLs carrying `user:pass@` userinfo: keep the scheme and host.
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
  // NAME=value / NAME: value for credential-shaped names. Not a plain
  // `.replace()` in the chain above — see `redactNamedCredentialValues`.
  return redactNamedCredentialValues(patterned);
}

/**
 * Replace exact sensitive values in text.
 *
 * Every match is located against the ORIGINAL text and the result is emitted
 * once, so overlapping matches merge into a single `[REDACTED]` and no needle
 * can ever match inside a token an earlier needle produced.
 *
 * That last property is load-bearing. This function used to take a `replaceAll`
 * fast path that chained over a *mutating* accumulator, which meant any needle
 * drawn from the letters of `[REDACTED]` re-matched the tokens already injected
 * and the output grew geometrically: `redactSensitiveText("a".repeat(50),
 * ["a","E","D","T","C","R"])` returned 32,450 characters — 649x the input. On a
 * path where the needle set is derived from configuration or the environment,
 * that is a memory-exhaustion hazard reachable from ordinary command output.
 * The encoded-form path never had the bug because it always worked this way.
 */
/** Max characters of a provider error body worth surfacing in a message. */
const ERROR_BODY_MAX_LEN = 200;

/**
 * Make an HTTP error body safe to put in an error message: pattern-redact
 * credential shapes, then clip. Provider bodies can echo the credential that
 * was sent and can be megabytes of HTML, and these messages travel — into
 * `--json` output and agent transcripts.
 *
 * Lives here rather than beside one transport because every HTTP client in the
 * codebase needs it; the embeddings transport originally lacked it and leaked
 * raw 10 MB bodies into error messages.
 */
export function redactErrorBody(input: string): string {
  if (!input) return "";
  let out = redactCredentialPatterns(input);
  if (out.length > ERROR_BODY_MAX_LEN) {
    out = `${out.slice(0, ERROR_BODY_MAX_LEN)}…`;
  }
  return out;
}

export function redactSensitiveText(text: string, sensitiveValues: Iterable<string>): string {
  const values = [...new Set(sensitiveValues)]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  if (values.length === 0) return text;
  const coverageDelta = new Int32Array(text.length + 1);
  if (text.includes("%") || text.includes("+")) {
    // Percent-/plus-encoded text: match needle and haystack in their decoded
    // forms, mapping hits back to source offsets.
    const addMatchesForMode = (plusAsSpace: boolean): void => {
      const haystack = normalizeEncodedText(text, plusAsSpace);
      for (const value of values) {
        addMappedMatches(coverageDelta, haystack, normalizeEncodedText(value, plusAsSpace).text);
      }
    };
    addMatchesForMode(false);
    if (text.includes("+")) addMatchesForMode(true);
  } else {
    for (const value of values) addPlainMatches(coverageDelta, text, value);
  }
  let redacted = "";
  let coverage = 0;
  let offset = 0;
  let found = false;
  for (let index = 0; index <= text.length; index++) {
    const wasCovered = coverage > 0;
    coverage += coverageDelta[index]!;
    const isCovered = coverage > 0;
    if (!wasCovered && isCovered) {
      redacted += `${text.slice(offset, index)}[REDACTED]`;
      found = true;
    } else if (wasCovered && !isCovered) {
      offset = index;
    }
  }
  return found ? redacted + text.slice(offset) : text;
}

/** Recursively redact string leaves before a structured value crosses a durable/output boundary. */
export function redactSensitiveValue<T>(value: T, sensitiveValues: Iterable<string>): T {
  const values = [...sensitiveValues];
  const redact = (entry: unknown): unknown => {
    if (typeof entry === "string") return redactSensitiveText(entry, values);
    if (Array.isArray(entry)) return entry.map(redact);
    if (entry && typeof entry === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(entry)) {
        const redactedKey = redactSensitiveText(key, values);
        // Two DISTINCT keys can redact to the same string (`{a, b, ab}` under
        // needles `a`/`b` all collapse toward `[REDACTED]`). Building this with
        // `Object.fromEntries` kept only the last of each colliding group, so a
        // field was silently DROPPED rather than redacted — data loss disguised
        // as redaction. Suffix instead: the value stays, the key stays hidden.
        let finalKey = redactedKey;
        for (let n = 2; Object.hasOwn(out, finalKey); n++) finalKey = `${redactedKey} (${n})`;
        out[finalKey] = redact(child);
      }
      return out;
    }
    return entry;
  };
  return redact(value) as T;
}
