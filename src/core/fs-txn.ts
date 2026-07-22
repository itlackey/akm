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
 * ## Crash-window test seam
 *
 * `_setTxnMutationHookForTests` replaces the per-engine hooks; domain code
 * fires named points through {@link txnMutationHook} exactly where the legacy
 * engines fired theirs, so the subprocess crash runners re-key mechanically.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FileChangeOp } from "./file-change";
import { getDataDir } from "./paths";
import { warn } from "./warn";

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
  /** Registered transaction kind (e.g. `proposal-accept`, `mv`). */
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
  const fd = fs.openSync(filePath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function fsyncTxnDir(dirPath: string): void {
  try {
    fsyncTxnFile(dirPath);
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
 * Sweep a transaction directory that has NO journal — but only when it is
 * demonstrably stale. All kinds share one namespace per root, so a scanner
 * may encounter a SIBLING transaction inside `beginTxn`'s mkdir→journal
 * window; a grace period keeps the sweep from racing it. Returns true when
 * the directory was removed.
 */
export function sweepJournallessTxnDir(dir: string, graceMs = 300_000): boolean {
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
 * `filter` optionally narrows recovery (e.g. one kind, one proposal id).
 */
export async function recoverTxnsForRoot(
  root: string,
  filter?: (journal: TxnJournal<unknown>) => boolean,
): Promise<TxnJournal<unknown>[]> {
  const nsDir = txnNamespaceDir(root);
  const recovered: TxnJournal<unknown>[] = [];
  if (!fs.existsSync(nsDir)) return recovered;
  for (const entry of fs.readdirSync(nsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(nsDir, entry.name);
    const journalPath = path.join(dir, "journal.json");
    if (!fs.existsSync(journalPath)) {
      sweepJournallessTxnDir(dir);
      continue;
    }
    const journal = readJournal(journalPath);
    if (filter && !filter(journal)) continue;
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
  }
  return recovered;
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
