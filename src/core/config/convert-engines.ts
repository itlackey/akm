// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The pre-0.10 `engines` / `defaults` config read as `connections` / `harnesses`.
 *
 * One pure function, two call sites: the loader runs it in memory on every read
 * (`runConfigFilePipeline`) and `akm migrate apply` writes its result back.
 * Whatever it cannot carry over is named in `notes` and dropped. One step per row of
 * the migration table in `docs/reference/configuration.md`; `models.json` and the
 * references in strategies, index passes and gates are folded in by their own modules.
 */

import { isRecord } from "../common";
import type { LlmInference } from "../llm-inference";
import {
  convertIndexEngines,
  dropJudgeEngine,
  improveStrategyDefault,
  moveStrategyExecution,
  retargeter,
} from "./convert-engine-references";
import {
  asDict,
  type Conversion,
  type Dict,
  type EngineTarget,
  type Entries,
  str,
  wireFieldsOf,
} from "./convert-engines-shared";
import { foldEngineModels, foldModelsOverlay, type OwnModels } from "./convert-models-overlay";
import { deepMergeConfig } from "./deep-merge";
import { isEnvReference } from "./schema/primitives";

export type { EngineTarget };

export interface ConvertEnginesOptions {
  /** The parsed user `models.json`: alias to engine column to model. */
  readonly modelsOverlay?: unknown;
  /**
   * The connections and harnesses an `extends` base defines (read without the overlay): models.json also names them,
   * and a partial entry written beside the base is how what it places there outlives the file.
   */
  readonly inherited?: { readonly connections?: Dict; readonly harnesses?: Dict };
  /** Where an engine's implicit key variable (`AKM_ENGINE_<NAME>_API_KEY`, `AKM_LLM_API_KEY`) is looked for; one that is set becomes the connection's `$VAR` key. */
  readonly env?: NodeJS.ProcessEnv;
}

/** A key an engine kept in a file or the secret store, or as a literal, which a connection cannot carry: it belongs in `credentials.json`. */
export interface EngineKey {
  /** The engine that held it. */
  readonly engine: string;
  /** The connection it became, which names the `credentials.json` entry. */
  readonly connection: string;
  readonly field: "apiKey" | "apiKeyFile";
}

export interface ConvertEnginesResult {
  readonly config: Dict;
  readonly notes: string[];
  /** Whether `raw` held anything of the retired form. */
  readonly changed: boolean;
  /** The keys `config` does not carry; their values are still in `raw`. */
  readonly keys: readonly EngineKey[];
  /** What each engine of `raw` became, under the name it has now; a runtime with no connection behind it has none. */
  readonly targets: Readonly<Record<string, EngineTarget>>;
}

const LLM_ENGINE_KEYS = new Set([
  "kind",
  "provider",
  "endpoint",
  "model",
  "apiKey",
  "apiKeyFile",
  "temperature",
  "maxTokens",
  "timeoutMs",
  "concurrency",
  "supportsJsonSchema",
  "extraParams",
  "contextLength",
  "enableThinking",
  "reasoningEffort",
]);
const AGENT_ENGINE_KEYS = new Set([
  "kind",
  "platform",
  "bin",
  "args",
  "workspace",
  "model",
  "agent",
  "timeoutMs",
  "llmEngine",
]);
const CARRIED = ["endpoint", "contextLength", "timeoutMs", "concurrency"] as const;

/**
 * The environment variable an engine's key used to be read from without being
 * named in config, when it is set: `AKM_ENGINE_<NAME>_API_KEY` for any engine,
 * and `AKM_LLM_API_KEY` for the engine `defaults.llmEngine` named.
 */
function implicitKeyVariable(name: string, defaults: Dict, env: NodeJS.ProcessEnv | undefined): string | undefined {
  const own = `AKM_ENGINE_${name.toUpperCase().replaceAll("-", "_")}_API_KEY`;
  if (env?.[own]?.trim()) return own;
  if (name === str(defaults.llmEngine) && env?.AKM_LLM_API_KEY?.trim()) return "AKM_LLM_API_KEY";
  return undefined;
}

