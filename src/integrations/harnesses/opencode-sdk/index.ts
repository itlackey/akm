// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode SDK harness (#564).
 *
 * Per-harness barrel for the SDK-mode dispatch path:
 *   - descriptor → ./harness.ts ({@link OpencodeSdkHarness}, the
 *     {@link AkmHarness} that `HARNESS_REGISTRY` registers)
 *   - agent runner → ./sdk-runner.ts (runOpencodeSdk)
 *
 * The descriptor lives in its own leaf module (`./harness.ts`) rather than
 * here so that the registry can import the class WITHOUT pulling in
 * `./sdk-runner` (and its `core/config` dependency) — see the header of
 * `./harness.ts` for the temporal-dead-zone cycle this avoids. This barrel is
 * the runtime entry point that re-exports both.
 *
 * Unlike the CLI harnesses, the SDK path has no native session logs of its own
 * (`capabilities.sessionLogs = false`): it dispatches via the embedded
 * `@opencode-ai/sdk` and surfaces output directly rather than writing platform
 * session files. It is still detected at setup and migrated from v1 profile
 * names. Canonical id is `'opencode-sdk'` with no alias.
 */

export { OpencodeSdkHarness } from "./harness";
export { closeServer, runOpencodeSdk } from "./sdk-runner";
