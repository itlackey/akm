/**
 * Golden-fixture infrastructure (WI-01 — brief §3.1/§3.2, R6/R12).
 *
 * NOT a fixed point (unlike tests/_helpers/sandbox.ts / tests/_preload.ts) —
 * this is a new file minted by this chunk and is free to evolve.
 *
 * Golden fixtures live at `tests/fixtures/goldens/<area>/<scenario>.json`
 * (areas: `improve/`, `journal/`, `consolidate/`, `cli/`), JSON, 2-space,
 * sorted keys, trailing newline (see {@link stableStringify}). Every fixture
 * must have exactly one entry in `tests/fixtures/goldens/DESIGNATIONS.json`
 * (policed by `tests/goldens-designations.test.ts`).
 *
 * ## Grammar-agnostic normalization (brief §3.2 rule 2)
 *
 * {@link normalizeGolden} strips nondeterministic/grammar-coupled detail out
 * of a captured value before it is compared or serialized, replacing it with
 * one of five placeholders:
 *
 *   - `<TS>`    ISO-8601 timestamps, AND `timestampForFilename()` tokens
 *               (`src/core/common.ts:525` —
 *               `new Date().toISOString().replace(/[:.]/g, "-")`) wherever
 *               they appear embedded in filenames/frontmatter/journals.
 *   - `<ID>`    uuids / proposal ids. Default outcome for any bare
 *               uuid-shaped string (proposal ids are `crypto.randomUUID()`
 *               per `src/commands/proposal/repository.ts`).
 *   - `<TXN>`   transaction ids. Key-name override: applies instead of
 *               `<ID>` when the enclosing object key's name contains
 *               "transaction" (case-insensitive) — covers both
 *               `transactionId` and the mv-engine's idempotency-key grammar
 *               (`mutationTransactionId`, `idempotencyMetadataKey`).
 *   - `<STASH>` / `<DATA>` / `<TMP>`   sandbox root substitution. Only
 *               applied when the corresponding root is passed via the
 *               `roots` argument (per-test sandbox directories are random
 *               per run, so callers must supply them explicitly — there is
 *               no way to recognize a sandbox root from shape alone).
 *   - `<DUR>`   duration fields. Key-name based: any numeric field whose key
 *               contains "duration" (case-insensitive) — e.g. `durationMs`,
 *               `totalDurationMs`.
 *
 * Normalization is idempotent (normalizing an already-normalized value is a
 * no-op) and recurses through plain objects and arrays.
 *
 * ## Regeneration
 *
 * `saveGolden` / `expectGolden`'s record path only ever run when
 * `AKM_UPDATE_GOLDENS=1` is set in the environment of the *developer
 * invocation* — e.g. `AKM_UPDATE_GOLDENS=1 bun test tests/foo.test.ts`.
 * Never set this env var from inside a test: `tests/_preload.ts`'s
 * `afterEach` tripwire polices AKM_-, XDG_-, and HOME-prefixed env leaks
 * across tests, and more importantly, regenerating a golden outside its designated capture
 * chunk (see `DESIGNATIONS.json`'s `designation`/`reBaselineChunk` fields)
 * is forbidden by plan §15 rule 5 — it would show up as an unreviewed git
 * diff on a frozen fixture and is a review BLOCKER.
 */

import { expect } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Repo root, resolved relative to this file (tests/_helpers/golden.ts). */
const REPO_ROOT: string = path.resolve(__dirname, "..", "..");

/**
 * Absolute sandbox roots to fold into `<STASH>`/`<DATA>`/`<TMP>` during
 * normalization. Omit a key to leave that class of path unsubstituted.
 */
export interface GoldenRoots {
  stash?: string;
  data?: string;
  tmp?: string;
}

const ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
/** `timestampForFilename()` token: toISOString() with `[:.]` -> `-`. */
const FILENAME_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/g;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** True iff `key` looks like it names a transaction id (brief §3.2). */
function isTransactionKey(key: string): boolean {
  return key.toLowerCase().includes("transaction");
}

/** True iff `key` looks like it names a duration field (brief §3.2). */
function isDurationKey(key: string): boolean {
  return /duration/i.test(key);
}

/** Apply the roots + <TS> + <ID> substitutions to a single string value. */
function normalizeString(value: string, roots: GoldenRoots | undefined): string {
  let out = value;
  if (roots?.stash) out = out.split(roots.stash).join("<STASH>");
  if (roots?.data) out = out.split(roots.data).join("<DATA>");
  if (roots?.tmp) out = out.split(roots.tmp).join("<TMP>");
  out = out.replace(FILENAME_TIMESTAMP_RE, "<TS>");
  out = out.replace(ISO_TIMESTAMP_RE, "<TS>");
  out = out.replace(UUID_RE, "<ID>");
  return out;
}

