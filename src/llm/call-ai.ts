/**
 * Unified AI call adapter: prefers `config.agent` (agent CLI shell-out),
 * falls back to `config.llm` (HTTP chat-completions).
 *
 * NOT for use by background indexer passes — those call `chatCompletion`
 * directly to avoid the agent-CLI overhead and to stay on the HTTP path that
 * the indexer was designed around.
 */

import type { AkmConfig } from "../core/config";
import { warn } from "../core/warn";
import { resolveAgentProfile, runAgent } from "../integrations/agent";
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
 * Unified AI call: prefers `config.agent` (agent CLI), falls back to
 * `config.llm` (HTTP). When neither is configured, returns a structured
 * error pointing the user at `akm setup`.
 *
 * NOT for use by background indexer passes — those call `chatCompletion`
 * directly.
 */
export async function callAi(config: AkmConfig, prompt: string, opts: CallAiOptions = {}): Promise<CallAiResult> {
  if (config.agent) {
    try {
      const defaultName = config.agent.default;
      if (!defaultName) {
        return {
          ok: false,
          error: "No default agent profile configured. Set `agent.default` in config.json or run `akm setup`.",
        };
      }
      const profile = resolveAgentProfile(defaultName, config.agent.profiles?.[defaultName]);
      if (!profile) {
        return {
          ok: false,
          error: `Agent profile "${defaultName}" is not built-in and has no \`bin\` override.`,
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

  if (config.llm) {
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
      const content = await chatCompletion(config.llm, messages, {
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
      return { ok: true, content, path: "llm-http" };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  return {
    ok: false,
    error: "No AI connection configured. Run `akm setup` or set `agent` or `llm` in your config.",
  };
}
