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
 * The environment variables an engine's key used to be read from without being
 * named in config: `AKM_ENGINE_<NAME>_API_KEY` for any engine, and
 * `AKM_LLM_API_KEY` for the engine `defaults.llmEngine` named.
 */
function implicitKeyVariables(name: string, defaults: Dict): string[] {
  const own = `AKM_ENGINE_${name.toUpperCase().replaceAll("-", "_")}_API_KEY`;
  return name === str(defaults.llmEngine) ? [own, "AKM_LLM_API_KEY"] : [own];
}

/** The connections and harnesses the engines became, under the names they had, and what the later steps need of them. */
interface Converted {
  readonly connections: Dict;
  readonly harnesses: Dict;
  /** The removed opencode-sdk engines that ran over an `llmEngine`, each with it: akm's own runtime has no entry of its own. */
  readonly runtimes: Map<string, string>;
  /** The harnesses that were opencode-sdk engines without an `llmEngine`: `models.json` keyed their aliases by `opencode-sdk`. */
  readonly sdkHarnesses: Set<string>;
  /** The engines whose key a connection cannot carry. */
  readonly keyHolders: Array<{ engine: string; field: EngineKey["field"] }>;
  /** An engine's own model: what an alias nothing else names falls back to. */
  readonly ownModelOf: Array<{ kind: "connections" | "harnesses"; engine: string; model: string }>;
}

/**
 * The entries as `connections` / `harnesses` now name them, and how an old engine name maps to them.
 * The two name maps are computed once, one name to one name, and every step reads them: the entries, the
 * keys, the models, the references.
 */
interface Naming {
  readonly defaultConnection: string | undefined;
  readonly defaultHarness: string | undefined;
  readonly connectionName: (name: string) => string;
  readonly harnessName: (name: string) => string;
  readonly connections: Dict;
  readonly harnesses: Dict;
  readonly keys: readonly EngineKey[];
  /** The connection or harness an old engine name now is. */
  readonly target: (engine: string) => EngineTarget | undefined;
}

// ── engines → connections / harnesses ────────────────────────────────────────

/**
 * `engines.<name>` with `kind: "agent"` and `platform: "opencode-sdk"` over an `llmEngine`: OpenCode ran over
 * akm's own connection, which is what akm's own runtime is now, so it has no entry of its own.
 */
function runtimeEngine(
  name: string,
  engine: Dict,
  llmEngine: string,
  converted: Converted,
  conversion: Conversion,
): void {
  converted.runtimes.set(name, llmEngine);
  const dropped = ["model", "timeoutMs", "workspace", "bin", "agent"].filter((key) => engine[key] !== undefined);
  const gone = dropped.length === 0 ? "" : `; its ${dropped.join(", ")} ${dropped.length === 1 ? "is" : "are"} dropped`;
  conversion.notes.push(
    `engines.${name}: opencode-sdk over llmEngine "${llmEngine}" is akm's own runtime over connection "${llmEngine}" now, with no entry of its own${gone}.`,
  );
}

/**
 * `engines.<name>` with `kind: "agent"`: `harnesses.<name>`. An `opencode-sdk` engine with no `llmEngine` ran the
 * user's own OpenCode (provider, model and login from its configuration), which the `opencode` harness runs now.
 */
function agentEngineToHarness(name: string, engine: Dict, converted: Converted): void {
  const sdk = engine.platform === "opencode-sdk";
  const harness: Dict = { platform: sdk ? "opencode" : engine.platform };
  if (sdk) converted.sdkHarnesses.add(name);
  for (const key of ["bin", "args", "workspace", "agent", "timeoutMs"])
    if (engine[key] !== undefined) harness[key] = engine[key];
  const model = str(engine.model);
  if (model !== undefined) converted.ownModelOf.push({ kind: "harnesses", engine: name, model });
  converted.harnesses[name] = harness;
}

/**
 * The key of an engine, on its connection: a `$VAR` is kept; a file, a literal or a secret reference cannot be
 * (the key belongs in `credentials.json`); and with none written, the variable it used to be read from implicitly,
 * when that one is set. When none is, the connection has no key, and a note says which variables 0.9 read.
 */
