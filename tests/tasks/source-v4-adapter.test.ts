// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests-first contract for P2a's task source v4 -> prepare-seam PROJECTION
 * (spec docs/plans/specs/p2a-task-source-v4.md §3.5, D2-N5, D2-N6). Lane A
 * TESTS — this file owns `projectTaskSourceV4()`; the grammar/router half
 * lives in tests/tasks/source-v4.test.ts.
 *
 * Scope clarification (read before "fixing" this file to test something
 * else): the task brief's one-line summary calls this a "v4 document ->
 * TaskDefinition adapter". The SPEC (authoritative) is explicit that P2a
 * touches no such thing — §4.4: "`src/tasks/model/definition.ts` is NOT
 * modified. `TaskDefinition` gains no `inputs`/`output` in P2a; P2b widens
 * it when it widens the adapter." The real P2a seam is
 * `projectTaskSourceV4(doc): PreparableTaskDocument` (§3.5), where
 * `PreparableTaskDocument` is a NAME for `TaskV3SourceDocument` (§3.1's file
 * table) — the type `prepareTaskV3Execution` already consumes, unmodified.
 * This file tests exactly that seam.
 *
 * The projection is DELIBERATELY LOSSY relative to the parsed
 * `TaskSourceV4Document` — this is not a bug this file should paper over:
 *
 *   - host-local activation has no task-source projection
 *     (D2-N5) — it is carried separately to the scheduler seam, which is
 *     Lane C's `scheduler-sync.ts` edit, not this function.
 *   - `inputs` (the document's typed input declarations) is NOT projected
 *     anywhere — input delivery is P2b (spec §0).
 *   - `schedule[i].inputs` (per-binding literal overrides) is NOT projected
 *     onto `triggers.schedules[i]` — same reason (B-38).
 *   - `schedule.length === 0` projects to `triggers = { manual: true,
 *     schedules: [] }` (D2-N6) — v3's OWN spelling for "no cron, dispatch
 *     only", so no downstream consumer of `PreparableTaskDocument` learns a
 *     new shape.
 *   - the projected `version` is the LITERAL `3` — the prepare contract's
 *     discriminant, not a re-assertion that the source was v3. This is a
 *     recorded wart (§3.5); P4 retires it with the type rename.
 *
 * Every assertion below about a mapped field is a TARGETED per-field check
 * (`projected.akm?.<key>`), not a whole-object `toEqual` on `akm` — the spec
 * does not pin whether the projector emits an always-present (possibly
 * empty) `akm` object or omits the key entirely when nothing maps, and a
 * whole-object equality would silently take a position on that undecided
 * question. `target`, `triggers` (incl. `triggers.schedules`), `env`,
 * `name`, `source`, and `version` ARE asserted with whole-value equality:
 * the spec is fully explicit about all of those shapes, and for
 * `triggers.schedules` in particular, whole-value equality is exactly what
 * PROVES `enabled`/`inputs` were dropped (an extra key would fail `toEqual`
 * against a `{cron, source, ordinal}`-only expectation).
 *
 * RED-phase import strategy: identical to tests/tasks/source-v4.test.ts —
 * see that file's header for the full empirical rationale (multi-line named
 * imports misplace the diagnostic line; biome's `--write` merges
 * same-specifier named imports and only the LAST stacked `@ts-expect-error`
 * survives). Every not-yet-existing MODULE is imported as a namespace behind
 * ONE pin and destructured immediately after. `PreparableTaskDocument` is
 * different: it is one new type on an EXISTING, already-resolving module
 * (`src/tasks/prepare/prepared-execution.ts`), so importing it by name
 * raises a single, single-line TS2305 ("has no exported member") — pinned
 * the same way, no namespace indirection needed since there is nothing else
 * from that path to merge with.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { PreparableTaskDocument } from "../../src/tasks/prepare/prepared-execution";
import * as ProjectV4Module from "../../src/tasks/source/project-v4";
import * as TaskSourceV4Module from "../../src/tasks/source/task-source-v4";

const { projectTaskSourceV4 } = ProjectV4Module;
const { parseTaskSourceV4, TASK_SOURCE_V4_VERSION } = TaskSourceV4Module;
type TaskSourceV4Document = TaskSourceV4Module.TaskSourceV4Document;

const ROOT = path.resolve(import.meta.dir, "../..");
const FIXTURES_DIR = path.join(ROOT, "tests/fixtures/execution-contracts/tasks/v4");

// ── Fixture table (mirrors tests/tasks/parse-v3-adapter.test.ts's convention: ──
// ── "maps every fixture in tests/fixtures/execution-contracts/tasks/v4/") ──

