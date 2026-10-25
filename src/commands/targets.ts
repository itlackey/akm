// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Where akm's work runs, as one table: a row for each configured connection
 * and harness, and a row for each kind of work naming the connection or
 * harness, and the model, it resolves to. The work rows are resolved by the same
 * resolvers the calls use, so the table never disagrees with what a call does.
 *
 * Pure but for the key and PATH lookups it reads. What needs the network or a
 * process (is the endpoint reachable, what does the harness report as its
 * version) is passed in by the caller that wants it: `akm health` supplies
 * them, `akm info` does not.
 */
import {
  type AkmConfig,
  type ConnectionConfig,
  defaultConnection,
  defaultHarness,
  type HarnessConfig,
} from "../core/config/config";
import { readCredential } from "../core/config/credentials";
import { IMPROVE_ENGINE_PROCESSES } from "../core/config/engine-semantics";
import { SHIPPED_ALIAS } from "../core/config/model-aliases";
import { envReferenceName } from "../core/config/schema/primitives";
import { ConfigError } from "../core/errors";
import { defaultWhich, type WhichFn } from "../integrations/agent/detect";
import { resolveTarget } from "../integrations/agent/resolution";
import type { RunnerSpec } from "../integrations/agent/runner";
import { DEFAULT_LOCAL_MODEL } from "../llm/embedder";
import { effectiveEmbedding } from "../llm/embedders/connection";
import { resolveIndexPassExecution } from "../llm/index-passes";
import { resolveImproveExecution } from "./improve/execution";
import { redactUrlCredentials } from "./ui/redact";

/** How a connection's key is held: a `$VAR` that is (not) set in this environment, a `credentials.json` entry, or no key. */
export type KeyState = "env-set" | "env-unset" | "credentials" | "none";

export interface ConnectionRow {
  readonly type: "connection";
  readonly name: string;
  readonly default: boolean;
  readonly endpoint: string;
  readonly key: KeyState;
  /** Whether the endpoint answered; absent when it was not asked. */
  readonly reachable?: boolean;
  readonly error?: string;
  /** The last recorded call, ISO; `null` when none in the window; absent when not looked up. */
  readonly lastUsedAt?: string | null;
}

export interface HarnessRow {
  readonly type: "harness";
  readonly name: string;
  readonly default: boolean;
  readonly platform: string;
  /** Whether its binary is on PATH. */
  readonly installed: boolean;
  /** What `--version` printed; absent when it was not asked or nothing came back. */
  readonly version?: string;
  readonly lastUsedAt?: string | null;
}

/** The kind of work a process row is about. */
export type ProcessName =
  | "improve"
  | "judges"
  | "agents"
  | "extract"
  | "enrich"
  | "index"
  | "embedding"
  | "curate-rerank";

export interface ProcessRow {
  readonly type: "process";
  readonly process: ProcessName;
  /** What it runs on: a connection, a harness, an endpoint of its own, akm's built-in embedder; `null` when it does not run. */
  readonly kind: "connection" | "harness" | "endpoint" | "local" | null;
  readonly target: string | null;
  readonly model: string | null;
  /** Parts of the work that resolve somewhere else, by name (an improve process pinned to another connection). */
  readonly overrides?: readonly string[];
  /** Why it could not be resolved, when something is wrong with the config rather than simply not set up. */
  readonly problem?: string;
}

export type TargetRow = ConnectionRow | HarnessRow | ProcessRow;

export interface TargetsInput {
  readonly config: AkmConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly which?: WhichFn;
  /** Per connection name: whether its endpoint answered. */
  readonly reachability?: ReadonlyMap<string, { reachable: boolean; error?: string }>;
  /** Per harness name: its `--version` output. */
  readonly versions?: ReadonlyMap<string, string | undefined>;
  /** Per connection or harness name: its last recorded call. */
  readonly lastUsed?: ReadonlyMap<string, string>;
}

function keyState(connection: ConnectionConfig, name: string, env: NodeJS.ProcessEnv): KeyState {
  const variable = connection.apiKey === undefined ? undefined : envReferenceName(connection.apiKey);
  if (variable !== undefined) return env[variable]?.trim() ? "env-set" : "env-unset";
  return readCredential(name) !== undefined ? "credentials" : "none";
}

function connectionRows(input: TargetsInput): ConnectionRow[] {
  const { config } = input;
  const defaultName = defaultConnection(config)?.name;
  return Object.entries(config.connections ?? {}).map(([name, connection]) => {
    const reach = input.reachability?.get(name);
    return {
      type: "connection",
      name,
      default: name === defaultName,
      endpoint: redactUrlCredentials(connection.endpoint),
      key: keyState(connection, name, input.env ?? process.env),
      ...(reach ? { reachable: reach.reachable, ...(reach.error ? { error: reach.error } : {}) } : {}),
      ...(input.lastUsed ? { lastUsedAt: input.lastUsed.get(name) ?? null } : {}),
    };
  });
}

