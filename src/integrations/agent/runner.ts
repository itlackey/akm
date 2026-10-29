// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { isRecord } from "../../core/common";
import type { LlmInference } from "../../core/llm-inference";

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
  /**
   * `false`: only an `extends` base defines this connection, so its endpoint is the base's and it never uses a key
   * stored on this host. Decided once, by `resolveTarget`; absent means it may.
   */
  readonly storedKey?: boolean;
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

/**
 * Read a journaled runner back. A current runner is kept as stored. An earlier
 * release's `llm`, `agent` and `sdk` runners are not read: they fall through to
 * the last case and the plan that holds one cannot be decoded, so its run starts
 * afresh.
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
    default:
      throw new TypeError("a frozen runner's kind must be connection or harness");
  }
}
