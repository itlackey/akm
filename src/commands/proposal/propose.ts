// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm propose <type> <name> --task ...` — proposal-producing agent
 * command (#226).
 *
 * Mirrors {@link akmReflect} but for fresh authoring. The agent receives a
 * task description plus per-asset-type schema hints and is asked to author
 * a brand-new asset payload. The output lands ONLY in the proposal queue.
 *
 * Failures use the same {@link AgentFailureReason} discriminants as
 * `akm reflect`. `propose_invoked` is emitted at command entry.
 */

import fs from "node:fs";
import { placementTypes, stashDirFor } from "../../core/asset/asset-placement";
import { resolveStashDir } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { ConfigError, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { redactSensitiveText } from "../../core/redaction";
import { resolveStandardsContext } from "../../core/standards/resolve-standards-context";
import { deriveEntryProvenance, deriveInstallations, slugForPath } from "../../indexer/installations";
import type { AgentFailureReason, AgentRunResult, RunAgentOptions } from "../../integrations/agent";
import { resolveEngine } from "../../integrations/agent/engine-resolution";
import { buildProposePrompt, parseAgentProposalPayload } from "../../integrations/agent/prompts";
import { collectDispatchSensitiveValues, executeRunner } from "../../integrations/agent/runner-dispatch";
import { parseStoredRef } from "../../migrate/legacy-ref-grammar";
import { baseFailureFields, enoentHintMessage, isEnoentFailure } from "../agent/agent-support";
import {
  type CreateProposalInput,
  createProposal,
  isProposalSkipped,
  type Proposal,
  type ProposalsContext,
} from "./repository";

export interface AkmProposeOptions {
  type: string;
  name: string;
  task: string;
  engine?: string;
  timeoutMs?: number;
  stashDir?: string;
  runAgentOptions?: Pick<RunAgentOptions, "spawn" | "setTimeoutFn" | "clearTimeoutFn">;
  agentConfig?: AkmConfig;
  ctx?: ProposalsContext;
}

export interface AkmProposeFailure {
  schemaVersion: 2;
  ok: false;
  reason: AgentFailureReason;
  error: string;
  type: string;
  name: string;
  engine: string;
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
}

export interface AkmProposeSuccess {
  schemaVersion: 2;
  ok: true;
  proposal: Proposal;
  ref: string;
  engine: string;
  durationMs: number;
}

export type AkmProposeResult = AkmProposeSuccess | AkmProposeFailure;

function failureEnvelope(
  result: AgentRunResult,
  type: string,
  name: string,
  engine: string,
  fallbackReason: AgentFailureReason = "non_zero_exit",
): AkmProposeFailure {
  return {
    ...baseFailureFields(result, fallbackReason),
    schemaVersion: 2,
    type,
    name,
    engine,
  };
}

/**
 * WI-8.5a — the fully-qualified `bundle//conceptId` item_ref for a proposal
 * target in `stashDir`. The conceptId is BUILT from the D-R2 static table
 * (`deriveEntryProvenance`), never looked up, so a propose target that does not
 * yet exist on disk still keys onto its final spelling; the bundle is the
 * write-target stash's installation id (same derivation the index write path
 * uses). Matches `createProposal`'s durable `proposals.ref` mint, so the entry
 * event, the fallback ref, and the stored proposal all carry one spelling.
 */
function proposeItemRef(stashDir: string, type: string, name: string): string {
  const bundleId = deriveInstallations([{ path: stashDir, writable: true }])[0]?.id ?? slugForPath(stashDir);
  return deriveEntryProvenance({ bundleId, componentId: bundleId, adapterId: "akm" }, type, name).itemRef;
}

export async function akmPropose(options: AkmProposeOptions): Promise<AkmProposeResult> {
  if (!options.type?.trim()) {
    throw new UsageError("propose: <type> is required.", "MISSING_REQUIRED_ARGUMENT");
  }
  if (!options.name?.trim()) {
    throw new UsageError("propose: <name> is required.", "MISSING_REQUIRED_ARGUMENT");
  }
  if (!options.task?.trim()) {
    throw new UsageError("propose: --task is required.", "MISSING_REQUIRED_ARGUMENT");
  }
  if (!stashDirFor(options.type)) {
    throw new UsageError(
      `propose: unknown asset type "${options.type}". Known types: ${[...placementTypes()].sort().join(", ")}.`,
      "INVALID_FLAG_VALUE",
    );
  }

  const stash = options.stashDir ?? resolveStashDir();

  // 1. Always emit `propose_invoked`. WI-8.5b: the INPUT ref carries the same
  // fully-qualified item_ref the durable proposal is minted under
  // (`proposeItemRef`), so the entry event and the stored proposal agree.
  appendEvent({
    eventType: "propose_invoked",
    ref: proposeItemRef(stash, options.type, options.name),
    metadata: {
      type: options.type,
      name: options.name,
      task: options.task,
      ...(options.engine ? { engine: options.engine } : {}),
    },
  });

  // 2. Resolve the selected engine exactly once. Propose accepts either kind;
  // the LLM arm uses the caller-specific plain-chat handler below.
  const config = options.agentConfig ?? (await import("../../core/config/config.js")).loadConfig();
  const engineName = options.engine ?? config.defaults?.engine;
  if (!engineName) throw new ConfigError("propose requires --engine or defaults.engine.", "INVALID_CONFIG_FILE");
  const runner = resolveEngine(engineName, config);
  const profile = runner.kind === "llm" ? undefined : runner.profile;

  // 3. Build prompt.
  // Synthesize a temp draft path so opencode can write the asset content
  // directly using its file tools rather than returning JSON via stdout.
  const draftFilePath = import("node:os").then((os) =>
    import("node:path").then((path) =>
      path.join(
        os.tmpdir(),
        `akm-propose-${options.type}-${options.name.replace(/[^a-z0-9_-]/gi, "_")}-${Date.now()}.md`,
      ),
    ),
  );
  const resolvedDraftPath = await draftFilePath;

  // Standards "rulebook" for this target — wiki schema (wiki page) or stash
  // convention/meta facts (non-wiki asset); empty when neither fires.
  const standardsContext = resolveStandardsContext(`${options.type}:${options.name}`, stash);

  const prompt = buildProposePrompt({
    type: options.type,
    name: options.name,
    task: options.task,
    ...(standardsContext.trim() ? { standardsContext } : {}),
    draftFilePath: resolvedDraftPath,
  });

  // 4. Dispatch the selected engine.
  // Real agent runs use interactive mode so file tools can write the draft.
  // Injected/custom spawns still need captured stdout for JSON payload tests.
  // All kinds cross the unified RunnerSpec dispatch boundary.
  const useCustomSpawn = Boolean(options.runAgentOptions?.spawn);
  let result: AgentRunResult;
  const runOptions: RunAgentOptions = {
    stdio: useCustomSpawn ? "captured" : "interactive",
    parseOutput: "text",
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.runAgentOptions ?? {}),
  };
  const sensitiveValues = collectDispatchSensitiveValues(runner, runOptions);
  result = await executeRunner(runner, prompt, runOptions, {
    llm: async (spec, llmPrompt, opts) => {
      const { chatCompletion } = await import("../../llm/client.js");
      const started = Date.now();
      try {
        const stdout = await chatCompletion(spec.connection, [{ role: "user", content: llmPrompt }], {
          ...(Object.hasOwn(opts, "timeoutMs") ? { timeoutMs: opts.timeoutMs } : {}),
        });
        return { ok: true, exitCode: 0, stdout, stderr: "", durationMs: Date.now() - started };
      } catch (error) {
        return {
          ok: false,
          exitCode: null,
          stdout: "",
          stderr: "",
          durationMs: Date.now() - started,
          error: String(error),
          reason: "spawn_failed",
        };
      }
    },
  });

  if (!result.ok) {
    // B3: ENOENT / not-found gives an actionable hint.
    if (isEnoentFailure(result)) {
      return {
        ...failureEnvelope(result, options.type, options.name, engineName),
        error: enoentHintMessage(profile?.bin ?? engineName),
      };
    }
    return failureEnvelope(result, options.type, options.name, engineName);
  }

  // 5. Resolve the proposal content.
  // Path A: opencode wrote the draft file — read it directly (no stdout parse).
  // Path B: fallback to stdout JSON parse for non-file-writing agents.
  let payload: ReturnType<typeof parseAgentProposalPayload>;

  if (fs.existsSync(resolvedDraftPath)) {
    const draftContent = fs.readFileSync(resolvedDraftPath, "utf8");
    fs.unlinkSync(resolvedDraftPath);
    payload = {
      ref: proposeItemRef(stash, options.type, options.name), // WI-8.5a item_ref flip
      content: draftContent,
    };
  } else {
    // B1: When interactive mode was used and stdout is empty, the agent did not
    // write the draft file and stdout was not captured — surface an actionable error.
    const stdioWasInteractive = !useCustomSpawn;
    if (stdioWasInteractive && (result.stdout ?? "") === "") {
      return {
        schemaVersion: 2,
        ok: false,
        reason: "parse_error",
        error:
          "Agent did not write draft file and stdout was not captured (interactive mode). Check that the agent CLI understood the file-write instruction, or configure a headless profile with stdio: 'captured'.",
        type: options.type,
        name: options.name,
        engine: engineName,
        exitCode: result.exitCode,
        ...(result.stderr ? { stderr: result.stderr } : {}),
      };
    }
    try {
      payload = parseAgentProposalPayload(result.stdout ?? "");
    } catch (err) {
      return {
        schemaVersion: 2,
        ok: false,
        reason: "parse_error",
        error: err instanceof Error ? err.message : String(err),
        type: options.type,
        name: options.name,
        engine: engineName,
        exitCode: result.exitCode,
        stdout: result.stdout,
        ...(result.stderr ? { stderr: result.stderr } : {}),
      };
    }
  }

  payload = { ...payload, content: redactSensitiveText(payload.content, sensitiveValues) };

  // 6. Insert the proposal. Note: we allow the agent's `ref` to normalise the
  // asset name (e.g. path-cleanup), but only after validating that the ref is
  // well-formed and the type still matches the requested type.
  const expectedRef = proposeItemRef(stash, options.type, options.name); // WI-8.5a item_ref flip
  let ref = expectedRef;
  if (payload.ref) {
    let parsedRef: ReturnType<typeof parseStoredRef>;
    try {
      parsedRef = parseStoredRef(payload.ref);
    } catch (err) {
      return {
        schemaVersion: 2,
        ok: false,
        reason: "parse_error",
        error: err instanceof Error ? err.message : String(err),
        type: options.type,
        name: options.name,
        engine: engineName,
        exitCode: result.exitCode,
        stdout: result.stdout,
        ...(result.stderr ? { stderr: result.stderr } : {}),
      };
    }
    if (parsedRef.type !== options.type) {
      return {
        schemaVersion: 2,
        ok: false,
        reason: "parse_error",
        error: `Agent returned ref type ${parsedRef.type} but expected ${options.type}`,
        type: options.type,
        name: options.name,
        engine: engineName,
        exitCode: result.exitCode,
        stdout: result.stdout,
        ...(result.stderr ? { stderr: result.stderr } : {}),
      };
    }
    ref = proposeItemRef(stash, parsedRef.type, parsedRef.name); // WI-8.5a item_ref flip
  }

  const createInput: CreateProposalInput = {
    ref,
    source: "propose",
    sourceRun: `propose-${Date.now()}`,
    // User-initiated proposals always bypass dedup/cooldown guards — the
    // operator is explicitly asking for a new proposal.
    force: true,
    payload: {
      content: payload.content,
      ...(payload.frontmatter ? { frontmatter: payload.frontmatter } : {}),
    },
  };
  const proposalResult = createProposal(stash, createInput, options.ctx);

  // With force:true, the result is always a Proposal (never skipped).
  if (isProposalSkipped(proposalResult)) {
    // Should never happen when force:true, but be defensive.
    throw new Error(`Unexpected skip in propose command: ${proposalResult.message}`);
  }

  const proposal: Proposal = proposalResult;
  return {
    schemaVersion: 2,
    ok: true,
    proposal,
    ref: proposal.ref,
    engine: engineName,
    durationMs: result.durationMs,
  };
}
