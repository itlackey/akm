// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `RunContext` — the shared, run-scoped carrier for the three improve verbs
 * (revise = reflect, learn = extract/distill/inference, consolidate = the
 * memory-tier ops; D17). WI-7.5–7.8 decompose the improve god-functions into
 * named passes that thread a `RunContext` instead of long positional argument
 * lists.
 *
 * ## The D6 read-once seam
 *
 * `readAsset` is a memoizing file-read seam whose memo is **NEVER run-wide**
 * (D6 / top-risk #7: a run-wide memo would serve prep-time bytes after a mid-run
 * write). The guarantee is structural here, not merely conventional:
 *
 *   - The **base** context returned by {@link createRunContext} has NO active
 *     memo. `readAsset` on it always reads through to disk, so it can never go
 *     stale — the safe default.
 *   - {@link RunContext.withFreshAssetMemo} mints a sibling context that shares
 *     every run-scoped carrier but owns a FRESH, empty memo. Memoization is
 *     therefore opt-in per scope:
 *       * prep's stage-body passes share ONE memo, forked only AFTER the
 *         mutating pre-loop passes have written their ops to disk, then
 *         discarded at stage end;
 *       * reflect and distill each fork their own memo per verb invocation, so
 *         their reads still happen at invoke time (not prep time).
 *   - Within a memo scope, {@link RunContext.writeAsset} writes through to disk
 *     AND refreshes the memo, and {@link RunContext.noteAssetWrite} drops a memo
 *     entry for a path written out-of-band, so a subsequent `readAsset` of the
 *     same path returns POST-write bytes (e.g. the distill in-loop salience
 *     stamp at `distill.ts:816`).
 *
 * The contract is pinned by `tests/commands/improve/run-context.test.ts`.
 *
 * This module deliberately mints only the carrier + seam. Adoption at the verb
 * call sites lands in WI-7.5 (reflect/distill), WI-7.6 (preparation), and
 * WI-7.7 (akmImprove/extract). It does NOT change `EventsContext` shape and does
 * NOT thread a db handle into `ProposalsContext` (D14).
 */

import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../../core/config/config";
import type { LlmConnectionConfig } from "../../core/config/config-types";
import type { EventsContext } from "../../core/events";
import { chatCompletion } from "../../llm/client";
import type { ProposalsContext } from "../proposal/repository";

/** The chat-completion seam shape shared by every improve LLM caller. */
export type RunContextChatFn = typeof chatCompletion;

/**
 * File read/write seams. Injected only by tests; production uses `fs`. Kept off
 * the {@link RunContext} surface so callers see a single `readAsset` seam, not
 * two levels of indirection.
 */
export interface AssetIoSeams {
  /** Read a file's UTF-8 content. Defaults to `fs.readFileSync(path, "utf8")`. */
  readFile?: (filePath: string) => string;
  /** Write a file's UTF-8 content. Defaults to `fs.writeFileSync(path, content, "utf8")`. */
  writeFile?: (filePath: string, content: string) => void;
}

export interface RunContext {
  /** Loaded, resolved AKM config for this run. */
  readonly config: AkmConfig;
  /**
   * Events context carrying the long-lived state.db handle (`eventsCtx.db`) so
   * hot-path `appendEvent` calls skip the per-event open/close. Shape is frozen
   * (D14/R25) — `loop-stages.ts` dereferences `eventsCtx.db` directly.
   */
  readonly eventsCtx: EventsContext;
  /** Proposals clock/id/dbPath seam. No db handle is threaded in (D14). */
  readonly proposalsCtx: ProposalsContext;
  /** The chat-completion seam (test-injectable via structured-call late binding). */
  readonly chat: RunContextChatFn;
  /** Resolve the run's LLM connection config lazily (null when unconfigured). */
  readonly getLlmConfig: () => LlmConnectionConfig | null;
  /** Stable run id stamped onto automated proposals + events (PROV-DM). */
  readonly sourceRun: string;
  /** When true, mutating side effects are suppressed. */
  readonly dryRun: boolean;
  /** Cooperative-cancellation signal for the run (watchdog / SIGTERM). */
  readonly signal?: AbortSignal;
  /** Clock seam — ms since epoch. Defaults to `Date.now`. */
  readonly now: () => number;

