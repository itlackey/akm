// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig, EngineConfig, HarnessId } from "../core/config/config";

const CHAT_SUFFIX = "/chat/completions";

export function normalizeChatCompletionsEndpoint(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("endpoint must use http or https");
  if (url.username || url.password || url.search || url.hash)
    throw new Error("endpoint cannot contain credentials, query, or fragment");
  let pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith(CHAT_SUFFIX)) {
    if (!pathname.endsWith("/v1") && !pathname.includes("/openai")) pathname += "/v1";
    pathname += CHAT_SUFFIX;
  }
  url.pathname = pathname;
  return url.toString().replace(/\/$/, "");
}

export function engineFingerprint(engine: EngineConfig): string {
  return engine.kind === "llm"
    ? `llm:${normalizeChatCompletionsEndpoint(engine.endpoint)}`
    : `agent:${engine.platform}`;
}

export interface VerifyLlmCandidate {
  endpoint: string;
  model: string;
  apiKeyEnvVar?: string;
}

export async function verifyOpenAiCompatibleEndpoint(
  candidate: VerifyLlmCandidate,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: true; endpoint: string } | { ok: false; reason: string }> {
  let endpoint: string;
  try {
    endpoint = normalizeChatCompletionsEndpoint(candidate.endpoint);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!candidate.model.trim()) return { ok: false, reason: "no detected model" };
  const credential = candidate.apiKeyEnvVar ? process.env[candidate.apiKeyEnvVar] : undefined;
  if (candidate.apiKeyEnvVar && !credential) {
    return { ok: false, reason: `required credential ${candidate.apiKeyEnvVar} is unavailable` };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  timer.unref?.();
  try {
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      },
      body: JSON.stringify({
        model: candidate.model,
        messages: [{ role: "user", content: "Reply OK" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    if (typeof body.choices?.[0]?.message?.content !== "string") {
      return { ok: false, reason: "response did not contain choices[0].message.content" };
    }
    return { ok: true, endpoint };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized && /^[a-z]/.test(normalized) ? normalized : "local";
}

function availableName(config: AkmConfig, preferred: string, fingerprint: string): string {
  for (const [name, engine] of Object.entries(config.engines ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (engineFingerprint(engine) === fingerprint) return name;
  }
  const base = slug(preferred);
  if (!config.engines?.[base]) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!config.engines?.[candidate]) return candidate;
  }
}

/** Insert or reuse an LLM engine by canonical endpoint without modifying a match. */
export function upsertDetectedLlmEngine(
  config: AkmConfig,
  candidate: { provider: string; endpoint: string; model: string; apiKeyEnvVar?: string },
): { config: AkmConfig; name: string; reused: boolean } {
  const endpoint = normalizeChatCompletionsEndpoint(candidate.endpoint);
  const fingerprint = `llm:${endpoint}`;
  const name = availableName(config, candidate.provider, fingerprint);
  const existing = config.engines?.[name];
  const reused = existing !== undefined && engineFingerprint(existing) === fingerprint;
  const engines = reused
    ? config.engines
    : {
        ...(config.engines ?? {}),
        [name]: {
          kind: "llm" as const,
          provider: candidate.provider,
          endpoint,
          model: candidate.model,
          ...(candidate.apiKeyEnvVar ? { apiKey: `\${${candidate.apiKeyEnvVar}}` } : {}),
        },
      };
  const defaults = { ...(config.defaults ?? {}) };
  const currentDefault = defaults.llmEngine;
  if (
    !currentDefault ||
    (config.engines?.[currentDefault] && engineFingerprint(config.engines[currentDefault]) === fingerprint)
  ) {
    defaults.llmEngine = name;
  }
  if (!defaults.engine) defaults.engine = defaults.llmEngine ?? name;
  return { config: { ...config, engines, defaults }, name, reused };
}

/** Insert or reuse an agent engine by canonical platform without modifying a match. */
export function upsertDetectedAgentEngine(
  config: AkmConfig,
  platform: HarnessId,
): { config: AkmConfig; name: string; reused: boolean } {
  const fingerprint = `agent:${platform}`;
  const name = availableName(config, platform, fingerprint);
  const existing = config.engines?.[name];
  const reused = existing !== undefined && engineFingerprint(existing) === fingerprint;
  const engines = reused ? config.engines : { ...(config.engines ?? {}), [name]: { kind: "agent" as const, platform } };
  const defaults = { ...(config.defaults ?? {}) };
  const currentDefault = defaults.engine;
  if (
    !currentDefault ||
    (config.engines?.[currentDefault] && engineFingerprint(config.engines[currentDefault]) === fingerprint)
  ) {
    defaults.engine = name;
  }
  return { config: { ...config, engines, defaults }, name, reused };
}
