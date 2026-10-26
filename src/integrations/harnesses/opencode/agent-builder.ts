// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode command builder: the `opencode run` CLI of the opencode harness
 * (#1244), for both majors, treated like the Claude and Codex CLIs. The user's
 * OpenCode owns its config, logins and sessions; akm hands it a prompt and reads
 * the reply from stdout.
 *
 * The prompt goes on stdin: `opencode run` alters an argv message (quotes change,
 * inner quotes are escaped) and a prompt that starts with `-` could be taken for
 * a flag; stdin is read verbatim. akm closes it after the write, which the CLI
 * needs: with stdin open it waits for more input.
 *
 * Model work sets `OPENCODE_DISABLE_FREE_MODELS` (OpenCode 2.1.2 and later, where
 * the variable first appears). With no usable provider, OpenCode 2
 * would otherwise send akm's data to its hosted free model. The variable deletes
 * every zero-cost model of the `opencode` and `opencode-go` providers, so on agent
 * work it would override a model the user chose.
 *
 * OpenCode 2 only: `--standalone` keeps the run to one process that ends with it
 * (the default attaches to a background service that outlives the CLI, is shared
 * across users on one port, ignores inline config and replays killed sessions at
 * every start), and `--title` names the session and spares the second model
 * request that would otherwise generate a title. The CLI refuses `--server` with
 * `--standalone`, so agent work whose authored args name `--server` is a
 * configuration error; an authored `--standalone` is kept once.
 *
 * A binary whose version cannot be read runs as OpenCode 1, with one warning that says so.
 *
 * Model work drops the config's `args`, keeping the model they name, as the
 * Claude and Codex shells do. On OpenCode 2 it runs as {@link MODEL_WORK_AGENT},
 * an agent defined inline for the run whose tools are limited to reading and
 * searching, added to the user's own inline config; OpenCode 1 cannot be
 * restricted and runs it unrestricted, with a one-line warning.
 */

import { asRecord, tryParseJson } from "../../../core/common";
import { ConfigError } from "../../../core/errors";
import { warnOnce } from "../../../core/warn";
import {
  type AgentDispatchRequest,
  type BuiltCommand,
  type HarnessBuilder,
  type HarnessSpawn,
  modelFromArgs,
  withoutLeading,
  withoutModelFlag,
} from "../harness";
import { detectOpencodeMajor, isOpencode2 } from "./version";

/** The agent OpenCode 2 runs akm's model work as, limited to reading and searching; the name also marks those sessions in the user's history (`./session-log-v2.ts`). */
export const MODEL_WORK_AGENT = "akm-model-work";

/**
 * The agent's definition, passed inline so it merges over the user's config and is never written anywhere. Its
 * permission map is default-deny with the reading tools allowed after it (the last matching entry wins; measured on
 * OpenCode 2.1.2): `"*": "deny"` removes every tool, one a plugin registers that akm has never heard of included, and
 * the allows give back `read`, `glob` and `grep` and, when the akm plugin is installed, `akm_search`, `akm_show` and
 * `akm_curate`. Nothing else is allowed. This limits the tools; a plugin's own `setup` and hooks still run.
 */
const MODEL_WORK_AGENT_DEFINITION = {
  mode: "primary",
  permission: {
    "*": "deny",
    read: "allow",
    glob: "allow",
    grep: "allow",
    akm_search: "allow",
    akm_show: "allow",
    akm_curate: "allow",
  },
};

const CONFIG_CONTENT_ENV = "OPENCODE_CONFIG_CONTENT";

/**
 * The inline config model work runs with: the user's own `OPENCODE_CONFIG_CONTENT` as it is, with akm's agent set on
 * `agent.akm-model-work`, the one key akm's definition wins. The child's value is built from the parent's, so a
 * provider, model or key the user keeps only there stays. Content that is not a JSON object is left out, with one
 * warning.
 */
function modelWorkConfig(): string {
  const content = process.env[CONFIG_CONTENT_ENV]?.trim();
  const user = content ? asRecord(tryParseJson(content)) : undefined;
  if (content && !user) {
    warnOnce(
      "opencode-config-content",
      `${CONFIG_CONTENT_ENV} is not a JSON object, so OpenCode model work runs without it.`,
    );
  }
  return JSON.stringify({
    ...user,
    agent: { ...asRecord(user?.agent), [MODEL_WORK_AGENT]: MODEL_WORK_AGENT_DEFINITION },
  });
}

const NO_FREE_MODELS = { OPENCODE_DISABLE_FREE_MODELS: "1" };

/** What OpenCode 2 agent work gets besides its authored args: one process that ends with it, and a named session. */
function agentWorkFlags(args: readonly string[]): string[] {
  const server = args.find((arg) => arg === "--server" || arg.startsWith("--server="));
  if (server !== undefined) {
    throw new ConfigError(
      `harnesses.<name>.args names ${server.split("=")[0]}, which the opencode harness does not support: akm runs OpenCode 2 with --standalone so that a stop ends the run and nothing is shared with, or replayed from, a background service, and OpenCode refuses the two together.`,
      "INVALID_CONFIG_FILE",
      "Remove --server from harnesses.<name>.args.",
    );
  }
  return [...(args.includes("--standalone") ? [] : ["--standalone"]), "--title", "akm"];
}

export const opencodeBuilder: HarnessBuilder = {
  build({ bin, args }: HarnessSpawn, req: AgentDispatchRequest): BuiltCommand {
    const agent = req.agent ? ["--agent", req.agent] : [];
    const model = req.model ? ["--model", req.model] : [];
    if (req.prompt === undefined) {
      // An interactive launch is the TUI, which `run` (headless) is not.
      const authored = withoutLeading(args, "run");
      return { argv: [bin, ...(req.model ? withoutModelFlag(authored) : authored), ...agent, ...model] };
    }

    const oc2 = isOpencode2(bin);
    if (!oc2 && detectOpencodeMajor(bin).reportedMajor === undefined) {
      warnOnce(
        `opencode-version-unreadable:${bin}`,
        `Could not read the version of ${bin}, so akm runs it as OpenCode 1: no --standalone (an OpenCode 2 would attach to its shared background service), and model work unrestricted. Check \`${bin} --version\`.`,
      );
    }
    const oc2Flags = oc2 ? ["--standalone", "--title", "akm"] : [];
    if (req.modelWork) {
      if (!oc2) {
        warnOnce(
          "opencode-1-model-work",
          "OpenCode 1 cannot restrict its tools, so model work on it runs unrestricted, in a scratch directory. OpenCode 2 limits its tools to reading and searching.",
        );
      }
      const named = req.model ?? modelFromArgs(args);
      return {
        argv: [
          bin,
          "run",
          ...oc2Flags,
          ...(oc2 ? ["--agent", MODEL_WORK_AGENT] : []),
          ...(named ? ["--model", named] : []),
        ],
        env: { ...NO_FREE_MODELS, ...(oc2 ? { [CONFIG_CONTENT_ENV]: modelWorkConfig() } : {}) },
        stdin: req.prompt,
      };
    }
    return {
      argv: [
        bin,
        ...(req.model ? withoutModelFlag(args) : args),
        ...(oc2 ? agentWorkFlags(args) : []),
        ...agent,
        ...model,
      ],
      stdin: req.prompt,
    };
  },
};
