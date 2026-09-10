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
 * akm does not manage individual keys — edit the `.env` file with your own
 * editor. Values are quoted/escaped only when necessary and round-trip
 * through `dotenv`; the shell-load safety guarantee lives on the READ path
 * (see `buildShellExportScript` + `akm env export`).
 *
 * Invariant: nothing from an env file except key NAMES may be written to
 * stdout, returned through the indexer, the `akm show` renderer, or any
 * structured output channel. Key NAMES are surfaced for discoverability;
 * comment text is NOT — real .env files routinely carry commented-out
 * `KEY=value` lines and free-text notes containing live credentials, so
 * comments are treated exactly like values. The supported value-load paths
 * are:
 *
 *   - `akm env run <ref> -- <command>` — values injected into the child
 *     process env (never via a shell), see `loadEnv` (loaded by
 *     `env-binding.ts#resolveEnvBinding`, then merged into the child env by
 *     `env-cli.ts`). This is the primary path and the only one safe for AI
 *     agents (no values ever reach stdout). For an interactive shell, `akm
 *     env run <ref> -- $SHELL`.
 *   - `akm env export <ref> --out <file>` — write parse-then-reserialized safe
 *     `export KEY='value'` lines to a file (mode 0600) for `source`-ing. Values
 *     are re-emitted single-quoted so a raw `.env` containing `X=$(cmd)` cannot
 *     execute on load. `export` never prints values to stdout (would leak into
 *     an agent's context); `path` prints only the file path.
 *
 * Value parsing is delegated to the `dotenv` package.
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
import { scanEnvKeyNames, writeFileAtomic } from "../../core/common";
import { sensitiveMarkerPath } from "../../core/sensitive-marker-path";

export { scanEnvKeyNames };

/**
 * Read and return ONLY non-secret metadata: key names.
 *
 * The function reads the whole file into memory (same as any dotenv parser)
 * but deliberately does not parse values — the LHS-only regex scanner above
 * ensures no value content is retained or returned. Comment text is never
 * returned either: comments routinely contain commented-out `KEY=value`
 * credentials and free-text secrets, so they never leave this function.
 */
export function listKeys(envPath: string): { keys: string[] } {
  if (!fs.existsSync(envPath)) return { keys: [] };
  const text = fs.readFileSync(envPath, "utf8");
  return { keys: scanEnvKeyNames(text) };
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
  const marker = sensitiveMarkerPath(envPath, "env");
  if (fs.existsSync(marker)) fs.rmSync(marker);
  return true;
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
