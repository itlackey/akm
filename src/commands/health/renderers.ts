// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm health` document renderers.
 *
 * Both handlers are **pure functions of the shaped result**. Everything the
 * rich report needs — per-run rows, window-compare deltas, the pending
 * proposal queue, and the window labels — travels in the result itself
 * (`runs`/`deltas`/`report`, populated by `akm health --report`). There is no
 * out-of-band context: an earlier revision bound the proposal queue through
 * module state set by the command right before `output()`, which coupled the
 * renderer to call order and made the command branch on the output format to
 * know when to bind it. Putting the data in the envelope removed both.
 *
 * The Markdown renderer registers into the shared per-command registry (D7,
 * `../../output/render-registry.ts`) alongside every other command's `--format
 * md` renderer. The HTML renderer does not: `health` was, and remains, the
 * only command with a bespoke HTML report, so `cli/shared.ts` calls
 * {@link renderHealthHtml} directly instead of going through a registry with
 * exactly one possible registrant.
 *
 * Returning `null` falls through to the generic renderer, so a result without
 * the report dataset still renders — generically — instead of erroring or
 * emitting an empty table.
 */

import { renderHtml, resolveTemplatePath } from "../../output/html-render";
import { registerMdRenderer } from "../../output/render-registry";
import { buildHealthHtmlReplacements } from "./html-report";
import { renderRunsDetailMd, renderWindowCompareMd } from "./md-report";
import type { AkmHealthResult } from "./types-result";

function isHealthResult(value: unknown): value is AkmHealthResult {
  return value !== null && typeof value === "object" && "status" in value;
}

registerMdRenderer("health", (result) => {
  if (!isHealthResult(result)) return null;
  if (result.windows && result.windows.length > 0) {
    return renderWindowCompareMd(result.windows, result.deltas);
  }
  if (result.runs) return renderRunsDetailMd(result.runs);
  return null;
});

/** `--format html` renderer for `akm health`, called directly from `cli/shared.ts`. */
export function renderHealthHtml(result: unknown): string | null {
  if (!isHealthResult(result) || !result.report) return null;
  return renderHtml(
    resolveTemplatePath("health"),
    buildHealthHtmlReplacements(result, {
      window: result.report.window,
      compare: result.report.compare,
      comparisonMode: result.report.comparisonMode,
      proposals: result.report.pendingProposals,
      deltas: result.deltas,
    }),
  );
}
