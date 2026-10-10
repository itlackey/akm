// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Observability command cluster — `akm log` (append-only events stream).
 * Extracted verbatim from src/cli.ts (WS6) so the God Module shrinks; the
 * `main.subCommands.log` key and its args/output shape are byte-identical.
 *
 * `log` reads the append-only state.db events stream. It shares no helpers
 * with any command still inline in cli.ts.
 *
 * 0.9.0 CLI overhaul (S3): `log` was a group with `list`/`tail` subcommands;
 * `tail` (a foreground polling daemon) is dropped and `log` becomes a LEAF
 * command that is today's `list` surface, unchanged (including the
 * `--since @offset:<id>` durable cursor and --ref/--type filters). The
 * `lessons`/`lesson` group (`coverage`, `strength`) is dropped entirely —
 * ranking's `lessonStrength` contributor is untouched, only the CLI read
 * surface for it goes away.
 *
 * The embedded agent-guide surfaces (`akm hints` and `akm help agents`) live
 * in src/cli.ts, so their loading code is intentionally outside this module.
 *
 * The leaf handler's body is a plain `runWithJsonErrors(...) + output(...)`,
 * migrated onto `defineJsonCommand`, which emits the same JSON envelope
 * (stdout/stderr/exit-code) as the inline form.
 */

import { parsePositiveIntFlag } from "../cli/parse-args";
import { defineJsonCommand, output, parseAllFlagValues } from "../cli/shared";
import { UsageError } from "../core/errors";
import { akmEventsList } from "./log";

/**
 * `log` flattened from a group (`log list`/`log tail`) to a leaf in 0.9 (S3).
 * `log` declares no positional args, so citty leaves any leftover positional
 * token in `args._` uninterpreted rather than rejecting it — meaning
 * `akm log tail` and `akm log list` silently ran today's `log` surface
 * instead of failing like the other removed spellings (`log tail` is the
 * dangerous one: it used to stream/follow, so an unmigrated caller got a
 * silent one-shot snapshot instead of an error).
 */
function rejectExtraLogPositionals(positionals: unknown): void {
  const extra = Array.isArray(positionals) ? (positionals as unknown[]).map(String) : [];
  if (extra.length === 0) return;
  throw new UsageError(
    `akm log takes no positional arguments, but got ${extra.map((token) => `"${token}"`).join(" ")}.`,
    "INVALID_FLAG_VALUE",
  );
}

// ── `akm log` ────────────────────────────────────────────────────────────────
// Append-only events stream surface (#204). Reads state.db events with
// optional --since/--type/--ref filters.
//
// R-060: the internal output()/shape-registry command name is `log-list`
// (renamed from the pre-rename `events-list`, back when the command group was
// still called `akm events`). This string never reaches the wire —
// `shapeEventsOutput` (src/output/shapes/helpers.ts) builds its own envelope
// and never stamps a `shape` field — so the rename is a coherence-only
// change, not a schemaVersion bump. Kept as `log-list` (not renamed to `log`)
// even though the group flattened to a leaf, to avoid unrelated churn on the
// internal registry key.

export const logCommand = defineJsonCommand({
  meta: { name: "log", description: "List events from the append-only state.db events stream" },
  args: {
    since: {
      type: "string",
      description: "ISO timestamp / epoch ms, OR `@offset:<id>` for a durable row-id cursor (resume across processes)",
    },
    type: { type: "string", description: "Filter by event type (add, remove, remember, feedback, ...)" },
    ref: { type: "string", description: "Filter by asset ref ([bundle//]conceptId)" },
    run: {
      type: "string",
      description: "Filter to a workflow run's events (metadata.runId), e.g. the id from `akm workflow run`",
    },
    "exclude-tags": {
      type: "string",
      description: "Exclude events matching these tags (repeatable)",
    },
    "include-tags": {
      type: "string",
      description: "Only include events with ALL these tags (repeatable)",
    },
    limit: {
      type: "string",
      description: "Return only the most recent N events matching every other filter (default: unlimited)",
    },
  },
  run({ args }) {
    rejectExtraLogPositionals(args._);
    const excludeTags = parseAllFlagValues("--exclude-tags");
    const includeTags = parseAllFlagValues("--include-tags");
    const limit = parsePositiveIntFlag(args.limit);
    const result = akmEventsList({
      since: args.since,
      type: args.type,
      ref: args.ref,
      run: args.run,
      ...(excludeTags.length > 0 ? { excludeTags } : {}),
      ...(includeTags.length > 0 ? { includeTags } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    output("log-list", result);
  },
});
