// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Built-in `BundleAdapter` barrel + the static, frozen `BUILTIN_ADAPTERS` list
 * (normative §12.6) — akm 0.9.0 chunk-2 (WI-A) + the format-family work item
 * (#46).
 *
 * `BUILTIN_ADAPTERS` is the ordered built-in adapter set the registry
 * (`../registry`) exposes via `getAdapters()` / `adapterForId()`. It is a
 * plain frozen array populated at MODULE LOAD — there is no mutable
 * registration step and no load-order dependency, so no production call site
 * (`installations.ts#detectAdapterId`, `provider-utils.ts#detectStashRoot`)
 * depends on anyone first calling a registration function (normative §12.6 —
 * "static frozen `BUILTIN_ADAPTERS` map"). The earlier mutable
 * `registerAdapter` singleton that this replaced is retired.
 */

import { ADAPTER_ID_TABLE } from "../adapter-ids";
import type { BundleAdapter } from "../bundle-adapter";
import { agentSkillsAdapter } from "./agent-skills-adapter";
import { akmAdapter } from "./akm-adapter";
import { akmTaskAdapter } from "./akm-task-adapter";
import { akmWorkflowAdapter } from "./akm-workflow-adapter";
import { claudeAdapter } from "./claude-adapter";
import { dotenvAdapter } from "./dotenv-adapter";
import { genericFilesAdapter } from "./generic-files-adapter";
import { llmWikiAdapter } from "./llm-wiki-adapter";
import { okfAdapter } from "./okf-adapter";
import { opencodeAdapter } from "./opencode-adapter";
import { websiteSnapshotAdapter } from "./website-snapshot-adapter";

export { agentSkillsAdapter } from "./agent-skills-adapter";
export { akmAdapter } from "./akm-adapter";
export { akmTaskAdapter } from "./akm-task-adapter";
export { akmWorkflowAdapter } from "./akm-workflow-adapter";
export { claudeAdapter } from "./claude-adapter";
export { dotenvAdapter } from "./dotenv-adapter";
export { genericFilesAdapter } from "./generic-files-adapter";
export { llmWikiAdapter } from "./llm-wiki-adapter";
export { okfAdapter } from "./okf-adapter";
export { opencodeAdapter } from "./opencode-adapter";
export { websiteSnapshotAdapter } from "./website-snapshot-adapter";

/**
 * Every built-in adapter, frozen in the §1.2 install-time probe order: the first
 * adapter whose `looksLikeRoot` fires claims a root, so MORE-SPECIFIC probes
 * come FIRST. This ARRAY ORDER is the executable probe order (`getAdapters()`
 * returns it verbatim) and is pinned by the conformance suite's ordered-owner
 * matrix — it, not the spec §1.2(3) 5-adapter prose listing, is authoritative
 * for the implemented 11-family set.
 *
 * Probe-precedence rationale (grounds "cannot shadow the existing three"):
 *
 *  - The three loosest probes — `llm-wiki`, `akm`, and `okf` — stay LAST.
 *    Native AKM evidence wins before OKF because AKM Markdown is an OKF
 *    superset; the AKM probe is correspondingly strict enough not to claim an
 *    OKF bundle merely because it contains one familiar directory name.
 *  - `akm.looksLikeRoot` fires on ANY root carrying a stash-subdir-named
 *    directory — which includes a `.claude`/`.opencode` tool dir (`commands/`,
 *    `agents/`, `skills/`) and a dotenv bundle (`env/`, `secrets/`). So
 *    `claude` / `opencode` / `dotenv` come AHEAD of `akm`; their tighter
 *    markers (CLAUDE.md+tooldir / AGENTS.md|opencode.json / env-secrets-ONLY)
 *    claim those roots first, and `akm` still wins its own workspace root (which
 *    those tighter probes reject).
 *  - `website-snapshot` (manifest.json), `agent-skills` (a `<name>/SKILL.md`
 *    package), `akm-workflow` (a workflow-shaped top-level file), and `akm-task`
 *    (a schedule-bearing top-level `.yml`) carry disjoint, specific markers that
 *    fire on none of the other roots; they come at the front for clarity.
 *  - `generic-files` is EXPLICIT-CONFIG ONLY (§1.2) — its `looksLikeRoot` never
 *    fires — so it is LAST and can never shadow anything.
 */
export const BUILTIN_ADAPTERS: readonly BundleAdapter[] = Object.freeze([
  // Specific, disjoint markers first.
  websiteSnapshotAdapter,
  agentSkillsAdapter,
  // Tool dirs + dotenv BEFORE akm (they share stash-subdir-shaped structure).
  claudeAdapter,
  opencodeAdapter,
  dotenvAdapter,
  // Native akm sub-formats (disjoint content-shape probes).
  akmWorkflowAdapter,
  akmTaskAdapter,
  // Loose probes: specific native layouts before the portable OKF baseline.
  llmWikiAdapter,
  akmAdapter,
  okfAdapter,
  // Explicit-config fallback (never auto-selected) — last.
  genericFilesAdapter,
]);

// Construction-time drift guard (#909): ../adapter-ids.ts's ADAPTER_ID_TABLE
// is config's dependency-free mirror of this list, kept out of core/config's
// import graph so config doesn't have to import this (heavier) barrel. Assert
// they match so the mirror can never silently drift — a new/reordered/renamed
// adapter that forgets to update adapter-ids.ts fails loudly here instead of
// quietly breaking config's `components.*.adapter` validation.
{
  const actualIds = BUILTIN_ADAPTERS.map((a) => a.id);
  const expectedIds = [...ADAPTER_ID_TABLE];
  if (actualIds.length !== expectedIds.length || actualIds.some((id, i) => id !== expectedIds[i])) {
    throw new Error(
      `adapter-ids.ts ADAPTER_ID_TABLE (${expectedIds.join(", ")}) does not match ` +
        `BUILTIN_ADAPTERS (${actualIds.join(", ")}) — update adapter-ids.ts to match.`,
    );
  }
}
