// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The opencode agent that runs unattended model work under the model-work
 * tool policy (`MODEL_WORK_TOOLS`). The CLI builder injects it through
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
 *   - every other tool is denied. Each permission opencode knows is named, so
 *     a same-named agent in the user's config cannot re-allow one through
 *     opencode's config merge, and `*` covers the rest.
 * The same rules also go in the top-level `permission`, so an opencode that
 * falls back to its default agent is confined too.
 */

export const MODEL_WORK_OPENCODE_AGENT = "akm-model-work";

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

/** The opencode config fragment that defines and confines the model-work agent. */
export function modelWorkOpencodeConfig(): Record<string, unknown> {
  return {
    permission: { ...MODEL_WORK_PERMISSION },
    agent: {
      [MODEL_WORK_OPENCODE_AGENT]: {
        mode: "primary",
        description: "akm unattended model work: read and edit inside its working directory only.",
        permission: { ...MODEL_WORK_PERMISSION },
      },
    },
  };
}
