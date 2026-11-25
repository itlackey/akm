// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Session planning for `akm extract`: the per-session lock, the zero-LLM
 * gates (content-hash skip, size floor, triage score) and the read-only
 * classification of candidates into skipped and model sessions.
 */

import fs from "node:fs";
import path from "node:path";
import {
  createLockPayload,
  type LockOwnership,
  probeLock,
  reclaimStaleLock,
  tryAcquireLockSync,
} from "../../core/file-lock";
import type { ExtractedSessionResult } from "../../core/improve-types";
import { getStateDbPath } from "../../core/state-db";
import { preFilterSession } from "../../integrations/session-logs/pre-filter";
import type { SessionData, SessionLogHarness, SessionRef, SessionSummary } from "../../integrations/session-logs/types";
import {
  type ExtractedSessionRow,
  shouldSkipAlreadyExtractedSession,
} from "../../storage/repositories/extract-sessions-repository";
import { contentHash } from "./content-hash";
import type { AkmExtractOptions } from "./extract";

export function extractSessionLockPath(harness: string, sessionId: string, stateDbPath: string): string {
  const safe = `${harness}-${sessionId}`.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(path.dirname(stateDbPath), "extract-locks", `extract-${safe}.lock`);
}

function extractSessionLockIsUnavailable(harness: string, sessionId: string, stateDbPath: string): boolean {
  const probe = probeLock(extractSessionLockPath(harness, sessionId, stateDbPath));
  return probe.state === "held" || probe.state === "inaccessible";
}

/**
 * Claim a session so a concurrent extract (a session-end hook racing the
 * hourly improve run) cannot process it twice. Only a lock whose holder is
 * dead is reclaimed (no age window: a live extraction can run for many
 * minutes, the #872 lesson in `core/run-lock.ts`); a
 * filesystem error proceeds, so locking never blocks extraction outright.
 */
export function acquireExtractSessionLock(lockPath: string): { proceed: boolean; ownership?: LockOwnership } {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    let ownership = tryAcquireLockSync(lockPath, createLockPayload());
    if (ownership) return { proceed: true, ownership };
    const probe = probeLock(lockPath);
    if (probe.state === "held") return { proceed: false };
    if (probe.state === "stale" && !reclaimStaleLock(lockPath, probe)) return { proceed: false };
    ownership = tryAcquireLockSync(lockPath, createLockPayload());
    return ownership ? { proceed: true, ownership } : { proceed: false };
  } catch {
    return { proceed: true };
  }
}

/**
 * A session result before the run's engine is stamped on it. `failedCauses` holds the causes of writes the
 * validator did not refuse; the run sums them into `writeFailures` and does not return them per session (#1290).
 */
export type ExtractSessionOutcome = Omit<ExtractedSessionResult, "engine"> & { failedCauses?: string[] };
type PreFilterStats = ExtractedSessionResult["preFilter"];

const NO_PREFILTER: PreFilterStats = { inputCount: 0, outputCount: 0, truncatedCount: 0 };

export function sessionOutcome(
  sessionId: string,
  harness: string,
  fields: Partial<ExtractSessionOutcome>,
): ExtractSessionOutcome {
  return { sessionId, harness, candidateCount: 0, proposalIds: [], preFilter: NO_PREFILTER, warnings: [], ...fields };
}

export function preFilterStats(filtered: ReturnType<typeof preFilterSession>): PreFilterStats {
  const { inputCount, outputCount, truncatedCount } = filtered.stats;
  return { inputCount, outputCount, truncatedCount };
}

/**
 * The skip authority for "already extracted": a hash of the raw event stream
 * (`role\ntext` per event, NUL-separated so boundaries cannot be forged). It
 * excludes titles, timestamps and inline refs, and ignores pre-filter config.
 */
export function hashSessionContent(data: SessionData): string {
  return contentHash(data.events.map((e) => `${e.role ?? "unknown"}\n${e.text}`).join("\n\0\n"));
}

// ── Session triage (heuristic, zero LLM cost, default off) ───────────────────

export const DEFAULT_TRIAGE_MIN_SCORE = 2;
const TRIAGE_MARKER_RE =
  /\b(error|failed|fix(?:ed)?|root cause|turns out|because|decided|instead|gotcha|workaround|regress(?:ed)?|broke|TIL)\b/i;
const TRIAGE_EDIT_COMMIT_RE = /\b(Edit|Write|MultiEdit|git commit|diff)\b/i;

/**
 * Score a session for extraction worth: learning markers (capped 2), tool
 * density, edits/commits, and the substantive assistant/tool share.
 */
function sessionTriagePasses(data: SessionData, minScore: number): boolean {
  const events = data.events;
  const count = (predicate: (e: SessionData["events"][number]) => boolean) => events.filter(predicate).length;
  const markers = Math.min(
    count((e) => TRIAGE_MARKER_RE.test(e.text)),
    2,
  );
  const toolDensity = Math.min(count((e) => e.role === "tool") * 0.25, 1.5);
  const editCommit = Math.min(count((e) => Boolean(e.filePath) || TRIAGE_EDIT_COMMIT_RE.test(e.text)) * 0.25, 1.5);
  const substantive = count((e) => (e.role === "assistant" || e.role === "tool") && e.text.length >= 40);
  const substantiveRatio = Math.min(events.length > 0 ? substantive / events.length : 0, 1);
  return markers + toolDensity + editCommit + substantiveRatio >= minScore;
}

