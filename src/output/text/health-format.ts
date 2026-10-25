// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm health` plain-text renderer.
 *
 * Before this module existed, `--format text` had no registered formatter
 * for `health` at all, so every invocation fell through to
 * `renderGenericText` — fine for the scalar fields (`ok=true`,
 * `status=pass`, `metrics.taskFailRate=0`, …) but `hardChecks` and
 * `advisories` are arrays of small uniform records, and the generic
 * fallback's array handling JSON-dumps an array as ONE line. For the
 * command whose entire job is "tell a human what's wrong," that made the
 * two fields that actually carry diagnostic signal the least readable part
 * of the output.
 *
 * This formatter renders those record-arrays via the shared `./status-list`
 * helper — worst-status-first,
 * one glyph-prefixed line per check, with `evidence` gated behind
 * `--detail normal|full` (the default is `brief`; see `resolveOutputMode` in
 * `../context.ts`) so the common case stays scannable while the full
 * diagnostic payload is one flag away, never dropped. Every other field
 * (`metrics`, `improve`, and the optional `runs`/`windows`/`deltas`/`report`
 * datasets `--report`/`--group-by run`/`--window-compare` add) keeps the
 * exact `dotted.path=value` rendering `renderGenericText` already used, via
 * the exported `flattenForText` — those are mostly nested scalar trees, not
 * the shape this formatter exists to fix, so reusing that convention keeps
 * them unchanged rather than inventing a second style for no reason.
 *
 * `--format json`/`jsonl`/`yaml` are untouched: they serialize the envelope,
 * not this rendering, and never call anything in this file. `--format md`
 * keeps its own pre-existing bespoke tables for `--group-by run` /
 * `--window-compare` (`../../commands/health/renderers.ts`) — this module is
 * `text` only.
 */

import type { DetailLevel } from "../context";
import { flattenForText } from "../generic-render";
import { renderStatusEntries, type StatusEntry, summarizeCounts } from "./status-list";
import { renderTargetsTable } from "./targets-table";

/** The subset of `HealthCheckResult` (`src/commands/health/types-checks.ts`) this formatter reads. */
interface HealthCheckLike {
  name: string;
  kind?: string;
  status?: string;
  message?: string;
  confidence?: string;
  evidence?: Record<string, unknown>;
}

const STATUS_GLYPH: Record<string, string> = { fail: "✗", warn: "⚠", unknown: "?", pass: "✓" };
const STATUS_RANK: Record<string, number> = { fail: 0, warn: 1, unknown: 2, pass: 3 };
/** Worst-first, for both the section summary and (via `STATUS_RANK`) row order. */
const STATUS_ORDER = ["fail", "warn", "unknown", "pass"] as const;

/** One evidence field per line, `key: value` — objects/arrays JSON-compact, matching `formatInfoPlain`'s nested-field convention. */
function evidenceLines(evidence: Record<string, unknown> | undefined): string[] {
  if (!evidence) return [];
  return Object.entries(evidence).map(
    ([key, value]) => `${key}: ${value !== null && typeof value === "object" ? JSON.stringify(value) : String(value)}`,
  );
}

function checkStatusEntry(check: HealthCheckLike, detail: DetailLevel): StatusEntry {
  const status = check.status ?? "unknown";
  const meta = [check.kind, check.confidence].filter((v): v is string => !!v).join(", ");
  return {
    severityRank: STATUS_RANK[status] ?? 9,
    glyph: STATUS_GLYPH[status] ?? "?",
    headline: `${check.name}  [${status}${meta ? `, ${meta}` : ""}]  ${check.message ?? ""}`.trimEnd(),
    // Evidence is diagnostic detail, not the headline signal — gated behind
    // --detail the same way `formatSearchPlain`/`formatCuratePlain` gate
    // their own verbose fields (full path/editHint/whyMatched, "why" reasoning).
    // The `targets` table is the exception: it is the check's answer, so it always shows.
    detailLines:
      check.name === "targets" && Array.isArray(check.evidence?.rows)
        ? renderTargetsTable(check.evidence.rows)
        : detail === "brief"
          ? []
          : evidenceLines(check.evidence),
  };
}

/** Render one `hardChecks`/`advisories` section: a count summary header, then worst-first rows. */
function renderCheckSection(title: string, checks: readonly HealthCheckLike[], detail: DetailLevel): string[] {
  if (checks.length === 0) return [`${title}: (none)`];
  const counts: Record<string, number> = {};
  for (const check of checks) {
    const status = check.status ?? "unknown";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  const summary = summarizeCounts(counts, STATUS_ORDER);
  const header = `${title} (${checks.length}${summary ? ` — ${summary}` : ""})`;
  return [header, ...renderStatusEntries(checks.map((check) => checkStatusEntry(check, detail)))];
}

/** Fields already rendered explicitly above — everything else in `r` falls to the `flattenForText` sweep below. */
const HANDLED_KEYS = new Set(["ok", "status", "since", "hardChecks", "advisories", "shape", "schemaVersion"]);

export function formatHealthPlain(r: Record<string, unknown>, detail: DetailLevel): string | null {
  if (r === null || typeof r !== "object") return null;

  const lines: string[] = [];
  if (typeof r.ok === "boolean") lines.push(`ok: ${r.ok}`);
  if (typeof r.status === "string") lines.push(`status: ${r.status}`);
  if (typeof r.since === "string") lines.push(`since: ${r.since}`);

  const hardChecks = Array.isArray(r.hardChecks) ? (r.hardChecks as HealthCheckLike[]) : [];
  const advisories = Array.isArray(r.advisories) ? (r.advisories as HealthCheckLike[]) : [];

  lines.push("", ...renderCheckSection("hardChecks", hardChecks, detail));
  lines.push("", ...renderCheckSection("advisories", advisories, detail));

  if (
    detail === "brief" &&
    [...hardChecks, ...advisories].some((c) => c.name !== "targets" && c.evidence && Object.keys(c.evidence).length > 0)
  ) {
    lines.push("", "(evidence omitted at --detail brief; re-run with --detail normal or --detail full to see it)");
  }

  // Everything else (metrics, improve, and the optional runs/windows/deltas/
  // report datasets) is a nested scalar tree, not the array-of-records shape
  // this formatter exists to fix — keep the existing dotted-path convention
  // for it rather than inventing a second one.
  for (const [key, value] of Object.entries(r)) {
    if (HANDLED_KEYS.has(key) || value === undefined) continue;
    const fieldLines: string[] = [];
    flattenForText(value, key, fieldLines);
    if (fieldLines.length > 0) lines.push("", ...fieldLines);
  }

  return lines.join("\n").trim();
}
