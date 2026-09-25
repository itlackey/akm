// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The ONE durable filesystem-transaction engine (plan §2.2 / §4.5, Chunk 6
 * WI-6.3). Replaces the three (+1) per-domain journal engines — proposal
 * accept/revert, proposal reject, mv, consolidate — with a single journal
 * home, journal format, fsync discipline, phase runner, and recovery scanner.
 *
 * ## Journal home
 *
 * `getDataDir()/txn/<rootNs24>/<transactionId>/journal.json`, namespaced by
 * the sha256 of the resolved root the transaction mutates. Every legacy home
 * (`proposal-transactions/`, `proposal-rejections/`, in-stash
 * `.akm/mv-transactions/`, in-stash `consolidate-journal.json`) collapses
 * onto this one.
 *
 * ## Phase model
 *
 * Each transaction KIND declares its ordered phase vocabulary and a commit
 * point. A journal found at a phase strictly BEFORE the commit point rolls
 * BACK (the batch never happened); at or after it rolls FORWARD (the kind's
 * `finalize` resumes idempotently from the recorded phase). Phase writes are
 * durable: tmp + fsync + rename + parent-dir fsync — the exact discipline
 * every legacy engine used, now in one place.
 *
 * ## Kind handlers
 *
 * Domain logic (what the files are, how to roll back, which DB/index/event
 * steps finalize) stays with the domain: each kind registers a
 * {@link TxnKindHandler}. The engine owns discovery, safety fencing, journal
 * I/O, ordering, and cleanup. Recovery entry points call
 * {@link recoverTxnsForRoot} (after importing the domain registrar so the
 * kinds are registered).
 *
 * ## Quarantine
 *
 * A journal {@link recoverTxnsForRoot} cannot recover — an unreadable
 * `journal.json`, a fence violation, or a `rollback`/`finalize` throw — is
 * moved to `$DATA/txn-quarantine/<rootNs>/<transactionId>/` (see
 * {@link QuarantinedTxn}) rather than aborting the whole scan. A `finalize`
 * throw that is a `TransientError` or SQLite-contention-shaped
 * (`isSqliteContentionError`) is the one exception: it means ordinary
 * `state.db` contention mid-`finalize`, not a broken journal, so it is left
 * in place for a later scan to retry rather than quarantined. Recovery is
 * per-journal: one poisoned or busy journal never blocks the others, and
 * never bricks a later scan against the same root the way a thrown error
 * would.
 *
 * ## Crash-window test seam
 *
 * `_setTxnMutationHookForTests` replaces the per-engine hooks; domain code
 * fires named points through {@link txnMutationHook} exactly where the legacy
 * engines fired theirs, so the subprocess crash runners re-key mechanically.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pkgVersion } from "../version";
import { TransientError } from "./errors";
import type { FileChangeOp } from "./file-change";
import { getDataDir } from "./paths";
import { isSqliteContentionError } from "./state-db";
import { warn, warnOnce } from "./warn";

// ── Journal shapes ───────────────────────────────────────────────────────────

/**
 * Uniform per-file view of one journaled change. `path` is ABSOLUTE (journals
 * are machine-local recovery state, never portable). Hashes are sha256 hex of
 * the expected content; `null` means "must not exist" (beforeHash for a
 * create, afterHash for a delete).
 */
export interface JournaledFileChange {
  path: string;
  op: FileChangeOp;
  beforeHash: string | null;
  afterHash: string | null;
}

export interface TxnJournal<P = unknown> {
  version: 1;
  /** Registered transaction kind (e.g. `proposal`, `proposal-reject`). */
  kind: string;
  phase: string;
  transactionId: string;
  /** Resolved absolute root this transaction mutates (namespace + fence). */
  root: string;
  /** Uniform FileChange view of the batch (may be empty for DB-only kinds). */
  changes: JournaledFileChange[];
  decidedAt: string;
  /** Kind-owned payload — opaque to the engine. */
  payload: P;
}

export interface Txn<P = unknown> {
  journal: TxnJournal<P>;
  journalPath: string;
  dir: string;
}

/**
 * One journal {@link recoverTxnsForRoot} could not recover (a fence
 * violation or a `rollback`/`finalize` throw) and quarantined instead of
 * aborting the scan. `journalPath` is the journal's new location under
 * `$DATA/txn-quarantine/<rootNs>/<transactionId>/journal.json`.
 */
