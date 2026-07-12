// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Deterministic proposal-drain engine (Proposal-Queue Triage, Phase 1).
 *
 * Drains the *standing pending backlog* of proposals using a deterministic,
 * no-LLM policy keyed on generator (proposal `source`) and diff size. This is
 * the engine behind `akm proposal drain` and (later) the `triage` improve
 * pre-pass.
 *
 * Design (see docs/archive/proposal-triage-implementation-plan.md):
 *   - Reuses `listProposals` (no source filter — generator filtering is
 *     in-memory) and the `akmProposalAccept` / `akmProposalReject` wrappers from
 *     `proposal.ts` so the standard `promoted` / `rejected` events are emitted.
 *     It deliberately does NOT use `runAutoAcceptGate`, which is confidence-gated.
 *   - Backlog-only: `excludeIds` removes this-run's fresh proposals so triage
 *     never re-adjudicates the per-run auto-accept gate's decisions (decision #2).
 *   - Hard guardrails enforced in code: a `maxAccepts` ceiling checked *before*
 *     the promote loop (remainder → `skippedByCap`); `maxDiffLines` defers large
 *     accepts; `applyMode: "queue"` (the safe default) never promotes (stage
 *     only); `rejectEmpty` rejects empty / near-empty diffs.
 *   - The judgment tier (Phase 3) adjudicates the deferred items: when a
 *     `judgment` RunnerSpec is supplied the engine pre-fetches context (the live
 *     asset + sibling pending proposals for the same ref) into a prompt,
 *     dispatches it to the configured runner (llm → `chatCompletion`, agent →
 *     `runAgent`, sdk → `runOpencodeSdk`, mirroring `reflect.ts`'s switch), and
 *     performs the resulting accept / reject *itself* (the runner only judges).
 *     Items the runner cannot resolve — and any deferred items when no runner is
 *     configured — surface a `triage_deferred` event so "enabled, no agent"
 *     never silently looks like full success.
 *
 * The promote / reject functions and the runner dispatch are injectable
 * (mirrors `improve-auto-accept.ts` and reflect's dual test seams) so tests can
 * run the full engine without touching the filesystem or spawning a process.
 */

import fs from "node:fs";
import path from "node:path";
import { parseAssetRef } from "../../core/asset/asset-ref";
import { resolveAssetPathFromName, TYPE_DIRS } from "../../core/asset/asset-spec";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import type { AkmConfig } from "../../core/config/config";
import type { EventsContext } from "../../core/events";
import { appendEvent } from "../../core/events";
import { info, warn } from "../../core/warn";
import type { RunAgentOptions } from "../../integrations/agent";
import type { RunnerSpec } from "../../integrations/agent/runner";
import { executeRunner, type RunnerSeams } from "../../integrations/agent/runner-dispatch";
import { type ChatMessage, chatCompletion, stripJsonFences } from "../../llm/client";
import { akmProposalAccept, akmProposalReject, type ProposalRejectResult } from "./proposal";
import { listProposals, type Proposal, type ProposalGateDecision, recordGateDecision } from "./repository";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single accept rule within a {@link DrainPolicy}. */
export interface DrainAcceptRule {
  /** Generator (proposal `source`) this rule matches, e.g. "extract". */
  generator: string;
  /** Accept only when the proposed content is <= this many lines. */
  maxDiffLines?: number;
  /** Accept only when the proposed content has >= this many body lines. */
  minContentLines?: number;
  /**
   * When set, the rule matches only if the proposal's frontmatter `type` field
   * equals this value (e.g. "lesson"). Absent = match any type (backward-compat).
   */
  requireType?: string;
}

/** A deterministic triage policy: which generators auto-accept / defer. */
export interface DrainPolicy {
  name: string;
  /** Generators (with optional size bounds) whose proposals auto-accept. */
  accept: DrainAcceptRule[];
  /** Reject proposals whose diff is empty / near-empty. */
  rejectEmpty: boolean;
  /**
   * Generators whose mid-band / ambiguous items are deferred to the judgment
   * tier (Phase 3). For Phase 1 these simply land in `deferred[]` unprocessed.
   */
  defer: string[];
}

export type DrainDeferReason = "mid-band" | "possible-dup";

/**
 * Gate-decision context the engine stamps onto each proposal it adjudicates
 * (#577). Captures the reason token plus the thresholds that were in effect, so
 * `akm proposal show` can later reconstruct a comparison like "210 > 200".
 */
export interface DrainGateContext {
  reason: string;
  /**
   * The value this gate measured and compared against the threshold (the
   * proposed content's line count for `max-diff-lines`, the non-empty body-line
   * count for `min-content-lines`), so `akm proposal show` can render a full
   * comparison like "210 > 200" rather than only the bound (#577).
   */
  measured?: number;
  thresholds?: { maxDiffLines?: number; minContentLines?: number };
}

export interface DrainOptions {
  stashDir: string;
  /** Frozen destination identity used by every promotion path. */
  target?: string;
  /** Frozen config snapshot paired with {@link target}. */
  config?: AkmConfig;
  policy: DrainPolicy;
  /** "queue" (default, safe) stages only and never promotes; "promote" accepts. */
  applyMode: "queue" | "promote";
  /** Hard per-run accept ceiling, enforced before the promote loop. */
  maxAccepts: number;
  /** When true, performs zero writes (no accept / reject). */
  dryRun: boolean;
  /** Fresh-this-run proposal ids to exclude (decision #2). */
  excludeIds?: Set<string>;
  /**
   * Optional global diff-line bound. Accepts whose content exceeds this are
   * deferred ("mid-band"), never promoted. Applied in addition to any per-rule
   * `maxDiffLines`.
   */
  maxDiffLines?: number;
  /**
   * Optional judgment tier (Phase 3). When a RunnerSpec is supplied the engine
   * adjudicates each deferred item through the runner and performs the resulting
   * accept / reject itself. `null` / absent leaves deferred items unresolved and
   * emits `triage_deferred`.
   */
  judgment?: RunnerSpec | null;
  eventsCtx?: EventsContext;
}

export interface DrainResult {
  /** Proposal ids promoted (accepted) this run. Empty in queue / dry-run mode. */
  promoted: string[];
  /** Proposal ids rejected (empty diffs) this run. Empty in dry-run mode. */
  rejected: string[];
  /** Proposals left for the judgment tier, with the reason they were deferred. */
  deferred: Array<{ id: string; reason: DrainDeferReason }>;
  /** Accept candidates dropped because the `maxAccepts` ceiling was reached. */
  skippedByCap: string[];
  /**
   * Items the judgment tier resolved as "accept" but that a queue-mode run did
   * not promote (staged for a follow-up promote run). These are RESOLVED — the
   * judge decided — and are deliberately NOT reported as "left unresolved" by
   * the `triage_deferred` event. Empty outside queue mode.
   */
  staged: string[];
}

// Injectable test seams (mirrors improve-auto-accept.ts's promoteFn override).
export type PromoteFn = typeof akmProposalAccept;
export type RejectFn = (
  options: Parameters<typeof akmProposalReject>[0],
) => ProposalRejectResult | Promise<ProposalRejectResult>;

/** A single verdict the judgment runner returns for a deferred proposal. */
export interface JudgmentVerdict {
  decision: "accept" | "reject" | "defer";
  reason: string;
}

/**
 * Injectable runner seams for the judgment tier, mirroring reflect's dual test
 * seams (`chat` for the LLM HTTP path, `runAgentFn` for the spawn path). Tests
 * inject a fake `chat` (llm-mode) or `runAgentFn` (agent-mode) so the dispatch
 * switch runs deterministically without a network call or a real process.
 */
export interface JudgmentSeams {
  /** Test seam for the `llm` runner kind — replaces `chatCompletion`. */
  chat?: (config: RunnerSpec & { kind: "llm" }, messages: ChatMessage[]) => Promise<string>;
  /** Test seam for the `agent` runner kind — replaces `runAgent`. */
  runAgentFn?: RunnerSeams["runAgent"];
  /** Test seam for the `sdk` runner kind — replaces `runOpencodeSdk`. */
  runSdkFn?: RunnerSeams["runSdk"];
}

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

/** Number of non-empty body lines (frontmatter excluded). */
export function contentBodyLineCount(content: string): number {
  // Reuse the canonical frontmatter parser so CRLF / BOM are handled
  // consistently with the rest of the stash (parseFrontmatter returns the body
  // in `content`).
  return parseFrontmatter(content)
    .content.split("\n")
    .filter((line) => line.trim().length > 0).length;
}

/** Total line count of the proposed content (matches the bulk-accept measure). */
export function contentLineCount(content: string): number {
  return content.split("\n").length;
}

/** An empty / near-empty diff has no meaningful body content. */
export function isEmptyDiff(proposal: Proposal): boolean {
  const content = proposal.payload.content ?? "";
  if (content.trim().length === 0) return true;
  return contentBodyLineCount(content) === 0;
}

/**
 * Decide a deterministic verdict for a single backlog proposal under `policy`.
 * Returns `null` when no rule applies (the proposal is left pending untouched).
 */
export function classifyProposal(
  proposal: Proposal,
  policy: DrainPolicy,
  maxDiffLines?: number,
):
  | { verdict: "accept"; gate: DrainGateContext }
  | { verdict: "reject"; reason: string; gate: DrainGateContext }
  | { verdict: "defer"; reason: DrainDeferReason; gate: DrainGateContext }
  | null {
  const content = proposal.payload.content ?? "";

  // Empty / near-empty diffs reject first (the reject-empty floor).
  if (policy.rejectEmpty && isEmptyDiff(proposal)) {
    return { verdict: "reject", reason: "empty diff", gate: { reason: "empty-diff" } };
  }

  const rule = policy.accept.find((r) => {
    if (r.generator !== proposal.source) return false;
    if (r.requireType !== undefined) {
      const fm = parseFrontmatter(proposal.payload.content ?? "").data;
      if (typeof fm.type !== "string" || fm.type !== r.requireType) return false;
    }
    return true;
  });
  if (rule) {
    const lines = contentLineCount(content);
    const body = contentBodyLineCount(content);
    // Per-rule and global diff bounds defer large accepts (no silent rewrites).
    const effectiveMax = Math.min(
      rule.maxDiffLines ?? Number.POSITIVE_INFINITY,
      maxDiffLines ?? Number.POSITIVE_INFINITY,
    );
    if (lines > effectiveMax) {
      return {
        verdict: "defer",
        reason: "mid-band",
        gate: { reason: "max-diff-lines", measured: lines, thresholds: { maxDiffLines: effectiveMax } },
      };
    }
    if (rule.minContentLines !== undefined && body < rule.minContentLines) {
      // Too little content to confidently auto-accept — leave for judgment.
      return {
        verdict: "defer",
        reason: "mid-band",
        gate: { reason: "min-content-lines", measured: body, thresholds: { minContentLines: rule.minContentLines } },
      };
    }
    return { verdict: "accept", gate: { reason: "policy-accept" } };
  }

  if (policy.defer.includes(proposal.source)) {
    const reason = deferReasonForSource(proposal.source);
    return { verdict: "defer", reason, gate: { reason } };
  }

  // No matching rule — leave pending, untouched.
  return null;
}

function deferReasonForSource(source: string): DrainDeferReason {
  return source === "distill" ? "possible-dup" : "mid-band";
}

// ---------------------------------------------------------------------------
// Judgment tier (Phase 3)
// ---------------------------------------------------------------------------

/** Read the live on-disk content of a proposal's target asset, if it exists. */
function readLiveAssetContent(stashDir: string, ref: string): string | undefined {
  try {
    const parsed = parseAssetRef(ref);
    const typeDir = TYPE_DIRS[parsed.type];
    if (!typeDir) return undefined;
    const typeRoot = path.join(stashDir, typeDir);
    const assetPath = resolveAssetPathFromName(parsed.type, typeRoot, parsed.name);
    if (!fs.existsSync(assetPath)) return undefined;
    return fs.readFileSync(assetPath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Pre-fetch the context the judgment runner needs to adjudicate one deferred
 * proposal: the proposed content, the live asset it would overwrite, and the
 * sibling pending proposals for the same ref (so a dedup verdict can compare).
 */
function prefetchJudgmentContext(
  stashDir: string,
  proposal: Proposal,
  pending: Proposal[],
): { liveAsset: string | undefined; siblings: Proposal[] } {
  const liveAsset = readLiveAssetContent(stashDir, proposal.ref);
  const siblings = pending.filter((p) => p.ref === proposal.ref && p.id !== proposal.id);
  return { liveAsset, siblings };
}

/** Build the judgment prompt with the proposed content + pre-fetched context. */
export function buildJudgmentPrompt(
  proposal: Proposal,
  reason: DrainDeferReason,
  ctx: { liveAsset: string | undefined; siblings: Proposal[] },
): string {
  const proposed = proposal.payload.content ?? "";
  const sections: string[] = [
    "You are adjudicating a pending knowledge-base proposal that the deterministic",
    "triage pass could not resolve. Decide whether to accept, reject, or defer it.",
    "",
    `Asset ref: ${proposal.ref}`,
    `Generator (source): ${proposal.source}`,
    `Deferred because: ${reason}`,
    "",
    "## Proposed content",
    "```",
    proposed,
    "```",
  ];

  if (ctx.liveAsset !== undefined) {
    sections.push("", "## Current live asset (would be overwritten on accept)", "```", ctx.liveAsset, "```");
  } else {
    sections.push("", "## Current live asset", "(none — this proposal would create a new asset)");
  }

  if (ctx.siblings.length > 0) {
    sections.push("", "## Other pending proposals for the same ref (dedup context)");
    for (const sib of ctx.siblings) {
      sections.push("", `### Sibling ${sib.id} (source: ${sib.source})`, "```", sib.payload.content ?? "", "```");
    }
  }

  sections.push(
    "",
    "## Your task",
    'Return ONLY a JSON object: {"decision": "accept" | "reject" | "defer", "reason": "<short reason>"}.',
    "- accept: the proposed content is a correct, valuable update worth committing.",
    "- reject: the proposal is wrong, a duplicate, or contradicts the live asset.",
    "- defer: you cannot decide from the provided context (leave it pending).",
    "Output the JSON object and nothing else.",
  );

  return sections.join("\n");
}

/** Parse a {@link JudgmentVerdict} from raw runner output. Lenient. */
export function parseJudgmentVerdict(raw: string): JudgmentVerdict | null {
  const cleaned = stripJsonFences(raw).trim();
  if (!cleaned) return null;
  // Find the first balanced-looking JSON object in the output.
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const decision = (obj as { decision?: unknown }).decision;
  const reason = (obj as { reason?: unknown }).reason;
  if (decision !== "accept" && decision !== "reject" && decision !== "defer") return null;
  return { decision, reason: typeof reason === "string" ? reason : "" };
}

/**
 * Dispatch a single judgment prompt to the resolved runner via the unified
 * {@link executeRunner} seam (X3). The `llm` arm is drain-specific (wraps
 * `chatCompletion` — no filesystem) so it is supplied as the `llm` handler; the
 * byte-identical `agent` / `sdk` arms route to the default profile runners (or
 * the injected {@link JudgmentSeams} test fakes). A failed spawn warns and
 * yields `null`, matching the prior per-arm behavior.
 */
async function dispatchJudgment(
  runner: RunnerSpec,
  prompt: string,
  seams: JudgmentSeams,
): Promise<JudgmentVerdict | null> {
  const runOptions: RunAgentOptions = {
    stdio: "captured",
    parseOutput: "text",
    ...(runner.timeoutMs !== undefined ? { timeoutMs: runner.timeoutMs } : {}),
  };
  const result = await executeRunner(runner, prompt, runOptions, {
    llm: async (spec, p) => {
      const messages: ChatMessage[] = [{ role: "user", content: p }];
      const raw = seams.chat
        ? await seams.chat(spec, messages)
        : await chatCompletion(spec.connection, messages, {
            ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
          });
      // chatCompletion has no failure envelope — a returned string is success.
      return { ok: true, exitCode: 0, stdout: raw, stderr: "", durationMs: 0 };
    },
    ...(seams.runAgentFn ? { runAgent: seams.runAgentFn } : {}),
    ...(seams.runSdkFn ? { runSdk: seams.runSdkFn } : {}),
  });
  if (!result.ok) {
    warn(`[triage] judgment ${runner.kind} failed: ${result.error ?? result.reason ?? "unknown error"}`);
    return null;
  }
  return parseJudgmentVerdict(result.stdout);
}

interface JudgmentTierInput {
  stashDir: string;
  applyMode: "queue" | "promote";
  dryRun: boolean;
  runner: RunnerSpec;
  deferred: Array<{ id: string; reason: DrainDeferReason }>;
  pending: Proposal[];
  promoteFn: PromoteFn;
  rejectFn: RejectFn;
  seams: JudgmentSeams;
  target?: string;
  config?: AkmConfig;
  /**
   * Remaining accept budget so (deterministic promotions + judgment-tier
   * promotions) ≤ maxAccepts. Once exhausted, further judge-"accept" items are
   * routed to `skippedByCap` instead of being promoted. Only meaningful in
   * promote mode (queue mode promotes nothing). Defaults to unbounded.
   */
  remainingAcceptBudget: number;
}

/**
 * Run the judgment tier over the deferred items. The runner only *judges*; the
 * engine performs the resulting accept (respecting `applyMode`) / reject write.
 * Returns the ids the engine promoted / rejected, the ids staged (judge said
 * "accept" but queue mode did not promote), the ids dropped by the accept cap,
 * and the items still unresolved (verdict "defer", parse failure, or a runner
 * error).
 */
async function runJudgmentTier(input: JudgmentTierInput): Promise<{
  promoted: string[];
  rejected: string[];
  staged: string[];
  skippedByCap: string[];
  stillDeferred: Array<{ id: string; reason: DrainDeferReason }>;
}> {
  const byId = new Map(input.pending.map((p) => [p.id, p]));
  const promoted: string[] = [];
  const rejected: string[] = [];
  const staged: string[] = [];
  const skippedByCap: string[] = [];
  const stillDeferred: Array<{ id: string; reason: DrainDeferReason }> = [];
  // Remaining accept budget shared with the deterministic promote loop.
  let acceptBudget = Math.max(0, input.remainingAcceptBudget);

  for (const item of input.deferred) {
    const proposal = byId.get(item.id);
    if (!proposal) {
      stillDeferred.push(item);
      continue;
    }
    const ctx = prefetchJudgmentContext(input.stashDir, proposal, input.pending);
    const prompt = buildJudgmentPrompt(proposal, item.reason, ctx);

    let verdict: JudgmentVerdict | null;
    try {
      verdict = await dispatchJudgment(input.runner, prompt, input.seams);
    } catch (err) {
      warn(`[triage] judgment dispatch failed for ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
      stillDeferred.push(item);
      continue;
    }

    if (!verdict || verdict.decision === "defer") {
      stillDeferred.push(item);
      continue;
    }

    if (verdict.decision === "reject") {
      if (input.dryRun) {
        rejected.push(item.id);
        continue;
      }
      try {
        await input.rejectFn({ stashDir: input.stashDir, id: item.id, reason: verdict.reason || "judgment: reject" });
        rejected.push(item.id);
      } catch (err) {
        warn(`[triage] judgment reject failed for ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
        stillDeferred.push(item);
      }
      continue;
    }

    // decision === "accept" — gated on applyMode, exactly like the
    // deterministic accept path (queue mode never writes).
    if (input.applyMode !== "promote") {
      // Staged: a queue-mode run never promotes, so the item stays pending but
      // is RESOLVED (the runner judged it). Track separately so it is NOT
      // reported as "left unresolved" and a follow-up promote run picks it up.
      staged.push(item.id);
      continue;
    }
    // Accept cap: once the shared budget is exhausted, route further accepts to
    // skippedByCap instead of promoting (keeps total promotions ≤ maxAccepts).
    if (acceptBudget <= 0) {
      skippedByCap.push(item.id);
      continue;
    }
    if (input.dryRun) {
      promoted.push(item.id);
      acceptBudget -= 1;
      continue;
    }
    try {
      await input.promoteFn({
        stashDir: input.stashDir,
        id: item.id,
        ...(input.target ? { target: input.target } : {}),
        ...(input.config ? { config: input.config } : {}),
      });
      promoted.push(item.id);
      acceptBudget -= 1;
    } catch (err) {
      warn(`[triage] judgment promote failed for ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
      stillDeferred.push(item);
    }
  }

  return { promoted, rejected, staged, skippedByCap, stillDeferred };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Drain the standing pending backlog under a deterministic policy.
 *
 * @param opts       Drain options (policy, applyMode, ceilings, dry-run).
 * @param promoteFn  Injectable override for `akmProposalAccept` (test seam).
 * @param rejectFn   Injectable override for `akmProposalReject` (test seam).
 */
export async function drainProposals(
  opts: DrainOptions,
  promoteFn: PromoteFn = akmProposalAccept,
  rejectFn: RejectFn = akmProposalReject,
  judgmentSeams: JudgmentSeams = {},
): Promise<DrainResult> {
  const result: DrainResult = { promoted: [], rejected: [], deferred: [], skippedByCap: [], staged: [] };

  const exclude = opts.excludeIds ?? new Set<string>();
  const pending = listProposals(opts.stashDir, { status: "pending" }).filter((p) => !exclude.has(p.id));

  // First, classify every proposal deterministically.
  const acceptIds: string[] = [];
  const rejectTargets: Array<{ id: string; reason: string }> = [];
  const gateLabel = `triage:${opts.policy.name}`;
  // Items deferred purely because they need a judge (no threshold-based reason)
  // — these are re-stamped `no-judge-configured` when no runner resolves them.
  const needsJudge = new Set<string>();

  for (const proposal of pending) {
    // Do NOT reclassify a proposal that was already conclusively stamped
    // `auto-rejected` by a prior gate run (e.g. the improve confidence gate).
    // Overwriting an authoritative rejection with `auto-accepted` would corrupt
    // the audit trail and silently promote content the gate explicitly rejected.
    // Such proposals remain pending until the TTL expires them — the queue is
    // audited-autonomous; no manual-review rung exists (06-M3).
    if (proposal.gateDecision?.outcome === "auto-rejected") continue;

    const decision = classifyProposal(proposal, opts.policy, opts.maxDiffLines);
    if (decision === null) continue;
    // #577: stamp the gate's verdict onto the proposal so `akm proposal show`
    // can explain WHY it landed here. A dry-run performs zero writes, so it
    // records nothing.
    const outcome =
      decision.verdict === "accept" ? "auto-accepted" : decision.verdict === "reject" ? "auto-rejected" : "deferred";
    stampGateDecision(opts, proposal.id, {
      outcome,
      reason: decision.gate.reason,
      ...(decision.gate.measured !== undefined ? { measured: decision.gate.measured } : {}),
      ...(decision.gate.thresholds ? { thresholds: decision.gate.thresholds } : {}),
      gate: gateLabel,
    });
    // A defer with no threshold (mid-band / possible-dup from the defer list) is
    // pending only because it needs adjudication — re-stampable to
    // `no-judge-configured`. A band-based defer keeps its specific reason.
    if (decision.verdict === "defer" && !decision.gate.thresholds) {
      needsJudge.add(proposal.id);
    }

    if (decision.verdict === "accept") {
      acceptIds.push(proposal.id);
    } else if (decision.verdict === "reject") {
      rejectTargets.push({ id: proposal.id, reason: decision.reason });
    } else {
      result.deferred.push({ id: proposal.id, reason: decision.reason });
    }
  }

  // --- Reject empties (independent of the accept ceiling / applyMode) ---
  for (const target of rejectTargets) {
    if (opts.dryRun) {
      result.rejected.push(target.id);
      continue;
    }
    try {
      await rejectFn({ stashDir: opts.stashDir, id: target.id, reason: target.reason });
      result.rejected.push(target.id);
    } catch (err) {
      warn(`[triage] reject failed for ${target.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- Accept ceiling: enforced BEFORE the promote loop ---
  const withinCap = acceptIds.slice(0, Math.max(0, opts.maxAccepts));
  result.skippedByCap = acceptIds.slice(Math.max(0, opts.maxAccepts));
  if (result.skippedByCap.length > 0) {
    info(
      `[triage] accept ceiling reached: ${withinCap.length} promoted, ${result.skippedByCap.length} skipped by cap (maxAccepts=${opts.maxAccepts})`,
    );
  }

  // --- Promotion gate: applyMode "queue" never promotes (stage only) ---
  // Count deterministic promotions so the judgment tier shares the same accept
  // budget (deterministic + judgment promotions ≤ maxAccepts).
  let deterministicPromoted = 0;
  if (opts.applyMode === "promote" && !opts.dryRun) {
    info(`[triage] auto-promote active: ${withinCap.length} accepts allowed this run`);
    for (const id of withinCap) {
      try {
        await promoteFn({
          stashDir: opts.stashDir,
          id,
          ...(opts.target ? { target: opts.target } : {}),
          ...(opts.config ? { config: opts.config } : {}),
        });
        result.promoted.push(id);
        deterministicPromoted += 1;
      } catch (err) {
        warn(`[triage] promote failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else if (opts.applyMode === "promote" && opts.dryRun) {
    // Dry-run promote: report (and count, for the shared budget) what would be
    // promoted without writing.
    result.promoted.push(...withinCap);
    deterministicPromoted = withinCap.length;
  }
  // applyMode "queue": leave accept candidates pending (staged). No promotion.

  // Remaining accept budget for the judgment tier: maxAccepts minus what was
  // actually promoted deterministically. Bounds the TOTAL promotions, not just
  // the deterministic path. Moot in queue mode (it promotes nothing).
  const remainingAcceptBudget = Math.max(0, Math.max(0, opts.maxAccepts) - deterministicPromoted);

  // --- Judgment tier (Phase 3): adjudicate the deferred items ---
  // Only runs when a RunnerSpec is configured. The runner returns a verdict; the
  // ENGINE performs the resulting accept (respecting applyMode) / reject write.
  if (opts.judgment && result.deferred.length > 0) {
    const tier = await runJudgmentTier({
      stashDir: opts.stashDir,
      applyMode: opts.applyMode,
      dryRun: opts.dryRun,
      runner: opts.judgment,
      deferred: result.deferred,
      pending,
      promoteFn,
      rejectFn,
      seams: judgmentSeams,
      ...(opts.target ? { target: opts.target } : {}),
      ...(opts.config ? { config: opts.config } : {}),
      remainingAcceptBudget,
    });
    result.promoted.push(...tier.promoted);
    result.rejected.push(...tier.rejected);
    result.staged.push(...tier.staged);
    // Judgment-tier accepts dropped by the shared accept cap surface under
    // skippedByCap, same as deterministic cap drops.
    result.skippedByCap.push(...tier.skippedByCap);
    if (tier.skippedByCap.length > 0) {
      info(
        `[triage] accept ceiling reached in judgment tier: ${tier.skippedByCap.length} judged-accept items skipped by cap (maxAccepts=${opts.maxAccepts})`,
      );
    }
    // #577: re-stamp the gate decision for items the judgment tier resolved so
    // `akm proposal show` reflects the judge's verdict, not the earlier
    // deterministic defer.
    for (const id of tier.promoted) {
      stampGateDecision(opts, id, { outcome: "auto-accepted", reason: "judgment-accept", gate: gateLabel });
    }
    for (const id of tier.rejected) {
      stampGateDecision(opts, id, { outcome: "auto-rejected", reason: "judgment-reject", gate: gateLabel });
    }
    // Replace the deferred list with only the items the judgment tier could NOT
    // resolve (verdict "defer", parse failure, or runner error). Staged
    // queue-mode accepts are RESOLVED and tracked in result.staged instead.
    result.deferred = tier.stillDeferred;
  } else if (result.deferred.length > 0) {
    // #577: no judgment runner configured — items deferred *because they need a
    // judge* (mid-band / possible-dup, no threshold reason) stay pending solely
    // for lack of one. Re-stamp those as `no-judge-configured` so the operator
    // sees a per-proposal reason instead of inferring it from the run-level
    // triage_deferred aggregate. Band-deferred items keep their specific reason
    // (e.g. `max-diff-lines`), which is more actionable than "no judge".
    for (const item of result.deferred) {
      if (needsJudge.has(item.id)) {
        stampGateDecision(opts, item.id, { outcome: "deferred", reason: "no-judge-configured", gate: gateLabel });
      }
    }
  }

  emitDrainEvents(opts, result);

  return result;
}

/**
 * Persist a gate decision onto a proposal, honouring the dry-run contract
 * (a dry run performs zero writes, so it records nothing) and never letting a
 * persistence failure abort the drain (#577). Best-effort by design.
 */
function stampGateDecision(opts: DrainOptions, id: string, decision: Omit<ProposalGateDecision, "decidedAt">): void {
  if (opts.dryRun) return;
  try {
    recordGateDecision(opts.stashDir, id, decision);
  } catch (err) {
    warn(`[triage] failed to record gate decision for ${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function emitDrainEvents(opts: DrainOptions, result: DrainResult): void {
  const deferredByReason: Record<string, number> = {};
  for (const d of result.deferred) {
    deferredByReason[d.reason] = (deferredByReason[d.reason] ?? 0) + 1;
  }

  appendEvent(
    {
      eventType: "triage_drained",
      metadata: {
        promoted: result.promoted.length,
        rejected: result.rejected.length,
        deferredByReason,
        skippedByCap: result.skippedByCap.length,
        ...(result.staged.length > 0 ? { staged: result.staged.length } : {}),
        policy: opts.policy.name,
        applyMode: opts.applyMode,
        ...(opts.dryRun ? { dryRun: true } : {}),
      },
    },
    opts.eventsCtx ?? {},
  );

  // Surface any items the judge could NOT resolve after the (optional) judgment
  // tier so a backlog of deferred items never silently looks like full success.
  // This fires when no runner is configured OR the judgment tier ran but could
  // not resolve every item (verdict "defer", parse failure, or a runner error).
  // Queue-mode staged accepts are RESOLVED (the judge decided) and live in
  // result.staged, so they are deliberately excluded from this "unresolved" count.
  if (result.deferred.length > 0) {
    appendEvent(
      {
        eventType: "triage_deferred",
        metadata: {
          deferred: result.deferred.length,
          deferredByReason,
          reason: opts.judgment ? "judgment tier left items unresolved" : "no judgment runner configured",
        },
      },
      opts.eventsCtx ?? {},
    );
  }
}