function normalizeValue(value: unknown, roots: GoldenRoots | undefined, key: string | undefined): unknown {
  if (typeof value === "string") {
    const normalized = normalizeString(value, roots);
    if (key && isTransactionKey(key) && normalized.includes("<ID>")) {
      return normalized.split("<ID>").join("<TXN>");
    }
    return normalized;
  }
  if (typeof value === "number") {
    if (key && isDurationKey(key)) return "<DUR>";
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item, roots, key));
  }
  if (value !== null && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(input)) {
      out[k] = normalizeValue(input[k], roots, k);
    }
    return out;
  }
  return value;
}

/**
 * Recursively normalize `value`, replacing nondeterministic/grammar-coupled
 * detail with the placeholder classes documented above. Idempotent.
 */
export function normalizeGolden(value: unknown, roots?: GoldenRoots): unknown {
  return normalizeValue(value, roots, undefined);
}

/** Recursively sort object keys (arrays keep element order). */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(input).sort()) {
      out[k] = sortKeysDeep(input[k]);
    }
    return out;
  }
  return value;
}

/**
 * Key-sorted, 2-space-indented JSON serialization with exactly one trailing
 * newline. Used by {@link saveGolden} so committed fixtures diff minimally
 * regardless of the key-insertion order the capturing test happened to use.
 * Idempotent under parse + re-stringify.
 */
export function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

function resolveGoldenPath(relPath: string): string {
  return path.isAbsolute(relPath) ? relPath : path.resolve(REPO_ROOT, relPath);
}

/** Load and JSON-parse a golden fixture. `relPath` is repo-root-relative. */
export function loadGolden<T = unknown>(relPath: string): T {
  const abs = resolveGoldenPath(relPath);
  return JSON.parse(fs.readFileSync(abs, "utf8")) as T;
}

/**
 * Write `value` to `relPath` as a stable-stringified golden fixture. Only
 * runs when `AKM_UPDATE_GOLDENS=1` is set (developer invocation, never
 * inside a test) — throws otherwise so a stray call can never silently
 * rewrite a frozen fixture during a normal test run.
 */
export function saveGolden(relPath: string, value: unknown): void {
  if (process.env.AKM_UPDATE_GOLDENS !== "1") {
    throw new Error(
      `[golden] refusing to write ${relPath}: saveGolden only writes when AKM_UPDATE_GOLDENS=1 is set by the ` +
        `developer invocation (e.g. \`AKM_UPDATE_GOLDENS=1 bun test <path>\`) — never set this from inside a test. ` +
        `Regenerating a golden outside its designated capture chunk (see DESIGNATIONS.json) is a review BLOCKER ` +
        `(plan §15 rule 5).`,
    );
  }
  const abs = resolveGoldenPath(relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, stableStringify(value));
}

/**
 * Normalize `actual`, then either record it (when `AKM_UPDATE_GOLDENS=1`) or
 * load-and-deep-equal-compare it against the committed fixture at `relPath`.
 * Throws a clear error if the fixture is missing and regeneration is not
 * requested, rather than silently passing.
 */
export function expectGolden(relPath: string, actual: unknown, roots?: GoldenRoots): void {
  const normalizedActual = normalizeGolden(actual, roots);
  if (process.env.AKM_UPDATE_GOLDENS === "1") {
    saveGolden(relPath, normalizedActual);
    return;
  }
  const abs = resolveGoldenPath(relPath);
  if (!fs.existsSync(abs)) {
    throw new Error(
      `[golden] missing golden fixture: ${relPath}. Re-run with AKM_UPDATE_GOLDENS=1 to record it (developer ` +
        `invocation only — never set this env var inside a test).`,
    );
  }
  const expected = loadGolden(relPath);
  expect(normalizedActual).toEqual(expected);
}

/** Hex SHA-256 of a file's raw bytes. */
export function sha256File(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return createHash("sha256").update(data).digest("hex");
}

/** Hex SHA-256 of a string (used for dangling-symlink entries in a tree manifest). */
function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function walkFileTree(dir: string, base: string, out: Record<string, string>): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(base, abs).split(path.sep).join("/");
    if (entry.isSymbolicLink()) {
      let stat: fs.Stats | undefined;
      try {
        stat = fs.statSync(abs);
      } catch {
        // Dangling symlink: hash the link target text so the manifest stays
        // deterministic without following a target that doesn't exist.
        out[rel] = `symlink:${sha256Hex(fs.readlinkSync(abs))}`;
        continue;
      }
      if (stat.isDirectory()) {
        walkFileTree(abs, base, out);
      } else {
        out[rel] = sha256File(abs);
      }
      continue;
    }
    if (entry.isDirectory()) {
      walkFileTree(abs, base, out);
      continue;
    }
    if (entry.isFile()) {
      out[rel] = sha256File(abs);
    }
  }
}

/**
 * Sorted `{ relPosixPath: sha256 }` manifest of every regular file under
 * `dir` (recursive). Symlinks are followed and hashed as their target's
 * content; a dangling symlink is hashed by its link-target text instead of
 * throwing. Paths are POSIX-separated and relative to `dir`.
 */
export function fileTreeManifest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  walkFileTree(dir, dir, out);
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(out).sort()) sorted[key] = out[key]!;
  return sorted;
}