export interface QuarantinedTxn {
  transactionId: string;
  kind: string;
  phase: string;
  journalPath: string;
  reason: string;
}

export interface TxnKindHandler<P = unknown> {
  /** Ordered phase vocabulary; `phases[0]` is the initial (prepared) phase. */
  phases: readonly string[];
  /**
   * First roll-FORWARD phase: a recovered journal at a phase before this one
   * rolls back; at or after it, `finalize` resumes. Must appear in `phases`.
   */
  commitPhase: string;
  /**
   * Kind-specific safety fence run before any recovery action, AFTER the
   * engine's own fences. Throw to refuse the journal.
   */
  validate?(journal: TxnJournal<P>, txnDir: string, root: string): void;
  /** Undo a not-yet-committed batch. Must be idempotent. */
  rollback(txn: Txn<P>): void | Promise<void>;
  /**
   * Complete a committed batch from `journal.phase` onward. Must be
   * idempotent and advance phases via {@link advanceTxn} as steps land,
   * ending at the terminal phase (last entry of `phases`).
   */
  finalize(txn: Txn<P>): void | Promise<void>;
}

// ── Registry ─────────────────────────────────────────────────────────────────

const kinds = new Map<string, TxnKindHandler<never>>();

/**
 * Register (or replace) the handler for a transaction kind. Handlers are
 * stored payload-erased; beginTxn/recovery re-associate `P` via the kind tag.
 */
export function registerTxnKind<P>(kind: string, handler: TxnKindHandler<P>): void {
  kinds.set(kind, handler as TxnKindHandler<never>);
}

function requireKind(kind: string): TxnKindHandler<never> {
  const handler = kinds.get(kind);
  if (!handler) throw new Error(`No transaction handler registered for kind "${kind}".`);
  return handler;
}

/** True when `kind` has a registered handler (see {@link recoverTxnsForRoot}). */
function hasKind(kind: string): boolean {
  return kinds.has(kind);
}

// ── Test seam ────────────────────────────────────────────────────────────────

let mutationHookForTests: ((point: string) => void) | undefined;

/** TEST-ONLY crash-window hook used by subprocess recovery tests. */
export function _setTxnMutationHookForTests(hook?: (point: string) => void): void {
  mutationHookForTests = hook;
}

/** Fire a named crash-window point (no-op outside tests). */
export function txnMutationHook(point: string): void {
  mutationHookForTests?.(point);
}

// ── Durable file I/O primitives (shared fsync discipline) ────────────────────

export function txnHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function txnFileHash(filePath: string): string {
  return txnHash(fs.readFileSync(filePath));
}

