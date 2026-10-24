// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import {
  type AkmConfig,
  type ConnectionConfig,
  defaultConnection,
  type HarnessConfig,
  type HarnessId,
} from "../core/config/config";

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

/** What identifies a configured connection (its canonical endpoint) or harness (its platform). */
export function engineFingerprint(
  entry:
    | { kind: "connection"; connection: ConnectionConfig }
    | { kind: "harness"; name: string; harness: HarnessConfig },
): string {
  return entry.kind === "connection"
    ? `llm:${normalizeChatCompletionsEndpoint(entry.connection.endpoint)}`
    : `agent:${entry.harness.platform ?? entry.name}`;
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

/** The name of the entry already holding `fingerprint`, else the first free name built from `preferred`. */
function availableName(
  entries: Record<string, unknown>,
  fingerprintOf: (name: string) => string,
  preferred: string,
  fingerprint: string,
): string {
  for (const name of Object.keys(entries).sort()) {
    if (fingerprintOf(name) === fingerprint) return name;
  }
  const base = slug(preferred);
  if (!entries[base]) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!entries[candidate]) return candidate;
  }
}

/** Insert or reuse a connection by canonical endpoint without modifying a match. The first one is named `default`. */
export function upsertDetectedLlmEngine(
  config: AkmConfig,
  candidate: { provider: string; endpoint: string; model: string; apiKeyEnvVar?: string },
): { config: AkmConfig; name: string; reused: boolean } {
  const endpoint = normalizeChatCompletionsEndpoint(candidate.endpoint);
  const fingerprint = `llm:${endpoint}`;
  const connections = config.connections ?? {};
  const fingerprintOf = (name: string) =>
    engineFingerprint({ kind: "connection", connection: connections[name] as ConnectionConfig });
  const name =
    Object.keys(connections).length === 0
      ? "default"
      : availableName(connections, fingerprintOf, candidate.provider, fingerprint);
  const reused = connections[name] !== undefined && fingerprintOf(name) === fingerprint;
  if (reused) return { config, name, reused };
  const connection: ConnectionConfig = {
    endpoint,
    models: { fast: candidate.model, balanced: candidate.model, reasoning: candidate.model },
    ...(candidate.apiKeyEnvVar ? { apiKey: `$${candidate.apiKeyEnvVar}` } : {}),
  };
  return { config: { ...config, connections: { ...connections, [name]: connection } }, name, reused };
}

/** Insert or reuse a harness by canonical platform without modifying a match. */
export function upsertDetectedAgentEngine(
  config: AkmConfig,
  platform: HarnessId,
): { config: AkmConfig; name: string; reused: boolean } {
  const fingerprint = `agent:${platform}`;
  const harnesses = config.harnesses ?? {};
  const fingerprintOf = (name: string) =>
    engineFingerprint({ kind: "harness", name, harness: harnesses[name] as HarnessConfig });
  const name = availableName(harnesses, fingerprintOf, platform, fingerprint);
  const reused = harnesses[name] !== undefined && fingerprintOf(name) === fingerprint;
  if (reused) return { config, name, reused };
  const harness: HarnessConfig = name === platform ? {} : { platform };
  return { config: { ...config, harnesses: { ...harnesses, [name]: harness } }, name, reused };
}
