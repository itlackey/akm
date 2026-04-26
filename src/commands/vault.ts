/**
 * Vault asset type — secret storage backed by `.env` files.
 *
 * Invariant: vault values must never be written to stdout, returned through
 * the indexer, the `akm show` renderer, or any structured output channel.
 * The supported load paths are:
 *
 *   - `eval "$(akm vault load vault:<name>)"` — `vault load` parses the vault
 *     with dotenv (no shell expansion, no code execution), writes a safely
 *     single-quote-escaped `export KEY='value'` script to a mode-0600 temp
 *     file, and emits `. <tmp>; rm -f <tmp>` on stdout. Values reach bash
 *     only via the temp file, never via akm's stdout.
 *   - `injectIntoEnv(vaultPath, target)` — programmatic API for modules that
 *     need values in a process environment.
 *
 * Value parsing is delegated to the `dotenv` package — we deliberately do not
 * implement our own quoting/escaping rules for security-sensitive content.
 */

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

/** Matches a KEY=value assignment line, capturing only the key. */
const ASSIGN_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Scan lines and return KEY names in file order, without duplicates. */
function scanKeys(text: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(ASSIGN_RE);
    if (!m) continue;
    const key = m[1];
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/**
 * Scan lines and return start-of-line `#` comments (with the leading `#` and
 * any leading whitespace stripped). Inline/trailing `#` after an assignment is
 * never extracted.
 */
function scanComments(text: string): string[] {
  const comments: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("#")) {
      comments.push(trimmed.slice(1).trimStart());
    }
  }
  return comments;
}

/**
 * Read and return ONLY non-secret metadata (keys + start-of-line comments).
 *
 * The function reads the whole file into memory (same as any dotenv parser)
 * but deliberately does not parse values — the LHS-only regex scanners above
 * ensure no value content is retained or returned. The guarantee is that
 * values never leave this function.
 */
export function listKeys(vaultPath: string): { keys: string[]; comments: string[] } {
  if (!fs.existsSync(vaultPath)) return { keys: [], comments: [] };
  const text = fs.readFileSync(vaultPath, "utf8");
  return { keys: scanKeys(text), comments: scanComments(text) };
}

/**
 * Return structured `entries` pairing each key with the nearest preceding
 * comment line (if any). This replaces the parallel `keys[]` + `comments[]`
 * shape used internally by `listKeys` with a single merged array, which is
 * easier for callers to consume (QA #35).
 *
 * Values are never included — the same privacy guarantee as `listKeys`.
 */
export function listEntries(vaultPath: string): Array<{ key: string; comment?: string }> {
  if (!fs.existsSync(vaultPath)) return [];
  const text = fs.readFileSync(vaultPath, "utf8");
  const lines = text.split(/\r?\n/);
  const seen = new Set<string>();
  const entries: Array<{ key: string; comment?: string }> = [];
  let pendingComment: string | undefined;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("#")) {
      // Capture the most recent comment before a key
      pendingComment = trimmed.slice(1).trimStart() || undefined;
      continue;
    }
    const m = line.match(ASSIGN_RE);
    if (m) {
      const key = m[1];
      if (!seen.has(key)) {
        seen.add(key);
        const entry: { key: string; comment?: string } = { key };
        if (pendingComment) entry.comment = pendingComment;
        entries.push(entry);
      }
      pendingComment = undefined;
    } else {
      // Any non-comment, non-assignment line (including blank lines)
      // breaks "nearest preceding comment line" association.
      pendingComment = undefined;
    }
  }
  return entries;
}

/**
 * Read all KEY=value pairs from a vault file. Intended for programmatic
 * callers that need to inject values into a process environment. Callers
 * MUST NOT write the returned values to stdout or any logged output.
 *
 * Value parsing (quoting, escapes, multi-line, etc.) is delegated to dotenv.
 */
export function loadEnv(vaultPath: string): Record<string, string> {
  if (!fs.existsSync(vaultPath)) return {};
  const buf = fs.readFileSync(vaultPath);
  return dotenv.parse(buf);
}

/**
 * Load a vault and assign its values into `target` (defaults to `process.env`).
 * Returns the list of keys that were set so the caller can log/observe without
 * touching values.
 *
 * Existing keys in `target` are overwritten — callers who want to preserve
 * pre-existing environment variables should filter before calling.
 */
