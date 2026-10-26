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
 *     connection states.
 *   - **akm's roots.** OpenCode's config, data, cache and state directories and its
 *     temp directory are akm's (`../roots.ts`), so nothing of the user's OpenCode
 *     is read or written and the sessions land where akm's reader looks. The
 *     inherited `OPENCODE_*` variables are dropped for the same reason.
 *   - **Nothing from outside.** No hosted free models and no model catalog fetch
 *     (a run with no usable provider fails instead of sending its prompt to
 *     OpenCode's service), and no project config (`AGENTS.md`, `opencode.json`).
 *   - **The resume sweep is off** because `--standalone` keeps the run to one
 *     process that ends with it and replays nobody's killed sessions.
 *
 * Model work runs as the read-only agent of `../agent-builder.ts`; agent work as
 * OpenCode's default agent (or the native agent the request names) with its normal
 * tools. Both get akm's three read tools and the connection's request fields from
 * the plugin (`../../../../assets/opencode/akm-plugin.js`).
 */

import path from "node:path";
import { openAiBaseUrl } from "../../../../core/endpoint-url";
import { effectiveRequestFields } from "../../../../core/llm-inference";
import type { ChatCompletionConfig } from "../../../../llm/client";
import type { AgentDispatchRequest } from "../../harness";
import { MODEL_WORK_AGENT, MODEL_WORK_AGENT_DEFINITION } from "../agent-builder";

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
  /** The akm executable the plugin's tools call. */
  readonly akm: string;
}

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

/** What OpenCode assumes of a model that states no limit. It refuses a model whose limit states only one of the two. */
const DEFAULT_LIMIT = { context: 200_000, output: 32_000 };

/** The inline OpenCode config of a run. */
export function runtimeConfig(
  connection: ChatCompletionConfig,
  modelWork: boolean,
  pluginDirectory: string,
): Record<string, unknown> {
  const requestFields = effectiveRequestFields(connection.request, connection.inference);
  const context = positiveInteger(connection.contextLength);
  const output = positiveInteger(requestFields.max_tokens);
  const limit =
    context === undefined && output === undefined
      ? undefined
      : { context: context ?? DEFAULT_LIMIT.context, output: output ?? DEFAULT_LIMIT.output };
  return {
    plugins: [{ package: pluginDirectory, options: { requestFields } }],
    provider: {
      [PROVIDER]: {
        npm: "@ai-sdk/openai-compatible",
        name: PROVIDER,
        options: {
          baseURL: openAiBaseUrl(connection.endpoint),
          ...(connection.apiKey ? { apiKey: connection.apiKey } : {}),
        },
        models: {
          [connection.model]: {
            name: connection.model,
            ...(limit ? { limit } : {}),
          },
        },
      },
    },
    ...(modelWork ? { agents: { [MODEL_WORK_AGENT]: MODEL_WORK_AGENT_DEFINITION } } : {}),
  };
}

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
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    AKM_OPENCODE_CLI: where.akm,
  };
}

/** The command line of a run; the prompt is not on it, it goes on stdin. */
export function runtimeArgv(
  connection: ChatCompletionConfig,
  dispatch: AgentDispatchRequest,
  binary: string,
): string[] {
  const agent = dispatch.modelWork ? MODEL_WORK_AGENT : dispatch.agent;
  return [
    binary,
    "run",
    "--standalone",
    "--title",
    "akm",
    ...(agent ? ["--agent", agent] : []),
    "--model",
    `${PROVIDER}/${connection.model}`,
  ];
}
