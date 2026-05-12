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

import { buildWorkflowAction } from "../output/renderers";

/** Map asset types to their primary renderer names. */
export const TYPE_TO_RENDERER: Record<string, string> = {
  script: "script-source",
  skill: "skill-md",
  command: "command-md",
  agent: "agent-md",
  knowledge: "knowledge-md",
  memory: "memory-md",
  workflow: "workflow-md",
  vault: "vault-env",
  wiki: "wiki-md",
  task: "task-md",
};

/** Map asset types to action builder functions for search results. */
export const ACTION_BUILDERS: Record<string, (ref: string) => string> = {
  script: (ref) => `akm show ${ref} -> execute the run command`,
  skill: (ref) => `akm show ${ref} -> follow the instructions`,
  command: (ref) => `akm show ${ref} -> fill placeholders and dispatch`,
  agent: (ref) => `akm show ${ref} -> dispatch with full prompt`,
  knowledge: (ref) => `akm show ${ref} -> read reference material`,
  memory: (ref) => `akm show ${ref} -> recall context`,
  workflow: (ref) => buildWorkflowAction(ref),
  vault: (ref) =>
    `akm show ${ref} -> inspect keys; source "$(akm vault path ${ref})" -> load values; akm vault run ${ref} -- <command> -> run with injected env`,
  wiki: (ref) => `akm show ${ref} -> read the wiki page`,
  task: (ref) =>
    `akm tasks show ${ref.replace(/^task:/, "")} -> inspect; akm tasks run <id> -> run now; akm tasks remove <id> -> unschedule`,
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
