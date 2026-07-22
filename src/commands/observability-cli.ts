// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Observability command cluster — `akm log` (events list/tail), `akm lessons`
 * (coverage), and `akm hints`. Extracted verbatim from src/cli.ts (WS6) so the
 * God Module shrinks; the `main.subCommands.{log,lessons,hints}` keys and every
 * subcommand's args/output shape are byte-identical.
 *
 * These three surfaces are cohesive read-only "tell me what happened / what to
 * do" commands: `log` reads the append-only state.db events stream, `lessons
 * coverage` reports tag-coverage gaps from the index, and `hints` prints the
 * embedded AGENTS.md guidance. They share no helpers with any command still
 * inline in cli.ts, so the `loadHints` private helper and the
 * `formatEventLine` / `EMBEDDED_HINTS*` / db-tag-set imports move with them.
 *
 * The leaf handlers whose body is a plain `runWithJsonErrors(...) + output(...)`
 * (`events list`, `lessons coverage`) are migrated onto `defineJsonCommand`,
 * which emits the same JSON envelope (stdout/stderr/exit-code) as the inline
 * form. `events tail` (manual streaming console/stderr writes) and `hints`
 * (direct `process.stdout.write`) keep a plain `defineCommand` wrapping
 * `runWithJsonErrors` so their byte-for-byte output stays untouched.
 */

import fs from "node:fs";
import path from "node:path";
import { defineCommand } from "citty";
import { parsePositiveIntFlag } from "../cli/parse-args";
import { defineJsonCommand, output, parseAllFlagValues, runWithJsonErrors } from "../cli/shared";
import { EMBEDDED_HINTS, EMBEDDED_HINTS_FULL } from "../output/cli-hints";
import { getOutputMode, parseDetailLevel } from "../output/context";
import { formatEventLine } from "../output/text";
import { getDirname } from "../runtime";
import { closeDatabase, openExistingDatabase } from "../storage/repositories/index-connection";
import { collectTagSetFromEntries } from "../storage/repositories/index-entries-repository";
import { akmEventsList, akmEventsTail } from "./events";

// ── `akm log` ────────────────────────────────────────────────────────────────
// Append-only events stream surface (#204). `list` reads state.db events
// with optional --since/--type/--ref filters; `tail` follows the table via
// a polling loop and prints each event as a single JSONL line.

const eventsListCommand = defineJsonCommand({
  meta: { name: "list", description: "List events from the append-only state.db events stream" },
  args: {
    since: {
      type: "string",
      description: "ISO timestamp / epoch ms, OR `@offset:<id>` for a durable row-id cursor (resume across processes)",
    },
    type: { type: "string", description: "Filter by event type (add, remove, remember, feedback, ...)" },
    ref: { type: "string", description: "Filter by asset ref (type:name)" },
    "exclude-tags": {
      type: "string",
      description: "Exclude events matching these tags (repeatable)",
    },
    "include-tags": {
      type: "string",
      description: "Only include events with ALL these tags (repeatable)",
    },
  },
  run({ args }) {
    const excludeTags = parseAllFlagValues("--exclude-tags");
    const includeTags = parseAllFlagValues("--include-tags");
    const result = akmEventsList({
      since: args.since,
      type: args.type,
      ref: args.ref,
      ...(excludeTags.length > 0 ? { excludeTags } : {}),
      ...(includeTags.length > 0 ? { includeTags } : {}),
    });
    output("events-list", result);
  },
});

const eventsTailCommand = defineCommand({
  meta: { name: "tail", description: "Follow the append-only state.db events stream (polling)" },
  args: {
    since: {
      type: "string",
      description: "ISO timestamp / epoch ms, OR `@offset:<id>` for a durable row-id cursor (resume across processes)",
    },
    type: { type: "string", description: "Filter by event type" },
    ref: { type: "string", description: "Filter by asset ref (type:name)" },
    "interval-ms": { type: "string", description: "Polling interval in ms (default: 75)" },
    "max-duration-ms": { type: "string", description: "Stop after this many ms (default: never)" },
    "max-events": { type: "string", description: "Stop after observing this many events" },
    "exclude-tags": {
      type: "string",
      description: "Exclude events matching these tags (repeatable)",
    },
    "include-tags": {
      type: "string",
      description: "Only include events with ALL these tags (repeatable)",
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const intervalMs = parsePositiveIntFlag(args["interval-ms"], "--interval-ms");
      const maxDurationMs = parsePositiveIntFlag(args["max-duration-ms"], "--max-duration-ms");
      const maxEvents = parsePositiveIntFlag(args["max-events"], "--max-events");
      const mode = getOutputMode();
      // In streaming text mode we want each event to print as soon as it
      // arrives. The polling loop emits via `onEvent`; the final result is
      // also rendered through the standard output() pipeline so JSON
      // consumers always get the canonical envelope.
      const stream = mode.format === "text" || mode.format === "jsonl";
      const excludeTags = parseAllFlagValues("--exclude-tags");
      const includeTags = parseAllFlagValues("--include-tags");
      const result = await akmEventsTail({
        since: args.since,
        type: args.type,
        ref: args.ref,
        intervalMs,
        maxDurationMs,
        maxEvents,
        ...(excludeTags.length > 0 ? { excludeTags } : {}),
        ...(includeTags.length > 0 ? { includeTags } : {}),
        onEvent: stream
          ? (event) => {
              if (mode.format === "jsonl") {
                console.log(JSON.stringify(event));
              } else {
                console.log(formatEventLine(event as unknown as Record<string, unknown>));
              }
            }
          : undefined,
      });
      // Emit the canonical envelope last (JSON/YAML modes rely on this;
      // streaming modes already printed each event but we still emit a
      // trailer so callers can persist the resumable cursor).
      if (!stream) {
        output("events-tail", result);
      } else if (mode.format === "jsonl") {
        // Final discriminated trailer row so jsonl consumers can resume.
        const trailer = {
          _kind: "trailer",
          schemaVersion: 1,
          nextOffset: result.nextOffset,
          totalCount: result.totalCount,
          reason: result.reason,
        };
        console.log(JSON.stringify(trailer));
      } else {
        // text mode: keep stdout pristine for line-oriented parsers and
        // emit the trailer on stderr.
        process.stderr.write(
          `[events-tail] reason=${result.reason} nextOffset=${result.nextOffset} total=${result.totalCount}\n`,
        );
      }
    });
  },
});

export const logCommand = defineCommand({
  meta: {
    name: "log",
    description: "Read or follow the append-only state.db events stream (mutations, feedback, indexing)",
  },
  subCommands: {
    list: eventsListCommand,
    tail: eventsTailCommand,
  },
});

// ── lessons subcommands (Phase 7A / Advantage D4c) ──────────────────────────

const lessonsCoverageCommand = defineJsonCommand({
  meta: {
    name: "coverage",
    description:
      "Report tags that exist on indexed assets but are NOT yet covered by any lesson.\n\n" +
      "Useful for spotting topics where the stash has skills/commands/scripts but no\n" +
      "crystallized lesson — a signal that the team has tacit knowledge worth distilling.\n\n" +
      "Default output is JSON: { uncoveredTags: string[], lessonTagCount: number, totalTagCount: number }.\n" +
      "Pass --format text for a plain-text bulleted list.",
  },
  args: {},
  run() {
    const db = openExistingDatabase();
    try {
      const allTagSet = collectTagSetFromEntries(db, undefined);
      const lessonTagSet = collectTagSetFromEntries(db, "lesson");
      const uncovered: string[] = [];
      for (const tag of allTagSet) {
        if (!lessonTagSet.has(tag)) uncovered.push(tag);
      }
      uncovered.sort((a, b) => a.localeCompare(b));
      output("lessons-coverage", {
        ok: true,
        uncoveredTags: uncovered,
        lessonTagCount: lessonTagSet.size,
        totalTagCount: allTagSet.size,
      });
    } finally {
      closeDatabase(db);
    }
  },
});

export const lessonsCommand = defineCommand({
  meta: {
    name: "lessons",
    alias: "lesson",
    description: "Lesson-asset tooling: tag-coverage gaps, strength queries.",
  },
  subCommands: {
    coverage: lessonsCoverageCommand,
  },
});

// ── `akm hints` ──────────────────────────────────────────────────────────────

export const hintsCommand = defineCommand({
  meta: {
    name: "hints",
    description: "Print agent instructions on how to use akm, use --detail full for a complete guide",
  },
  args: {
    detail: {
      type: "string",
      description:
        "Hints detail level (brief|normal|full). `brief` prints the short guide; `normal`/`full` print the complete guide.",
      default: "normal",
    },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      // Let the global parser validate the value so an invalid `--detail`
      // returns the standard JSON error envelope (exit 2) rather than a raw
      // stack trace + exit 1. `brief` → short doc; `normal`/`full` → full doc.
      const detail = parseDetailLevel(args.detail as string | undefined) ?? "normal";
      process.stdout.write(loadHints(detail === "brief" ? "brief" : "full"));
    });
  },
});

// ── Hints (embedded AGENTS.md) ──────────────────────────────────────────────

function loadHints(detail: "brief" | "normal" | "full" = "normal"): string {
  // `brief` → the short AGENTS.md guide; `normal`/`full` → the complete guide.
  const wantFull = detail !== "brief";
  const filename = wantFull ? "AGENTS.full.md" : "AGENTS.md";
  const fallback = wantFull ? EMBEDDED_HINTS_FULL : EMBEDDED_HINTS;

  // Try reading from the docs/ directory (works in dev and when installed via npm)
  try {
    const docsPath = path.resolve(getDirname(import.meta.url), `../../docs/agents/${filename}`);
    if (fs.existsSync(docsPath)) {
      return fs.readFileSync(docsPath, "utf8");
    }
  } catch {
    // fall through
  }
  // Fallback for compiled binary — inline content
  return fallback;
}