interface ManifestFixture {
  readonly id: string;
  readonly file: string;
  readonly represents: readonly string[];
  readonly expected: Readonly<Record<string, unknown>>;
}

function loadManifestFixtures(): readonly ManifestFixture[] {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, "manifest.json"), "utf8");
  const parsed = JSON.parse(raw) as { readonly fixtures: readonly ManifestFixture[] };
  return parsed.fixtures;
}

function parseFixtureDocument(fixture: ManifestFixture): TaskSourceV4Document {
  const filePath = path.join(FIXTURES_DIR, fixture.file);
  return parseTaskSourceV4({ yaml: fs.readFileSync(filePath, "utf8"), filePath });
}

function projectFixture(fixture: ManifestFixture): PreparableTaskDocument {
  return projectTaskSourceV4(parseFixtureDocument(fixture));
}

const MANIFEST_FIXTURES = loadManifestFixtures();

/**
 * Hand-derived from each fixture's YAML against §3.5's projection table —
 * NOT copied from manifest.json's own "expected" block, which pins the RAW
 * task-source-v4 PARSE shape (schedule[].inputs,
 * inputs:, target.uses nesting) for a DIFFERENT consumer
 * (tests/tasks/source-v4.test.ts's grammar assertions). This table pins the
 * PROJECTED `PreparableTaskDocument` shape instead, which deliberately
 * drops several of those same fields (see file header).
 */
interface FixtureExpectation {
  readonly id: string;
  readonly name: string;
  readonly target: Readonly<Record<string, unknown>>;
  readonly env: Readonly<Record<string, unknown>> | undefined;
  readonly manual: boolean;
  readonly schedules: ReadonlyArray<Readonly<{ cron: string; source: string; ordinal: number }>>;
  /** Only the akm-mapped keys THIS fixture authors — checked per-field, never as a whole-object equality (see file header). */
  readonly akm: Readonly<Record<string, unknown>>;
}

const FIXTURE_EXPECTATIONS: readonly FixtureExpectation[] = [
  {
    id: "schedule-absent-manual-only",
    name: "task source v4 fixture - no schedule",
    target: { kind: "uses", uses: { kind: "command", ref: "commands/review" } },
    env: undefined,
    manual: true,
    schedules: [],
    akm: {},
  },
  {
    id: "schedule-string-shorthand",
    name: "task source v4 fixture - schedule string shorthand",
    target: { kind: "uses", uses: { kind: "command", ref: "commands/review" } },
    env: undefined,
    manual: false,
    schedules: [{ cron: "0 8 * * 1", source: "schedule", ordinal: 0 }],
    akm: {},
  },
  {
    id: "schedule-list-multiple",
    name: "task source v4 fixture - schedule list",
    target: { kind: "uses", uses: { kind: "command", ref: "commands/review" } },
    env: undefined,
    manual: false,
    schedules: [
      { cron: "0 6 * * *", source: "schedule[0].cron", ordinal: 0 },
      { cron: "30 18 * * 1-5", source: "schedule[1].cron", ordinal: 1 },
      { cron: "0 9 * * 1", source: "schedule[2].cron", ordinal: 2 },
    ],
    akm: {},
  },
  {
    id: "target-command",
    name: "task source v4 fixture - command target",
    target: { kind: "uses", uses: { kind: "command", ref: "commands/publish-changelog" } },
    env: undefined,
    manual: false,
    schedules: [{ cron: "15 4 * * 1", source: "schedule", ordinal: 0 }],
    akm: {},
  },
  {
    id: "target-script",
    name: "task source v4 fixture - script target",
    target: { kind: "uses", uses: { kind: "script", ref: "scripts/nightly-cleanup.sh" } },
    env: undefined,
    manual: false,
    schedules: [{ cron: "15 4 * * 1", source: "schedule", ordinal: 0 }],
    akm: {},
  },
  {
    id: "target-workflow",
    name: "task source v4 fixture - workflow target",
    target: { kind: "uses", uses: { kind: "workflow", ref: "workflows/nightly-report" } },
    env: undefined,
    manual: false,
    schedules: [{ cron: "15 4 * * 1", source: "schedule", ordinal: 0 }],
    akm: {},
  },
  {
    id: "target-builtin-command",
    name: "task source v4 fixture - builtin command target",
    target: {
      kind: "uses",
      uses: { kind: "builtin-command", ref: "akm/command" },
      with: { content: "Say hello", arguments: "--flag" },
      command: { kind: "inline", content: "Say hello", arguments: "--flag" },
    },
    env: undefined,
    manual: false,
    schedules: [{ cron: "15 4 * * 1", source: "schedule", ordinal: 0 }],
    akm: {},
  },
  {
    id: "target-run-shell",
    name: "task source v4 fixture - run shell target",
    target: { kind: "run", run: "akm index --full", shell: "bash" },
    env: undefined,
    manual: false,
    schedules: [{ cron: "15 4 * * 1", source: "schedule", ordinal: 0 }],
    akm: {},
  },
  {
    id: "inputs-and-output",
    name: "task source v4 fixture - inputs and output",
    target: { kind: "uses", uses: { kind: "command", ref: "commands/review" } },
    env: undefined,
    manual: true,
    schedules: [],
    akm: { outputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } },
  },
  {
    id: "execution-controls",
    name: "task source v4 fixture - execution controls",
    target: { kind: "run", run: "akm index --full" },
    env: { MODE: "safe", RETRIES: 3, DRY_RUN: true },
    manual: false,
    schedules: [{ cron: "15 4 * * 1", source: "schedule", ordinal: 0 }],
    akm: {
      description: "Exercises every top-level v4 execution control and D2-N7 survivor",
      when_to_use: "Run to exercise every non-schedule top-level v4 key",
      tags: ["contract", "review"],
      agent: "reviewer-agent",
      engine: "fixture-llm",
      model: "fixture-exact-model",
      inference: { seed: 7 },
      tools: ["read", "grep"],
      timeout: 45000,
      redact: ["CONTRACT_FIXTURE_TOKEN"],
      maxSteps: 8,
      maxRetries: 2,
    },
  },
];