function carryEngineKey(
  name: string,
  engine: Dict,
  connection: Dict,
  defaults: Dict,
  env: NodeJS.ProcessEnv | undefined,
  converted: Converted,
  conversion: Conversion,
): void {
  const apiKey = str(engine.apiKey);
  if (apiKey !== undefined && isEnvReference(apiKey)) connection.apiKey = apiKey;
  else if (apiKey !== undefined || engine.apiKeyFile !== undefined) {
    converted.keyHolders.push({ engine: name, field: engine.apiKeyFile !== undefined ? "apiKeyFile" : "apiKey" });
  } else {
    const variables = implicitKeyVariables(name, defaults);
    const variable = variables.find((candidate) => env?.[candidate]?.trim());
    if (variable !== undefined) connection.apiKey = `$${variable}`;
    else {
      conversion.notes.push(
        `engines.${name}: it names no key, and ${variables.join(" or ")}, which it used to read when set, is not set here, so the connection has no key. If the endpoint needs one, set the variable and run \`akm setup --api-key-env <VARIABLE>\`, or store the key with \`akm setup\`.`,
      );
    }
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
  carryEngineKey(name, engine, connection, defaults, env, converted, conversion);
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
    sdkHarnesses: new Set(),
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
    const llmEngine = str(engine.llmEngine);
    if (engine.kind !== "agent") llmEngineToConnection(name, engine, defaults, env, converted, conversion);
    else if (engine.platform === "opencode-sdk" && llmEngine !== undefined)
      runtimeEngine(name, engine, llmEngine, converted, conversion);
    else agentEngineToHarness(name, engine, converted);
  }
  return converted;
}

// ── the defaults are the entries named `default` ─────────────────────────────

/**
 * The name each of `names` has once `from` is called `default`. An existing `default` moves aside to
 * `legacy-default`, or the first `legacy-default-<n>` that nothing else (an engine, or an entry the file writes
 * itself under `taken`) already has, so no two entries ever share a name and none is lost.
 */
function renameMap(
  names: readonly string[],
  taken: readonly string[],
  from: string | undefined,
): (name: string) => string {
  const moved = new Map<string, string>();
  if (from !== undefined && from !== "default") {
    moved.set(from, "default");
    if (names.includes("default")) {
      const used = new Set([...names, ...taken]);
      let aside = "legacy-default";
      for (let n = 2; used.has(aside); n += 1) aside = `legacy-default-${n}`;
      moved.set("default", aside);
    }
  }
  return (name) => moved.get(name) ?? name;
}

/** The entry the loader reads as the default: the one called `default`, else the only one. */
const defaultName = (entries: Dict): string | undefined =>
  "default" in entries ? "default" : Object.keys(entries).length === 1 ? Object.keys(entries)[0] : undefined;

/**
 * The engine 0.9 ran agent work on when `defaults.engine` named none and OpenCode was installed: the one called
 * `opencode-sdk`, else a bare OpenCode of the user's own.
 */
const IMPLICIT_AGENT_ENGINE = "opencode-sdk";

/**
 * Where agent work ran when `defaults.engine` named no harness, if that is not where it runs now. A runtime was akm's
 * own; with no `defaults.engine` it was the user's OpenCode, whenever it was installed.
 */
function agentWorkMoved(
  defaultEngine: string | undefined,
  runtimes: ReadonlyMap<string, string>,
  harness: string | undefined,
): string | undefined {
  if (defaultEngine !== undefined) {
    return runtimes.has(defaultEngine) && harness !== undefined
      ? `Agent work ran on akm's own runtime (engines.${defaultEngine}); with the harness "${harness}" configured it now runs there. Remove that harness to keep agent work on akm's runtime.`
      : undefined;
  }
  const ran =
    "Without defaults.engine, agent work ran on your own OpenCode (the implicit fallback), when it was installed";
  return harness !== undefined
    ? `${ran}; with the harness "${harness}" configured it now runs there.`
    : `${ran}; it now runs on akm's own runtime. To keep it on your OpenCode, enable the harness: \`akm setup --harness opencode\`.`;
}

