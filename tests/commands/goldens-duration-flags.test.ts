// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-07 (Chunk 0a — brief §11, R4): CLI output baselines for the Chunk 9
 * sweep, family E — duration-flag surfaces. Three independent `--since`
 * parsers coexist in this codebase today, each with its own grammar; Chunk 9
 * must not silently unify them without this baseline making the behavior
 * change visible:
 *
 *   - `src/core/time.ts` `DURATION_UNITS` / `parseDuration` — canonical,
 *     CASE-SENSITIVE (`m`=minutes, `M`=months). Used by `akm health --since`.
 *   - `src/commands/improve/extract.ts` `parseSinceArg` (`extract.ts:411`) —
 *     CASE-INSENSITIVE `[mhd]/i` regex, so `5M` means 5 MINUTES (`extract.ts:416`),
 *     diverging from the core grammar's `M`=months. Wired to `akm extract --since`.
 *   - `src/commands/improve/consolidate.ts` `parseSinceToIso` (module-private,
 *     `consolidate.ts:2824`) — config-driven only (`incrementalSince`), returns
 *     its input UNCHANGED (identity fallback) on non-matching input rather than
 *     throwing. Not reachable from any CLI flag.
 *
 * Plus `resolveRelativeDates` (`src/commands/improve/memory/memory-improve.ts:362-391`,
 * module-private) — memory-CONTENT phrase rewriting against a `referenceDate`,
 * not flag parsing at all; captured here because the brief's duration-surface
 * sweep names it explicitly as a residue that must not be folded into the
 * duration grammar without this baseline exposing the change.
 *
 * `akm log list --since` (family A/E's "events" surface) turns out to use a
 * FOURTH parser again: neither `DURATION_UNITS` nor `parseSinceArg` — only a
 * literal ISO timestamp / epoch ms, or the `@offset:<id>` cursor grammar. A
 * plain duration shorthand like `24h` is REJECTED there (see the "family E —
 * events (log) --since" test below) — captured as-is, a genuine surprise
 * worth Chunk 9's attention, not a bug this chunk fixes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { narrowToIncrementalCandidates } from "../../src/commands/improve/consolidate";
import type { MemoryEntry } from "../../src/commands/improve/consolidate/types";
import { applyMemoryCleanup, type MemoryCleanupPlan } from "../../src/commands/improve/memory/memory-improve";
import { runCliCapture } from "../_helpers/cli";
import { expectGolden } from "../_helpers/golden";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";
import { DURATION_RELATIVE_MEMORY_NAME, DURATION_SINCE_MEMORY_NAME } from "../fixtures/goldens/cli/fixture-refs";

let storage: IsolatedAkmStorage;

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCliCapture(args);
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────
// CLI surfaces
// ─────────────────────────────────────────────────────────────────────────

describe("family E — extract --since", () => {
  test("extract --type claude-code --since 24h/30m/7d/<ISO>/garbage/5M --dry-run", async () => {
    writeSandboxConfig({
      semanticSearchMode: "off",
      engines: { "test-llm": { kind: "llm", endpoint: "http://localhost:1/v1/chat/completions", model: "test-model" } },
      defaults: { llmEngine: "test-llm" },
    });
    const emptyLocation = fs.mkdtempSync(path.join(os.tmpdir(), "akm-cli-goldens-extract-loc-"));
    const isoNow = new Date().toISOString();
    const outcomes: Record<string, { exitCode: number; ok?: boolean; code?: string }> = {};
    try {
      for (const [label, since] of [
        ["24h", "24h"],
        ["30m", "30m"],
        ["7d", "7d"],
        ["iso", isoNow],
        ["garbage", "garbage"],
        // Case-variant divergence pin (extract.ts:416, [mhd]/i): unit letter is
        // lower-cased before matching against the m|h|d switch, so `5M` means 5
        // MINUTES here — the opposite of core `DURATION_UNITS` (`M`=months).
        ["5M-case-variant", "5M"],
      ] as const) {
        const result = await runCli([
          "extract",
          "--type",
          "claude-code",
          "--since",
          since,
          "--location",
          emptyLocation,
          "--dry-run",
          "--format=json",
        ]);
        if (result.code === 0) {
          outcomes[label] = { exitCode: result.code, ok: (JSON.parse(result.stdout) as { ok: boolean }).ok };
        } else {
          const parsed = JSON.parse(result.stderr) as { ok: boolean; code?: string };
          outcomes[label] = { exitCode: result.code, ok: parsed.ok, code: parsed.code };
        }
      }
    } finally {
      fs.rmSync(emptyLocation, { recursive: true, force: true });
    }

    // Every duration shorthand + ISO succeeds (zero sessions found under the
    // empty --location, so dryRun completes trivially); only "garbage" fails.
    expect(outcomes["24h"]?.exitCode).toBe(0);
    expect(outcomes["5M-case-variant"]?.exitCode).toBe(0);
    expect(outcomes.garbage?.exitCode).toBe(2);
    expect(outcomes.garbage?.code).toBe("INVALID_FLAG_VALUE");

    expectGolden("tests/fixtures/goldens/cli/e-extract-since.json", { outcomes });
  });
});

describe("family E — health --since", () => {
  test("health --since 5m", async () => {
    writeSandboxConfig({ semanticSearchMode: "off" });
    const result = await runCli(["health", "--since", "5m", "--format=json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { status: string };
    expectGolden("tests/fixtures/goldens/cli/e-health-since.json", {
      exitCode: result.code,
      status: parsed.status,
    });
  });
});

describe("family E — events (log) --since", () => {
  test("log list --since 24h (rejected) and --since @offset:0 (accepted)", async () => {
    writeSandboxConfig({ semanticSearchMode: "off" });
    // Seed at least one state.db event so @offset:0 has something to return.
    await runCli(["remember", "duration flags fixture note", "--name", "duration-fixture", "--format=json"]);

    const durationShorthand = await runCli(["log", "list", "--since", "24h", "--format=json"]);
    const offsetCursor = await runCli(["log", "list", "--since", "@offset:0", "--format=json"]);

    // Captured as-is (module docstring): `akm log list --since` does NOT
    // accept the `24h`-style duration shorthand that `health`/`extract` do —
    // only an ISO timestamp / epoch ms, or `@offset:<id>`.
    expect(durationShorthand.code).toBe(2);
    expect(offsetCursor.code).toBe(0);

    const durationErr = JSON.parse(durationShorthand.stderr) as { ok: boolean; code?: string };
    const offsetJson = JSON.parse(offsetCursor.stdout) as Record<string, unknown>;
    expectGolden("tests/fixtures/goldens/cli/e-events-since.json", {
      durationShorthand: { exitCode: durationShorthand.code, code: durationErr.code },
      offsetCursor: { exitCode: offsetCursor.code, stdoutKeys: Object.keys(offsetJson).sort() },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Unit-only residues (not CLI-reachable)
// ─────────────────────────────────────────────────────────────────────────

describe("family E — parseSinceToIso identity fallback (consolidate.ts:2824, config-driven)", () => {
  test("narrowToIncrementalCandidates: garbage since never selects anything; valid duration/ISO do", () => {
    // parseSinceToIso is module-private; exercised indirectly through the
    // exported narrowToIncrementalCandidates, whose isChanged() comparison
    // (`mtime.toISOString() > sinceIso`) is a STRING comparison. On garbage
    // input, parseSinceToIso returns the input UNCHANGED (identity fallback)
    // — and because every ISO timestamp is lexicographically LESS than any
    // string starting with a lowercase letter (digit '0'-'9' < 'a'-'z' in
    // ASCII), isChanged() is false for EVERY memory, so the function returns
    // [] for ANY unparseable since value, silently, with no warning pushed.
    // This is a genuine, previously-latent characterization surprise — Chunk
    // 9 must not silently swap this parser for one that throws on garbage
    // input, or "incremental consolidate --since <typo>" changes from a
    // silent no-op to a hard failure.
    const filePath = path.join(storage.stashDir, "memories", `${DURATION_SINCE_MEMORY_NAME}.md`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "---\ndescription: since fallback fixture\n---\n\nbody\n");
    const memories: MemoryEntry[] = [
      {
        name: DURATION_SINCE_MEMORY_NAME,
        filePath,
        description: "since fallback fixture",
        tags: [],
        stashDir: storage.stashDir,
      },
    ];

    const garbageWarnings: string[] = [];
    const garbageResult = narrowToIncrementalCandidates(memories, "not-a-real-date", garbageWarnings);
    expect(garbageResult).toEqual([]);
    expect(garbageWarnings).toEqual([]);

    const durationWarnings: string[] = [];
    const durationResult = narrowToIncrementalCandidates(memories, "24h", durationWarnings);
    expect(durationResult).toHaveLength(1);

    const isoNow = new Date().toISOString();
    const isoWarnings: string[] = [];
    const isoResult = narrowToIncrementalCandidates(memories, isoNow, isoWarnings);
    expect(isoResult).toEqual([]);

    expectGolden("tests/fixtures/goldens/improve/since-to-iso-identity-fallback.json", {
      garbageSince: { selectedCount: garbageResult.length, warningsCount: garbageWarnings.length },
      validDurationSince: { selectedCount: durationResult.length, warningsCount: durationWarnings.length },
      isoNowSince: { selectedCount: isoResult.length, warningsCount: isoWarnings.length },
    });
  });
});

describe("family E — resolveRelativeDates phrase grammar (memory-improve.ts:362-391, pinned referenceDate)", () => {
  test("yesterday / last week|month|year / N days|weeks|months ago, anchored to frontmatter createdAt", () => {
    // resolveRelativeDates is module-private; exercised through the exported
    // applyMemoryCleanup, which anchors referenceDate on the derived memory's
    // `createdAt` frontmatter field (falling back to file mtime when absent
    // or unparseable) — see memory-improve.ts:309-333.
    const referenceCreatedAt = "2026-01-15T00:00:00.000Z"; // Thursday
    const relPath = path.join("memories", "derived", `${DURATION_RELATIVE_MEMORY_NAME}.md`);
    const filePath = path.join(storage.stashDir, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const body =
      "We shipped yesterday. Discussed last week, and the plan formed last month; " +
      "the project itself began last year. Also 3 days ago, 2 weeks ago, and 2 months ago.";
    fs.writeFileSync(
      filePath,
      `---\ndescription: relative dates fixture\ncreatedAt: ${referenceCreatedAt}\n---\n\n${body}\n`,
    );
    const plan: MemoryCleanupPlan = {
      analyzedDerived: 1,
      pruneCandidates: [],
      contradictionCandidates: [],
      beliefStateTransitions: [],
      consolidationCandidates: [],
      relativeDateCandidates: [
        { ref: `memory:${DURATION_RELATIVE_MEMORY_NAME}`, filePath, matches: ["yesterday", "last week"] },
      ],
    };

    const result = applyMemoryCleanup(storage.stashDir, plan);
    expect(result.relativeDatesResolved).toBe(1);
    const rewritten = fs.readFileSync(filePath, "utf8");

    expectGolden("tests/fixtures/goldens/improve/resolve-relative-dates.json", {
      referenceCreatedAt,
      relativeDatesResolved: result.relativeDatesResolved,
      rewrittenBodyContainsRawPhrase: {
        yesterday: rewritten.includes("yesterday"),
        lastWeek: rewritten.includes("last week"),
        lastMonth: rewritten.includes("last month"),
        lastYear: rewritten.includes("last year"),
      },
      rewrittenBody: rewritten.slice(rewritten.indexOf("\n\n") + 2).trim(),
    });
  });
});
