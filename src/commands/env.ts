// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Environment asset type (`env`) — whole `.env` file storage.
 *
 * An `env` asset holds a GROUP of related CONFIGURATION for an app or service
 * (URLs, feature flags, and any credentials it needs) in a single `.env` file,
 * sourced/injected wholesale. Values may or may not be sensitive — akm protects
 * them all the same. For a single sensitive value used on its own for
 * authentication (a token, key, or cert), use the `secret` type instead.
 *
 * Unlike the deprecated `vault` type it replaces, akm does NOT manage individual
 * KEY=value entries (no `set`/`unset`/quoting): you edit the `.env` file with
 * your own editor, and akm loads it. The simplification removes the
 * hand-rolled quoting/escaping surface; the safety guarantee moves to the READ
 * path instead (see `buildShellExportScript` + `akm env export`).
 *
 * Invariant: env values must never be written to stdout, returned through the
 * indexer, the `akm show` renderer, or any structured output channel. Key
 * NAMES and start-of-line comments ARE surfaced by design (discoverability) —
 * only values are secret. The supported value-load paths are:
 *
 *   - `akm env run <ref> -- <command>` — values injected into the child
 *     process env (never via a shell), see `injectIntoEnv` / `loadEnv`. This is
 *     the primary path and the only one safe for AI agents (no values ever
 *     reach stdout). For an interactive shell, `akm env run <ref> -- $SHELL`.
 *   - `akm env export <ref> --out <file>` — write parse-then-reserialized safe
 *     `export KEY='value'` lines to a file (mode 0600) for `source`-ing. Values
 *     are re-emitted single-quoted so a raw `.env` containing `X=$(cmd)` cannot
 *     execute on load. `export` never prints values to stdout (would leak into
 *     an agent's context); `path` prints only the file path.
 *
 * Value parsing is delegated to the `dotenv` package — we deliberately do not
 * implement our own quoting/escaping rules for security-sensitive content.
 *
 * Secret-token substitution: env VALUES may embed `${secret:NAME}` tokens, which
 * are replaced at `env run` time with the value of the sibling `secret:NAME`
 * asset in the SAME stash (see `resolveSecretTokens`). Substitution applies to
 * values only, never keys; only the `${secret:...}` form is recognised —
 * shell-style `${VAR}` / `$VAR` are left untouched. The secret lookup is
 * injected so this module keeps its narrow dependency surface (dotenv +
 * core/common) and never reaches into the secret resolver/source machinery.
 */

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { writeFileAtomic } from "../core/common";

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
export function listKeys(envPath: string): { keys: string[]; comments: string[] } {
  if (!fs.existsSync(envPath)) return { keys: [], comments: [] };
  const text = fs.readFileSync(envPath, "utf8");
  return { keys: scanKeys(text), comments: scanComments(text) };
}

/**
 * Return structured `entries` pairing each key with the nearest preceding
 * comment line (if any). This is an easier-to-consume shape than the parallel
 * `keys[]` + `comments[]` of `listKeys` (QA #35).
 *
 * Values are never included — the same privacy guarantee as `listKeys`.
 */
export function listEntries(envPath: string): Array<{ key: string; comment?: string }> {
  if (!fs.existsSync(envPath)) return [];
  const text = fs.readFileSync(envPath, "utf8");
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
 * Read all KEY=value pairs from an env file. Intended for programmatic callers
 * that need to inject values into a process environment. Callers MUST NOT write
 * the returned values to stdout or any logged output.
 *
 * Value parsing (quoting, escapes, multi-line, etc.) is delegated to dotenv.
 */
export function loadEnv(envPath: string): Record<string, string> {
  if (!fs.existsSync(envPath)) return {};
  const buf = fs.readFileSync(envPath);
  return dotenv.parse(buf);
}

/**
 * Load an env file and assign its values into `target` (defaults to
 * `process.env`). Returns the list of keys that were set so the caller can
 * log/observe without touching values.
 *
 * Existing keys in `target` are overwritten — callers who want to preserve
 * pre-existing environment variables should filter before calling.
 */
export function injectIntoEnv(
  envPath: string,
  target: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string[] {
  const env = loadEnv(envPath);
  for (const [key, value] of Object.entries(env)) {
    target[key] = value;
  }
  return Object.keys(env);
}

/**
 * Serialise an env file's values as a POSIX shell script of `export KEY='value'`
 * lines, with single-quote escaping (`'\''`). Every line is an assignment of a
 * literal string — there is no expansion, command substitution, or
 * non-assignment content, so `eval`-ing the output is safe regardless of what
 * the source file contains.
 *
 * This is the trust boundary for shell loading: a raw `.env` may contain
 * `X=$(rm -rf ~)`, which would execute if `source`d directly, but dotenv parses
 * it to the literal string `$(rm -rf ~)` and we re-emit it single-quoted. This
 * backs `akm env export <ref> --out <file>` (file-only; never printed to stdout).
 *
 * NOTE: `${secret:NAME}` token substitution is intentionally NOT applied here.
 * The export path emits values single-quoted as literals, so an unsubstituted
 * `${secret:NAME}` is written verbatim (it would expand to nothing under POSIX
 * shells, never to the secret). Secret-token resolution is scoped to the
 * `env run` value-injection path only; see `resolveSecretTokens`.
 */
export function buildShellExportScript(envPath: string): string {
  const env = loadEnv(envPath);
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
 * Matches a `${secret:NAME}` substitution token in an env value. The captured
 * NAME accepts the same character set as a secret asset name (letters, digits,
 * `_`, `.`, `/`, `-`). Only this exact form is recognised — shell-style
 * `${VAR}` and `$VAR` deliberately do not match and are left untouched.
 */
const SECRET_TOKEN_RE = /\$\{secret:([A-Za-z0-9_./-]+)\}/g;

/**
 * Replace every `${secret:NAME}` token in each value with the corresponding
 * secret value, looked up via the injected `resolveSecret`. Keys are never
 * touched. Multiple tokens per value and tokens embedded in larger strings
 * (e.g. `Bearer ${secret:a}:${secret:b}`) are all substituted.
 *
 * `resolveSecret` returns `undefined` for an unknown secret name; such names are
 * collected into `missing` (de-duplicated, in first-seen order) and their tokens
 * are left unsubstituted in the returned values. Callers MUST treat a non-empty
 * `missing` as a hard error and inject NOTHING — never partially inject.
 *
 * The lookup is injected so this module does not import the secret
 * resolver/source machinery directly, preserving its narrow dependency surface.
 * Resolved secret values must never be logged or printed by callers.
 */
export function resolveSecretTokens(
  values: Record<string, string>,
  resolveSecret: (name: string) => string | undefined,
): { values: Record<string, string>; missing: string[] } {
  const missing: string[] = [];
  const missingSeen = new Set<string>();
  const out: Record<string, string> = {};
  const cache = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    out[key] = value.replace(SECRET_TOKEN_RE, (match, name: string) => {
      let resolved = cache.get(name);
      if (!cache.has(name)) {
        resolved = resolveSecret(name);
        cache.set(name, resolved);
      }
      if (resolved === undefined) {
        if (!missingSeen.has(name)) {
          missingSeen.add(name);
          missing.push(name);
        }
        return match;
      }
      return resolved;
    });
  }

  return { values: out, missing };
}

/** Create an empty env file (does nothing if it already exists). */
export function createEnv(envPath: string): void {
  ensureParentDir(envPath);
  if (fs.existsSync(envPath)) return;
  writeFileAtomic(envPath, "", 0o600);
}

/**
 * Write (create or overwrite) an env file with the given text content,
 * atomically at mode 0600. Used to ingest an existing `.env` file
 * (`env create --from-file` / `--from-stdin`).
 */
export function writeEnv(envPath: string, content: string): void {
  ensureParentDir(envPath);
  writeFileAtomic(envPath, content, 0o600);
}

/** Remove an env file (and its `.sensitive` marker, if present). Returns true if it existed. */
export function removeEnv(envPath: string): boolean {
  if (!fs.existsSync(envPath)) return false;
  fs.rmSync(envPath);
  const marker = `${envPath}.sensitive`;
  if (fs.existsSync(marker)) fs.rmSync(marker);
  return true;
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
