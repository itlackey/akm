// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { getHarness } from "../../integrations/harnesses";
/**
 * The pre-0.10 `engines` / `defaults` config read as `connections` / `harnesses`.
 *
 * One pure function, two call sites: the loader runs it in memory on every read
 * (`runConfigFilePipeline`) and `akm migrate apply` writes its result back.
 * Whatever it cannot carry over is named in `notes` and dropped.
 */
import { isRecord } from "../common";
import { inferenceWireFields, type LlmInference } from "../llm-inference";
import { isEnvReference } from "./schema/primitives";

type Dict = Record<string, unknown>;

export interface ConvertEnginesOptions {
  /** The parsed user `models.json`: alias to engine column to model. */
  readonly modelsOverlay?: unknown;
  /** Where an engine's implicit `AKM_ENGINE_<NAME>_API_KEY` is looked for; a variable that is set becomes the connection's `$VAR` key. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface ConvertEnginesResult {
  readonly config: Dict;
  readonly notes: string[];
  /** Whether `raw` held anything of the retired form. */
  readonly changed: boolean;
}

const ALIASES = ["fast", "balanced", "reasoning"] as const;
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

const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const allAliases = (model: string | undefined): Dict | undefined =>
  model === undefined ? undefined : Object.fromEntries(ALIASES.map((alias) => [alias, model]));

/** An overlay entry as a model entry: the bare name, or `{ model, ...fields }` when it sets more. */
function modelEntry(model: string, fields: Dict): unknown {
  return Object.keys(fields).length > 0 ? { model, ...fields } : model;
}