export type Triage = { enabled: boolean; minScore: number };

// ── Planning ─────────────────────────────────────────────────────────────────

export interface SessionGateOptions {
  maxTotalChars: number | undefined;
  minContentChars: number;
  triage: Triage;
}

/**
 * The zero-LLM gates for one session: read, the content-hash skip (only
 * `--force` overrides it, even for `--session-id`), the raw-size floor and the
 * triage score. Returns a skip, or what the prompt needs.
 */
export async function runPreLlmSessionGates(
  harness: SessionLogHarness,
  sessionRef: SessionRef,
  prior: ExtractedSessionRow | undefined,
  force: boolean,
  gates: SessionGateOptions,
): Promise<
  | { skip: ExtractSessionOutcome }
  | { data: SessionData; filtered: ReturnType<typeof preFilterSession>; contentHash: string }
> {
  const { sessionId } = sessionRef;
  let data: SessionData;
  try {
    data = await harness.readSession(sessionRef);
  } catch (err) {
    return {
      skip: sessionOutcome(sessionId, harness.name, {
        warnings: [`readSession failed: ${err instanceof Error ? err.message : String(err)}`],
        skipped: true,
        skipReason: "read_failed",
      }),
    };
  }
  const hash = hashSessionContent(data);
  if (!force && shouldSkipAlreadyExtractedSession(prior, hash)) {
    return {
      skip: sessionOutcome(sessionId, harness.name, {
        warnings: [`already extracted (content unchanged) at ${prior?.processed_at}; pass --force to re-process`],
        skipped: true,
        skipReason: "already_extracted",
        contentHash: hash,
      }),
    };
  }
  // The prompt sees only parent-origin events; subagent work still reaches
  // the hash above and the inline-ref harvest.
  const filtered = preFilterSession(
    { ...data, events: data.events.filter((e) => e.filePath === data.ref.filePath) },
    typeof gates.maxTotalChars === "number" ? { maxTotalChars: gates.maxTotalChars } : {},
  );
  // Measured on the full raw stream: pre-filtered size says little about value.
  const rawChars = data.events.reduce((sum, event) => sum + event.text.length, 0);
  const skipReason =
    gates.minContentChars > 0 && rawChars < gates.minContentChars
      ? "too_short"
      : gates.triage.enabled && !sessionTriagePasses(data, gates.triage.minScore)
        ? "triaged_out"
        : undefined;
  if (skipReason) {
    return {
      skip: sessionOutcome(sessionId, harness.name, {
        preFilter: preFilterStats(filtered),
        skipped: true,
        skipReason,
        contentHash: hash,
      }),
    };
  }
  return { data, filtered, contentHash: hash };
}

export type ExtractEligibleGate = Exclude<
  Awaited<ReturnType<typeof runPreLlmSessionGates>>,
  { skip: ExtractSessionOutcome }
>;

export type ExtractSessionPlan =
  | { kind: "skip"; summary: SessionSummary; result: ExtractSessionOutcome }
  | { kind: "model"; summary: SessionSummary; gate: ExtractEligibleGate };

export function lockedConcurrentResult(harness: string, summary: SessionSummary): ExtractSessionOutcome {
  return sessionOutcome(summary.sessionId, harness, {
    warnings: ["concurrent extract holds this session's lock — skipped (handled by the other run)"],
    skipped: true,
    skipReason: "locked_concurrent",
  });
}

/**
 * Classify candidates read-only, up to `maxSessionsPerRun` model sessions
 * (explicit `--session-id` and `--force` are uncapped); the rest are deferred.
 */
export async function planExtractSessions(args: {
  candidates: SessionSummary[];
  options: AkmExtractOptions;
  harness: SessionLogHarness;
  seenMap: Map<string, ExtractedSessionRow>;
  gates: SessionGateOptions;
  maxSessionsPerRun: number;
  locking: boolean;
}): Promise<{ plans: ExtractSessionPlan[]; deferredCandidates: SessionSummary[] }> {
  const { candidates, options, harness, maxSessionsPerRun, locking } = args;
  const lockUnavailable = (summary: SessionSummary) =>
    locking &&
    extractSessionLockIsUnavailable(harness.name, summary.sessionId, options.stateDbPath ?? getStateDbPath());
  const plans: ExtractSessionPlan[] = [];
  let modelCount = 0;
  for (let index = 0; index < candidates.length; index++) {
    const capped = !options.sessionId && !options.force && maxSessionsPerRun > 0 && modelCount >= maxSessionsPerRun;
    if (options.signal?.aborted || capped) return { plans, deferredCandidates: candidates.slice(index) };
    const summary = candidates[index];
    if (!summary) continue;
    if (lockUnavailable(summary)) {
      plans.push({ kind: "skip", summary, result: lockedConcurrentResult(harness.name, summary) });
      continue;
    }
    const prior = args.seenMap.get(summary.sessionId);
    const gate = await runPreLlmSessionGates(harness, summary, prior, options.force === true, args.gates);
    if ("skip" in gate) {
      plans.push({ kind: "skip", summary, result: gate.skip });
      continue;
    }
    // Classifying can take long enough for a session-end hook to claim the lock.
    if (lockUnavailable(summary)) {
      plans.push({ kind: "skip", summary, result: lockedConcurrentResult(harness.name, summary) });
      continue;
    }
    plans.push({ kind: "model", summary, gate });
    modelCount += 1;
  }
  return { plans, deferredCandidates: [] };
}
