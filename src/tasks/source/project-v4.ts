// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `projectTaskSourceV4()` — the task source v4 -> prepare-seam projection
 * (spec docs/plans/specs/p2a-task-source-v4.md §3.5).
 *
 * `prepareTaskV3Execution` (`src/tasks/prepare/prepare.ts`) has never needed
 * to change. This is a pure, typed transform from an already-parsed
 * `TaskSourceV4Document` into a `PreparableTaskDocument` (a name for
 * `TaskV3SourceDocument` that is not version-bound,
 * `src/tasks/prepare/prepared-execution.ts`) — no YAML string is fabricated
 * and nothing is re-parsed (the P1b §4.3 invariant this phase carries
 * forward: no file under `src/` may spell out a fabricated task-v3 header
 * line immediately followed by a synthetic executable-selector line — see
 * `tests/workflows/direct-script-typed.test.ts`'s source-text scan, which
 * this file's own prose is careful not to trip by literally reproducing
 * that two-line needle).
 *
 * The projection is DELIBERATELY LOSSY relative to the parsed document:
 *
 *   - `inputs` (the document's typed input declarations) is NOT projected
 *     anywhere — input delivery reads the ORIGINAL parsed document directly
 *     (`src/tasks/run/load-task.ts`), not this projection.
 *   - `schedule[i].inputs` (per-binding literal overrides) is NOT projected
 *     onto `triggers.schedules[i]` — same reason (B-38).
 *   - `schedule.length === 0` projects to `triggers = { manual: true,
 *     schedules: [] }` (D2-N6) — v3's OWN spelling for "no cron, dispatch
 *     only", so no downstream consumer of `PreparableTaskDocument` learns a
 *     new shape.
 *   - the projected `version` is the LITERAL `3` — the prepare contract's
 *     discriminant, not a re-assertion that the source was v3
 *     (spec docs/plans/specs/p4-deletions-closeout.md §3.2.7). P4 deleted
 *     `TASK_V3_SCHEMA_VERSION` (task v3 acceptance is gone from `src`) but
 *     left `PreparableTaskDocument`'s NAME and shape alone (§0, R-R1 —
 *     the rename is deferred to a follow-up commit after the sweep), so
 *     this recorded wart persists; see the literal's own inline comment
 *     below.
 */

import type { PreparableTaskDocument } from "../prepare/prepared-execution";
import type { TaskV3AkmOptions } from "../source-v3";
import type { TaskSourceV4Document } from "./task-source-v4";

/**
 * Map every top-level task source v4 execution control and D2-N7 survivor
 * into v3's `akm.*` shape, one field at a time (never a whole-object copy,
 * so a field task source v4 does not represent — such as `inputs` — can
 * never leak in by accident). Returns `undefined` when
 * nothing maps, matching v3's own
 * convention of omitting the `akm` key entirely rather than emitting an
 * always-present empty object (`source-v3.ts:789`).
 */
function projectAkm(document: TaskSourceV4Document): Readonly<TaskV3AkmOptions> | undefined {
  const out: Record<string, unknown> = {};
  if (document.description !== undefined) out.description = document.description;
  if (document.when_to_use !== undefined) out.when_to_use = document.when_to_use;
  if (document.tags !== undefined) out.tags = document.tags;

  const execution = document.execution;
  if (execution.agent !== undefined) out.agent = execution.agent;
  if (execution.engine !== undefined) out.engine = execution.engine;
  if (execution.model !== undefined) out.model = execution.model;
  if (execution.inference !== undefined) out.inference = execution.inference;
  if (execution.tools !== undefined) out.tools = execution.tools;
  if (execution.timeout !== undefined) out.timeout = execution.timeout;
  if (execution.redact !== undefined) out.redact = execution.redact;
  if (execution.maxSteps !== undefined) out.maxSteps = execution.maxSteps;
  if (execution.maxRetries !== undefined) out.maxRetries = execution.maxRetries;

  if (document.output !== undefined) out.outputSchema = document.output;

  return Object.keys(out).length > 0 ? (Object.freeze(out) as Readonly<TaskV3AkmOptions>) : undefined;
}

/** Project one parsed task source v4 document into the prepare seam's existing input shape (spec §3.5). */
export function projectTaskSourceV4(document: TaskSourceV4Document): PreparableTaskDocument {
  const akm = projectAkm(document);
  const schedules = Object.freeze(
    document.schedule.map((entry) => Object.freeze({ cron: entry.cron, source: entry.source, ordinal: entry.ordinal })),
  );
  return Object.freeze({
    // The literal `3` is the prepare seam's own discriminant
    // (PreparableTaskDocument = TaskV3SourceDocument), not an assertion that
    // the source this was projected from was task v3 — `TASK_V3_SCHEMA_VERSION`
    // is gone (P4 deleted task v3 acceptance from src), and this projection
    // only ever runs on a task source v4 document (P2a §3.5's recorded wart).
    version: 3,
    ...(document.name !== undefined ? { name: document.name } : {}),
    target: document.target,
    ...(document.env !== undefined ? { env: document.env } : {}),
    ...(akm !== undefined ? { akm } : {}),
    triggers: Object.freeze({ manual: document.manualOnly, schedules }),
    source: Object.freeze({ path: document.source.path }),
  }) as PreparableTaskDocument;
}