function expectationFor(id: string): FixtureExpectation {
  const found = FIXTURE_EXPECTATIONS.find((entry) => entry.id === id);
  if (!found) {
    throw new Error(`No projection expectation authored in this test for manifest fixture "${id}" — add one above.`);
  }
  return found;
}

interface LoadedCase {
  readonly fixture: ManifestFixture;
  readonly expectation: FixtureExpectation;
  readonly document: TaskSourceV4Document;
  readonly projected: PreparableTaskDocument;
}

function loadCase(fixture: ManifestFixture): LoadedCase {
  const document = parseFixtureDocument(fixture);
  const projected = projectTaskSourceV4(document);
  return { fixture, expectation: expectationFor(fixture.id), document, projected };
}

describe("projectTaskSourceV4 — every tests/fixtures/execution-contracts/tasks/v4/ fixture (spec §3.5)", () => {
  // Canary: if manifest.json gains/loses a fixture without a matching update
  // here, this fails first with a clear count mismatch rather than a
  // confusing per-property diff below.
  test("the manifest has exactly the 10 fixtures this table covers", () => {
    expect(MANIFEST_FIXTURES).toHaveLength(10);
    expect(FIXTURE_EXPECTATIONS).toHaveLength(10);
  });

  test.each(
    MANIFEST_FIXTURES.map((fixture) => [fixture.id, fixture] as const),
  )("%s projects target (uses/run, with, shell, working-directory) identically (spec §3.5)", (_id, fixture) => {
    const { expectation, projected } = loadCase(fixture);
    expect(projected.target, fixture.id).toEqual(expectation.target as never);
  });

  test.each(
    MANIFEST_FIXTURES.map((fixture) => [fixture.id, fixture] as const),
  )("%s projects schedule[] into triggers.schedules[] as {cron, source, ordinal} ONLY — no enabled, no inputs (D2-N5, B-38, spec §3.5)", (_id, fixture) => {
    const { expectation, projected } = loadCase(fixture);
    expect(projected.triggers.schedules, fixture.id).toEqual(expectation.schedules);
    expect(projected.triggers.manual, fixture.id).toBe(expectation.manual);
    expect(Object.isFrozen(projected.triggers.schedules), fixture.id).toBe(true);
    for (const binding of projected.triggers.schedules) {
      expect(Object.isFrozen(binding), `${fixture.id} binding ${binding.cron}`).toBe(true);
    }
  });

  test.each(
    MANIFEST_FIXTURES.map((fixture) => [fixture.id, fixture] as const),
  )("%s projects name, env, source.path, and the version: 3 discriminant literal (spec §3.5)", (_id, fixture) => {
    const { expectation, projected, document } = loadCase(fixture);
    expect(projected.name, fixture.id).toBe(expectation.name);
    expect(projected.env, fixture.id).toEqual(expectation.env as never);
    expect(projected.source, fixture.id).toEqual({ path: document.source.path });
    expect(projected.version, fixture.id).toBe(3);
  });

  test.each(
    MANIFEST_FIXTURES.map((fixture) => [fixture.id, fixture] as const),
  )("%s projects every akm-mapped field individually (description/when_to_use/tags/agent/engine/model/inference/tools/timeout/redact/maxSteps/maxRetries/outputSchema)", (_id, fixture) => {
    const { expectation, projected } = loadCase(fixture);
    const akm = projected.akm as Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(expectation.akm)) {
      expect(akm?.[key], `${fixture.id}.akm.${key}`).toEqual(value);
    }
  });

  test("inputs: (the document's typed input declarations) never appears anywhere on the projected document — delivery is P2b (spec §0, §3.5)", () => {
    const fixture = MANIFEST_FIXTURES.find((entry) => entry.id === "inputs-and-output");
    if (!fixture) throw new Error("fixture 'inputs-and-output' must exist");
    const { projected } = loadCase(fixture);
    expect(Object.hasOwn(projected, "inputs")).toBe(false);
    expect((projected.akm as Record<string, unknown> | undefined)?.inputs).toBeUndefined();
  });

  test("host-local activation is absent from the projected source document", () => {
    const fixture = MANIFEST_FIXTURES.find((entry) => entry.id === "schedule-list-multiple");
    if (!fixture) throw new Error("fixture 'schedule-list-multiple' must exist");
    const { projected } = loadCase(fixture);
    expect((projected.akm as Record<string, unknown> | undefined)?.enabled).toBeUndefined();
    // The strict {cron, source, ordinal}-only equality above proves source
    // projection contains schedule syntax, never local activation state.
  });

  test("never throws for any fixture the task source v4 parser accepts (manifest.json's own invariant)", () => {
    for (const fixture of MANIFEST_FIXTURES) {
      expect(() => projectFixture(fixture), fixture.id).not.toThrow();
    }
  });

  test("every projection is deep-frozen", () => {
    for (const fixture of MANIFEST_FIXTURES) {
      const projected = projectFixture(fixture);
      expect(Object.isFrozen(projected), fixture.id).toBe(true);
      expect(Object.isFrozen(projected.target), fixture.id).toBe(true);
      expect(Object.isFrozen(projected.triggers), fixture.id).toBe(true);
    }
  });
});

