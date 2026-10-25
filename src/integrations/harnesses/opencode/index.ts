// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The OpenCode harness (#564, #1244): the user's own OpenCode, enabled like the
 * Claude and Codex CLIs. One entry, one lowerer (the persona goes in the prompt;
 * inference is the user's config's to set, and says so), two transports chosen
 * when a request is dispatched by the major version of the installed binary:
 *   - OpenCode 1: its CLI, `opencode run` with the prompt on stdin
 *     (./agent-builder.ts).
 *   - OpenCode 2: embedded in akm's process (./embedded/), with the user's
 *     config, providers and logins and their default model, in akm's own
 *     database.
 *
 * Per-harness barrel that gathers the OpenCode integration surfaces:
 *   - session-log reader     → ./session-log.ts   (OpenCodeProvider)
 *   - agent command builder  → ./agent-builder.ts (opencodeBuilder)
 *
 * It also defines {@link OpencodeHarness}, the {@link AkmHarness} descriptor
 * that `HARNESS_REGISTRY` registers. The embedded transport imports `core/config`,
 * which the registry must not load, so it is imported when it runs.
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
import { detectOpencodeMajor } from "./version";

export { opencodeBuilder } from "./agent-builder";
export { OpenCodeProvider } from "./session-log";

/**
 * The names an `opencode` process reads beyond the common baseline: its API key
 * (OpenCode Go and Zen read `OPENCODE_API_KEY`), the config file it is pointed
 * at, and the XDG base directories.
 */
const OPENCODE_ENV_PASSTHROUGH = ["OPENCODE_API_KEY", "OPENCODE_CONFIG", ...XDG_BASE_DIR_ENV_PASSTHROUGH] as const;

/** OpenCode 2 runs embedded; OpenCode 1, and a binary whose version cannot be read, run as the CLI. */
function runsEmbedded(bin: string): boolean {
  const major = detectOpencodeMajor(bin).reportedMajor;
  return major !== undefined && major >= 2;
}

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
  readonly runInProcess: AkmHarness["runInProcess"] = (profile, opts) =>
    runsEmbedded(profile.bin)
      ? import("./embedded/run").then((embedded) => embedded.runOpencodeHarness(profile, opts))
      : undefined;
  readonly systemPrompt = false;
  readonly nativeAgent = true;
  // Model work is confined (read-only) on OpenCode 2 only; OpenCode 1 runs it unrestricted, with a warning.
  // Lowering asks for the confined run either way; setup asks whether the installed OpenCode can give it.
  readonly confinable = true;
  readonly confinableInstalled = () => runsEmbedded(this.profile.bin);
}
