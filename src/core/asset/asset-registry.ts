// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Central registry for asset type renderer and action builder maps.
 *
 * Previously these maps lived in `db-search.ts` (then `local-search.ts`) and
 * were wired into `asset-spec.ts` via a fragile `_setAssetTypeHooks` deferred
 * callback pattern. If the search module was imported after
 * `registerAssetType()` calls, hooks would be silently dropped.
 *
 * This module is a simple singleton that both `asset-spec.ts` and
 * `db-search.ts` import from, eliminating the import-order dependency
 * entirely.
 */

import { buildWorkflowAction } from "../../output/renderers";

/** Map asset types to their primary renderer names. */
export const TYPE_TO_RENDERER: Record<string, string> = {
  script: "script-source",
  skill: "skill-md",
  command: "command-md",
  agent: "agent-md",
  knowledge: "knowledge-md",
  lesson: "lesson-md",
  memory: "memory-md",
  workflow: "workflow-md",
  env: "env-file",
  secret: "secret-file",
  wiki: "wiki-md",
  task: "task-yaml",
  session: "session-md",
};

/** Map asset types to action builder functions for search results. */
export const ACTION_BUILDERS: Record<string, (ref: string) => string> = {
  script: (ref) => `akm show ${ref} -> execute the run command`,
  skill: (ref) => `akm show ${ref} -> follow the instructions`,
  command: (ref) => `akm show ${ref} -> fill placeholders and dispatch`,
  agent: (ref) => `akm show ${ref} -> dispatch with full prompt`,
  knowledge: (ref) => `akm show ${ref} -> read reference material`,
  lesson: (ref) => `akm show ${ref} -> read the lesson and apply when_to_use`,
  memory: (ref) => `akm show ${ref} -> recall context`,
  workflow: (ref) => buildWorkflowAction(ref),
  env: (ref) =>
    `akm show ${ref} -> inspect key names; akm env run ${ref} -- <command> -> run with the whole .env injected (the agent-safe path — values never reach stdout). akm env export ${ref} --out <file> writes a sourceable script (values to a file, not stdout).`,
  secret: (ref) =>
    `akm show ${ref} -> name only (value never shown); akm secret path ${ref} -> file path; akm secret run ${ref} <VAR> -- <command> -> run with value injected into $VAR`,
  wiki: (ref) => `akm show ${ref} -> read the wiki page`,
  task: (ref) =>
    `akm tasks show ${ref.replace(/^task:/, "")} -> inspect; akm tasks run <id> -> run now; akm tasks remove <id> -> unschedule`,
  session: (ref) =>
    `akm show ${ref} -> read the session summary; follow the \`access\` frontmatter to open the raw log at \`log_path\``,
};

/**
 * Register a type-to-renderer mapping.
 *
 * Called by `registerAssetType()` in `asset-spec.ts` when a spec includes
 * `rendererName`, or directly by extension code.
 */
export function registerTypeRenderer(type: string, rendererName: string): void {
  TYPE_TO_RENDERER[type] = rendererName;
}

/**
 * Register an action builder for an asset type.
 *
 * Called by `registerAssetType()` in `asset-spec.ts` when a spec includes
 * `actionBuilder`, or directly by extension code.
 */
export function registerActionBuilder(type: string, builder: (ref: string) => string): void {
  ACTION_BUILDERS[type] = builder;
}

/**
 * Lookup table that maps asset types to their renderer name and action
 * builder. Designed to be injectable so tests can isolate renderer behavior
 * without mutating the module-level singleton maps.
 *
 * The default registry simply reads from `TYPE_TO_RENDERER` and
 * `ACTION_BUILDERS`; tests may pass a fresh literal instead.
 */
export interface RendererRegistry {
  rendererNameFor(type: string): string | undefined;
  actionBuilderFor(type: string): ((ref: string) => string) | undefined;
}

export const defaultRendererRegistry: RendererRegistry = {
  rendererNameFor(type) {
    return TYPE_TO_RENDERER[type];
  },
  actionBuilderFor(type) {
    return ACTION_BUILDERS[type];
  },
};
