// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Plain-text formatters for command output.
 *
 * Built-in formatters are registered once, in one explicit pass
 * (`BUILT_IN_TEXT_FORMATTERS`). `formatPlain` dispatches to them. Returning
 * `null` means "no plain rendering available"; the caller (`output()` in
 * `src/cli/shared.ts`) falls back to `renderGenericText`'s flat `key=value`
 * rendering of the shaped envelope (`src/output/generic-render.ts`).
 *
 * Pure functions — no IO.
 */

import { type ProjectView, withProjectLine } from "../core/projects";
import type { DetailLevel } from "./context";
import type { OutputCommandName } from "./shapes";
import { writeStdout } from "./stdout";
import { envFormatters } from "./text/env";
import { eventsFormatters } from "./text/events";
import {
  formatAddPlain,
  formatBundleRenamePlain,
  formatBundleShowPlain,
  formatClonePlain,
  formatConfigPlain,
  formatCuratePlain,
  formatFeedbackPlain,
  formatHealthPlain,
  formatImportPlain,
  formatIndexPlain,
  formatInfoPlain,
  formatInitPlain,
  formatLintPlain,
  formatListPlain,
  formatModelsPlain,
  formatModelsSetPlain,
  formatRegistryAddPlain,
  formatRegistryListPlain,
  formatRegistryRemovePlain,
  formatRememberPlain,
  formatRemovePlain,
  formatSearchPlain,
  formatShowPlain,
  formatSyncPlain,
  formatUpdatePlain,
  formatUpgradePlain,
} from "./text/helpers";
import { improveReportFormatters } from "./text/improve-report";
import { metricsFormatters } from "./text/metrics";
import { migrateFormatters } from "./text/migrate";
import { proposalProducerFormatters } from "./text/proposal/producer";
import { proposalFormatters } from "./text/proposal/proposal";
import { getTextFormatterHandler, registerTextFormatters, type TextFormatterEntry } from "./text/registry";
import { workflowFormatters } from "./text/workflow";

const BUILT_IN_TEXT_FORMATTERS: TextFormatterEntry[] = [
  { command: "bundle-create", handler: (r) => formatInitPlain(r) },
  { command: "bundle-rename", handler: (r) => formatBundleRenamePlain(r) },
  { command: "bundle-show", handler: (r) => formatBundleShowPlain(r) },
  { command: "index", handler: (r) => formatIndexPlain(r) },
  { command: "show", handler: (r, detail) => formatShowPlain(r, detail) },
  {
    command: "search",
    handler: (r, detail) => withProjectLine(formatSearchPlain(r, detail), r.project as ProjectView | undefined),
  },
  {
    command: "curate",
    handler: (r, detail) => withProjectLine(formatCuratePlain(r, detail), r.project as ProjectView | undefined),
  },
  ...workflowFormatters,
  { command: "list", handler: (r) => formatListPlain(r) },
  { command: "add", handler: (r) => formatAddPlain(r) },
  { command: "remove", handler: (r) => formatRemovePlain(r) },
  { command: "update", handler: (r) => formatUpdatePlain(r) },
  { command: "upgrade", handler: (r) => formatUpgradePlain(r) },
  { command: "clone", handler: (r) => formatClonePlain(r) },
  ...eventsFormatters,
  ...proposalFormatters,
  ...proposalProducerFormatters,
  { command: "info", handler: (r) => formatInfoPlain(r) },
  { command: "health", handler: (r, detail) => formatHealthPlain(r, detail) },
  ...metricsFormatters,
  ...improveReportFormatters,
  { command: "lint", handler: (r) => formatLintPlain(r) },
  { command: "config", handler: (r) => formatConfigPlain(r) },
  { command: "feedback", handler: (r) => formatFeedbackPlain(r) },
  { command: "remember", handler: (r) => formatRememberPlain(r) },
  { command: "import", handler: (r) => formatImportPlain(r) },
  { command: "sync", handler: (r) => formatSyncPlain(r) },
  { command: "registry-list", handler: (r) => formatRegistryListPlain(r) },
  { command: "registry-add", handler: (r) => formatRegistryAddPlain(r) },
  { command: "registry-remove", handler: (r) => formatRegistryRemovePlain(r) },
  ...envFormatters,
  ...migrateFormatters,
  { command: "models", handler: (r) => formatModelsPlain(r) },
  { command: "models-set", handler: (r) => formatModelsSetPlain(r) },
];

registerTextFormatters(BUILT_IN_TEXT_FORMATTERS);

// ── JSONL output (unchanged — not part of the formatPlain dispatch) ───────────

export function outputJsonl(command: string, shaped: unknown): void {
  if (command === "search") {
    const r = shaped as Record<string, unknown>;
    const results = Array.isArray(r.results) ? (r.results as Record<string, unknown>[]) : [];
    for (const hit of results) {
      writeStdout(JSON.stringify(hit));
    }
    const registryHits = Array.isArray(r.registryHits) ? (r.registryHits as Record<string, unknown>[]) : [];
    for (const hit of registryHits) {
      writeStdout(JSON.stringify(hit));
    }
    return;
  }
  // `curate --pack` is a list of packed items, one record per line.
  if (command === "curate-pack" && Array.isArray(shaped)) {
    for (const record of shaped) writeStdout(JSON.stringify(record));
    return;
  }
  // For non-search commands, output the whole object as a single JSONL line
  writeStdout(JSON.stringify(shaped));
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

/**
 * Return a plain-text string for commands that are better as short messages,
 * or null to fall through to the generic text rendering of the shaped
 * envelope (`renderGenericText`, applied in `output()` in
 * `src/cli/shared.ts` — this module stays dependency-free of that renderer).
 */
export function formatPlain(command: OutputCommandName, result: unknown, detail: DetailLevel): string | null {
  const handler = getTextFormatterHandler(command);
  if (handler) {
    return handler(result as Record<string, unknown>, detail);
  }
  return null;
}
