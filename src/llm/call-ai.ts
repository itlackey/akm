// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unified AI call adapter: prefers the configured agent profile (agent CLI
 * shell-out), falls back to the default LLM profile (HTTP chat-completions).
 *
 * NOT for use by background indexer passes — those call `chatCompletion`
 * directly to avoid the agent-CLI overhead and to stay on the HTTP path that
 * the indexer was designed around.
 */

import type { AkmConfig } from "../core/config/config";
import { getDefaultLlmConfig } from "../core/config/config";
import { warn } from "../core/warn";
import { resolveProfileFromConfig, runAgent } from "../integrations/agent";
import { chatCompletion } from "./client";

export interface CallAiOptions {
  systemPrompt?: string;
  /**
   * If set, caller expects file-write contract (agent CLI only). Falls back
   * to stdout JSON if the HTTP path is used instead.
   */
  draftFilePath?: string;
  timeoutMs?: number;
}

export type CallAiResult = { ok: true; content: string; path: "agent-cli" | "llm-http" } | { ok: false; error: string };

/**
 * Unified AI call: prefers the default agent profile, falls back to the
 * default LLM profile. When neither is configured, returns a structured
 * error pointing the user at `akm setup`.
 */
export async function callAi(config: AkmConfig, prompt: string, opts: CallAiOptions = {}): Promise<CallAiResult> {
  const defaultAgentName = config.defaults?.agent;
  if (defaultAgentName) {
    try {
      const profile = resolveProfileFromConfig(defaultAgentName, config);
      if (!profile) {
        return {
          ok: false,
          error: `Agent profile "${defaultAgentName}" is not built-in and has no \`bin\` override.`,
        };
      }
      const result = await runAgent(profile, prompt, {
        stdio: opts.draftFilePath ? "interactive" : "captured",
        parseOutput: "text",
        timeoutMs: opts.timeoutMs,
      });
      if (!result.ok) return { ok: false, error: result.error ?? result.reason ?? "agent failed" };
      return { ok: true, content: result.stdout ?? "", path: "agent-cli" };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  const llmConfig = getDefaultLlmConfig(config);
  if (llmConfig) {
    if (opts.draftFilePath) {
      warn(
        "[akm] No agent CLI configured — falling back to LLM API. " +
          "File-write contract unavailable; expecting JSON in stdout. " +
          "Install an agent CLI and run `akm setup` for full functionality.",
      );
    }
    const messages: Array<{ role: "system" | "user"; content: string }> = [];
    if (opts.systemPrompt) messages.push({ role: "system", content: opts.systemPrompt });
    messages.push({ role: "user", content: prompt });
    try {
      const content = await chatCompletion(llmConfig, messages, {
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
      return { ok: true, content, path: "llm-http" };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  return {
    ok: false,
    error: "No AI connection configured. Run `akm setup` or set `defaults.agent`/`defaults.llm`.",
  };
}