/** `defaults.llmEngine`, else `defaults.engine`: that connection is `default`; `defaults.engine` naming one of several harnesses: that harness is. */
function nameDefaults(defaults: Dict, converted: Converted, conversion: Conversion, written: Entries): Naming {
  const { connections, harnesses, runtimes, sdkHarnesses, keyHolders } = converted;
  const implicit = sdkHarnesses.has(IMPLICIT_AGENT_ENGINE) || runtimes.has(IMPLICIT_AGENT_ENGINE);
  const defaultEngine = str(defaults.engine) ?? (implicit ? IMPLICIT_AGENT_ENGINE : undefined);
  const modelWorkEngine = str(defaults.llmEngine);
  const runtimeLlm = defaultEngine === undefined ? undefined : runtimes.get(defaultEngine);
  const modelWorkRuntimeLlm = modelWorkEngine === undefined ? undefined : runtimes.get(modelWorkEngine);
  const defaultConnection = [modelWorkEngine, modelWorkRuntimeLlm, defaultEngine, runtimeLlm].find(
    (n) => n !== undefined && n in connections,
  );
  const defaultHarness =
    defaultEngine !== undefined && defaultEngine in harnesses && Object.keys(harnesses).length > 1
      ? defaultEngine
      : undefined;
  const connectionName = renameMap(Object.keys(connections), Object.keys(written.connections), defaultConnection);
  const harnessName = renameMap(Object.keys(harnesses), Object.keys(written.harnesses), defaultHarness);
  const renamed = (entries: Dict, name: (engine: string) => string): Dict =>
    Object.fromEntries(Object.entries(entries).map(([engine, entry]) => [name(engine), entry]));
  const named = {
    connections: renamed(connections, connectionName),
    harnesses: renamed(harnesses, harnessName),
  };
  const defaultHarnessName = defaultName(named.harnesses);
  const hasEngines = Object.keys(connections).length + Object.keys(harnesses).length + runtimes.size > 0;
  const moved = hasEngines ? agentWorkMoved(defaultEngine, runtimes, defaultHarnessName) : undefined;
  if (moved !== undefined) conversion.notes.push(moved);
  // `defaults.llmEngine` could name an agent engine, which then ran akm's model work; model work runs on the default
  // connection, else the default harness, whichever engine that was.
  if (modelWorkEngine !== undefined && modelWorkEngine in harnesses) {
    const now = harnessName(modelWorkEngine);
    if (defaultName({ ...named.connections, ...written.connections }) !== undefined || defaultHarnessName !== now) {
      conversion.notes.push(
        `defaults.llmEngine "${modelWorkEngine}" named an agent engine, which ran akm's model work. Model work now runs on the default connection, else the default harness; to keep it on the harness "${now}", set improve.harness to it.`,
      );
    }
  }
  for (const [kind, rename] of [
    ["connections", connectionName],
    ["harnesses", harnessName],
  ] as const) {
    const aside = rename("default");
    if (aside === "default") continue;
    conversion.notes.push(
      `engines.default is now ${kind}.${aside}, and "default" names another engine: an engine: default key is rewritten by \`akm migrate apply\` where it can be, but a script or scheduled command that passes --engine default now reaches the new "default"; change it to the name ${aside}.`,
    );
  }
  const target = (engine: string): EngineTarget | undefined => {
    const runtime = runtimes.get(engine);
    if (runtime !== undefined) return runtime in connections ? { connection: connectionName(runtime) } : undefined;
    if (engine in harnesses) return { harness: harnessName(engine) };
    if (engine in connections) return { connection: connectionName(engine) };
    return { connection: engine };
  };
  const keys = keyHolders.map(({ engine, field }) => ({
    engine,
    connection: connectionName(engine),
    field,
  }));
  return { defaultConnection, defaultHarness, connectionName, harnessName, ...named, keys, target };
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
    ownModels[kind].set(kind === "connections" ? naming.connectionName(engine) : naming.harnessName(engine), model);
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
  const naming = nameDefaults(defaults, converted, conversion, {
    connections: asDict(out.connections),
    harnesses: asDict(out.harnesses),
  });
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
        .filter((name) => name in converted.connections)
        .map((name) => naming.connectionName(name)),
      sdkHarness: [...converted.sdkHarnesses].map((name) => naming.harnessName(name)),
      connection: (engine) => (engine in converted.connections ? naming.connectionName(engine) : undefined),
    },
  });
  foldEngineModels(merged, ownModels);

  const retarget = retargeter(conversion, naming.target);
  const improve = out.improve;
  if (isRecord(improve)) moveStrategyExecution(improve, conversion, retarget);
  improveStrategyDefault(out, defaults, improve);
  dropJudgeEngine(out, conversion, naming.target, defaultName(merged.connections));
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
