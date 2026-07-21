// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Built-in `BundleAdapter` barrel — akm 0.9.0 chunk-2 (WI-A) + the format-family
 * work item (#46).
 *
 * `registerBuiltinAdapters()` registers the concrete adapters onto the
 * `../registry` singleton. ADDITIVE: not called from any production composition
 * root yet (Chunk 3 wires it in when it repoints consumers off the legacy
 * globals). Later work-items add their adapters to the body of this function the
 * same way.
 */

import { registerAdapter } from "../registry";
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
 * Register every built-in adapter onto the shared registry (idempotent —
 * re-registering an id replaces in place). Registration order IS the §1.2
 * install-time probe order: the first adapter whose `looksLikeRoot` fires claims
 * a root, so MORE-SPECIFIC probes register FIRST.
 *
 * Probe-precedence rationale (grounds "cannot shadow the existing three"):
 *
 *  - The three loosest probes — `llm-wiki` (schema.md + pages/), `okf` (root
 *    index.md), `akm` (a placement stash subdir / `.stash`) — stay LAST and in
 *    their established order (`llm-wiki` BEFORE `okf`: a wiki root also carries a
 *    root index.md, so the more-specific wiki probe must win the overlap).
 *  - `akm.looksLikeRoot` fires on ANY root carrying a stash-subdir-named
 *    directory — which includes a `.claude`/`.opencode` tool dir (`commands/`,
 *    `agents/`, `skills/`) and a dotenv bundle (`env/`, `secrets/`). So
 *    `claude` / `opencode` / `dotenv` register AHEAD of `akm`; their tighter
 *    markers (CLAUDE.md+tooldir / AGENTS.md|opencode.json / env-secrets-ONLY)
 *    claim those roots first, and `akm` still wins its own workspace root (which
 *    those tighter probes reject).
 *  - `website-snapshot` (manifest.json), `agent-skills` (a `<name>/SKILL.md`
 *    package), `akm-workflow` (a workflow-shaped top-level file), and `akm-task`
 *    (a schedule-bearing top-level `.yml`) carry disjoint, specific markers that
 *    fire on none of the other roots; they register at the front for clarity.
 *  - `generic-files` is EXPLICIT-CONFIG ONLY (§1.2) — its `looksLikeRoot` never
 *    fires — so it is registered LAST and can never shadow anything.
 */
export function registerBuiltinAdapters(): void {
  // Specific, disjoint markers first.
  registerAdapter(websiteSnapshotAdapter);
  registerAdapter(agentSkillsAdapter);
  // Tool dirs + dotenv BEFORE akm (they share stash-subdir-shaped structure).
  registerAdapter(claudeAdapter);
  registerAdapter(opencodeAdapter);
  registerAdapter(dotenvAdapter);
  // Native akm sub-formats (disjoint content-shape probes).
  registerAdapter(akmWorkflowAdapter);
  registerAdapter(akmTaskAdapter);
  // The three established loose probes, in their established order.
  registerAdapter(llmWikiAdapter);
  registerAdapter(okfAdapter);
  registerAdapter(akmAdapter);
  // Explicit-config fallback (never auto-selected) — last.
  registerAdapter(genericFilesAdapter);
}
