// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Identity-passthrough commands — registered here so the registry stays
// exhaustive (v1 spec §9). Each result object is already shaped at the
// command boundary; the registry just confirms there's no surprise
// command name slipping through.
import type { OutputShapeEntry } from "./registry";

// #484: stamp schemaVersion + shape discriminator on passthrough envelopes so
// third-party consumers can pin a schema version and dispatch on shape uniformly.
// #918: also stamp `ok: true` so a caller branching on `.ok` sees the same
// field on every success envelope that it sees on the `{ok:false,...}` error
// envelope. Never overwrites an existing `shape`, `schemaVersion`, or `ok`;
// a command whose exit code grades the outcome emits through
// `outputWithExitCode` (src/cli/shared.ts), which sets `ok` from that code.
//
// Builds a shallow copy rather than mutating `result` in place: several
// command results (e.g. `akm task sync --dry-run`'s `SchedulerPlanPreview`,
// see src/tasks/scheduler-sync-preview.ts) are deliberately `Object.freeze`d
// by their producer as an immutability guarantee, and an in-place `obj.shape
// = …` assignment throws ("Attempting to define property on object that is
// not extensible") the moment it hits one. Copying tolerates both frozen and
// mutable inputs uniformly, and `output()` never uses the result's identity
// past this call, so a copy is safe here.
function makeStampHandler(command: string) {
  return (result: unknown): unknown => {
    if (result === null || result === undefined) return result;
    if (typeof result !== "object" || Array.isArray(result)) return result;
    const obj = result as Record<string, unknown>;
    return {
      // `ok` first so it heads the printed envelope instead of trailing a
      // (possibly large) dump — the spread below still wins with `obj`'s own
      // `ok` value when present, only its position is fixed here.
      ok: obj.ok ?? true,
      ...obj,
      shape: obj.shape ?? command,
      schemaVersion: obj.schemaVersion ?? 1,
    };
  };
}

const PASSTHROUGH_COMMANDS = [
  "add",
  "agent-result",
  "bundle-create",
  "bundle-show",
  "clone",
  "command-dry-run",
  "config",
  "config-diff",
  "env-create",
  "env-export",
  "env-remove",
  "feedback",
  "extract",
  "health",
  "improve",
  "improve-report",
  "import",
  "index",
  "info",
  "lint",
  "list",
  "models",
  "proposal-accept-batch",
  "proposal-drain",
  "proposal-reject-batch",
  "proposal-revert",
  "registry-add",
  "registry-list",
  "registry-remove",
  "remember",
  "remove",
  "secret-set",
  "setup",
  "sync",
  "task-add",
  "task-doctor",
  "task-explain",
  "task-history",
  "task-prune",
  "task-run",
  "task-sync",
  "task-sync-dry-run",
  "task-validate",
  "update",
  "upgrade",
  "workflow-abandon",
  "workflow-create",
  "workflow-list",
  "workflow-plan",
  "workflow-resume",
  "workflow-run",
  "workflow-status",
] as const;

export const passthroughShapes: OutputShapeEntry[] = PASSTHROUGH_COMMANDS.map((command) => ({
  command,
  handler: makeStampHandler(command),
}));
