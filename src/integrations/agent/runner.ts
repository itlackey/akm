// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { isRecord } from "../../core/common";
import { inferenceWireFields, type LlmInference } from "../../core/llm-inference";

/**
 * What an execution runs on, as `resolveTarget` decided it. Credentials stay
 * symbolic (`apiKey` is the config's `$VAR` reference, or absent for the key held
 * under `name` in `credentials.json`), so this shape can be journaled; the key is
 * read only at dispatch.
 */
export interface ConnectionRunner {
  readonly kind: "connection";
  /** The connection's name; also the name its stored key is filed under. */
  readonly name: string;
  readonly endpoint: string;
  readonly model: string;
  /** Request fields sent as written: the connection's, under the model entry's. */
  readonly request: Readonly<Record<string, unknown>>;
  /** The portable settings the layers that chose this runner set; the client translates them over `request` when it sends. */
  readonly inference?: LlmInference;
  readonly apiKey?: string;
  readonly contextLength?: number;
  readonly concurrency?: number;
  /** `null` runs unbounded. */
  readonly timeoutMs: number | null;
}

export interface HarnessRunner {
  readonly kind: "harness";
  readonly name: string;
  readonly platform: string;
  readonly bin: string;
  readonly args: readonly string[];
  readonly workspace?: string;
  /** The harness's native agent to run when a request names none. */
  readonly agent?: string;
  readonly model?: string;
  /** `null` runs unbounded. */
  readonly timeoutMs: number | null;
}

export type RunnerSpec = ConnectionRunner | HarnessRunner;

/** The engine name an earlier release's runner carries. */
function frozenEngineName(value: Record<string, unknown>): string {
  if (typeof value.engine !== "string") throw new TypeError("a frozen runner must carry an engine name");
  return value.engine;
}

/** A runner a release before the connections rework froze, which cannot be run now. */
function refuseFrozenRunner(why: string): never {
  throw new TypeError(`a frozen runner from an earlier release cannot run now: ${why}; start the run afresh`);
}

/**
 * A `kind: "llm"` runner of an earlier release, as a connection runner. Its
 * inference becomes the request fields it was sent as. Its credential must be an
 * explicit `$VAR`: the implicit `AKM_ENGINE_<NAME>_API_KEY` convention, a key
 * file and a secret-store reference are gone, and a run that relied on one would
 * dispatch without its key.
 */
function readFrozenLlmRunner(value: Record<string, unknown>): ConnectionRunner {
  const connection = value.connection;
  if (!isRecord(connection) || typeof connection.endpoint !== "string" || typeof connection.model !== "string") {
    throw new TypeError("a frozen llm runner must carry connection.endpoint and connection.model");
  }
  if (value.apiKeyFile !== undefined || value.apiKeySecretRef !== undefined) {
    refuseFrozenRunner("it reads its key from a file or the secret store");
  }
  const names = isRecord(value.credential) && Array.isArray(value.credential.names) ? value.credential.names : [];
  if (names.some((name) => typeof name === "string" && name.startsWith("AKM_ENGINE_"))) {
    refuseFrozenRunner("it reads its key from an AKM_ENGINE_* variable");
  }
  const explicit = typeof names[0] === "string" ? names[0] : undefined;
  const inference = connection as LlmInference;
  return {
    kind: "connection",
    name: frozenEngineName(value),
    endpoint: connection.endpoint,
    model: connection.model,
    request: inferenceWireFields(inference),
    ...(explicit ? { apiKey: `$${explicit}` } : {}),
    ...(typeof connection.contextLength === "number" ? { contextLength: connection.contextLength } : {}),
    timeoutMs: typeof value.timeoutMs === "number" ? value.timeoutMs : null,
  };
}

/** A `kind: "agent"` runner of an earlier release, as a harness runner. */
function readFrozenAgentRunner(value: Record<string, unknown>): HarnessRunner {
  const profile = value.profile;
  if (!isRecord(profile) || typeof profile.name !== "string" || typeof profile.bin !== "string") {
    throw new TypeError("a frozen agent runner must carry profile.name and profile.bin");
  }
  return {
    kind: "harness",
    name: frozenEngineName(value),
    platform: typeof profile.platform === "string" ? profile.platform : profile.name,
    bin: profile.bin,
    args: Array.isArray(profile.args) ? (profile.args as string[]) : [],
    ...(typeof profile.workspace === "string" ? { workspace: profile.workspace } : {}),
    ...(typeof profile.agent === "string" ? { agent: profile.agent } : {}),
    ...(typeof profile.model === "string" ? { model: profile.model } : {}),
    timeoutMs: typeof value.timeoutMs === "number" ? value.timeoutMs : null,
  };
}

/**
 * Read a journaled runner back. A current runner is kept as stored; an earlier
 * release's `llm` and `agent` runners are read as the connection and harness
 * runners they became, and its `sdk` runner, which has no equivalent, is refused
 * so the run starts afresh.
 */
export function decodeFrozenRunnerSpec(value: unknown): RunnerSpec {
  if (!isRecord(value)) throw new TypeError("a frozen runner must be an object");
  switch (value.kind) {
    case "connection":
      if (typeof value.name !== "string" || typeof value.endpoint !== "string" || typeof value.model !== "string") {
        throw new TypeError("a frozen connection runner must carry name, endpoint and model");
      }
      return value as unknown as ConnectionRunner;
    case "harness":
      if (typeof value.name !== "string" || typeof value.platform !== "string" || typeof value.bin !== "string") {
        throw new TypeError("a frozen harness runner must carry name, platform and bin");
      }
      return { args: [], ...value } as unknown as HarnessRunner;
    case "llm":
      return readFrozenLlmRunner(value);
    case "agent":
      return readFrozenAgentRunner(value);
    case "sdk":
      return refuseFrozenRunner("it ran OpenCode as an engine of its own");
    default:
      throw new TypeError("a frozen runner's kind must be connection or harness");
  }
}
