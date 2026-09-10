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
 * plain rendering available"; the caller (`output()` in `src/cli/shared.ts`)
 * falls back to `renderGenericText`'s flat `key=value` rendering of the
 * shaped envelope (`src/output/generic-render.ts` — NOT `renderGenericMarkdown`;
 * markdown syntax is markup, not plain text, so `text` gets its own generic
 * renderer rather than reusing `md`'s). NOT YAML either: this comment (and
 * the one on `formatPlain` below) used to say the fallback was YAML, but it
 * never was — the fallback was pretty-printed JSON until it became a generic
 * renderer.
 *
 * Pure functions — no IO.
 */

import type { DetailLevel } from "./context";
import type { OutputCommandName } from "./shapes";
import { addFormatters } from "./text/add";
import { bundleCreateFormatters } from "./text/bundle-create";
import { bundleShowFormatters } from "./text/bundle-show";
import { cloneFormatters } from "./text/clone";
import { configFormatters } from "./text/config";
import { curateFormatters } from "./text/curate";
import { envFormatters } from "./text/env";
import { eventsFormatters } from "./text/events";
import { feedbackFormatters } from "./text/feedback";
import { healthFormatters } from "./text/health";
import { importFormatters } from "./text/import";
import { improveReportFormatters } from "./text/improve-report";
import { indexFormatters } from "./text/index";
import { infoFormatters } from "./text/info";
import { lintFormatters } from "./text/lint";
import { listFormatters } from "./text/list";
import { migrateFormatters } from "./text/migrate";
import { modelsFormatters } from "./text/models";
import { proposalProducerFormatters } from "./text/proposal/producer";
import { proposalFormatters } from "./text/proposal/proposal";
import { getTextFormatterHandler, registerTextFormatters, type TextFormatterEntry } from "./text/registry";
import { registryCommandFormatters } from "./text/registry-commands";
import { rememberFormatters } from "./text/remember";
import { removeFormatters } from "./text/remove";
import { searchFormatters } from "./text/search";
import { showFormatters } from "./text/show";
import { syncFormatters } from "./text/sync";
import { updateFormatters } from "./text/update";
import { upgradeFormatters } from "./text/upgrade";
import { workflowFormatters } from "./text/workflow";

// ── Explicit built-in formatter assembly ──────────────────────────────────────
// Each entry below is a pure exported `TextFormatterEntry[]` from a per-command
// module. The set is registered ONCE, deterministically, with no reliance on
// import order. Removing a module from this list removes its registration —
// and because each name is referenced statically, a deleted export fails to
// compile instead of silently disappearing at runtime.
const BUILT_IN_TEXT_FORMATTERS: TextFormatterEntry[] = [
  ...bundleCreateFormatters,
  ...bundleShowFormatters,
  ...indexFormatters,
  ...showFormatters,
  ...searchFormatters,
  ...curateFormatters,
  ...workflowFormatters,
  ...listFormatters,
  ...addFormatters,
  ...removeFormatters,
  ...updateFormatters,
  ...upgradeFormatters,
  ...cloneFormatters,
  ...eventsFormatters,
  ...proposalFormatters,
  ...proposalProducerFormatters,
  ...infoFormatters,
  ...healthFormatters,
  ...improveReportFormatters,
  ...lintFormatters,
  ...configFormatters,
  ...feedbackFormatters,
  ...rememberFormatters,
  ...importFormatters,
  ...syncFormatters,
  ...registryCommandFormatters,
  ...envFormatters,
  ...migrateFormatters,
  ...modelsFormatters,
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
 * or null to fall through to the generic text rendering of the shaped
 * envelope (`renderGenericText`, applied in `output()` in
 * `src/cli/shared.ts` — this module stays dependency-free of that renderer).
 */
export function formatPlain(command: OutputCommandName, result: unknown, detail: DetailLevel): string | null {
  const handler = getTextFormatterHandler(command);
  if (handler) {
    return handler(result as Record<string, unknown>, detail);
  }
  return null; // fall through to the generic text renderer, not YAML
}
