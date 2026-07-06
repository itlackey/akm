// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode SDK harness (#564).
 *
 * Per-harness barrel for the SDK-mode dispatch path:
 *   - agent runner → ./sdk-runner.ts (runOpencodeSdk)
 *
 * It also defines {@link OpencodeSdkHarness}, the {@link AkmHarness} descriptor
 * that `HARNESS_REGISTRY` registers.
 *
 * Unlike the CLI harnesses, the SDK path has no native session logs of its own
 * (`capabilities.sessionLogs = false`): it dispatches via the embedded
 * `@opencode-ai/sdk` and surfaces output directly rather than writing platform
 * session files. It is still detected at setup and migrated from v1 profile
 * names. Canonical id is `'opencode-sdk'` with no alias.
 */

import { BaseHarness, type HarnessCapabilities } from "../types";

export { closeServer, runOpencodeSdk } from "./sdk-runner";

function caps(c: Partial<HarnessCapabilities>): HarnessCapabilities {
  return {
    sessionLogs: false,
    agentDispatch: false,
    detection: false,
    configImport: false,
    runtimeIdentity: false,
    v1Migration: false,
    ...c,
  };
}

/**
 * OpenCode SDK (embedded-SDK dispatch path).
 *
 * Dispatch-only: no native session logs, but detected at setup and migrated
 * from v1 profile names.
 */
export class OpencodeSdkHarness extends BaseHarness {
  readonly id = "opencode-sdk" as const;
  readonly displayName = "OpenCode SDK";
  readonly aliases = [] as const;
  // Decorated v1 profile names like "opencode-sdk-fast" belong to the SDK path.
  protected readonly v1ProfilePrefixes = ["opencode-sdk"] as const;
  // ── Workflow-engine descriptor (plan §"Capability matrix", P2) ────────────
  // Embedded-SDK dispatch on this machine ⇒ local-runner (the matrix's
  // "local (sdk/cli)" row, SDK half).
  readonly pattern = "local-runner" as const;
  // `session.prompt` returns structured SDK events/messages; akm extracts the
  // final message then validates against the node schema ⇒ native-json tier.
  readonly structuredOutput = "native-json" as const;
  // No `resume` flag: session reuse is programmatic — the SDK session id is
  // stored opportunistically on the unit row and passed back to
  // `session.prompt`, not replayed via a CLI flag.
  // No `identityEnv`: the SDK runs in-process; it does not mark a child
  // process environment with a session id of its own.
  readonly capabilities = caps({
    agentDispatch: true,
    detection: true,
    v1Migration: true,
  });
}
