// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `txn-quarantine` and `txn-awaiting-recovery` advisories for `akm health`.
 *
 * A poisoned transaction journal `akm migrate apply` cannot recover (an
 * unreadable `journal.json` or a fence violation) is quarantined rather than
 * bricking recovery — moved to `$DATA/txn-quarantine/<rootNs>/<id>/` with a
 * `reason.json` beside it (see `src/core/fs-txn.ts`'s
 * `recoverTxnsForRoot`/`QuarantinedTxn`). Quarantine is silent by design
 * (`akm migrate apply` still reports `current`); `collectTxnQuarantineAdvisory`
 * is what surfaces a non-empty quarantine dir to an operator who isn't
 * reading migrate's own output.
 *
 * A trusted, fenced journal whose `rollback`/`finalize` threw is DEFERRED
 * instead — left in place under `$DATA/txn/<rootNs>/<id>/` for a later scan,
 * or an operation on the entity it belongs to, to retry (see
 * `recoverTxnsForRoot`/`DeferredTxn`). That is also silent by design, so
 * `collectTxnAwaitingRecoveryAdvisory` reports a journal that has been
 * sitting there past a grace period — it is not "always show a pass line".
 *
 * Both are best-effort and read-only, matching the data-dir-usage/
 * stash-exposure house pattern: `undefined` whenever there is nothing to
 * report.
 */

import fs from "node:fs";
import path from "node:path";
import type { HealthCheckResult } from "./types";

/** Transaction kinds registered by `src/commands/proposal/repository.ts`. */
const PROPOSAL_TXN_KINDS = new Set(["proposal", "proposal-reject"]);

/** A journal awaiting recovery younger than this is still a normal in-flight operation, not stuck. */
const AWAITING_RECOVERY_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Build the `txn-quarantine` advisory, or `undefined` when `$DATA/txn-quarantine`
 * is missing/unreadable/empty. `dataDir` is the caller-resolved `getDataDir()`
 * path — this module never resolves paths or reads env itself.
 */
export function collectTxnQuarantineAdvisory(dataDir: string): HealthCheckResult | undefined {
  const quarantineDir = path.join(dataDir, "txn-quarantine");
  let namespaces: fs.Dirent[];
  try {
    namespaces = fs.readdirSync(quarantineDir, { withFileTypes: true });
  } catch {
    return undefined; // no quarantine dir yet — nothing to report.
  }

  let count = 0;
  for (const ns of namespaces) {
    if (!ns.isDirectory()) continue;
    try {
      count += fs
        .readdirSync(path.join(quarantineDir, ns.name), { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).length;
    } catch {
      // Unreadable namespace dir — best-effort, skip it.
    }
  }
  if (count === 0) return undefined;

  return {
    name: "txn-quarantine",
    kind: "deterministic",
    status: "warn",
    confidence: "high",
    message:
      `${count} transaction journal(s) quarantined at ${quarantineDir}. ` +
      "Each journal's reason.json names why; nothing was deleted.",
    evidence: { quarantineDir, count },
  };
}

/**
 * Build the `txn-awaiting-recovery` advisory, or `undefined` when
 * `$DATA/txn` holds no journal older than {@link AWAITING_RECOVERY_MIN_AGE_MS}.
 * A journal this old under `$DATA/txn/<rootNs>/<id>/` (not
 * `txn-quarantine/`) is a DEFERRED recovery action, not a fresh in-flight
 * operation — see `src/core/fs-txn.ts`'s `recoverTxnsForRoot`/`DeferredTxn`.
 * `dataDir` is the caller-resolved `getDataDir()` path; `now` defaults to
 * the real clock and is injectable for tests.
 */
export function collectTxnAwaitingRecoveryAdvisory(
  dataDir: string,
  now: number = Date.now(),
): HealthCheckResult | undefined {
  const txnDir = path.join(dataDir, "txn");
  let namespaces: fs.Dirent[];
  try {
    namespaces = fs.readdirSync(txnDir, { withFileTypes: true });
  } catch {
    return undefined; // no txn dir yet — nothing to report.
  }

  const stale: { transactionId: string; proposalId?: string }[] = [];
  for (const ns of namespaces) {
    if (!ns.isDirectory()) continue;
    const nsDir = path.join(txnDir, ns.name);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(nsDir, { withFileTypes: true });
    } catch {
      continue; // Unreadable namespace dir — best-effort, skip it.
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const journalPath = path.join(nsDir, entry.name, "journal.json");
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(journalPath).mtimeMs;
      } catch {
        continue; // no journal.json here (a fresh, journal-less transaction dir)
      }
      if (now - mtimeMs < AWAITING_RECOVERY_MIN_AGE_MS) continue;
      try {
        const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
          transactionId?: unknown;
          kind?: unknown;
          payload?: { proposalId?: unknown };
        };
        const transactionId = typeof journal.transactionId === "string" ? journal.transactionId : entry.name;
        const kind = typeof journal.kind === "string" ? journal.kind : undefined;
        const proposalId =
          kind !== undefined && PROPOSAL_TXN_KINDS.has(kind) && typeof journal.payload?.proposalId === "string"
            ? journal.payload.proposalId
            : undefined;
        stale.push(proposalId !== undefined ? { transactionId, proposalId } : { transactionId });
      } catch {
        // Unreadable journal — the quarantine advisory covers this case.
      }
    }
  }
  if (stale.length === 0) return undefined;

  const named = stale.map((entry) =>
    entry.proposalId !== undefined ? `${entry.transactionId} (proposal ${entry.proposalId})` : entry.transactionId,
  );
  const hasProposal = stale.some((entry) => entry.proposalId !== undefined);
  const action = hasProposal
    ? "For a named proposal, run `akm proposal show <id>` then accept, reject or revert it; `akm migrate status` lists every stuck journal."
    : "`akm migrate status` lists every stuck journal.";

  return {
    name: "txn-awaiting-recovery",
    kind: "deterministic",
    status: "warn",
    confidence: "high",
    message: `${stale.length} transaction journal(s) still awaiting recovery at ${txnDir}: ${named.join(", ")}. ${action}`,
    evidence: { txnDir, count: stale.length, transactionIds: stale.map((entry) => entry.transactionId) },
  };
}
