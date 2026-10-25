// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The OpenCode harness (#564, #1244): the user's own OpenCode, enabled like the
 * Claude and Codex CLIs. One entry, one lowerer (the persona goes in the prompt;
 * inference is the user's config's to set, and says so), one transport for both
 * majors: its CLI, `opencode run` with the prompt on stdin (./agent-builder.ts).
 * The user's OpenCode owns its config, logins and sessions.
 *
 * Per-harness barrel that gathers the OpenCode integration surfaces:
 *   - session-log reader     → ./session-log.ts   (OpenCodeProvider)
 *   - agent command builder  → ./agent-builder.ts (opencodeBuilder)
 *
 * It also defines {@link OpencodeHarness}, the {@link AkmHarness} descriptor
 * that `HARNESS_REGISTRY` registers.
 *
 * id normalization: OpenCode's canonical id (`'opencode'`) is also its runtime
 * identity and session-log provider name — there is no historical split (unlike
 * Claude Code's 'claude' vs 'claude'), so no alias bridge is needed.
 */

import { XDG_BASE_DIR_ENV_PASSTHROUGH } from "../../../core/spawn-env";
import type { SessionLogHarness } from "../../session-logs/types";
import type { AkmHarness } from "../harness";
import { opencodeBuilder } from "./agent-builder";
import { OpenCodeProvider } from "./session-log";
import { isOpencode2 } from "./version";

export { opencodeBuilder } from "./agent-builder";
export { OpenCodeProvider } from "./session-log";

/**
 * The names an `opencode` process reads beyond the common baseline: its API key
 * (OpenCode Go and Zen read `OPENCODE_API_KEY`), the config file and directory it
 * is pointed at, and the XDG base directories.
 */
const OPENCODE_ENV_PASSTHROUGH = [
  "OPENCODE_API_KEY",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  ...XDG_BASE_DIR_ENV_PASSTHROUGH,
] as const;

/**
 * OpenCode.
 *
 * Canonical id is `'opencode'`; it has no distinct runtime identity or alias.
 */
export class OpencodeHarness implements AkmHarness {
  readonly id = "opencode" as const;
  readonly displayName = "OpenCode";
  // Home-relative config dir scanned by `akm setup` (#567). OpenCode has a
  // session-log provider, so offering it as a stash source is functional.
  readonly setupDetectionDir = ".config/opencode";
  readonly build = opencodeBuilder.build;
  readonly profile = { bin: "opencode", args: ["run"], envPassthrough: OPENCODE_ENV_PASSTHROUGH };
  // ── Workflow-engine descriptor (plan §"Capability matrix", P2) ────────────
  // Session-id env marker for run attribution.
  readonly identityEnv = ["OPENCODE_SESSION_ID"] as const;
  readonly sessionLogProvider = (): SessionLogHarness => new OpenCodeProvider();
  readonly systemPrompt = false;
  readonly nativeAgent = true;
  // Model work is confined (read-only) on OpenCode 2 only: its CLI takes an agent defined inline for the run
  // (./agent-builder.ts), OpenCode 1's cannot be restricted and runs it unrestricted, with a warning.
  // Lowering asks for the confined run either way; setup asks whether the installed OpenCode can give it.
  readonly confinable = true;
  readonly confinableInstalled = () => isOpencode2(this.profile.bin);
}
