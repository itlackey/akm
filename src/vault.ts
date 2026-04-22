/**
 * Vault asset type — secret storage backed by `.env` files.
 *
 * Invariant: vault values must never be written to stdout, returned through
 * the indexer, the `akm show` renderer, or any structured output channel.
 * The supported load paths are:
 *
 *   - `eval "$(akm vault load vault:<name>)"` — the shell `source`s the .env
 *     file directly; akm's stdout carries only the file path and `source`
 *     syntax, never values.
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
 * Values are never read from the file.
 */
export function listKeys(vaultPath: string): { keys: string[]; comments: string[] } {
  if (!fs.existsSync(vaultPath)) return { keys: [], comments: [] };
  const text = fs.readFileSync(vaultPath, "utf8");
  return { keys: scanKeys(text), comments: scanComments(text) };
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
 * Set a key in the vault file, preserving line order and comments. Creates
 * the file (and parent directory) if it does not exist.
 *
 * Values containing whitespace, quotes, `#`, `=`, backslashes, or newlines
 * are double-quoted with a small set of escape sequences understood by
 * dotenv. Round-trip safety is enforced by the test suite.
 */
export function setKey(vaultPath: string, key: string, value: string): void {
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
      break;
    }
  }

  if (!replaced) {
    if (lines.length > 0 && lines[lines.length - 1] === "") {
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
 * Quote a value for safe storage in a .env file that round-trips through
 * `dotenv.parse`. Strategy:
 *   - empty → empty
 *   - no special chars → unquoted
 *   - no `'`            → single-quote (dotenv reads single-quoted content
 *                         literally, no escape processing)
 *   - no `"` and no `\n`/`\r` literal sequence → double-quote (dotenv would
 *                         otherwise interpret `\n`/`\r` as newlines)
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
  if (!/[\s"'#=\\]/.test(value)) return value;
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