/** The connections and harnesses the engines became, under the names they had, and what the later steps need of them. */
interface Converted {
  readonly connections: Dict;
  readonly harnesses: Dict;
  /** The removed opencode-sdk engines, each with its `llmEngine`. */
  readonly runtimes: Map<string, string | undefined>;
  /** The engines whose key a connection cannot carry. */
  readonly keyHolders: Array<{ engine: string; field: EngineKey["field"] }>;
  /** An engine's own model: what an alias nothing else names falls back to. */
  readonly ownModelOf: Array<{ kind: "connections" | "harnesses"; engine: string; model: string }>;
}

/** The entries as `connections` / `harnesses` now name them, and how an old engine name maps to them. */
interface Naming {
  readonly defaultConnection: string | undefined;
  readonly defaultHarness: string | undefined;
  readonly newName: (name: string, from: string | undefined) => string;
  readonly connections: Dict;
  readonly harnesses: Dict;
  readonly keys: readonly EngineKey[];
  /** The connection or harness an old engine name now is. */
  readonly target: (engine: string) => EngineTarget | undefined;
}

// ── engines → connections / harnesses ────────────────────────────────────────

/** `engines.<name>` with `kind: "agent"` and `platform: "opencode-sdk"`: akm's own runtime has no entry of its own. */
function runtimeEngine(name: string, engine: Dict, converted: Converted, conversion: Conversion): void {
  converted.runtimes.set(name, str(engine.llmEngine));
  conversion.notes.push(
    `engines.${name}: opencode-sdk is akm's own runtime now, with no entry of its own; its model, timeout and workspace are dropped.`,
  );
}

/** `engines.<name>` with `kind: "agent"`, any other platform: `harnesses.<name>`. */
function agentEngineToHarness(name: string, engine: Dict, converted: Converted): void {
  const harness: Dict = { platform: engine.platform };
  for (const key of ["bin", "args", "workspace", "agent", "timeoutMs"])
    if (engine[key] !== undefined) harness[key] = engine[key];
  const model = str(engine.model);
  if (model !== undefined) converted.ownModelOf.push({ kind: "harnesses", engine: name, model });
  converted.harnesses[name] = harness;
}

/**
 * The key of an engine, on its connection: a `$VAR` is kept; a file, a literal or a secret reference cannot be
 * (the key belongs in `credentials.json`); and with none written, the variable it used to be read from implicitly.
 */
function carryEngineKey(
  name: string,
  engine: Dict,
  connection: Dict,
  defaults: Dict,
  env: NodeJS.ProcessEnv | undefined,
  converted: Converted,
): void {
  const apiKey = str(engine.apiKey);
  if (apiKey !== undefined && isEnvReference(apiKey)) connection.apiKey = apiKey;
  else if (apiKey !== undefined || engine.apiKeyFile !== undefined) {
    converted.keyHolders.push({ engine: name, field: engine.apiKeyFile !== undefined ? "apiKeyFile" : "apiKey" });
  } else {
    const variable = implicitKeyVariable(name, defaults, env);
    if (variable !== undefined) connection.apiKey = `$${variable}`;
  }
}

