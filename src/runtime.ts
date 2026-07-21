// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Runtime boundary for non-SQLite host APIs.
 *
 * Single source of truth for every `Bun.*` API (and `import.meta.dir`) used
 * outside the SQLite layer. The rest of the codebase imports these named
 * helpers and NEVER touches `Bun.*` directly, so the application code is
 * runtime-agnostic and the Node path is purely additive.
 *
 * Runtime selection: a single `isBun` flag (computed once at module load)
 * branches each helper. On Bun (the primary/test runtime) the helpers delegate
 * to the native `Bun.*` API so behaviour stays byte-identical; on Node they use
 * the `node:*` equivalents. The Node-only deps (`semver`) are loaded lazily so
 * Bun never resolves them.
 *
 * This is intentionally NOT an adapter/DI/ports-and-adapters layer — just a
 * plain module of named function exports plus a couple of structural types.
 *
 * @module runtime
 */

import { type ChildProcess, spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, statfsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

/** True when running under the Bun runtime. Computed once at module load. */
const isBun = !!process.versions?.bun;

/** A CommonJS-style require usable from this ESM module on both runtimes. */
const nodeRequire = createRequire(import.meta.url);

// ── Subprocess types ────────────────────────────────────────────────────────

/**
 * The async subprocess surface AKM relies on. This is the structural subset of
 * Bun's `Subprocess` that call sites use; on Bun a native `Subprocess` is
 * returned unchanged, on Node a thin adapter over `child_process.ChildProcess`
 * provides the same shape.
 */
export interface Subprocess {
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly stdin: WritableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly pid?: number;
  kill(signal?: number | string): void;
}

/** Options accepted by {@link spawn}. Common subset across runtimes. */
export interface SpawnOptions {
  stdin?: "inherit" | "pipe" | "ignore";
  stdout?: "inherit" | "pipe" | "ignore";
  stderr?: "inherit" | "pipe" | "ignore";
  env?: Record<string, string>;
  cwd?: string;
  detached?: boolean;
}

/** Result shape of {@link spawnSync}, mirroring Bun's `SyncSubprocess`. */
export interface SpawnSyncResult {
  success: boolean;
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

/** Options accepted by {@link spawnSync}. */
export interface SpawnSyncOptions {
  cwd?: string;
  env?: Record<string, string>;
}

// ── Subprocess ──────────────────────────────────────────────────────────────

/**
 * Spawn a child process asynchronously. On Bun delegates to `Bun.spawn` (the
 * returned native `Subprocess` is structurally identical to {@link Subprocess});
 * on Node wraps `child_process.spawn` to expose the same Web-stream surface.
 */
export function spawn(cmd: string[], options: SpawnOptions = {}): Subprocess {
  if (isBun) {
    return bunGlobal().spawn(cmd, options) as unknown as Subprocess;
  }
  return nodeSpawnAdapter(cmd, options);
}

/**
 * Spawn a child process synchronously, returning a Bun-shaped result (note
 * `success` and the Buffer `stdout`/`stderr`). On Node `child_process.spawnSync`
 * is normalised to that shape.
 */
export function spawnSync(cmd: string[], options: SpawnSyncOptions = {}): SpawnSyncResult {
  if (isBun) {
    const r = bunGlobal().spawnSync(cmd, options);
    return {
      success: r.success,
      exitCode: r.exitCode ?? null,
      stdout: toBuffer(r.stdout),
      stderr: toBuffer(r.stderr),
    };
  }
  const [bin, ...args] = cmd;
  const r = nodeSpawnSync(bin!, args, { cwd: options.cwd, env: options.env ?? process.env });
  const exitCode = r.status;
  return {
    success: r.error === undefined && exitCode === 0,
    exitCode: exitCode ?? null,
    stdout: toBuffer(r.stdout),
    stderr: toBuffer(r.stderr),
  };
}

function nodeSpawnAdapter(cmd: string[], options: SpawnOptions): Subprocess {
  const [bin, ...args] = cmd;
  const child: ChildProcess = nodeSpawn(bin!, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: options.detached,
    stdio: [stdioFor(options.stdin), stdioFor(options.stdout), stdioFor(options.stderr)],
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.once("exit", (code) => resolve(code ?? 0));
    child.once("error", reject);
  });
  return {
    get stdout() {
      return child.stdout ? (Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>) : null;
    },
    get stderr() {
      return child.stderr ? (Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>) : null;
    },
    get stdin() {
      return child.stdin ? (Writable_toWeb(child.stdin) as unknown as WritableStream<Uint8Array>) : null;
    },
    exited,
    get exitCode() {
      return child.exitCode;
    },
    pid: child.pid,
    kill(signal?: number | string) {
      child.kill(signal as NodeJS.Signals | number | undefined);
    },
  };
}

// `node:stream`'s Writable.toWeb is available on Node >=17; referenced via the
// class to avoid a static import that Bun's typings may not expose.
function Writable_toWeb(w: import("node:stream").Writable): unknown {
  const { Writable } = nodeRequire("node:stream") as typeof import("node:stream");
  return Writable.toWeb(w);
}

function stdioFor(mode: "inherit" | "pipe" | "ignore" | undefined): "inherit" | "pipe" | "ignore" {
  return mode ?? "pipe";
}

// ── Stdin ───────────────────────────────────────────────────────────────────

/**
 * Read all of stdin as a single `Buffer`, enforcing a byte limit. When more
 * than `limitBytes` is read, `onLimitExceeded()` is invoked and its return (an
 * Error) is thrown — callers supply their own message so behaviour is exact.
 */
export async function readStdin(limitBytes: number, onLimitExceeded: () => Error): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stdinIterator()) {
    total += chunk.byteLength;
    if (total > limitBytes) throw onLimitExceeded();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function stdinIterator(): AsyncIterable<Uint8Array> {
  if (isBun) {
    return bunGlobal().stdin.stream() as AsyncIterable<Uint8Array>;
  }
  // process.stdin is an async iterable of Buffer on Node.
  return process.stdin as AsyncIterable<Uint8Array>;
}

// ── File write ──────────────────────────────────────────────────────────────

/**
 * Stream a `Response` (or its body) to `filePath`. On Bun uses `Bun.write`,
 * which natively streams a `Response` to disk; on Node pipes the response body
 * through `stream/promises.pipeline` so the archive is never fully buffered.
 */
export async function writeResponseToFile(filePath: string, res: Response): Promise<void> {
  if (isBun) {
    await bunGlobal().write(filePath, res);
    return;
  }
  if (res.body) {
    const readable = Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
    await pipeline(readable, createWriteStream(filePath));
    return;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await pipeline(Readable.from(buf), createWriteStream(filePath));
}

// ── Hashing ─────────────────────────────────────────────────────────────────

/**
 * Hex SHA-256 of `data`. Uses `node:crypto` on both runtimes (available in Bun
 * and Node), which is simpler than `Bun.CryptoHasher` and produces identical
 * digests.
 */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Hex MD5 of `data`. Uses `node:crypto` on both runtimes. */
export function md5Hex(data: string | Uint8Array): string {
  return createHash("md5").update(data).digest("hex");
}

// ── Semver ──────────────────────────────────────────────────────────────────

/**
 * Compare two semver strings, returning -1, 0, or 1 (the ordering contract of
 * `Bun.semver.order`). On Bun uses the built-in; on Node uses the `semver`
 * package's `compare`, loaded lazily.
 */
export function semverOrder(a: string, b: string): -1 | 0 | 1 {
  if (isBun) {
    return bunGlobal().semver.order(a, b);
  }
  const semver = nodeRequire("semver") as typeof import("semver");
  return semver.compare(a, b) as -1 | 0 | 1;
}

// ── Module resolution ───────────────────────────────────────────────────────

/**
 * Resolve a module specifier without loading it, relative to `from`. On Bun
 * uses `Bun.resolveSync`; on Node uses `require.resolve`. Throws when the
 * specifier cannot be resolved (mirroring both underlying APIs).
 */
export function resolveModule(spec: string, from: string): string {
  if (isBun) {
    return bunGlobal().resolveSync(spec, from);
  }
  return nodeRequire.resolve(spec, { paths: [from] });
}

// ── Filesystem paths ────────────────────────────────────────────────────────

/**
 * The directory of the module identified by `importMetaUrl`. Replaces
 * `import.meta.dir` (Bun-only). Uses `fileURLToPath` + `dirname` on both
 * runtimes — on Bun this is byte-identical to `import.meta.dir`.
 */
export function getDirname(importMetaUrl: string): string {
  return path.dirname(fileURLToPath(importMetaUrl));
}

// ── Filesystem type probe ─────────────────────────────────────────────────────

/**
 * Best-effort filesystem-type probe: return the numeric `f_type` magic of the
 * filesystem backing `path`, or `undefined` on any error (ENOENT/EPERM/
 * unsupported). Used (via injection) by the SQLite journal-mode network-FS
 * fallback (#628).
 *
 * This is a runtime primitive (a `statfs` filesystem-type probe) and therefore
 * lives here, per the runtime boundary, even though it uses only `node:fs`. The
 * "magic-number → is-network" classification stays a pure helper elsewhere.
 *
 * `fs.statfsSync` is a stable `node:fs` API (Node ≥ 18.15) and is implemented
 * under Bun as well. It THROWS ENOENT on a non-existent path, so callers should
 * probe an already-created directory — the swallowed error simply yields
 * `undefined` (treated as "not network").
 */
export function statfsType(path: string): number | undefined {
  try {
    return statfsSync(path).type;
  } catch {
    return undefined;
  }
}

// ── Sleep ───────────────────────────────────────────────────────────────────

/**
 * Block the current thread for `ms` without busy-spinning. On Bun uses the real
 * blocking `Bun.sleepSync`; on Node uses `Atomics.wait` on a throwaway buffer,
 * which yields the thread to the OS scheduler the same way.
 */
export function sleepSync(ms: number): void {
  if (isBun) {
    bunGlobal().sleepSync(ms);
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Async sleep for `ms`. On Bun uses `Bun.sleep`; on Node a `setTimeout` promise. */
export function sleep(ms: number): Promise<void> {
  if (isBun) {
    return bunGlobal().sleep(ms) as Promise<void>;
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Main entrypoint ─────────────────────────────────────────────────────────

/**
 * Path of the script that started the process. On Bun this is `Bun.main`
 * (which, for compiled binaries, points at a virtual `/$bunfs/` path rather
 * than `process.execPath`); on Node it is `process.argv[1]`.
 */
export const mainPath: string | undefined = isBun ? bunGlobal().main : process.argv[1];

// ── Internals ───────────────────────────────────────────────────────────────

interface BunGlobal {
  spawn(cmd: string[], options: SpawnOptions): Subprocess;
  spawnSync(
    cmd: string[],
    options: SpawnSyncOptions,
  ): { success: boolean; exitCode: number | null; stdout: Uint8Array | Buffer; stderr: Uint8Array | Buffer };
  stdin: { stream(): AsyncIterable<Uint8Array> };
  write(path: string, data: Response): Promise<number>;
  semver: { order(a: string, b: string): -1 | 0 | 1 };
  resolveSync(spec: string, from: string): string;
  sleepSync(ms: number): void;
  sleep(ms: number): Promise<void>;
  main: string;
}

/** Access the `Bun` global. Only ever called when `isBun` is true. */
function bunGlobal(): BunGlobal {
  return (globalThis as unknown as { Bun: BunGlobal }).Bun;
}

function toBuffer(data: Uint8Array | Buffer | string | null | undefined): Buffer {
  if (data == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === "string") return Buffer.from(data, "utf8");
  return Buffer.from(data);
}
