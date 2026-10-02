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
 *   - read and edit stay inside the session directory (`external_directory`
 *     is denied). Write is part of opencode's edit permission, so it is
 *     confined the same way and cannot be denied on its own.
 *   - bash is denied, so `akm search` and `akm show` are not granted: opencode
 *     matches a bash rule against the command's words only, so
 *     `akm show x > ~/stash/asset.md` would pass an `akm show *` rule and
 *     write anywhere.
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
 *   - `steps` bounds the agentic loop. opencode only asks the model to stop
 *     at the limit, so the dispatch timeout bounds one that does not;
 *   - automatic compaction is off, so a long run cannot summarize the task
 *     away.
 *
 * At its step limit opencode sends a "maximum steps" text as a trailing
 * assistant message and still offers the tools. A qwen chat template (LM Studio,
 * llama-server) renders that as a prefill, so the model stops at once with an
 * empty reply, and no opencode setting changes it (`steps` only sets the limit).
 * A run that ends with no answer is asked once more, in its own session, with no
 * tool on offer: `opencode run` has no tools flag, so that turn runs the agent
 * with every permission denied, and opencode offers such an agent no tool.
 */

export const MODEL_WORK_OPENCODE_AGENT = "akm-model-work";

/** The agentic iterations a model-work run may take: a judge answers in one, a generator in a few. */
export const MODEL_WORK_STEPS = 8;

const MODEL_WORK_PROMPT =
  "You do one bounded task for akm. Use tools only to check what the task needs, never repeat a tool call, and reply with exactly what the task asks for.";

const MODEL_WORK_PERMISSION = {
  "*": "deny",
  read: "allow",
  edit: "allow",
  external_directory: "deny",
  bash: "deny",
  doom_loop: "deny",
  glob: "deny",
  grep: "deny",
  list: "deny",
  lsp: "deny",
  question: "deny",
  skill: "deny",
  task: "deny",
  todowrite: "deny",
  webfetch: "deny",
  websearch: "deny",
} as const;

/** Every permission of the policy, denied: the agent of a final turn is offered no tool. */
const MODEL_WORK_FINAL_TURN_PERMISSION = Object.fromEntries(
  Object.keys(MODEL_WORK_PERMISSION).map((name) => [name, "deny"]),
);

/**
 * The opencode config fragment that defines and confines the model-work agent.
 * The agent carries the request's inference options (`model-config.ts`), which
 * apply to its calls only: opencode's own calls on the same model, a title for
 * the session, keep the model's defaults. For the final turn (see the module
 * comment) the same agent has every permission denied.
 */
export function modelWorkOpencodeConfig(options?: Record<string, unknown>, finalTurn = false): Record<string, unknown> {
  const permission = finalTurn ? MODEL_WORK_FINAL_TURN_PERMISSION : MODEL_WORK_PERMISSION;
  return {
    permission: { ...permission },
    compaction: { auto: false },
    agent: {
      [MODEL_WORK_OPENCODE_AGENT]: {
        mode: "primary",
        description: "akm unattended model work: read and edit inside its working directory only.",
        prompt: MODEL_WORK_PROMPT,
        steps: MODEL_WORK_STEPS,
        ...(options ? { options } : {}),
        permission: { ...permission },
      },
    },
  };
}
