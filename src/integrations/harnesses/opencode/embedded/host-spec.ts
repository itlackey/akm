// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What each kind of embedded OpenCode host is: the policy, apart from how it is
 * carried out (`./sdk-host.ts` builds the real host from a {@link HostSpec}, a
 * test's fake host reads one).
 *
 * - The `runtime` host is akm's own agent runtime. It runs the connections its
 *   runs bring (`./runner-models.ts`) and no user or project OpenCode config,
 *   though OpenCode still reads `~/.agents` and its system config.
 * - The `opencode` host is the user's OpenCode: their config directory,
 *   providers and default model, with their logins copied from their own database
 *   (when it exists: akm never creates it) and akm's plugin added.
 */

import fs from "node:fs";
import type { Plugin } from "@opencode/plugin";
import { getDataDir } from "../../../../core/paths";
import { akmOpencodeDatabasePath, opencodeConfigDirOverride, opencodeDatabasePath } from "../roots";
import { akmPlugin, type SessionRegistry } from "./plugin";
import type { RunnerModels } from "./runner-models";
import { runtimeConfigContent } from "./runtime-config";

export type HostKind = "runtime" | "opencode";

/**
 * What akm asks of a new host: the real one is built from this by
 * `./sdk-host.ts`, a test's by a fake. The policy of each kind is decided here
 * ({@link specFor}); the SDK wiring that carries it out is `./sdk-host.ts`.
 */
export interface HostSpec {
  readonly kind: HostKind;
  /** Where akm keeps its OpenCode sessions. */
  readonly database: string;
  /** OpenCode config content akm supplies on top of what OpenCode loads. */
  readonly content?: Record<string, unknown>;
  readonly plugin: Plugin.Plugin;
  /** Cut off from the user's OpenCode: no project or Claude config, and its files under akm's own directories. */
  readonly isolated: boolean;
  /** Whether OpenCode may fetch the model catalog (models.dev); otherwise the bundled snapshot is used. */
  readonly fetchModels: boolean;
  /** The user's OpenCode database, whose logins the host copies into its own at start; the user's file is only read. */
  readonly credentialsFrom?: string;
  /** The user's config directory, when `OPENCODE_CONFIG_DIR` moves it (the embedded OpenCode does not read that variable). */
  readonly configDirectory?: string;
}

/** The spec of a new host of `kind`; `sessions` and `models` are what its plugin reads, `setEnvironment` how it sets a session's environment. */
export function specFor(
  kind: HostKind,
  sessions: SessionRegistry,
  models: RunnerModels,
  setEnvironment: (sessionID: string, variables: Record<string, string>) => Promise<void>,
): HostSpec {
  fs.mkdirSync(getDataDir(), { recursive: true });
  const database = akmOpencodeDatabasePath();
  const plugin = akmPlugin(sessions, models, setEnvironment);
  if (kind === "runtime") {
    return {
      kind,
      database,
      plugin,
      content: runtimeConfigContent(),
      isolated: true,
      fetchModels: false,
    };
  }
  const userDatabase = opencodeDatabasePath();
  const configDirectory = opencodeConfigDirOverride();
  return {
    kind,
    database,
    plugin,
    isolated: false,
    fetchModels: true,
    ...(fs.existsSync(userDatabase) ? { credentialsFrom: userDatabase } : {}),
    ...(configDirectory ? { configDirectory } : {}),
  };
}
