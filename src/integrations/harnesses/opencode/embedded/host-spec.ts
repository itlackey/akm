// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What akm's embedded OpenCode is, apart from how it is carried out
 * (`./sdk-host.ts` builds the real host from a {@link HostSpec}, a test's fake
 * host reads one). It is akm's own agent runtime: it runs the connections its
 * runs bring (`./runner-models.ts`) and no user or project OpenCode config,
 * though OpenCode still reads `~/.agents` and its system config.
 */

import fs from "node:fs";
import type { Plugin } from "@opencode/plugin";
import { getDataDir } from "../../../../core/paths";
import { akmOpencodeDatabasePath } from "../roots";
import { akmPlugin, type SessionRegistry } from "./plugin";
import type { RunnerModels } from "./runner-models";
import { runtimeConfigContent } from "./runtime-config";

/**
 * What akm asks of a new host: the real one is built from this by
 * `./sdk-host.ts`, a test's by a fake.
 */
export interface HostSpec {
  /** Where akm keeps its OpenCode sessions. */
  readonly database: string;
  /** OpenCode config content akm supplies on top of what OpenCode loads. */
  readonly content: Record<string, unknown>;
  readonly plugin: Plugin.Plugin;
}

/** The spec of a new host; `sessions` and `models` are what its plugin reads, `setEnvironment` how it sets a session's environment. */
export function specFor(
  sessions: SessionRegistry,
  models: RunnerModels,
  setEnvironment: (sessionID: string, variables: Record<string, string>) => Promise<void>,
): HostSpec {
  fs.mkdirSync(getDataDir(), { recursive: true });
  return {
    database: akmOpencodeDatabasePath(),
    plugin: akmPlugin(sessions, models, setEnvironment),
    content: runtimeConfigContent(),
  };
}
