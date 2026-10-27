// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The OpenCode 2 process akm's own runtime starts for one run, built the way the
 * opencode harness builds model work on the user's OpenCode 2
 * (`../agent-builder.ts`): `run --standalone --title akm`, the prompt on stdin,
 * the inline config in `OPENCODE_CONFIG_CONTENT`. What differs is that the
 * process is akm's own, so akm sets what a user's OpenCode keeps for itself:
 *
 *   - **The connection is the only provider.** `@ai-sdk/openai-compatible` (which
 *     the binary bundles) at the connection's endpoint, with its key, and the one
 *     model the run was dispatched with, with the context window and output cap the
 *     connection states. The key is not in the config: the config names a 0600
 *     file under akm's runtime directory that holds it (`{file:…}`), so no process
 *     environment holds the key.
 *   - **akm's roots.** OpenCode's config, data, cache and state directories and its
 *     temp directory are akm's (`../roots.ts`), so nothing of the user's OpenCode
 *     is read or written and the sessions land where akm's reader looks. The
 *     inherited `OPENCODE_*` variables are dropped for the same reason.
 *   - **Nothing from outside.** No hosted free models and no model catalog fetch
 *     (a run with no usable provider fails instead of sending its prompt to
 *     OpenCode's service), no project config (`AGENTS.md`, `opencode.json`) and no
 *     Claude Code files (`~/.claude/skills`).
 *   - **The resume sweep is off** because `--standalone` keeps the run to one
 *     process that ends with it and replays nobody's killed sessions.
 *   - **The agent's commands do not see any of this.** The plugin puts the
 *     variables this module sets back to what akm runs in, or removes them, in the
 *     environment of the commands the agent runs: they get the user's directories,
 *     not the runtime's, and no OpenCode setting of akm's (an `opencode` they run
 *     would otherwise load akm's provider and its key file).
 *
 * The run is OpenCode's default agent (or the native agent the request names) with
 * its normal tools, akm's three read tools and the connection's request fields
 * from the plugin (`../../../../assets/opencode/akm-plugin.js`).
 */

import path from "node:path";
import { openAiBaseUrl } from "../../../../core/endpoint-url";
import { effectiveRequestFields } from "../../../../core/llm-inference";
import type { ChatCompletionConfig } from "../../../../llm/client";
import type { AgentDispatchRequest } from "../../harness";

/** The provider the connection is declared as; a process runs one connection, so the name is fixed. */
const PROVIDER = "akm";

/** Where a run's process and the files it reads are. */
export interface RuntimeLocations {
  /** The OpenCode executable. */
  readonly binary: string;
  /** akm's runtime directory (`akmRuntimeDir()`); the XDG roots and the temp directory are under it. */
  readonly directory: string;
  /** The directory holding akm's plugin, which OpenCode loads. */
  readonly pluginDirectory: string;
  /** The argv that runs this akm (`resolveAkmInvocation`), which the plugin's tools call with their arguments appended. */
  readonly akm: readonly string[];
}

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

/**
 * A path as a `{file:…}` reference. OpenCode replaces the reference in the config's text before it parses it, so the
 * path is read with the text's JSON escapes in it (measured on 2.1.4: a path holding a backslash or a quote is not
 * found, and the request goes out with no key). Windows takes forward slashes, so its paths are written with them.
 */
function fileReference(file: string): string {
  return process.platform === "win32" ? file.replaceAll("\\", "/") : file;
}

/** What OpenCode assumes of a model that states no limit. It refuses a model whose limit states only one of the two. */
const DEFAULT_LIMIT = { context: 200_000, output: 32_000 };

/**
 * The inline OpenCode config of a run. `keyFile` is where the connection's key is written for the run, when it has
 * one. `ambient` is the environment the process is started over: the plugin gives the commands the agent runs these
 * values back for the variables the run sets, and removes them where there is none.
 */
export function runtimeConfig(
  connection: ChatCompletionConfig,
  pluginDirectory: string,
  keyFile: string,
  ambient: Readonly<Record<string, string>> = {},
): Record<string, unknown> {
  const requestFields = effectiveRequestFields(connection.request, connection.inference);
  const context = positiveInteger(connection.contextLength);
  const output = positiveInteger(requestFields.max_tokens);
  const limit =
    context === undefined && output === undefined
      ? undefined
      : { context: context ?? DEFAULT_LIMIT.context, output: output ?? DEFAULT_LIMIT.output };
  return {
    plugins: [
      {
        package: pluginDirectory,
        options: {
          requestFields,
          shellEnv: Object.fromEntries(RUNTIME_VARIABLES.map((name) => [name, ambient[name] ?? null])),
        },
      },
    ],
    provider: {
      [PROVIDER]: {
        npm: "@ai-sdk/openai-compatible",
        name: PROVIDER,
        options: {
          baseURL: openAiBaseUrl(connection.endpoint),
          ...(connection.apiKey ? { apiKey: `{file:${fileReference(keyFile)}}` } : {}),
        },
        models: {
          [connection.model]: {
            name: connection.model,
            ...(limit ? { limit } : {}),
          },
        },
      },
    },
  };
}

/**
 * The variables {@link runtimeEnv} sets that the commands the agent runs must not see as set: the runtime's roots (a
 * command would read and write akm's directories instead of the user's) and akm's OpenCode settings (an `opencode` a
 * command runs would load akm's provider and its key file). `AKM_OPENCODE_CLI`, between akm and its plugin, is
 * harmless to a command and is left.
 */
const RUNTIME_VARIABLES = [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "TMPDIR",
  "OPENCODE_DISABLE_FREE_MODELS",
  "OPENCODE_DISABLE_MODELS_FETCH",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_CONFIG_CONTENT",
] as const;

/** What a run sets in the process's environment, over the one akm and the caller give every child. */
export function runtimeEnv(config: Record<string, unknown>, where: RuntimeLocations): Record<string, string> {
  const at = (...parts: string[]): string => path.join(where.directory, ...parts);
  return {
    XDG_CONFIG_HOME: at("config"),
    XDG_DATA_HOME: at("data"),
    XDG_CACHE_HOME: at("cache"),
    XDG_STATE_HOME: at("state"),
    TMPDIR: at("tmp"),
    OPENCODE_DISABLE_FREE_MODELS: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    AKM_OPENCODE_CLI: JSON.stringify(where.akm),
  };
}

/**
 * A command that makes and migrates OpenCode's database and does nothing else (it lists the sessions, with no model and
 * no background service), for the first start of a database.
 */
export function runtimePrepareArgv(binary: string): string[] {
  return [binary, "session", "list", "--standalone"];
}

/**
 * The command line of a run; the prompt is not on it, it goes on stdin. `session` is the id the run's session is made
 * with (`--session` makes a session of that id when none has it), so akm finds the session the run left.
 */
export function runtimeArgv(
  connection: ChatCompletionConfig,
  dispatch: AgentDispatchRequest,
  binary: string,
  session: string,
): string[] {
  return [
    binary,
    "run",
    "--standalone",
    "--title",
    "akm",
    "--session",
    session,
    ...(dispatch.agent ? ["--agent", dispatch.agent] : []),
    "--model",
    `${PROVIDER}/${connection.model}`,
  ];
}
