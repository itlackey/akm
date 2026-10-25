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
 * Model work sets `OPENCODE_DISABLE_FREE_MODELS` (OpenCode 2.1 and later; the
 * variable first appears in the 2.1.2 CLI). With no usable provider, OpenCode 2
 * would otherwise send akm's data to its hosted free model. The variable deletes
 * every zero-cost model of the `opencode` and `opencode-go` providers, so on agent
 * work it would override a model the user chose.
 *
 * OpenCode 2 only: `--standalone` keeps the run to one process that ends with it
 * (the default attaches to a background service that outlives the CLI, is shared
 * across users on one port, ignores inline config and replays killed sessions at
 * every start), and `--title` names the session and spares the second model
 * request that would otherwise generate a title.
 *
 * Model work drops the config's `args`, keeping the model they name, as the
 * Claude and Codex shells do. On OpenCode 2 it runs as {@link MODEL_WORK_AGENT},
 * an agent defined inline for the run with the tools that change files or reach
 * out denied, so nothing is written to the user's files; OpenCode 1 cannot be
 * restricted and runs it unrestricted, with a one-line warning.
 */

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
import { isOpencode2 } from "./version";

/** The read-only agent OpenCode 2 runs akm's model work as; the name also marks those sessions in the user's history (`./session-log-v2.ts`). */
export const MODEL_WORK_AGENT = "akm-model-work";

/**
 * The agent's definition, passed inline so it merges over the user's config and is never written anywhere. Measured
 * on OpenCode 2.1.2: it leaves `glob`, `grep`, `read` and `skill`. `execute` must be denied, or code could fetch and
 * call OpenCode's worktree and session tools. An entry named for a plugin's tool denies it, so the akm plugin's two
 * tools that write (`akm_feedback`, `akm_remember`) are denied and its `akm_search`, `akm_show` and `akm_curate` stay.
 */
const MODEL_WORK_CONFIG = JSON.stringify({
  agent: {
    [MODEL_WORK_AGENT]: {
      mode: "primary",
      permission: {
        edit: "deny",
        write: "deny",
        bash: "deny",
        task: "deny",
        webfetch: "deny",
        execute: "deny",
        websearch: "deny",
        question: "deny",
        akm_feedback: "deny",
        akm_remember: "deny",
      },
    },
  },
});

const NO_FREE_MODELS = { OPENCODE_DISABLE_FREE_MODELS: "1" };

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
    const oc2Flags = oc2 ? ["--standalone", "--title", "akm"] : [];
    if (req.modelWork) {
      if (!oc2) {
        warnOnce(
          "opencode-1-model-work",
          "OpenCode 1 cannot restrict its tools, so model work on it runs unrestricted, in a scratch directory. OpenCode 2 runs it read-only.",
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
        env: { ...NO_FREE_MODELS, ...(oc2 ? { OPENCODE_CONFIG_CONTENT: MODEL_WORK_CONFIG } : {}) },
        stdin: req.prompt,
      };
    }
    return {
      argv: [bin, ...(req.model ? withoutModelFlag(args) : args), ...oc2Flags, ...agent, ...model],
      stdin: req.prompt,
    };
  },
};