export function convertEngineConfig(raw: Dict, options: ConvertEnginesOptions = {}): ConvertEnginesResult {
  const out = structuredClone(raw);
  const notes: string[] = [];
  let changed = false;
  const engines = isRecord(out.engines) ? (out.engines as Dict) : {};
  const defaults = isRecord(out.defaults) ? (out.defaults as Dict) : {};
  if (out.engines !== undefined || out.defaults !== undefined) changed = true;

  // ── engines → connections / harnesses ──────────────────────────────────────
  const connections: Dict = {};
  const harnesses: Dict = {};
  const runtimes = new Map<string, string | undefined>(); // removed opencode-sdk engines → their llmEngine
  for (const [name, engine] of Object.entries(engines)) {
    if (!isRecord(engine)) continue;
    const unknown = Object.keys(engine).filter(
      (k) => !(engine.kind === "agent" ? AGENT_ENGINE_KEYS : LLM_ENGINE_KEYS).has(k),
    );
    if (unknown.length > 0) notes.push(`engines.${name}: dropped ${unknown.join(", ")}, which akm does not read.`);
    if (engine.kind === "agent") {
      if (engine.platform === "opencode-sdk") {
        runtimes.set(name, str(engine.llmEngine));
        notes.push(
          `engines.${name}: opencode-sdk is akm's own runtime now, with no entry of its own; its model, timeout and workspace are dropped.`,
        );
        continue;
      }
      const harness: Dict = { platform: engine.platform };
      for (const key of ["bin", "args", "workspace", "agent", "timeoutMs"])
        if (engine[key] !== undefined) harness[key] = engine[key];
      const models = allAliases(str(engine.model));
      if (models) harness.models = models;
      harnesses[name] = harness;
      continue;
    }
    const connection: Dict = {};
    for (const key of CARRIED) if (engine[key] !== undefined) connection[key] = engine[key];
    const apiKey = str(engine.apiKey);
    if (apiKey !== undefined && isEnvReference(apiKey)) connection.apiKey = apiKey;
    else if (apiKey !== undefined || engine.apiKeyFile !== undefined) {
      notes.push(
        `engines.${name}: its ${engine.apiKeyFile !== undefined ? "apiKeyFile" : "apiKey"} is not read from config any more; \`akm migrate apply\` moves it to credentials.json.`,
      );
    } else {
      const variable = `AKM_ENGINE_${name.toUpperCase().replaceAll("-", "_")}_API_KEY`;
      if (options.env?.[variable]?.trim()) connection.apiKey = `$${variable}`;
    }
    const models = allAliases(str(engine.model));
    if (models) connection.models = models;
    if (engine.supportsJsonSchema === false) {
      notes.push(
        `engines.${name}: supportsJsonSchema is not a setting any more; akm retries without a schema when the endpoint rejects one.`,
      );
    }
    Object.assign(
      connection,
      inferenceWireFields({
        temperature: engine.temperature,
        maxTokens: engine.maxTokens,
        extraParams: engine.extraParams,
        enableThinking: engine.enableThinking,
        reasoningEffort: engine.reasoningEffort,
      } as LlmInference),
    );
    connections[name] = connection;
  }

  // ── the defaults are the entries named `default` ───────────────────────────
  const defaultEngine = str(defaults.engine);
  const runtimeLlm = defaultEngine === undefined ? undefined : runtimes.get(defaultEngine);
  const defaultConnection = [str(defaults.llmEngine), defaultEngine, runtimeLlm].find(
    (n) => n !== undefined && n in connections,
  );
  const defaultHarness =
    defaultEngine !== undefined && defaultEngine in harnesses && Object.keys(harnesses).length > 1
      ? defaultEngine
      : undefined;
  const renamed = (entries: Dict, from: string | undefined): Dict => {
    if (from === undefined || from === "default") return entries;
    return Object.fromEntries(
      Object.entries(entries).map(([name, entry]) => [
        name === from ? "default" : name === "default" ? "legacy-default" : name,
        entry,
      ]),
    );
  };
  const newName = (name: string, from: string | undefined): string =>
    name === from ? "default" : name === "default" && from ? "legacy-default" : name;
  const named = {
    connections: renamed(connections, defaultConnection),
    harnesses: renamed(harnesses, defaultHarness),
  };
  /** The connection or harness an old engine name now is. */
  const target = (engine: string): { connection: string } | { harness: string } | undefined => {
    const runtime = runtimes.get(engine);
    if (runtime !== undefined)
      return runtime in connections ? { connection: newName(runtime, defaultConnection) } : undefined;
    if (engine in harnesses) return { harness: newName(engine, defaultHarness) };
    if (engine in connections) return { connection: newName(engine, defaultConnection) };
    return { connection: engine };
  };

  // ── models.json folds into the models of what it named ─────────────────────
  const overlay =
    isRecord(options.modelsOverlay) && isRecord(options.modelsOverlay.aliases) ? options.modelsOverlay.aliases : {};
  const entries = Object.entries(overlay as Dict).flatMap(([alias, columns]) => {
    if (!isRecord(columns)) return [];
    const flat = Object.fromEntries(
      Object.entries(columns).filter(([k]) => k === "model" || k === "inference" || k === "engine"),
    );
    const perColumn = Object.entries(columns).filter(([k]) => !(k in flat));
    return [...perColumn, ...(Object.keys(flat).length > 0 ? [["*", flat] as const] : [])].map(([column, profile]) => ({
      alias,
      column,
      profile,
    }));
  });
  // The runtime's column is the weakest (it names OpenCode's own models), a connection's own the next, `*` fills what is left.
  const rank = (column: string): number => (column === "opencode-sdk" ? 0 : column === "*" ? 2 : 1);
  entries.sort((a, b) => rank(a.column) - rank(b.column));
  const modelsOf = (entry: Dict): Dict => {
    entry.models ??= {};
    return entry.models as Dict;
  };
  for (const { alias, column, profile } of entries) {
    const p: Dict = typeof profile === "string" ? { model: profile } : isRecord(profile) ? profile : {};
    const { effort, ...portable } = (isRecord(p.inference) ? p.inference : {}) as LlmInference & { effort?: string };
    const wire = inferenceWireFields({ ...portable, reasoningEffort: portable.reasoningEffort ?? effort });
    const where = `models.json ${alias}.${column === "*" ? "(all)" : column}`;
    if (p.engine !== undefined) {
      notes.push(`${where}: an engine indirection is not carried over.`);
      continue;
    }
    const connectionNames =
      column === "*"
        ? Object.keys(named.connections).filter((n) => !(alias in modelsOf(named.connections[n] as Dict)))
        : column === "opencode-sdk"
          ? [...runtimes.values()]
              .filter((n): n is string => n !== undefined && n in connections)
              .map((n) => newName(n, defaultConnection))
          : column in connections
            ? [newName(column, defaultConnection)]
            : [];
    const harnessNames = Object.entries(named.harnesses)
      .filter(([, h]) => (h as Dict).platform === column)
      .map(([n]) => n);
    if (connectionNames.length === 0 && harnessNames.length === 0) {
      notes.push(`${where}: names no configured connection or harness, so it is not carried over.`);
      continue;
    }
    for (const name of connectionNames) {
      const models = modelsOf(named.connections[name] as Dict);
      const existing = models[alias];
      const model = str(p.model) ?? str(isRecord(existing) ? existing.model : existing);
      if (model !== undefined) models[alias] = modelEntry(model, wire);
    }
    for (const name of harnessNames) {
      const harness = named.harnesses[name] as Dict;
      const model = str(p.model) ?? str(getHarness(String(harness.platform))?.models?.[alias]);
      if (model !== undefined) modelsOf(harness)[alias] = model;
      if (Object.keys(wire).length > 0)
        notes.push(`${where}: a harness takes the model only; the inference settings are not carried over.`);
    }
  }

  // ── per-process engine names become connection / harness ───────────────────
  const retarget = (holder: unknown, where: string, harnessOk = true): void => {
    if (!isRecord(holder) || !("engine" in holder)) return;
    changed = true;
    const engine = str(holder.engine);
    delete holder.engine;
    const found = engine === undefined ? undefined : target(engine);
    if (found === undefined) notes.push(`${where}: engine ${JSON.stringify(engine)} is not carried over.`);
    else if ("harness" in found && !harnessOk)
      notes.push(`${where}: index passes run on connections only; engine "${engine}" is not carried over.`);
    else for (const [key, value] of Object.entries(found)) holder[key] ??= value;
  };
  const improve = out.improve;
  if (isRecord(improve) && isRecord(improve.strategies)) {
    for (const [strategyName, strategy] of Object.entries(improve.strategies)) {
      if (!isRecord(strategy)) continue;
      for (const key of ["engine", "model", "llm", "timeoutMs"]) {
        if (key in strategy) {
          delete strategy[key];
          changed = true;
          notes.push(
            `improve.strategies.${strategyName}.${key}: a strategy says which processes run, not where; it is dropped.`,
          );
        }
      }
      for (const [processName, process] of Object.entries(isRecord(strategy.processes) ? strategy.processes : {})) {
        const where = `improve.strategies.${strategyName}.processes.${processName}`;
        retarget(process, `${where}.engine`);
        if (isRecord(process)) {
          retarget(process.qualityGate, `${where}.qualityGate.engine`);
          retarget(process.judgment, `${where}.judgment.engine`);
        }
      }
    }
  }
  if (defaults.improveStrategy !== undefined) {
    out.improve = { ...(isRecord(improve) ? improve : {}) };
    (out.improve as Dict).strategy ??= defaults.improveStrategy;
  }
  const workflow = out.workflow;
  if (isRecord(workflow) && "judgeEngine" in workflow) {
    delete workflow.judgeEngine;
    changed = true;
    notes.push("workflow.judgeEngine: a gate's judge is the default connection or harness now; it is dropped.");
  }
  const index = out.index;
  if (isRecord(index)) {
    const indexDefaults = index.defaults;
    delete index.defaults;
    if (isRecord(indexDefaults)) {
      changed = true;
      retarget(indexDefaults, "index.defaults.engine", false);
      for (const key of ["connection", "model", "timeoutMs", "llm"])
        if (indexDefaults[key] !== undefined) index[key] ??= indexDefaults[key];
    }
    for (const [pass, value] of Object.entries(index))
      if (pass !== "connection") retarget(value, `index.${pass}.engine`, false);
  }

  // ── assemble, keeping the file's key order ─────────────────────────────────
  const config: Dict = {};
  for (const [key, value] of Object.entries(out)) {
    if (key === "defaults") continue;
    if (key !== "engines") {
      config[key] = value;
      continue;
    }
    const merged = { ...(isRecord(out.connections) ? out.connections : {}), ...named.connections };
    const mergedHarnesses = { ...(isRecord(out.harnesses) ? out.harnesses : {}), ...named.harnesses };
    for (const [name, harness] of Object.entries(named.harnesses)) {
      if ((harness as Dict).platform === name) delete (harness as Dict).platform;
    }
    if (Object.keys(merged).length > 0) config.connections = merged;
    if (Object.keys(mergedHarnesses).length > 0) config.harnesses = mergedHarnesses;
  }
  return { config: changed ? config : raw, notes, changed };
}