export function injectIntoEnv(
  vaultPath: string,
  target: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string[] {
  const env = loadEnv(vaultPath);
  for (const [key, value] of Object.entries(env)) {
    target[key] = value;
  }
  return Object.keys(env);
}

/**
 * Serialise a vault's values as a POSIX shell script of `export KEY='value'`
 * lines, with single-quote escaping (`'\''`). Every line is an assignment of
 * a literal string — there is no expansion, command substitution, or
 * non-assignment content, so sourcing the output is safe regardless of what
 * the vault file contains.
 *
 * Intended for use by `akm vault load`, which writes this to a mode-0600
 * temp file and emits only the path (never values) on stdout.
 */
export function buildShellExportScript(vaultPath: string): string {
  const env = loadEnv(vaultPath);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    // Defence in depth: dotenv already validates key shape, but reject any
    // key we wouldn't be able to export safely.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const escaped = value.replace(/'/g, "'\\''");
    lines.push(`export ${key}='${escaped}'`);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * Set a key in the vault file, preserving line order and comments. Creates
 * the file (and parent directory) if it does not exist.
 *
 * `quoteValue` picks the safest representation that dotenv round-trips:
 * single-quoted when the value has no `'`, double-quoted when it has `'` but
 * no `"` and no literal `\n`/`\r` escape sequences, and unquoted only for
 * values that contain no characters requiring escaping (see quoteValue for
 * the full rule set). Values containing newlines or both quote types are
 * rejected outright. Round-trip safety is enforced by the test suite.
 *
 * When `comment` is provided it is written as a `# <comment>` line
 * immediately before the `KEY=value` line:
 *  - New key: the comment line is inserted just before the appended key.
 *  - Existing key: if the preceding line is already a comment it is replaced
 *    with the new comment; otherwise a new comment line is inserted.
 * When `comment` is absent the surrounding comment lines are left unchanged.
 */
export function setKey(vaultPath: string, key: string, value: string, comment?: string): void {
  validateKeyName(key);
  ensureParentDir(vaultPath);
  const existing = fs.existsSync(vaultPath) ? fs.readFileSync(vaultPath, "utf8") : "";
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
  const formatted = `${key}=${quoteValue(value)}`;
  let replaced = false;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ASSIGN_RE);
    if (m && m[1] === key) {
      lines[i] = formatted;
      replaced = true;
      if (comment !== undefined) {
        const commentLine = `# ${comment}`;
        const prevIsComment = i > 0 && lines[i - 1].trimStart().startsWith("#");
        if (prevIsComment) {
          lines[i - 1] = commentLine;
        } else {
          lines.splice(i, 0, commentLine);
        }
      }
      break;
    }
  }

  if (!replaced) {
    if (comment !== undefined) {
      const commentLine = `# ${comment}`;
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines[lines.length - 1] = commentLine;
        lines.push(formatted);
        lines.push("");
      } else {
        lines.push(commentLine);
        lines.push(formatted);
      }
    } else if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines[lines.length - 1] = formatted;
      lines.push("");
    } else {
      lines.push(formatted);
    }
  }

  let out = lines.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  writeFileAtomic(vaultPath, out);
}

/** Remove a key from the vault file. Returns true if the key was present. */
export function unsetKey(vaultPath: string, key: string): boolean {
  if (!fs.existsSync(vaultPath)) return false;
  const text = fs.readFileSync(vaultPath, "utf8");
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let removed = false;

  for (const line of lines) {
    const m = line.match(ASSIGN_RE);
    if (m && m[1] === key) {
      removed = true;
      continue;
    }
    kept.push(line);
  }

  if (!removed) return false;
  let out = kept.join("\n");
  if (out.length > 0 && !out.endsWith("\n")) out += "\n";
  writeFileAtomic(vaultPath, out);
  return true;
}

/** Create an empty vault file (does nothing if it already exists). */
export function createVault(vaultPath: string): void {
  ensureParentDir(vaultPath);
  if (fs.existsSync(vaultPath)) return;
  writeFileAtomic(vaultPath, "");
}

/**
 * Characters that are safe in an UNquoted dotenv value AND are not
 * metacharacters in POSIX shells. Anything outside this set forces quoting,
 * which is defense-in-depth for any caller that might ever `source` the
 * vault file directly instead of going through `akm vault load`.
 */
const UNQUOTED_SAFE_RE = /^[A-Za-z0-9_.:/@%+,-]+$/;

/**
 * Quote a value for safe storage in a .env file that round-trips through
 * `dotenv.parse` AND is safe if the file is ever `source`d by a POSIX shell.
 *
 * Strategy:
 *   - empty → empty
 *   - all-safe chars (alnum + `_.:/@%+,-`) → unquoted
 *   - no `'` → single-quote (dotenv and shell both treat single-quoted
 *                            content literally: no expansion, no escapes)
 *   - no `"` and no literal `\n`/`\r` escape sequence → double-quote
 *                            (dotenv unescapes `\n`/`\r` on read, so we
 *                            can't double-quote a value that contains
 *                            those literal sequences)
 *   - newlines or both quote types → reject
 *
 * dotenv intentionally does NOT support `\"` inside double-quoted values, so
 * we never produce that pattern.
 */
function quoteValue(value: string): string {
  if (value.length === 0) return "";
  if (/[\n\r]/.test(value)) {
    throw new Error("Vault values cannot contain literal newlines.");
  }
  if (UNQUOTED_SAFE_RE.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !/\\[nr]/.test(value)) return `"${value}"`;
  throw new Error("Vault value contains both single and double quote characters; not supported.");
}

function validateKeyName(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid vault key name: "${key}". Must match [A-Za-z_][A-Za-z0-9_]*`);
  }
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeFileAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* best-effort on platforms without chmod */
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}
