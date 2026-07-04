// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Small pure helpers shared across the improve command family. Extracted to
 * delete byte-identical duplication that previously lived inline in
 * recombine/procedural/loop-stages/improve. Keep this file free of I/O and
 * of any improve-specific state — these are leaf utilities.
 */

import type { AkmConfig } from "../../core/config/config";
import { getDefaultLlmConfig, getImproveProcessConfig } from "../../core/config/config";
import { warn } from "../../core/warn";
import { resolveImproveProcessRunnerFromProfile, runnerIsLlm } from "../../integrations/agent/runner";
import { type ChatMessage, chatCompletion } from "../../llm/client";

/** Normalize an unknown thrown value to a human-readable message string. */
export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Slugify an asset ref for use in eval-case / rejection filenames: lowercase,
 * non-alphanumerics collapsed to `-`, capped at 60 characters.
 */
export function refSlug(ref: string): string {
  return ref
    .replace(/[^a-z0-9]/gi, "-")
    .toLowerCase()
    .slice(0, 60);
}

/**
 * Resolve the production LLM seam for an improve process (`recombine` /
 * `procedural`) from the active default improve profile. Returns a function
 * that issues one bounded chatCompletion per call, or `undefined` when no LLM
 * is configured (the pass then makes no calls). Previously copied verbatim in
 * recombine.ts and procedural.ts.
 */
export function resolveImproveLlmFn(
  config: AkmConfig,
  opts: {
    processKey: "recombine" | "procedural";
    systemPrompt: string;
    tag: string;
    signal?: AbortSignal;
  },
): ((prompt: string) => Promise<string | null>) | undefined {
  const processConfig = getImproveProcessConfig(config, opts.processKey);
  const runnerSpec = resolveImproveProcessRunnerFromProfile(processConfig, config);
  const llmConfig = runnerSpec && runnerIsLlm(runnerSpec) ? runnerSpec.connection : getDefaultLlmConfig(config);
  if (!llmConfig) return undefined;
  return async (prompt: string) => {
    const messages: ChatMessage[] = [
      { role: "system", content: opts.systemPrompt },
      { role: "user", content: prompt },
    ];
    try {
      return await chatCompletion(llmConfig, messages, { signal: opts.signal, enableThinking: false });
    } catch (e) {
      warn(`${opts.tag} LLM call failed: ${String(e)}`);
      return null;
    }
  };
}
