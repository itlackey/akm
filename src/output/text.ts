/**
 * Plain-text formatters for command output.
 *
 * `formatPlain` dispatches to per-command formatters registered via
 * `registerTextFormatter`. Returning `null` means "no plain rendering
 * available — fall back to YAML".
 *
 * Pure functions — no IO.
 */

import type { DetailLevel } from "./context";
import { getTextFormatterHandler } from "./text/registry";

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
  formatVaultCreatePlain,
  formatVaultListPlain,
  formatVaultSetPlain,
  formatVaultUnsetPlain,
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

// ── Per-command text formatter modules (self-register at import time) ─────────
// Importing these modules triggers their `registerTextFormatter(...)` calls.
import "./text/init";
import "./text/index";
import "./text/show";
import "./text/search";
import "./text/curate";
import "./text/wiki";
import "./text/workflow";
import "./text/list";
import "./text/add";
import "./text/remove";
import "./text/update";
import "./text/upgrade";
import "./text/clone";
import "./text/history";
import "./text/events";
import "./text/proposal";
import "./text/proposal-producer";
import "./text/distill";
import "./text/info";
import "./text/config";
import "./text/feedback";
import "./text/remember";
import "./text/import";
import "./text/save";
import "./text/enable-disable";
import "./text/registry-commands";
import "./text/vault";

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
