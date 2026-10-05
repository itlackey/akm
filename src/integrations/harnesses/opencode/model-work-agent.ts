// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The opencode agent that runs unattended model work under the model-work
 * tool policy (`MODEL_WORK_POLICY_ID`). The CLI builder injects it through
 * `OPENCODE_CONFIG_CONTENT` and selects it with `--agent`; the SDK runner adds
 * it to its server config and names it in the prompt body.
 *
 * What opencode 1.18.25 confines, checked against a local stub:
 *   - read, grep and glob work in the session directory and akm's primary
 *     stash, and nowhere else. edit works in the session directory only: the
 *     stash is denied, by its path without the leading slash, because opencode
 *     matches edit patterns root-relative (to the git root, when the session
 *     directory is in a repository). Write is part of the edit permission.
 *   - `akm_search` and `akm_show` are the akm-opencode plugin's read tools; its
 *     other three are denied. bash is denied: opencode matches a bash rule
 *     against the command's words only, so `akm show x > ~/stash/asset.md`
 *     would pass an `akm show *` rule and write anywhere.
 *   - every other tool is denied, `doom_loop` included (its default, `ask`,
 *     would hang a headless server). Each permission opencode knows is named,
 *     so a same-named agent in the user's config cannot re-allow one through
 *     opencode's config merge, and `*` covers the rest.
 * The same rules also go in the top-level `permission`, so an opencode that
 * falls back to its default agent is confined too.
 *
 * The agent also keeps opencode's coding-assistant defaults out of model work:
 *   - its own short `prompt` replaces the provider's coding prompt, which
 *     tells the model to search extensively; opencode appends a request's
 *     system text after it and never substitutes it;
 *   - it sets no `steps`. At its step limit opencode sends a "maximum steps"
 *     text as a trailing assistant message, which a qwen chat template (LM
 *     Studio, llama-server) renders as the start of the model's reply: LM
 *     Studio then returns nothing and llama-server returns that text as the
 *     answer. The dispatch timeout bounds a run instead;
 *   - automatic compaction is off, so a long run cannot summarize the task
 *     away.
 */

import path from "node:path";
import { resolveStashDir } from "../../../core/common";
import { getStateDir } from "../../../core/paths";

export const MODEL_WORK_OPENCODE_AGENT = "akm-model-work";

const MODEL_WORK_PROMPT =
  "You do one bounded task for akm. Use tools only to check what the task needs, never repeat a tool call, and reply with exactly what the task asks for.";

function modelWorkPermission(stash: string | undefined) {
  return {
    "*": "deny",
    read: "allow",
    grep: "allow",
    glob: "allow",
    edit: { "*": "allow", ...(stash ? { [`${stash.slice(1)}/*`]: "deny" } : {}) },
    external_directory: {
      ...(stash ? { [`${stash}/*`]: "allow" } : {}),
      "~/.local/share/opencode/tool-output/*": "deny",
    },
    akm_search: "allow",
    akm_show: "allow",
    akm_feedback: "deny",
    akm_remember: "deny",
    akm_curate: "deny",
    bash: "deny",
    doom_loop: "deny",
    list: "deny",
    lsp: "deny",
    question: "deny",
    skill: "deny",
    task: "deny",
    todowrite: "deny",
    webfetch: "deny",
    websearch: "deny",
  };
}

/**
 * What an opencode model-work dispatch gives the akm-opencode plugin (it comes from the user's opencode config and gives
 * the model `akm_search` and `akm_show`): its own switches off, and its state in akm's state directory, the same for every
 * dispatch because an SDK server outlives its dispatch. win32 has no /bin/true, so the plugin keeps its CLI there.
 */
export function modelWorkPluginEnv(): Record<string, string> {
  return {
    AKM_AUTO_CURATE: "0",
    AKM_AUTO_LEARNING: "0",
    AKM_AUTO_SKILL_PROPOSALS: "0",
    AKM_WRITE_GATE: "off",
    XDG_STATE_HOME: path.join(getStateDir(), "opencode-model-work"),
    ...(process.platform === "win32" ? {} : { AKM_OPENCODE_CLI: "/bin/true" }),
  };
}

/**
 * The opencode config fragment that defines and confines the model-work agent.
 * The agent carries the request's inference options (`model-config.ts`), which
 * apply to its calls only: opencode's own calls on the same model, a title for
 * the session, keep the model's defaults.
 */
export function modelWorkOpencodeConfig(options?: Record<string, unknown>): Record<string, unknown> {
  let stash: string | undefined;
  try {
    stash = resolveStashDir();
  } catch {
    // akm has no stash here, so the agent is given no path into one.
  }
  const permission = modelWorkPermission(stash);
  return {
    permission: { ...permission },
    compaction: { auto: false },
    agent: {
      [MODEL_WORK_OPENCODE_AGENT]: {
        mode: "primary",
        description: "akm unattended model work: read and edit inside its working directory only.",
        prompt: MODEL_WORK_PROMPT,
        ...(options ? { options } : {}),
        permission: { ...permission },
      },
    },
  };
}
