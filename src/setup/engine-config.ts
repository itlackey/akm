// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig, EngineConfig, LlmConnectionConfig } from "../core/config/config";
import { ConfigError } from "../core/errors";

type AgentEngine = Extract<EngineConfig, { kind: "agent" }>;

/** Agent engines selected by setup, already in the persisted 0.9 shape. */
export interface AgentEngineSelection {
  default?: string;
  engines?: Record<string, EngineConfig>;
}

export function readCurrentLlmEngine(config: AkmConfig): LlmConnectionConfig | undefined {
  const name = config.defaults?.llmEngine;
  const engine = name ? config.engines?.[name] : undefined;
  if (!engine || engine.kind !== "llm") return undefined;
  const { kind: _kind, supportsJsonSchema, timeoutMs, ...connection } = engine;
  return {
    ...connection,
    ...(timeoutMs !== null && timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(supportsJsonSchema !== undefined ? { capabilities: { structuredOutput: supportsJsonSchema } } : {}),
  };
}

export function readAgentEngineSelection(config: AkmConfig): AgentEngineSelection | undefined {
  const engines: Record<string, AgentEngine> = {};
  for (const [name, engine] of Object.entries(config.engines ?? {})) {
    if (engine.kind === "agent") engines[name] = { ...engine };
  }
  const defaultName = config.defaults?.engine;
  const defaultIsAgent = defaultName && config.engines?.[defaultName]?.kind === "agent";
  if (Object.keys(engines).length === 0 && !defaultIsAgent) return undefined;
  return { ...(defaultIsAgent ? { default: defaultName } : {}), engines };
}

/** Write an OpenAI-compatible connection as a named LLM engine. */
export function writeLlmEngine(config: AkmConfig, llm: LlmConnectionConfig | undefined): Partial<AkmConfig> {
  const name = config.defaults?.llmEngine ?? "default";
  if (!llm) {
    const engines = { ...(config.engines ?? {}) };
    if (engines[name]?.kind === "llm") delete engines[name];
    const defaults = { ...(config.defaults ?? {}) };
    delete defaults.llmEngine;
    return { engines, defaults };
  }
  if (config.engines?.[name] && config.engines[name].kind !== "llm") {
    throw new ConfigError(
      `Cannot configure LLM engine ${JSON.stringify(name)} because that name belongs to an agent engine.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const endpoint = llm.endpoint.endsWith("/chat/completions")
    ? llm.endpoint
    : `${llm.endpoint.replace(/\/$/, "")}/chat/completions`;
  const { capabilities, ...connection } = llm;
  return {
    engines: {
      ...(config.engines ?? {}),
      [name]: {
        ...connection,
        kind: "llm",
        endpoint,
        ...(capabilities?.structuredOutput !== undefined ? { supportsJsonSchema: capabilities.structuredOutput } : {}),
      },
    },
    defaults: { ...(config.defaults ?? {}), llmEngine: name },
  };
}

/** Merge setup-selected agent engines without translating profile-shaped data. */
export function writeAgentEngines(config: AkmConfig, selection: AgentEngineSelection | undefined): Partial<AkmConfig> {
  for (const [name, engine] of Object.entries(selection?.engines ?? {})) {
    const existing = config.engines?.[name];
    if (existing && existing.kind !== engine.kind) {
      throw new ConfigError(
        `Cannot configure ${engine.kind} engine ${JSON.stringify(name)} because that name belongs to an ${existing.kind} engine.`,
        "INVALID_CONFIG_FILE",
      );
    }
  }
  const defaults = { ...(config.defaults ?? {}) };
  if (!selection?.default) delete defaults.engine;
  else defaults.engine = selection.default;
  const engines = { ...(config.engines ?? {}), ...(selection?.engines ?? {}) };
  if (selection?.default && engines[selection.default] && engines[selection.default].kind !== "agent") {
    throw new ConfigError(
      `Cannot select agent engine ${JSON.stringify(selection.default)} because that name belongs to an LLM engine.`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (selection?.default && !engines[selection.default]) {
    engines[selection.default] = {
      kind: "agent",
      platform: selection.default as AgentEngine["platform"],
    };
  }
  return { engines, defaults };
}

export function cloneLlmConnection(llm?: LlmConnectionConfig): LlmConnectionConfig | undefined {
  if (!llm) return undefined;
  return JSON.parse(JSON.stringify(llm)) as LlmConnectionConfig;
}
