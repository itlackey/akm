// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Identity-passthrough commands — registered here so the registry stays
// exhaustive (v1 spec §9). Each result object is already shaped at the
// command boundary; the registry just confirms there's no surprise
// command name slipping through.
import { registerOutputShape } from "./registry";

const passthrough = (result: unknown) => result;

const PASSTHROUGH_COMMANDS = [
  "add",
  "clone",
  "config",
  "curate",
  "disable",
  "enable",
  "feedback",
  "health",
  "import",
  "index",
  "info",
  "init",
  "list",
  "registry-add",
  "registry-build-index",
  "registry-list",
  "registry-remove",
  "remember",
  "remove",
  "save",
  "update",
  "upgrade",
  "vault-create",
  "vault-list",
  "vault-set",
  "vault-unset",
  "wiki-create",
  "wiki-ingest",
  "wiki-lint",
  "wiki-list",
  "wiki-pages",
  "wiki-register",
  "wiki-remove",
  "wiki-show",
  "wiki-stash",
  "workflow-complete",
  "workflow-create",
  "workflow-list",
  "workflow-next",
  "workflow-resume",
  "workflow-start",
  "workflow-status",
  "workflow-validate",
] as const;

for (const command of PASSTHROUGH_COMMANDS) {
  registerOutputShape(command, passthrough);
}