/** `engines.<name>` with `kind: "llm"`: `connections.<name>`. */
function llmEngineToConnection(
  name: string,
  engine: Dict,
  defaults: Dict,
  env: NodeJS.ProcessEnv | undefined,
  converted: Converted,
  conversion: Conversion,
): void {
  const connection: Dict = {};
  for (const key of CARRIED) if (engine[key] !== undefined) connection[key] = engine[key];
  carryEngineKey(name, engine, connection, defaults, env, converted);
  const model = str(engine.model);
  if (model !== undefined) converted.ownModelOf.push({ kind: "connections", engine: name, model });
  if (engine.provider !== undefined) {
    conversion.notes.push(
      `engines.${name}: provider is not a setting any more (akm does not branch on it); it is dropped.`,
    );
  }
  if (engine.supportsJsonSchema === false) {
    conversion.notes.push(
      `engines.${name}: supportsJsonSchema is not a setting any more; akm retries without a schema when the endpoint rejects one.`,
    );
  }
  Object.assign(
    connection,
    wireFieldsOf(
      {
        temperature: engine.temperature,
        maxTokens: engine.maxTokens,
        extraParams: engine.extraParams,
        enableThinking: engine.enableThinking,
        reasoningEffort: engine.reasoningEffort,
      } as LlmInference,
      `engines.${name}`,
      conversion.notes,
    ),
  );
  converted.connections[name] = connection;
}

function convertEngines(
  engines: Dict,
  defaults: Dict,
  env: NodeJS.ProcessEnv | undefined,
  conversion: Conversion,
): Converted {
  const converted: Converted = {
    connections: {},
    harnesses: {},
    runtimes: new Map(),
    keyHolders: [],
    ownModelOf: [],
  };
  for (const [name, engine] of Object.entries(engines)) {
    if (!isRecord(engine)) continue;
    const unknown = Object.keys(engine).filter(
      (k) => !(engine.kind === "agent" ? AGENT_ENGINE_KEYS : LLM_ENGINE_KEYS).has(k),
    );
    if (unknown.length > 0)
      conversion.notes.push(`engines.${name}: dropped ${unknown.join(", ")}, which akm does not read.`);
    if (engine.kind !== "agent") llmEngineToConnection(name, engine, defaults, env, converted, conversion);
    else if (engine.platform === "opencode-sdk") runtimeEngine(name, engine, converted, conversion);
    else agentEngineToHarness(name, engine, converted);
  }
  return converted;
}

// ── the defaults are the entries named `default` ─────────────────────────────

/** `defaults.llmEngine`, else `defaults.engine`: that connection is `default`; `defaults.engine` naming one of several harnesses: that harness is. */
function nameDefaults(defaults: Dict, converted: Converted, conversion: Conversion): Naming {
  const { connections, harnesses, runtimes, keyHolders } = converted;
  const defaultEngine = str(defaults.engine);
  const runtimeLlm = defaultEngine === undefined ? undefined : runtimes.get(defaultEngine);
  const defaultConnection = [str(defaults.llmEngine), defaultEngine, runtimeLlm].find(
    (n) => n !== undefined && n in connections,
  );
  const defaultHarness =
    defaultEngine !== undefined && defaultEngine in harnesses && Object.keys(harnesses).length > 1
      ? defaultEngine
      : undefined;
  const newName = (name: string, from: string | undefined): string =>
    name === from ? "default" : name === "default" && from ? "legacy-default" : name;
  const renamed = (entries: Dict, from: string | undefined): Dict => {
    if (from === undefined || from === "default") return entries;
    return Object.fromEntries(Object.entries(entries).map(([name, entry]) => [newName(name, from), entry]));
  };
  const named = {
    connections: renamed(connections, defaultConnection),
    harnesses: renamed(harnesses, defaultHarness),
  };
  const defaultHarnessName =
    "default" in named.harnesses
      ? "default"
      : Object.keys(named.harnesses).length === 1
        ? Object.keys(named.harnesses)[0]
        : undefined;
  if (defaultHarnessName !== undefined && (defaultEngine === undefined || runtimes.has(defaultEngine))) {
    conversion.notes.push(
      `Agent work ran on akm's own runtime${defaultEngine === undefined ? "" : ` (engines.${defaultEngine})`}; with the harness "${defaultHarnessName}" configured it now runs there. Remove that harness to keep agent work on akm's runtime.`,
    );
  }
  const target = (engine: string): EngineTarget | undefined => {
    if (runtimes.has(engine)) {
      const runtime = runtimes.get(engine);
      return runtime !== undefined && runtime in connections
        ? { connection: newName(runtime, defaultConnection) }
        : undefined;
    }
    if (engine in harnesses) return { harness: newName(engine, defaultHarness) };
    if (engine in connections) return { connection: newName(engine, defaultConnection) };
    return { connection: engine };
  };
  const keys = keyHolders.map(({ engine, field }) => ({
    engine,
    connection: newName(engine, defaultConnection),
    field,
  }));
  return { defaultConnection, defaultHarness, newName, ...named, keys, target };
}

