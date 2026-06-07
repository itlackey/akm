// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Plain-text formatters for command output.
 *
 * Built-in formatters are assembled EXPLICITLY here: each per-command module
 * under `src/output/text/` EXPORTS a pure `TextFormatterEntry[]` (no top-level
 * side effect), and this barrel imports those exports and registers them in a
 * single deterministic, order-independent pass (`BUILT_IN_TEXT_FORMATTERS`).
 * Dropping a module from the assembly array is a COMPILE error, not a silent
 * runtime gap.
 *
 * `formatPlain` dispatches to those formatters. Returning `null` means "no
 * plain rendering available — fall back to YAML".
 *
 * Pure functions — no IO.
 */

import type { DetailLevel } from "./context";
import { addFormatters } from "./text/add";
import { cloneFormatters } from "./text/clone";
import { configFormatters } from "./text/config";
import { curateFormatters } from "./text/curate";
import { distillFormatters } from "./text/distill";
import { enableDisableFormatters } from "./text/enable-disable";
import { envFormatters } from "./text/env";
import { eventsFormatters } from "./text/events";
import { feedbackFormatters } from "./text/feedback";
import { historyFormatters } from "./text/history";
import { importFormatters } from "./text/import";
import { indexFormatters } from "./text/index";
import { infoFormatters } from "./text/info";
import { initFormatters } from "./text/init";
import { listFormatters } from "./text/list";
import { proposalProducerFormatters } from "./text/proposal/producer";
import { proposalFormatters } from "./text/proposal/proposal";
import { getTextFormatterHandler, registerTextFormatters, type TextFormatterEntry } from "./text/registry";
import { registryCommandFormatters } from "./text/registry-commands";
import { rememberFormatters } from "./text/remember";
import { removeFormatters } from "./text/remove";
import { saveFormatters } from "./text/save";
import { searchFormatters } from "./text/search";
import { showFormatters } from "./text/show";
import { updateFormatters } from "./text/update";
import { upgradeFormatters } from "./text/upgrade";
import { wikiFormatters } from "./text/wiki";
import { workflowFormatters } from "./text/workflow";

// Re-export helpers so existing imports from `text.ts` keep working.
export {
  formatAddPlain,
  formatClonePlain,
  formatConfigPlain,
  formatCuratePlain,
  formatDistillPlain,
  formatEventLine,
  formatEventsPlain,
  formatFeedbackPlain,
  formatHistoryPlain,
  formatImportPlain,
  formatIndexPlain,
  formatInfoPlain,
  formatInitPlain,
  formatListPlain,
  formatProposalAcceptPlain,
  formatProposalDiffPlain,
  formatProposalListPlain,
  formatProposalProducerPlain,
  formatProposalRejectPlain,
  formatProposalShowPlain,
  formatRegistryAddPlain,
  formatRegistryBuildIndexPlain,
  formatRegistryListPlain,
  formatRegistryRemovePlain,
  formatRegistrySearchPlain,
  formatRememberPlain,
  formatRemovePlain,
  formatSavePlain,
  formatSearchPlain,
  formatShowPlain,
  formatToggleComponentPlain,
  formatUpdatePlain,
  formatUpgradePlain,
  formatWikiCreatePlain,
  formatWikiIngestPlain,
  formatWikiLintPlain,
  formatWikiListPlain,
  formatWikiPagesPlain,
  formatWikiRegisterPlain,
  formatWikiRemovePlain,
  formatWikiShowPlain,
  formatWikiStashPlain,
  formatWorkflowCreatePlain,
  formatWorkflowListPlain,
  formatWorkflowNextPlain,
  formatWorkflowResumePlain,
  formatWorkflowStatusPlain,
  formatWorkflowValidatePlain,
} from "./text/helpers";
export type { TextFormatterHandler } from "./text/registry";
// Re-export registry API so callers can use this module as the single entry
// point (backward compat).
export { deregisterTextFormatter, registerTextFormatter } from "./text/registry";

// ── Explicit built-in formatter assembly ──────────────────────────────────────
// Each entry below is a pure exported `TextFormatterEntry[]` from a per-command
// module. The set is registered ONCE, deterministically, with no reliance on
// import order. Removing a module from this list removes its registration —
// and because each name is referenced statically, a deleted export fails to
// compile instead of silently disappearing at runtime.
const BUILT_IN_TEXT_FORMATTERS: TextFormatterEntry[] = [
  ...initFormatters,
  ...indexFormatters,
  ...showFormatters,
  ...searchFormatters,
  ...curateFormatters,
  ...wikiFormatters,
  ...workflowFormatters,
  ...listFormatters,
  ...addFormatters,
  ...removeFormatters,
  ...updateFormatters,
  ...upgradeFormatters,
  ...cloneFormatters,
  ...historyFormatters,
  ...eventsFormatters,
  ...proposalFormatters,
  ...proposalProducerFormatters,
  ...distillFormatters,
  ...infoFormatters,
  ...configFormatters,
  ...feedbackFormatters,
  ...rememberFormatters,
  ...importFormatters,
  ...saveFormatters,
  ...enableDisableFormatters,
  ...registryCommandFormatters,
  ...envFormatters,
];

registerTextFormatters(BUILT_IN_TEXT_FORMATTERS);

// ── JSONL output (unchanged — not part of the formatPlain dispatch) ───────────

export function outputJsonl(command: string, shaped: unknown): void {
  if (command === "search" || command === "registry-search") {
    const r = shaped as Record<string, unknown>;
    const hits = Array.isArray(r.hits) ? (r.hits as Record<string, unknown>[]) : [];
    for (const hit of hits) {
      console.log(JSON.stringify(hit));
    }
    const registryHits = Array.isArray(r.registryHits) ? (r.registryHits as Record<string, unknown>[]) : [];
    for (const hit of registryHits) {
      console.log(JSON.stringify(hit));
    }
    return;
  }
  // For non-search commands, output the whole object as a single JSONL line
  console.log(JSON.stringify(shaped));
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

/**
 * Return a plain-text string for commands that are better as short messages,
 * or null to fall through to YAML output.
 */
export function formatPlain(command: string, result: unknown, detail: DetailLevel): string | null {
  const handler = getTextFormatterHandler(command);
  if (handler) {
    return handler(result as Record<string, unknown>, detail);
  }
  return null; // fall through to YAML
}
