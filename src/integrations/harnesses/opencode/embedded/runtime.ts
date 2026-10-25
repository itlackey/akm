// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The embedded OpenCode as akm's agent runtime: what the application's port
 * (`integrations/agent/runtime-port.ts`) asks of it, and nothing of the SDK.
 *
 * The host and the runner reach akm's read tools, and through them the command
 * layer, so they load when the runtime is used and not when the port is composed.
 * Lowering needs only the target, which is light.
 */

import type { AgentRuntime } from "../../../agent/runtime-port";
import { runtimeLowerer } from "./runtime-lowerer";

export const embeddedOpencodeRuntime: AgentRuntime = {
  lowering: runtimeLowerer,
  run: (profile, opts, connection) =>
    import("./run").then((embedded) => embedded.runOpencodeSdk(profile, opts, connection)),
  dispose: () => import("./host").then((host) => host.closeOpencodeSdk()),
};
