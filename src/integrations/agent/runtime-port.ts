// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What akm asks of its own agent runtime, which runs agent work on a connection.
 *
 * The application owns this port and nothing else: lowering needs the target a
 * request is lowered for, and dispatch needs to run one resolved dispatch.
 * Whatever implements it (today a pinned OpenCode 2 binary run as a process,
 * `harnesses/opencode/runtime/`) keeps its program and its configuration to
 * itself, and is given resolved input only: the connection a run was frozen with,
 * with its key already materialized. The implementation is chosen in one place,
 * `./runtime.ts`.
 */

import type { ChatCompletionConfig } from "../../llm/client";
import type { LowerTarget } from "../harnesses/harness";
import type { AgentProfile } from "./profiles";
import type { AgentRunResult, RunAgentOptions } from "./spawn";

export interface AgentRuntime {
  /** What a request is lowered for when it runs here: the persona, agent, confinement and inference the runtime takes. */
  readonly lowering: LowerTarget;
  /** Run one lowered dispatch on `connection`. Reads no config: the connection is the whole of what it is given about the endpoint. */
  run(profile: AgentProfile, opts: RunAgentOptions, connection: ChatCompletionConfig): Promise<AgentRunResult>;
  /** What the runtime still fetches on its first run, in words (what, how large), or undefined once it has it; `akm setup` offers to fetch it then. */
  pendingFetch(): string | undefined;
  /** Fetch it now rather than on the first run. */
  fetch(): Promise<void>;
}