  /**
   * Read a file's UTF-8 content. On the base context this always reads through
   * to disk; on a {@link withFreshAssetMemo} scope it memoizes within that scope
   * (D6 rule i). Read errors propagate (nothing is memoized on failure).
   */
  readAsset(filePath: string): string;
  /**
   * Write a file's UTF-8 content, then — within a memo scope — refresh the memo
   * so a later {@link readAsset} of the same path returns the written bytes
   * (D6 rule ii). Outside a memo scope this is a plain write-through.
   */
  writeAsset(filePath: string, content: string): void;
  /**
   * Drop the memo entry for a path written out-of-band, so the next
   * {@link readAsset} re-reads from disk (D6 rule ii). No-op outside a memo scope.
   */
  noteAssetWrite(filePath: string): void;

  /**
   * Mint a sibling `RunContext` sharing every run-scoped carrier (by reference)
   * but owning a FRESH, empty asset memo. Call this at each verb invocation and
   * once per prep stage region — never reuse a memo across those boundaries
   * (D6 rules i + iii).
   */
  withFreshAssetMemo(): RunContext;
}

/** Constructor input for {@link createRunContext}. */
export interface RunContextInit {
  config: AkmConfig;
  eventsCtx: EventsContext;
  proposalsCtx: ProposalsContext;
  /** Defaults to the real {@link chatCompletion}. */
  chat?: RunContextChatFn;
  getLlmConfig: () => LlmConnectionConfig | null;
  sourceRun: string;
  dryRun: boolean;
  signal?: AbortSignal;
  /** Defaults to `Date.now`. */
  now?: () => number;
  /** Test-only file IO seams. Production omits this and uses `fs`. */
  io?: AssetIoSeams;
}

/** The run-scoped carriers shared by every sibling context minted from one run. */
interface RunContextCarriers {
  config: AkmConfig;
  eventsCtx: EventsContext;
  proposalsCtx: ProposalsContext;
  chat: RunContextChatFn;
  getLlmConfig: () => LlmConnectionConfig | null;
  sourceRun: string;
  dryRun: boolean;
  signal?: AbortSignal;
  now: () => number;
  readFile: (filePath: string) => string;
  writeFile: (filePath: string, content: string) => void;
}

/**
 * Build a `RunContext` over the given carriers with the supplied memo (or `null`
 * for the non-memoizing base context). Kept private so the only way to obtain a
 * memoizing context is {@link RunContext.withFreshAssetMemo}.
 */
function buildRunContext(carriers: RunContextCarriers, memo: Map<string, string> | null): RunContext {
  const memoKey = (filePath: string): string => path.resolve(filePath);
  return {
    config: carriers.config,
    eventsCtx: carriers.eventsCtx,
    proposalsCtx: carriers.proposalsCtx,
    chat: carriers.chat,
    getLlmConfig: carriers.getLlmConfig,
    sourceRun: carriers.sourceRun,
    dryRun: carriers.dryRun,
    signal: carriers.signal,
    now: carriers.now,
    readAsset(filePath: string): string {
      if (!memo) return carriers.readFile(filePath);
      const key = memoKey(filePath);
      const cached = memo.get(key);
      if (cached !== undefined) return cached;
      const bytes = carriers.readFile(filePath);
      memo.set(key, bytes);
      return bytes;
    },
    writeAsset(filePath: string, content: string): void {
      carriers.writeFile(filePath, content);
      memo?.set(memoKey(filePath), content);
    },
    noteAssetWrite(filePath: string): void {
      memo?.delete(memoKey(filePath));
    },
    withFreshAssetMemo(): RunContext {
      return buildRunContext(carriers, new Map());
    },
  };
}

/**
 * Create the base `RunContext` for an improve run. Its `readAsset` is
 * non-memoizing (always fresh); call {@link RunContext.withFreshAssetMemo} to
 * enter a memoized pass/invocation scope.
 */
export function createRunContext(init: RunContextInit): RunContext {
  const carriers: RunContextCarriers = {
    config: init.config,
    eventsCtx: init.eventsCtx,
    proposalsCtx: init.proposalsCtx,
    chat: init.chat ?? chatCompletion,
    getLlmConfig: init.getLlmConfig,
    sourceRun: init.sourceRun,
    dryRun: init.dryRun,
    signal: init.signal,
    now: init.now ?? Date.now,
    readFile: init.io?.readFile ?? ((filePath: string): string => fs.readFileSync(filePath, "utf8")),
    writeFile:
      init.io?.writeFile ?? ((filePath: string, content: string): void => fs.writeFileSync(filePath, content, "utf8")),
  };
  return buildRunContext(carriers, null);
}