/** What the file writes under `connections` / `harnesses` itself, read with the converted entries: the written entry wins field by field. */
function mergeWritten(out: Dict, naming: Naming): Entries {
  for (const [name, harness] of Object.entries(naming.harnesses)) {
    if ((harness as Dict).platform === name) delete (harness as Dict).platform;
  }
  return {
    connections: deepMergeConfig(naming.connections, asDict(out.connections)) as Dict,
    harnesses: deepMergeConfig(naming.harnesses, asDict(out.harnesses)) as Dict,
  };
}

function ownModelsOf(converted: Converted, naming: Naming): OwnModels {
  const ownModels: OwnModels = { connections: new Map(), harnesses: new Map() };
  for (const { kind, engine, model } of converted.ownModelOf) {
    const from = kind === "connections" ? naming.defaultConnection : naming.defaultHarness;
    ownModels[kind].set(naming.newName(engine, from), model);
  }
  return ownModels;
}

// ── the whole conversion ─────────────────────────────────────────────────────

export function convertEngineConfig(raw: Dict, options: ConvertEnginesOptions = {}): ConvertEnginesResult {
  const out = structuredClone(raw);
  const engines = asDict(out.engines);
  const defaults = asDict(out.defaults);
  const conversion: Conversion = {
    notes: [],
    changed: out.engines !== undefined || out.defaults !== undefined,
  };

  const converted = convertEngines(engines, defaults, options.env, conversion);
  const naming = nameDefaults(defaults, converted, conversion);
  const merged = mergeWritten(out, naming);
  const ownModels = ownModelsOf(converted, naming);
  foldModelsOverlay(options.modelsOverlay, {
    conversion,
    merged,
    ownModels,
    written: { connections: asDict(out.connections), harnesses: asDict(out.harnesses) },
    inherited: { connections: options.inherited?.connections ?? {}, harnesses: options.inherited?.harnesses ?? {} },
    renamed: {
      runtime: [...converted.runtimes.values()]
        .filter((name): name is string => name !== undefined && name in converted.connections)
        .map((name) => naming.newName(name, naming.defaultConnection)),
      connection: (engine) =>
        engine in converted.connections ? naming.newName(engine, naming.defaultConnection) : undefined,
    },
  });
  foldEngineModels(merged, ownModels);

  const retarget = retargeter(conversion, naming.target);
  const improve = out.improve;
  if (isRecord(improve)) moveStrategyExecution(improve, conversion, retarget);
  improveStrategyDefault(out, defaults, improve);
  dropJudgeEngine(out, conversion);
  convertIndexEngines(out, conversion, retarget);

  // Assemble, keeping the file's key order.
  const config: Dict = {};
  let placed = false;
  for (const [key, value] of Object.entries(out)) {
    if (key === "defaults") continue;
    if (key !== "engines" && key !== "connections" && key !== "harnesses") {
      config[key] = value;
    } else if (!placed) {
      placed = true;
      if (Object.keys(merged.connections).length > 0) config.connections = merged.connections;
      if (Object.keys(merged.harnesses).length > 0) config.harnesses = merged.harnesses;
    }
  }
  const targets: Record<string, EngineTarget> = {};
  for (const name of Object.keys(engines).filter((engine) => isRecord(engines[engine]))) {
    const became = naming.target(name);
    if (became !== undefined) targets[name] = became;
  }
  return {
    config: conversion.changed ? config : raw,
    notes: conversion.notes,
    changed: conversion.changed,
    keys: naming.keys,
    targets,
  };
}