// ── Purity: a pure, typed transform over an ALREADY-PARSED document ────────

describe("projectTaskSourceV4 — purity (spec §3.5: no YAML is fabricated, nothing is re-parsed)", () => {
  test("accepts a hand-constructed TaskSourceV4Document with no YAML string and no file on disk", () => {
    const handBuilt: TaskSourceV4Document = {
      version: TASK_SOURCE_V4_VERSION,
      name: "hand-built",
      target: { kind: "uses", uses: { kind: "command", ref: "commands/review" } },
      execution: { timeout: 5000 },
      schedule: [{ cron: "0 0 * * *", inputs: {}, source: "schedule", ordinal: 0 }],
      manualOnly: false,
      source: { path: "/synthetic/hand-built.yml" },
    };
    const projected = projectTaskSourceV4(handBuilt);
    expect(projected.target).toEqual({ kind: "uses", uses: { kind: "command", ref: "commands/review" } });
    expect(projected.triggers).toEqual({
      manual: false,
      schedules: [{ cron: "0 0 * * *", source: "schedule", ordinal: 0 }],
    });
    expect((projected.akm as Record<string, unknown> | undefined)?.timeout).toBe(5000);
    expect(projected.source).toEqual({ path: "/synthetic/hand-built.yml" });
    expect(projected.version).toBe(3);
  });

  test("a manual-only hand-built document (schedule: []) projects triggers = { manual: true, schedules: [] } (D2-N6)", () => {
    const handBuilt: TaskSourceV4Document = {
      version: TASK_SOURCE_V4_VERSION,
      target: { kind: "run", run: "echo hi" },
      execution: {},
      schedule: [],
      manualOnly: true,
      source: { path: "/synthetic/manual-only.yml" },
    };
    const projected = projectTaskSourceV4(handBuilt);
    expect(projected.triggers).toEqual({ manual: true, schedules: [] });
  });

  test("src/tasks/source/project-v4.ts fabricates no synthetic v3 YAML text and re-parses nothing (P1b §4.3's invariant, carried forward per spec §3.5)", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/tasks/source/project-v4.ts"), "utf8");
    expect(source).not.toContain("version: 3\nuses:");
    expect(source).not.toMatch(/parseDocument\s*\(/);
    expect(source).not.toMatch(/\bparseTaskV3Yaml\b/);
  });
});