export function fsyncTxnFile(filePath: string): void {
  // Open for WRITE. Windows implements fsync as FlushFileBuffers, which
  // requires write access on the handle — a read-only descriptor fails with
  // EACCES/EPERM, so every proposal accept and reject failed on that platform.
  // POSIX accepts "r+" here just as readily as "r".
  const fd = fs.openSync(filePath, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function fsyncTxnDir(dirPath: string): void {
  try {
    // Read-only, unlike {@link fsyncTxnFile}: a directory cannot be opened for
    // write on POSIX (EISDIR), and on Windows this whole operation is
    // unsupported anyway and falls into the catch.
    const fd = fs.openSync(dirPath, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Directory fsync is unavailable on some platforms.
  }
}

/** Durably write `content` to `filePath` (tmp + fsync + rename + dir fsync). */
export function writeTxnFileDurably(filePath: string, content: string | Buffer, mode = 0o600): void {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, content, { mode });
  fsyncTxnFile(tempPath);
  fs.renameSync(tempPath, filePath);
  fsyncTxnDir(path.dirname(filePath));
}

// ── Journal home / discovery ─────────────────────────────────────────────────

/**
 * Canonical spelling of a transaction root: realpath when the root exists
 * (so symlinked spellings — e.g. a stash reached through macOS /tmp — hash
 * to the SAME namespace and bind-compare equal), resolved otherwise.
 */
export function canonicalTxnRoot(root: string): string {
  try {
    return fs.realpathSync(path.resolve(root));
  } catch {
    return path.resolve(root);
  }
}

/** Namespace directory for all transactions mutating `root`. */
export function txnNamespaceDir(root: string): string {
  const ns = txnHash(canonicalTxnRoot(root)).slice(0, 24);
  return path.join(getDataDir(), "txn", ns);
}

/**
 * Quarantine home for `root`'s namespace — the counterpart to
 * {@link txnNamespaceDir} under `$DATA/txn-quarantine` rather than
 * `$DATA/txn`, keyed by the same root-hash segment so both are easy to
 * correlate by eye.
 */
export function txnQuarantineNamespaceDir(root: string): string {
  return path.join(getDataDir(), "txn-quarantine", path.basename(txnNamespaceDir(root)));
}

/** Mint a transaction id ahead of {@link beginTxn} (see its `transactionId`). */
export function mintTxnId(): string {
  return randomUUID();
}

/** The directory a transaction with `transactionId` on `root` will own. */
export function txnDirFor(root: string, transactionId: string): string {
  return path.join(txnNamespaceDir(root), transactionId);
}

function writeJournal(txn: Txn<unknown>): void {
  writeTxnFileDurably(txn.journalPath, `${JSON.stringify(txn.journal, null, 2)}\n`);
}

/** Durably record `phase` on the journal, then mirror it in memory. */
export function advanceTxn(txn: Txn<unknown>, phase: string): void {
  const handler = requireKind(txn.journal.kind);
  if (!handler.phases.includes(phase)) {
    throw new Error(`Unknown phase "${phase}" for transaction kind "${txn.journal.kind}".`);
  }
  const next = { ...txn.journal, phase };
  writeTxnFileDurably(txn.journalPath, `${JSON.stringify(next, null, 2)}\n`);
  txn.journal.phase = phase;
}

/**
 * Open a new transaction: mint the id, create its directory, and durably
 * write the journal at the kind's initial phase. The caller stages sidecar
 * files under `txn.dir` and then applies/finalizes through the kind handler.
 */
export function beginTxn<P>(args: {
  kind: string;
  root: string;
  changes: JournaledFileChange[];
  payload: P;
  decidedAt?: string;
  /**
   * Pre-minted transaction id (defaults to a fresh UUID). Callers whose
   * payload embeds paths under the transaction directory mint the id first
   * (via {@link mintTxnId}) so the initial `prepared` journal is written
   * exactly ONCE with its final contents — crash-window tests intercept the
   * first journal rename per phase. Must be a plain path segment.
   */
  transactionId?: string;
}): Txn<P> {
  const handler = requireKind(args.kind);
  const transactionId = args.transactionId ?? randomUUID();
  if (!/^[A-Za-z0-9._-]+$/.test(transactionId) || transactionId === "." || transactionId === "..") {
    throw new Error(`Invalid transaction id "${transactionId}" — must be a plain path segment.`);
  }
  const dir = path.join(txnNamespaceDir(args.root), transactionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const journal: TxnJournal<P> = {
    version: 1,
    kind: args.kind,
    phase: handler.phases[0]!,
    transactionId,
    root: canonicalTxnRoot(args.root),
    changes: args.changes,
    decidedAt: args.decidedAt ?? new Date().toISOString(),
    payload: args.payload,
  };
  const txn: Txn<P> = { journal, journalPath: path.join(dir, "journal.json"), dir };
  writeJournal(txn);
  return txn;
}

/** Remove a transaction directory (and its namespace dir when empty). */
export function cleanupTxn(dir: string): string | null {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      fs.rmdirSync(path.dirname(dir));
    } catch {
      // Other transactions may still exist in the namespace.
    }
    return null;
  } catch (error) {
    const message = `transaction committed but cleanup failed at ${dir}: ${
      error instanceof Error ? error.message : String(error)
    }`;
    warn(`[txn] ${message}`);
    return message;
  }
}

/**
 * Grace period (ms) before a transaction directory/journal with no other
 * evidence of activity is treated as stale rather than possibly belonging to
 * a still-running operation. Shared by {@link sweepJournallessTxnDir} (racing
 * a sibling's mkdir→journal window, and the unknown-kind sweep in
 * {@link recoverTxnsForRoot}) and by read-only reporting such as `akm
 * health`'s stale-journal advisory (see {@link listTxnJournalsTolerant}).
 */
export const TXN_SWEEP_GRACE_MS = 300_000;

/**
 * Sweep a transaction directory that cannot be recovered — it has NO journal,
 * or (from {@link recoverTxnsForRoot}) a journal whose kind has no registered
 * handler — but only when it is demonstrably stale. All kinds share one
 * namespace per root, so a scanner may encounter a SIBLING transaction inside
 * `beginTxn`'s mkdir→journal window, or one whose registrar this process
 * simply has not imported yet; a grace period keeps the sweep from racing
 * either. Returns true when the directory was removed.
 */
export function sweepJournallessTxnDir(dir: string, graceMs = TXN_SWEEP_GRACE_MS): boolean {
  try {
    const age = Date.now() - fs.statSync(dir).mtimeMs;
    if (age < graceMs) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** True when `candidate` is inside `root` (both resolved). */
export function isWithinTxnRoot(candidate: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function readJournal(journalPath: string): TxnJournal<unknown> {
  let journal: TxnJournal<unknown>;
  try {
    journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as TxnJournal<unknown>;
  } catch (error) {
    throw new Error(
      `Cannot read transaction journal at ${journalPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (journal.version !== 1 || typeof journal.kind !== "string" || typeof journal.phase !== "string") {
    throw new Error(`Refusing unsafe transaction journal at ${journalPath}.`);
  }
  return journal;
}

/**
 * Move a transaction directory that {@link recoverTxnsForRoot} could not
 * recover to `$DATA/txn-quarantine/<rootNs>/<transactionId>/`, with a
 * `reason.json` beside the untouched `journal.json`. Nothing is deleted —
 * a human or a later release can inspect or restore it.
 */
function quarantineTxnDir(
  dir: string,
  root: string,
  journal: TxnJournal<unknown> | undefined,
  reason: string,
): QuarantinedTxn {
  const transactionId = journal?.transactionId ?? path.basename(dir);
  const quarantineDir = path.join(txnQuarantineNamespaceDir(root), transactionId);
  fs.mkdirSync(path.dirname(quarantineDir), { recursive: true, mode: 0o700 });
  fs.renameSync(dir, quarantineDir);
  const journalPath = path.join(quarantineDir, "journal.json");
  const reasonPayload = { reason, version: pkgVersion, quarantinedAt: new Date().toISOString() };
  writeTxnFileDurably(path.join(quarantineDir, "reason.json"), `${JSON.stringify(reasonPayload, null, 2)}\n`);
  warnOnce(
    `txn-quarantine:${transactionId}`,
    `[txn] quarantined transaction journal ${transactionId} (${reason}) at ${journalPath}`,
  );
  return { transactionId, kind: journal?.kind ?? "unknown", phase: journal?.phase ?? "unknown", journalPath, reason };
}

/**
 * {@link quarantineTxnDir}, but a failure of the quarantine move itself
 * (a failed rename, a `reason.json` write error) warns and leaves the
 * journal where it is instead of escaping {@link recoverTxnsForRoot}'s scan
 * — the one thing worse than a journal recovery can't resolve is a scan that
 * a quarantine attempt can't resolve either.
 */
function quarantineTxnDirSafely(
  dir: string,
  root: string,
  journal: TxnJournal<unknown> | undefined,
  reason: string,
): QuarantinedTxn | undefined {
  try {
    return quarantineTxnDir(dir, root, journal, reason);
  } catch (error) {
    warn(
      `[txn] failed to quarantine transaction journal at ${dir} (${reason}); leaving it in place: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

/** Engine-level safety fences shared by every kind. */
function fenceJournal(journal: TxnJournal<unknown>, txnDir: string, root: string, journalPath: string): void {
  if (canonicalTxnRoot(journal.root) !== canonicalTxnRoot(root)) {
    throw new Error(`Refusing transaction journal bound to a different root at ${journalPath}.`);
  }
  const handler = requireKind(journal.kind);
  if (!handler.phases.includes(journal.phase)) {
    throw new Error(`Refusing transaction journal with unknown phase "${journal.phase}" at ${journalPath}.`);
  }
  for (const change of journal.changes) {
    if (typeof change.path !== "string" || !isWithinTxnRoot(change.path, root)) {
      throw new Error(`Refusing transaction journal touching paths outside its root at ${journalPath}.`);
    }
  }
  handler.validate?.(journal as TxnJournal<never>, txnDir, root);
}

/**
 * Read-only probe: would {@link recoverTxnsForRoot} quarantine `journal` on
 * its fence check, without running the kind's `rollback`/`finalize` (which
 * this never invokes)? Fence checks are pure validation — root binding,
 * phase membership, path containment, and the kind's own `validate` — so
 * this is safe to call from a status/`--dry-run` path. Returns the failure
 * reason, or `undefined` if the fence would pass (a fence pass does not mean
 * recovery would succeed: `rollback`/`finalize` can still fail, and that is
 * only detectable by actually running recovery). A journal whose kind has no
 * registered handler returns `undefined` too — {@link recoverTxnsForRoot}
 * sweeps those rather than quarantining them.
 */
export function probeJournalFence(journal: TxnJournal<unknown>, root: string): string | undefined {
  if (!hasKind(journal.kind)) return undefined;
  const dir = txnDirFor(root, journal.transactionId);
  const journalPath = path.join(dir, "journal.json");
  try {
    fenceJournal(journal, dir, root, journalPath);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** True when `journal.phase` is at or after the kind's commit point. */
export function isCommittedPhase(journal: TxnJournal<unknown>): boolean {
  const handler = requireKind(journal.kind);
  return handler.phases.indexOf(journal.phase) >= handler.phases.indexOf(handler.commitPhase);
}

/**
 * Recover every interrupted transaction under `root`'s namespace: journals
 * before their kind's commit point roll BACK; the rest roll FORWARD through
 * the kind's `finalize`. Fully-finalized directories are swept. The domain
 * registrar (which registers the kinds) must be imported by the caller.
 *
 * A journal whose `kind` has NO registered handler is SWEPT (same stale-dir
 * grace period as {@link sweepJournallessTxnDir}) rather than thrown on. A
 * kind can disappear for good — 0.9.0 deleted `akm mv` and with it the
 * `kind:"mv"` handler — and an unrecoverable leftover journal must never
 * brick every later recovery scan (index refresh, proposal accept/reject) run
 * against the same root. The grace period also covers the transient case
 * where the caller has not imported a live kind's registrar yet.
 *
 * An unreadable or unparseable `journal.json` (torn write, or `readJournal`'s
 * own version/kind/phase refusal) is QUARANTINED with `journal` left
 * `undefined` — {@link quarantineTxnDir} already falls back to the directory
 * name and `"unknown"` for exactly this case — rather than thrown, so one
 * damaged journal never aborts the scan before its siblings are reached.
 *
 * A journal of a REGISTERED kind whose fence check or `rollback`/`finalize`
 * throws is QUARANTINED (moved to `$DATA/txn-quarantine/<rootNs>/<id>/`, see
 * {@link QuarantinedTxn}) and the scan continues with the next journal — with
 * one exception: a `TransientError` (`src/core/errors.ts`) or a
 * SQLite-contention-shaped error (`isSqliteContentionError`,
 * `src/core/state-db.ts`) means the journal is at or past its commit point
 * with `finalize` mid-flight against a busy `state.db`, not broken. That
 * journal is left exactly where it is — not quarantined, not counted as
 * recovered — for a later scan to retry once the contention clears. A
 * failure of the quarantine move itself (see
 * {@link quarantineTxnDirSafely}) warns and also leaves the journal in
 * place rather than escaping the scan. One poisoned or busy journal must
 * never block recovery of every OTHER journal in the same namespace, or
 * brick every later scan against the same root the way a thrown error
 * would.
 *
 * `filter` optionally narrows recovery (e.g. one kind, one proposal id). The
 * unknown-kind sweep runs BEFORE the filter: such a journal is garbage no
 * matter what the caller asked to recover, and leaving it behind is what
 * bricks the next scan.
 */
export async function recoverTxnsForRoot(
  root: string,
  filter?: (journal: TxnJournal<unknown>) => boolean,
): Promise<{ recovered: TxnJournal<unknown>[]; quarantined: QuarantinedTxn[] }> {
  const nsDir = txnNamespaceDir(root);
  const recovered: TxnJournal<unknown>[] = [];
  const quarantined: QuarantinedTxn[] = [];
  if (!fs.existsSync(nsDir)) return { recovered, quarantined };
  for (const entry of fs.readdirSync(nsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(nsDir, entry.name);
    const journalPath = path.join(dir, "journal.json");
    if (!fs.existsSync(journalPath)) {
      sweepJournallessTxnDir(dir);
      continue;
    }
    let journal: TxnJournal<unknown>;
    try {
      journal = readJournal(journalPath);
    } catch (error) {
      const q = quarantineTxnDirSafely(dir, root, undefined, error instanceof Error ? error.message : String(error));
      if (q) quarantined.push(q);
      continue;
    }
    if (!hasKind(journal.kind)) {
      if (sweepJournallessTxnDir(dir)) {
        warn(`[txn] swept unrecoverable journal of unregistered kind "${journal.kind}" at ${journalPath}.`);
      }
      continue;
    }
    if (filter && !filter(journal)) continue;
    try {
      fenceJournal(journal, dir, root, journalPath);
      const handler = requireKind(journal.kind);
      const txn: Txn<unknown> = { journal, journalPath, dir };
      const terminal = handler.phases[handler.phases.length - 1];
      if (!isCommittedPhase(journal)) {
        await handler.rollback(txn as Txn<never>);
      } else if (journal.phase !== terminal) {
        await handler.finalize(txn as Txn<never>);
      }
      recovered.push(journal);
      cleanupTxn(dir);
    } catch (error) {
      if (error instanceof TransientError || isSqliteContentionError(error)) {
        warnOnce(
          `txn-transient:${journal.transactionId}`,
          `[txn] leaving transaction journal ${journal.transactionId} in place after a transient error (${
            error instanceof Error ? error.message : String(error)
          }); a later 'akm migrate apply' retries it.`,
        );
        continue;
      }
      const q = quarantineTxnDirSafely(dir, root, journal, error instanceof Error ? error.message : String(error));
      if (q) quarantined.push(q);
    }
  }
  return { recovered, quarantined };
}

/**
 * Enumerate (without recovering) every journal across ALL namespaces that
 * matches `predicate`. Used by stash-scoped recovery entry points that don't
 * know which roots their interrupted transactions were bound to.
 */
export function listTxnJournals(predicate: (journal: TxnJournal<unknown>) => boolean): TxnJournal<unknown>[] {
  const home = path.join(getDataDir(), "txn");
  const matches: TxnJournal<unknown>[] = [];
  if (!fs.existsSync(home)) return matches;
  for (const ns of fs.readdirSync(home, { withFileTypes: true })) {
    if (!ns.isDirectory()) continue;
    const nsDir = path.join(home, ns.name);
    for (const entry of fs.readdirSync(nsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const journalPath = path.join(nsDir, entry.name, "journal.json");
      if (!fs.existsSync(journalPath)) continue;
      // Unreadable/invalid journals fail LOUDLY: a caller deciding what to
      // recover must never silently overlook a damaged journal (it may fence
      // an interrupted, irreversible mutation).
      const journal = readJournal(journalPath);
      if (predicate(journal)) matches.push(journal);
    }
  }
  return matches;
}

/** One journal matched by {@link listTxnJournalsTolerant}, plus its file mtime. */
export interface TxnJournalScanEntry {
  journal: TxnJournal<unknown>;
  /** `journal.json` mtime (ms since epoch) — an age proxy independent of parsing. */
  mtimeMs: number;
}

export interface TxnJournalScanResult {
  matches: TxnJournalScanEntry[];
  /** `journal.json` mtimes for files that could not be read/parsed. */
  unreadableMtimes: number[];
}

/**
 * Read-only, best-effort sibling of {@link listTxnJournals} for reporting
 * (e.g. `akm health`'s stale-journal advisory): a corrupt `journal.json` is
 * counted rather than thrown, so one damaged journal doesn't abort the whole
 * scan. Recovery call sites (which must decide how to roll a journal forward
 * or back) keep using {@link listTxnJournals} — it fails loudly on purpose,
 * since silently skipping a damaged journal there could leave an interrupted,
 * irreversible mutation unrecovered.
 */
export function listTxnJournalsTolerant(predicate: (journal: TxnJournal<unknown>) => boolean): TxnJournalScanResult {
  const home = path.join(getDataDir(), "txn");
  const matches: TxnJournalScanEntry[] = [];
  const unreadableMtimes: number[] = [];
  if (!fs.existsSync(home)) return { matches, unreadableMtimes };
  for (const ns of fs.readdirSync(home, { withFileTypes: true })) {
    if (!ns.isDirectory()) continue;
    const nsDir = path.join(home, ns.name);
    for (const entry of fs.readdirSync(nsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const journalPath = path.join(nsDir, entry.name, "journal.json");
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(journalPath).mtimeMs;
      } catch {
        continue; // no journal.json here, or it vanished mid-scan
      }
      try {
        const journal = readJournal(journalPath);
        if (predicate(journal)) matches.push({ journal, mtimeMs });
      } catch {
        unreadableMtimes.push(mtimeMs);
      }
    }
  }
  return { matches, unreadableMtimes };
}
