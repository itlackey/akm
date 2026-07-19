// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Fixture-local asset names/refs for the `cli/` golden area (WI-07 — brief
 * §3.2 rule 3, R6). Every ref string that ends up embedded in a committed
 * golden fixture under `tests/fixtures/goldens/cli/*.json` (text-format
 * outputs that necessarily quote a ref back at the user, e.g. `show`'s
 * plain-text rendering or `search`'s hit list) must be sourced from here,
 * never a production ref literal, so Chunk 5's §15.2 grammar codemod can
 * mechanically re-key these fixtures. JSON-shape/key-set goldens generally
 * don't need this (a key-set has no ref inside it), but scenario NAMES used
 * to build sandboxed-stash fixtures still come from here for consistency.
 *
 * Consumers: `tests/commands/goldens-cli-output.test.ts` (families A/D/F),
 * `tests/commands/goldens-cli-health-tasks.test.ts` (families B/C),
 * `tests/commands/goldens-duration-flags.test.ts` (family E).
 */

// ── Family A — search / show / list / info / curate / history / proposal /
//    env / secret / events / config ────────────────────────────────────────

/** `script:` asset used for the baseline show/search text-output cases. */
export const A_SCRIPT_NAME = "cli-a-deploy.sh";
/** `command:` asset (with/without an active workflow, formatShowPlain APPLY branches). */
export const A_COMMAND_NAME = "cli-a-release.md";
/** `skill:` asset — the APPLY-directive branch (activeRun vs no activeRun). */
export const A_SKILL_NAME = "cli-a-ops";
/** `agent:` asset used for the `--shape=agent` / `--shape=summary` show cases. */
export const A_AGENT_NAME = "cli-a-coach.md";
/** `knowledge:` asset used for the per-asset-type show sweep. */
export const A_KNOWLEDGE_NAME = "cli-a-guide.md";
/** `workflow:` asset started to populate an active run for the APPLY-branch scenario. */
export const A_WORKFLOW_NAME = "cli-a-flow";
/** `memory:` asset used for the `history --ref` seeded-usage-events case. */
export const A_MEMORY_NAME = "cli-a-history-subject";
/** `lesson:` asset used to seed a pending proposal for `proposal list|show|diff`. */
export const A_LESSON_NAME = "cli-a-rg-over-grep";

export function scriptRef(name: string = A_SCRIPT_NAME): string {
  return `scripts/${name}`;
}
export function commandRef(name: string = A_COMMAND_NAME): string {
  return `commands/${name}`;
}
export function skillRef(name: string = A_SKILL_NAME): string {
  return `skills/${name}`;
}
export function agentRef(name: string = A_AGENT_NAME): string {
  return `agents/${name}`;
}
export function knowledgeRef(name: string = A_KNOWLEDGE_NAME): string {
  return `knowledge/${name}`;
}
export function workflowRef(name: string = A_WORKFLOW_NAME): string {
  return `workflows/${name}`;
}
export function memoryRef(name: string = A_MEMORY_NAME): string {
  return `memories/${name}`;
}
export function lessonRef(name: string = A_LESSON_NAME): string {
  return `lessons/${name}`;
}

// ── Family B — health ────────────────────────────────────────────────────

export const HEALTH_TASK_ID = "cli-b-task";
export const HEALTH_WINDOW_A_NAME = "cli-b-window-a";
export const HEALTH_WINDOW_B_NAME = "cli-b-window-b";

// ── Family C — tasks ─────────────────────────────────────────────────────

/** Command-type task id that runs the always-succeeding `true` shell builtin. */
export const TASK_TRUE_ID = "cli-c-true-task";

// ── Family E — duration flags ────────────────────────────────────────────

/** Memory used by the `resolveRelativeDates` phrase-grammar unit goldens. */
export const DURATION_RELATIVE_MEMORY_NAME = "cli-e-relative-dates";
/** Memory used by `parseSinceToIso` / `narrowToIncrementalCandidates` unit goldens. */
export const DURATION_SINCE_MEMORY_NAME = "cli-e-since-fallback";
