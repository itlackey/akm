// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type AkmConfig, defaultConnection, defaultHarness, type HarnessConfig } from "../core/config/config";
import { resolveApiKey } from "../core/config/credentials";
import type { ChatCompletionConfig } from "../llm/client";

/** An OpenAI-compatible connection as setup holds it while it runs: where it is and the model picked for every alias. */
export interface SetupConnection {
  /** Which preset or harness it came from; a label for the prompts, never written to config. */
  provider?: string;
  endpoint: string;
  model: string;
  /** A `$VAR` reference; setup never writes a literal key. */
  apiKey?: string;
}

/** Harnesses selected by setup, already in the persisted shape. */
export interface HarnessSelection {
  /** The platform (and so the name) of the harness agent work should run on. */
  default?: string;
  harnesses?: Record<string, HarnessConfig>;
  /** Explicit setup choice to disable agentic features. */
  disabled?: true;
}

/** The connection a probe sends: its key read now (setup holds a `$VAR` reference), nothing else. */
export function probeConnection(llm: SetupConnection): ChatCompletionConfig {
  const apiKey = resolveApiKey(llm.apiKey, "default");
  return { endpoint: llm.endpoint, model: llm.model, ...(apiKey ? { apiKey } : {}) };
}

const STANDARD_ALIASES = ["fast", "balanced", "reasoning"] as const;

export function readCurrentLlmEngine(config: AkmConfig): SetupConnection | undefined {
  const found = defaultConnection(config);
  const entry = found ? Object.values(found.connection.models ?? {})[0] : undefined;
  if (!found || entry === undefined) return undefined;
  return {
    endpoint: found.connection.endpoint,
    model: typeof entry === "string" ? entry : entry.model,
    ...(found.connection.apiKey ? { apiKey: found.connection.apiKey } : {}),
  };
}

export function readAgentEngineSelection(config: AkmConfig): HarnessSelection | undefined {
  const harnesses = { ...(config.harnesses ?? {}) };
  if (Object.keys(harnesses).length === 0) return undefined;
  return { default: defaultHarness(config)?.name, harnesses };
}

/** Write an OpenAI-compatible connection as the default connection. */
export function writeLlmEngine(config: AkmConfig, llm: SetupConnection | undefined): Partial<AkmConfig> {
  const name = defaultConnection(config)?.name ?? "default";
  const connections = { ...(config.connections ?? {}) };
  if (!llm) {
    delete connections[name];
    return { connections };
  }
  const existing = connections[name];
  const models = {
    ...(existing?.models ?? {}),
    ...Object.fromEntries(STANDARD_ALIASES.map((alias) => [alias, llm.model])),
  };
  connections[name] = {
    ...existing,
    endpoint: llm.endpoint,
    models,
    ...(llm.apiKey ? { apiKey: llm.apiKey } : {}),
  };
  return { connections };
}

/** Merge setup-selected harnesses; the one agent work should run on is the lone harness, or the one named `default`. */
export function writeAgentEngines(config: AkmConfig, selection: HarnessSelection | undefined): Partial<AkmConfig> {
  if (selection?.disabled) return { harnesses: {} };
  const harnesses = { ...(config.harnesses ?? {}), ...(selection?.harnesses ?? {}) };
  const chosen = selection?.default;
  if (chosen) {
    harnesses[chosen] ??= {};
    if (Object.keys(harnesses).length > 1 && chosen !== "default") {
      const { [chosen]: entry, ...rest } = harnesses;
      return { harnesses: { ...rest, default: { platform: chosen, ...entry } as HarnessConfig } };
    }
  }
  return { harnesses };
}

export function cloneLlmConnection(llm?: SetupConnection): SetupConnection | undefined {
  if (!llm) return undefined;
  return JSON.parse(JSON.stringify(llm)) as SetupConnection;
}