/** A harness's binary, as a call to it would resolve it. */
function harnessBin(config: AkmConfig, name: string, harness: HarnessConfig): string {
  try {
    const target = resolveTarget({ config, layers: [{ harness: name }] });
    if (target.kind === "harness") return target.bin;
  } catch {
    // Falls through: nothing to look up.
  }
  return harness.bin ?? harness.platform ?? name;
}

function harnessRows(input: TargetsInput): HarnessRow[] {
  const { config } = input;
  const defaultName = defaultHarness(config)?.name;
  const which = input.which ?? defaultWhich;
  return Object.entries(config.harnesses ?? {}).map(([name, harness]) => {
    const version = input.versions?.get(name);
    return {
      type: "harness",
      name,
      default: name === defaultName,
      platform: harness.platform ?? name,
      installed: Boolean(which(harnessBin(config, name, harness))),
      ...(version ? { version } : {}),
      ...(input.lastUsed ? { lastUsedAt: input.lastUsed.get(name) ?? null } : {}),
    };
  });
}

// ── Work rows ───────────────────────────────────────────────────────────────

type Resolution = { readonly runner?: RunnerSpec; readonly problem?: string };

/** What a resolver says: a runner, nothing (not set up), or what is wrong with the config. */
function attempt(resolve: () => RunnerSpec | null | undefined): Resolution {
  try {
    const runner = resolve();
    return runner ? { runner } : {};
  } catch (err) {
    if (err instanceof ConfigError && (err.code === "LLM_NOT_CONFIGURED" || err.code === "AGENT_NOT_CONFIGURED")) {
      return {};
    }
    return { problem: err instanceof Error ? err.message : String(err) };
  }
}

const sameTarget = (a: Resolution, b: Resolution): boolean =>
  a.runner?.name === b.runner?.name && a.runner?.model === b.runner?.model;

/** A work row from its base resolution and the variants that may resolve somewhere else. */
function runnerRow(
  process: ProcessName,
  base: Resolution,
  variants: ReadonlyArray<readonly [string, Resolution]> = [],
): ProcessRow {
  const overrides = variants.filter(([, variant]) => !sameTarget(variant, base)).map(([name]) => name);
  const problem = base.problem ?? variants.find(([, variant]) => variant.problem)?.[1].problem;
  return {
    type: "process",
    process,
    kind: base.runner?.kind ?? null,
    target: base.runner?.name ?? null,
    model: base.runner?.model ?? null,
    ...(overrides.length > 0 ? { overrides } : {}),
    ...(problem ? { problem } : {}),
  };
}

function embeddingRow(config: AkmConfig): ProcessRow {
  const off: ProcessRow = { type: "process", process: "embedding", kind: null, target: null, model: null };
  if (config.semanticSearchMode === "off") return off;
  const embedding = effectiveEmbedding(config);
  if (embedding?.endpoint === undefined) {
    return {
      ...off,
      kind: "local",
      target: "built-in",
      model: embedding?.localModel ?? DEFAULT_LOCAL_MODEL,
    };
  }
  const served = config.embedding?.endpoint === undefined;
  return {
    ...off,
    kind: served ? "connection" : "endpoint",
    target: served ? (defaultConnection(config)?.name ?? null) : redactUrlCredentials(embedding.endpoint),
    model: embedding.model ?? null,
  };
}

function rerankRow(config: AkmConfig): ProcessRow {
  const rerank = config.search?.curateRerank;
  const on = rerank?.enabled === true && rerank.endpoint !== undefined;
  return {
    type: "process",
    process: "curate-rerank",
    kind: on ? "endpoint" : null,
    target: on ? redactUrlCredentials(rerank.endpoint as string) : null,
    model: on ? (rerank.model ?? null) : null,
  };
}

function processRows(config: AkmConfig): ProcessRow[] {
  const improve = (processName: string, alias: keyof typeof SHIPPED_ALIAS, rest: object = {}): Resolution =>
    attempt(() => resolveImproveExecution({ config, processName, alias: SHIPPED_ALIAS[alias], ...rest })?.runner);
  const gate = config.improve?.qualityGate;
  return [
    runnerRow(
      "improve",
      improve("improve", "improve"),
      IMPROVE_ENGINE_PROCESSES.map((name) => [name, improve(name, "improve")] as const),
    ),
    runnerRow("judges", improve("judge", "judge"), [
      ["triage judgment", improve("triage-judgment", "judge", { process: "triage" })],
      ["quality gate", improve("quality-judge", "judge", gate ? { current: gate } : {})],
    ]),
    runnerRow(
      "agents",
      attempt(() => resolveTarget({ config, layers: [{ model: SHIPPED_ALIAS.agent }] })),
    ),
    runnerRow("extract", improve("extract", "extract")),
    runnerRow("enrich", improve("remember-enrich", "enrich")),
    runnerRow(
      "index",
      attempt(() => resolveIndexPassExecution("memory", config).runner),
    ),
    embeddingRow(config),
    rerankRow(config),
  ];
}

export function targetRows(input: TargetsInput): TargetRow[] {
  return [...connectionRows(input), ...harnessRows(input), ...processRows(input.config)];
}
