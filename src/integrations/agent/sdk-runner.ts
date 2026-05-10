/**
 * OpenCode SDK agent runner — uses embedded @opencode-ai/sdk instead of
 * Bun.spawn. Requires no agent CLI binary to be installed. The user provides
 * an OpenAI-compatible endpoint (or inherits from config.llm) for the SDK.
 */

import type { LlmConnectionConfig } from "../../core/config";
import type { AgentFailureReason, AgentRunResult, RunAgentOptions } from "./spawn";
import type { AgentProfile } from "./profiles";

// Singleton server — started once per process, reused across calls
let _server: { client: any; server: { close(): void } } | null = null;

async function getOrStartServer(
  profile: AgentProfile,
  llmConfig?: LlmConnectionConfig,
): Promise<{ client: any }> {
  if (_server) return _server;

  const { createOpencode } = await import("@opencode-ai/sdk").catch(() => {
    throw new Error(
      "OpenCode SDK not available. Install @opencode-ai/sdk or configure a CLI agent instead.",
    );
  });

  // Resolve endpoint and model: profile fields take precedence over config.llm
  const endpoint = profile.endpoint ?? llmConfig?.endpoint;
  const apiKey = profile.apiKey ?? llmConfig?.apiKey;
  const model = profile.model;

  const sdkConfig: Record<string, unknown> = {};
  if (model) sdkConfig.model = model;
  if (endpoint || apiKey) {
    // Configure a custom OpenAI-compatible provider
    sdkConfig.provider = {
      "akm-custom": {
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: endpoint?.replace(/\/chat\/completions$/, "").replace(/\/$/, ""),
          ...(apiKey ? { apiKey } : {}),
        },
      },
    };
    // Use the custom provider's model if not already qualified
    if (model && !model.includes("/")) {
      sdkConfig.model = `akm-custom/${model}`;
    }
  }

  _server = await createOpencode(
    Object.keys(sdkConfig).length > 0 ? { config: sdkConfig } : {},
  );

  process.once("exit", () => {
    try { _server?.server.close(); } catch { /* ignore */ }
    _server = null;
  });

  return _server!;
}

export async function runAgentSdk(
  profile: AgentProfile,
  prompt: string,
  opts: RunAgentOptions = {},
  llmConfig?: LlmConnectionConfig,
): Promise<AgentRunResult> {
  const start = Date.now();

  let client: any;
  try {
    ({ client } = await getOrStartServer(profile, llmConfig));
  } catch (e) {
    return {
      ok: false,
      stdout: "",
      stderr: String(e),
      durationMs: Date.now() - start,
      exitCode: 1,
      reason: "spawn_failed" as AgentFailureReason,
      error: String(e),
    };
  }

  // One session per call — do NOT reuse (history accumulates, token costs grow)
  const sessionRes = await client.session.create({ body: { title: "akm" } });
  const sessionId = sessionRes.data?.id;
  if (!sessionId) {
    return {
      ok: false,
      stdout: "",
      stderr: "Failed to create session",
      durationMs: Date.now() - start,
      exitCode: 1,
      reason: "spawn_failed" as AgentFailureReason,
      error: "Failed to create OpenCode session",
    };
  }

  try {
    const result = await client.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: "text", text: prompt }] },
    });

    const parts: any[] = result.data?.parts ?? [];
    const textPart = parts.find((p: any) => p.type === "text");
    const stdout = textPart?.text ?? "";

    return {
      ok: true,
      stdout,
      stderr: "",
      durationMs: Date.now() - start,
      exitCode: 0,
    };
  } catch (e) {
    return {
      ok: false,
      stdout: "",
      stderr: String(e),
      durationMs: Date.now() - start,
      exitCode: 1,
      reason: "non_zero_exit" as AgentFailureReason,
      error: String(e),
    };
  } finally {
    // Clean up session to prevent disk accumulation in ~/.local/share/opencode/
    await client.session.delete({ path: { id: sessionId } }).catch(() => {});
  }
}
