// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm health` document renderer.
 *
 * The handler is a **pure function of the shaped result**. Everything the
 * rich report needs — per-run rows, window-compare deltas, the pending
 * proposal queue, and the window labels — travels in the result itself
 * (`runs`/`deltas`/`report`, populated by `akm health --report`). There is no
 * out-of-band context: an earlier revision bound the proposal queue through
 * module state set by the command right before `output()`, which coupled the
 * renderer to call order and made the command branch on the output format to
 * know when to bind it. Putting the data in the envelope removed both.
 *
 * It registers into the shared per-command registry (D7,
 * `../../output/render-registry.ts`) alongside every other command's `--format
 * md` renderer.
 *
 * Returning `null` falls through to the generic renderer, so a result without
 * the report dataset still renders — generically — instead of erroring or
 * emitting an empty table.
 */

import { registerMdRenderer } from "../../output/render-registry";
import { renderChecksMd, renderPendingProposalsMd, renderRunsDetailMd, renderWindowCompareMd } from "./md-report";
import type { AkmHealthResult } from "./types-result";

function isHealthResult(value: unknown): value is AkmHealthResult {
  return value !== null && typeof value === "object" && "status" in value;
}

/** Each part the result holds, in order, under its heading. */
registerMdRenderer("health", (result) => {
  if (!isHealthResult(result)) return null;
  const sections: [string, string][] = [["Checks", renderChecksMd([...result.hardChecks, ...result.advisories])]];
  if (result.windows && result.windows.length > 0) {
    sections.push(["Window comparison", renderWindowCompareMd(result.windows, result.deltas)]);
  }
  if (result.runs) sections.push(["Runs", renderRunsDetailMd(result.runs)]);
  if (result.report) sections.push(["Pending proposals", renderPendingProposalsMd(result.report.pendingProposals)]);
  return sections.map(([heading, body]) => `## ${heading}\n\n${body}`).join("\n\n");
});
