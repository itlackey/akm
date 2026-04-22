/**
 * Central registry for asset type renderer and action builder maps.
 *
 * Previously these maps lived in `local-search.ts` and were wired into
 * `asset-spec.ts` via a fragile `_setAssetTypeHooks` deferred callback
 * pattern. If `local-search.ts` was imported after `registerAssetType()`
 * calls, hooks would be silently dropped.
 *
 * This module is a simple singleton that both `asset-spec.ts` and
 * `local-search.ts` import from, eliminating the import-order dependency
 * entirely.
 */

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
};

/** Map asset types to action builder functions for search results. */
export const ACTION_BUILDERS: Record<string, (ref: string) => string> = {
  script: (ref) => `akm show ${ref} -> execute the run command`,
  skill: (ref) => `akm show ${ref} -> follow the instructions`,
  command: (ref) => `akm show ${ref} -> fill placeholders and dispatch`,
  agent: (ref) => `akm show ${ref} -> dispatch with full prompt`,
  knowledge: (ref) => `akm show ${ref} -> read reference material`,
  memory: (ref) => `akm show ${ref} -> recall context`,
  workflow: (ref) => `akm workflow next ${ref} -> start or resume the next step`,
  vault: (ref) =>
    `akm vault list ${ref} -> see key names; eval "$(akm vault load ${ref})" -> load values into the current shell (values never echoed)`,
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
