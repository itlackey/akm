// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one place akm's agent runtime is chosen. Lowering and dispatch use
 * {@link agentRuntime} and import nothing of the implementation; replacing the
 * runtime is a change to this line and the folder it names.
 */

import { opencodeRuntime } from "../harnesses/opencode/runtime";
import type { AgentRuntime } from "./runtime-port";

export const agentRuntime: AgentRuntime = opencodeRuntime;
