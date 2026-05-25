// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Identity-passthrough commands — registered here so the registry stays
// exhaustive (v1 spec §9). Each result object is already shaped at the
// command boundary; the registry just confirms there's no surprise
// command name slipping through.
import { registerOutputShape } from "./registry";

// #484: stamp schemaVersion + shape discriminator on passthrough envelopes so
// third-party consumers can pin a schema version and dispatch on shape uniformly.
// Idempotent — never overwrites an existing schemaVersion or shape field.
function makeStampHandler(command: string) {
  return (result: unknown): unknown => {
    if (result === null || result === undefined) return result;
    if (typeof result !== "object" || Array.isArray(result)) return result;
    const obj = result as Record<string, unknown>;
    if (obj.shape === undefined) obj.shape = command;
    if (obj.schemaVersion === undefined) obj.schemaVersion = 1;
    return obj;
  };
}

const PASSTHROUGH_COMMANDS = [
  "add",
  "clone",
  "config",
  "curate",
  "db-backups",
  "disable",
  "enable",
  "feedback",
  "graph-summary",
  "health",
  "import",
  "index",
  "info",
  "init",
  "lint",
  "list",
  "registry-add",
  "registry-build-index",
  "registry-list",
  "registry-remove",
  "remember",
  "remove",
  "save",
  "tasks-list",
  "update",
  "upgrade",
  "vault-create",
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
  registerOutputShape(command, makeStampHandler(command));
}
