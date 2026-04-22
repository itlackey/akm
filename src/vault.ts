/**
 * Vault asset type — secret storage backed by `.env` files.
 *
 * Invariant: vault values must never be returned through the indexer, the
 * `akm show` renderer, or the structured `output()` channel. The only paths
 * that may surface a value are `vault get --stdout` and `vault load`, both of
 * which are explicit operator actions that emit to stdout.
 */

import fs from "node:fs";
import path from "node:path";

export interface ParsedEnvFile {
  /** All KEY names in file order, without duplicates. */
  keys: string[];
  /**
   * All start-of-line `#` comment lines (with the leading `#` and any
   * leading whitespace stripped). Inline/trailing `#` after an assignment
   * is never extracted.
   */
  comments: string[];
  /** KEY → raw value (after dequoting). Internal use only — do not log/serialize. */
  entries: Map<string, string>;
}

const ASSIGN_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/**
 * Parse `.env`-format text. Format:
 *   - `KEY=value` or `export KEY=value`
 *   - `# start-of-line comment` (leading whitespace allowed)
 *   - blank lines ignored
 *   - values may be unquoted, single-quoted, or double-quoted
 *   - inline `#` after an assignment is treated as part of the (unquoted) value
 *     terminator only if preceded by whitespace; we deliberately do NOT extract
 *     trailing comments to avoid risking value leakage.
 */
export function parseEnvFile(text: string): ParsedEnvFile {
  const keys: string[] = [];
  const comments: string[] = [];
  const entries = new Map<string, string>();
  const seenKeys = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed.length === 0) continue;

    if (trimmed.startsWith("#")) {
      comments.push(trimmed.slice(1).trimStart());
      continue;
    }

    const match = line.match(ASSIGN_RE);
    if (!match) continue;

    const key = match[1];
    const value = dequote(match[2]);

    if (!seenKeys.has(key)) {
      keys.push(key);
      seenKeys.add(key);
    }
    entries.set(key, value);
  }

  return { keys, comments, entries };
}

function dequote(raw: string): string {
  let s = raw.trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      s = s.slice(1, -1);
      if (first === '"') {
        s = s
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      }
      return s;
    }
  }
  // Unquoted values: strip an inline comment ONLY if preceded by whitespace,
  // matching common dotenv conventions. Anything ambiguous stays as-is.
  const hashIdx = findInlineCommentStart(s);
  if (hashIdx >= 0) s = s.slice(0, hashIdx).trimEnd();
  return s;
}

function findInlineCommentStart(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "#" && (i === 0 || /\s/.test(s[i - 1]))) return i;
  }
  return -1;
}

/**
 * Read and parse a vault file, returning ONLY non-secret metadata (keys and
 * start-of-line comments). The underlying values never leave this function.
 */
export function listKeys(vaultPath: string): { keys: string[]; comments: string[] } {
  if (!fs.existsSync(vaultPath)) return { keys: [], comments: [] };
  const text = fs.readFileSync(vaultPath, "utf8");
  const parsed = parseEnvFile(text);
  return { keys: parsed.keys, comments: parsed.comments };
}

/**
 * Read all KEY=value pairs from a vault file. Caller is responsible for
 * keeping the returned values out of agent-visible output.
 */
export function loadEnv(vaultPath: string): Record<string, string> {
  if (!fs.existsSync(vaultPath)) return {};
  const text = fs.readFileSync(vaultPath, "utf8");
  const parsed = parseEnvFile(text);
  return Object.fromEntries(parsed.entries);
}

/**
 * Read a single value. Internal helper for `vault get --stdout` only — never
 * call from rendering or indexing paths.
 */
export function getKey(vaultPath: string, key: string): string | undefined {
  if (!fs.existsSync(vaultPath)) return undefined;
  const text = fs.readFileSync(vaultPath, "utf8");
  return parseEnvFile(text).entries.get(key);
}

/**
 * Set a key in the vault file, preserving line order and comments. Creates
 * the file (and parent directory) if it does not exist.
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

/**
 * Remove a key from the vault file. Returns true if the key was present.
 */
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

/**
 * Create an empty vault file (does nothing if it already exists).
 */
export function createVault(vaultPath: string): void {
  ensureParentDir(vaultPath);
  if (fs.existsSync(vaultPath)) return;
  writeFileAtomic(vaultPath, "");
}

function quoteValue(value: string): string {
  if (value.length === 0) return "";
  // Quote anything that could be misparsed: whitespace, `#`, `"`, `'`, `=`,
  // newlines, leading `export`. Use double quotes with escapes.
  if (/[\s"'#=\\]|^export\b/.test(value)) {
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return `"${escaped}"`;
  }
  return value;
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

/**
 * Format a load result as `export KEY='value'` lines for shell `eval`.
 * Single-quotes the value with `'\''` escapes for safety.
 */
export function formatAsExport(env: Record<string, string>): string {
  const out: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    const escaped = value.replace(/'/g, "'\\''");
    out.push(`export ${key}='${escaped}'`);
  }
  return out.join("\n");
}
