// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P2b Lane C — the v3 -> task source v4 migrator (spec
 * docs/plans/specs/p2b-input-bindings.md §1.3, §1.7 C-N1, §5, §6.2(a), §7
 * F-C1, rows B-60..B-75). `scripts/**` only — disjoint from Lanes A/B/D.
 *
 * Combines the two reference suites this migrator generation mirrors, each
 * scoped to one `describe` block below:
 *
 *   - "pure task v3 to v4 migration planner" mirrors
 *     tests/tasks/migrate-v2-to-v3.test.ts — the translation table, the
 *     blocked catalog, and classification/generation determinism, driven off
 *     the fixture corpus at tests/fixtures/execution-contracts/tasks/v3-to-v4/
 *     (deterministic|blocked split, mirroring the tasks/v2 family's own
 *     manifest.json shape).
 *   - "task v3 to v4 filesystem boundary" mirrors
 *     tests/migrate/task-v2-to-v3-files.test.ts — the fail-closed ladder:
 *     read-only preview, O_EXCL backups BEFORE mutation, TOCTOU recheck,
 *     mode-preserving atomic replace, rollback on failure, and convergence on
 *     re-inspect.
 *
 * RED TODAY: src/tasks/source/task-to-v4.ts and
 * task-files-to-v4.ts (spec §5.1) do not exist yet — every import below is a
 * genuine "Cannot find module" until Lane C's Implement step lands both
 * files, at which point this whole file goes GREEN or fails on its actual
 * assertions.
 *
 * RED-PHASE TYPE PINS: with a whole module missing (not just a member of an
 * existing one), the single `@ts-expect-error` directly above each `from
 * "..."` clause suppresses TS2307 for that one import statement, and every
 * name it binds (functions, types) then resolves to `any` — so no further
 * per-call-site pin is needed anywhere below (verified: `bunx tsc --noEmit`
 * is clean with exactly these two directives). The directive sits on the
 * LAST line of each multi-line import (immediately above the `from` clause,
 * inside the closing brace) rather than above `import {` — TypeScript
 * attaches "Cannot find module" to the `from` clause's own line, and a
 * directive above the wrong line is itself reported as an unused directive;
 * this placement is also biome-format-stable (`bunx biome check` proposes no
 * reformat of it), so a later `bunx biome check --write` cannot silently
 * detach the pin from the diagnostic it suppresses.
 *
 * Every fixture below is deliberately free of `inputs:`/`with: {from: ...}`
 * shapes — per §5.3, "`inputs:` is never invented. The migrator translates
 * structure, not intent." That is Lane A2's surface, not this one's.
 *
 * Reason-code strings (`"task-converted"`, `"already-v4"`,
 * `"github-action-target-removed"`, `"with-on-non-command-target"`,
 * `"source-enablement-removed"`, `"unsupported-task-version"`) are
 * this file's own invented, pinned vocabulary — the spec states the FACTS a
 * blocked/changed outcome must carry (§5.3, B-60..B-69), never exact bytes,
 * exactly as p2a's task-to-v3.ts precedent established
 * (`"task-converted"`/`"already-v3"`/`"argv-array-has-no-portable-shell-string"`
 * etc.). `"unsupported-task-version"` reuses task-to-v3.ts's own identical
 * string for the identical situation (an out-of-range `version:`), which is
 * consistency with an existing sibling convention, not invention. Two
 * genuinely ad hoc, not-fixture-backed edge cases (both scheduling sources
 * authored at once; an unrecognized `akm.*` member) are asserted by content
 * pattern (`.toMatch(/…/i)`) rather than an exact reason string, matching
 * migrate-v2-to-v3.test.ts's own mixed style for its analogous inline cases.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  applyTaskToV4MigrationPlan,
  inspectTaskToV4Files,
  taskMigrationBackupPathV4,
} from "../../scripts/akm-migrate/migrate/task-files-to-v4";
import { parseTaskSourceV4 } from "../../src/tasks/source/task-source-v4";
import { planTaskToV4File, planTaskToV4Migration } from "../../src/tasks/source/task-to-v4";
import {
  assertFixtureBytesUnchanged,
  captureFixtureBytes,
  EXECUTION_CONTRACT_FIXTURES,
} from "../_helpers/execution-contracts";

// ─────────────────────────────────────────────────────────────────────────
// "pure task v3 to v4 migration planner" — mirrors tests/tasks/migrate-v2-to-v3.test.ts
// ─────────────────────────────────────────────────────────────────────────

const ROOT = path.join(EXECUTION_CONTRACT_FIXTURES, "tasks/v3-to-v4");

interface Manifest {
  deterministic: Array<{ id: string; file: string; represents: string[] }>;
  blocked: Array<{ id: string; file: string; reasonCode: string }>;
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")) as Manifest;

function fixtureInput(file: string) {
  const filePath = path.join(ROOT, file);
  return { filePath, bytes: fs.readFileSync(filePath), mode: 0o640, writable: true };
}

function memoryInput(yaml: string, overrides: Record<string, unknown> = {}) {
  return {
    filePath: "/bundle/tasks/memory.yml",
    bytes: Buffer.from(yaml),
    mode: 0o640,
    writable: true,
    ...overrides,
  };
}

function fixtureOutcome(id: string) {
  const entry = manifest.deterministic.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`no deterministic fixture named ${id}`);
  return planTaskToV4File(fixtureInput(entry.file));
}

describe("pure task v3 to v4 migration planner", () => {
  test("converts every deterministic fixture and validates the emitted bytes through the production v4 parser", () => {
    const before = captureFixtureBytes(ROOT);
    for (const entry of manifest.deterministic) {
      const outcome = planTaskToV4File(fixtureInput(entry.file));
      expect(outcome.status, entry.file).toBe("changed");
      if (outcome.status !== "changed") throw new Error(`expected changed: ${entry.file}`);
      expect(outcome.reason).toBe("task-converted");
      expect(outcome.before.equals(fs.readFileSync(path.join(ROOT, entry.file)))).toBe(true);
      const parsed = parseTaskSourceV4({ yaml: outcome.after.toString("utf8"), filePath: outcome.filePath });
      expect(parsed.version).toBe(4);
      expect(Object.hasOwn(parsed, "inputs")).toBe(false);
      expect(outcome.after.equals(outcome.before)).toBe(false);
    }
    assertFixtureBytesUnchanged(ROOT, before);
  });

  test("translates akm.schedule to the string-shorthand schedule:, on.schedule to the list form with ordinals preserved, and on.workflow_dispatch-only to an absent schedule: with a notice", () => {
    const akmSchedule = fixtureOutcome("trigger-akm-schedule");
    const onSchedule = fixtureOutcome("trigger-on-schedule");
    const manual = fixtureOutcome("trigger-workflow-dispatch-manual");
    for (const outcome of [akmSchedule, onSchedule, manual]) {
      if (outcome.status !== "changed") throw new Error(`expected changed: ${outcome.filePath}`);
    }

    expect(parseYaml((akmSchedule as { after: Buffer }).after.toString("utf8"))).toEqual({
      version: 4,
      name: "v3 to v4 fixture - akm.schedule trigger",
      uses: "commands/publish-report",
      schedule: "0 6 * * *",
    });
    expect(parseYaml((onSchedule as { after: Buffer }).after.toString("utf8"))).toEqual({
      version: 4,
      name: "v3 to v4 fixture - on.schedule trigger",
      uses: "commands/publish-report",
      schedule: [{ cron: "30 9 * * 2" }, { cron: "0 0 1 * *" }],
    });
    const manualParsed = parseYaml((manual as { after: Buffer }).after.toString("utf8"));
    expect(manualParsed).toEqual({
      version: 4,
      name: "v3 to v4 fixture - manual dispatch only trigger",
      uses: "commands/publish-report",
    });
    expect(Object.hasOwn(manualParsed, "schedule")).toBe(false);
    expect((manual as { notice?: string }).notice).toMatch(/manual|workflow_dispatch|dispatch/i);
  });

  test("hoists akm.* execution controls to identical top-level keys with identical value bytes, preserving the run/shell target and env verbatim", () => {
    const outcome = fixtureOutcome("execution-controls-hoist");
    if (outcome.status !== "changed") throw new Error(outcome.detail ?? outcome.reason);
    expect(parseYaml(outcome.after.toString("utf8"))).toEqual({
      version: 4,
      name: "v3 to v4 fixture - execution controls hoist",
      run: "akm index --full",
      shell: "bash",
      env: { MODE: "safe", RETRIES: 3 },
      schedule: "15 4 * * 1",
      engine: "fixture-engine",
      model: "fixture-model",
      timeout: 45000,
      redact: ["CONTRACT_FIXTURE_TOKEN"],
      maxSteps: 8,
      maxRetries: 2,
    });
  });

  test("hoists description/when_to_use/tags/agent/inference/tools and outputSchema -> output, preserving a duration-string timeout", () => {
    const metadata = fixtureOutcome("metadata-hoist");
    const output = fixtureOutcome("output-schema-hoist");
    for (const outcome of [metadata, output]) {
      if (outcome.status !== "changed") throw new Error(`expected changed: ${outcome.filePath}`);
    }

    expect(parseYaml((metadata as { after: Buffer }).after.toString("utf8"))).toEqual({
      version: 4,
      name: "v3 to v4 fixture - metadata hoist",
      uses: "commands/publish-report",
      schedule: "@daily",
      description: "Publishes the nightly report",
      when_to_use: "Run after the nightly index completes",
      tags: ["reporting", "nightly"],
      agent: "fixture-agent",
      inference: { temperature: 0.2 },
      tools: ["filesystem"],
      timeout: "5m",
    });
    expect(parseYaml((output as { after: Buffer }).after.toString("utf8"))).toEqual({
      version: 4,
      name: "v3 to v4 fixture - output schema hoist",
      uses: "commands/publish-report",
      schedule: "@daily",
      output: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    });
  });

  // F3: the frozen v3 reader accepts `akm.outputSchema: null` verbatim as
  // "no schema" (task-source-v3-frozen.ts:256-258), but v4's `output:` has
  // no null form — parseOutputSchema always requires a mapping. Emitting
  // `output: null` used to fail the real parseTaskSourceV4 prevalidation and
  // block a valid, previously-runnable v3 file. Omitting the key entirely is
  // the faithful v4 equivalent of an explicit v3 null.
  test("treats akm.outputSchema: null as no schema — the output: key is omitted, not emitted as null", () => {
    const yaml = [
      "version: 3",
      "uses: commands/publish-report",
      "akm:",
      "  schedule: '@daily'",
      "  outputSchema: null",
      "",
    ].join("\n");
    const outcome = planTaskToV4File(memoryInput(yaml));
    expect(outcome.status).toBe("changed");
    if (outcome.status !== "changed") throw new Error(`expected changed: ${outcome.detail ?? outcome.reason}`);
    const parsed = parseYaml(outcome.after.toString("utf8"));
    expect(Object.hasOwn(parsed, "output")).toBe(false);
    expect(parseTaskSourceV4({ yaml: outcome.after.toString("utf8"), filePath: outcome.filePath }).version).toBe(4);
  });

  // Review round 1: task source v4 accepts `output:` only on a command target
  // (`targetConsumesOutputSchema`, src/tasks/source/task-source-v4.ts), while
  // the frozen v3 reader accepted `akm.outputSchema` on ANY target kind
  // (task-source-v3-frozen.ts:256-263) — and on run:/scripts//workflows/ it
  // was equally inert there. Hoisting it unconditionally emitted bytes the
  // real parseTaskSourceV4 prevalidation rejects, so a valid, previously-
  // runnable v3 file blocked with `generated-v4-validation-failed` (a blocked
  // file is skipped rather than aborting the rest of the plan, but it would
  // still never migrate on its own). Spec rows B-66 / §5.3 make the
  // outcome `changed` unconditionally: drop the already-inert field and say so
  // in a notice.
  test("drops akm.outputSchema on a non-command target with a notice instead of blocking the file", () => {
    const cases = [
      { target: 'run: "echo hi"', label: "run" },
      { target: "uses: scripts/deploy", label: "scripts/" },
      { target: "uses: workflows/nightly", label: "workflows/" },
    ];
    for (const { target, label } of cases) {
      const yaml = [
        "version: 3",
        target,
        "akm:",
        "  schedule: '@daily'",
        "  outputSchema:",
        "    type: object",
        "",
      ].join("\n");
      const outcome = planTaskToV4File(memoryInput(yaml));
      expect(outcome.status, label).toBe("changed");
      if (outcome.status !== "changed") throw new Error(`expected changed for ${label}: ${outcome.detail ?? ""}`);
      expect(outcome.reason, label).toBe("task-converted");
      const parsed = parseYaml(outcome.after.toString("utf8"));
      expect(Object.hasOwn(parsed, "output"), label).toBe(false);
      expect(outcome.notice, label).toMatch(/outputSchema/);
      expect(
        parseTaskSourceV4({ yaml: outcome.after.toString("utf8"), filePath: outcome.filePath }).version,
        label,
      ).toBe(4);
    }
  });

  // The control for the case above: a command target still hoists the schema
  // AND carries no drop notice, so the fix cannot silently widen into one.
  test("still hoists akm.outputSchema to output: on uses: akm/command, with no drop notice", () => {
    const yaml = [
      "version: 3",
      "uses: akm/command",
      "with:",
      "  ref: commands/publish-report",
      "akm:",
      "  schedule: '@daily'",
      "  outputSchema:",
      "    type: object",
      "",
    ].join("\n");
    const outcome = planTaskToV4File(memoryInput(yaml));
    expect(outcome.status).toBe("changed");
    if (outcome.status !== "changed") throw new Error(`expected changed: ${outcome.detail ?? outcome.reason}`);
    expect(parseYaml(outcome.after.toString("utf8"))).toMatchObject({ output: { type: "object" } });
    expect(outcome.notice).toBeUndefined();
  });

  test("drops retired source-owned akm.enabled while preserving schedules", () => {
    const singleCron = fixtureOutcome("enabled-false-akm-schedule");
    const list = fixtureOutcome("enabled-false-on-schedule");
    for (const outcome of [singleCron, list]) {
      if (outcome.status !== "changed") throw new Error(`expected changed: ${outcome.filePath}`);
    }

    expect(parseYaml((singleCron as { after: Buffer }).after.toString("utf8"))).toEqual({
      version: 4,
      name: "v3 to v4 fixture - enabled false with akm.schedule",
      uses: "commands/publish-report",
      schedule: "@daily",
    });
    expect(parseYaml((list as { after: Buffer }).after.toString("utf8"))).toEqual({
      version: 4,
      name: "v3 to v4 fixture - enabled false with on.schedule",
      uses: "commands/publish-report",
      schedule: [{ cron: "30 9 * * 2" }, { cron: "0 0 1 * *" }],
    });
  });

  test("blocks every ambiguous fixture with its stable catalog reason and leaves bytes untouched", () => {
    const before = captureFixtureBytes(ROOT);
    for (const entry of manifest.blocked) {
      const outcome = planTaskToV4File(fixtureInput(entry.file));
      expect(outcome.status, entry.file).toBe("blocked");
      expect(outcome.reason, entry.file).toBe(entry.reasonCode);
      expect(outcome.before.equals(fs.readFileSync(path.join(ROOT, entry.file))), entry.file).toBe(true);
    }
    assertFixtureBytesUnchanged(ROOT, before);
  });

  test("never guesses a github-action uses: target — the removal is named, not inferred", () => {
    const outcome = planTaskToV4File(fixtureInput("blocked/github-action.yml"));
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toBe("github-action-target-removed");
    expect(outcome.detail).toMatch(/github|action/i);
  });

  test("blocks a v3 document authoring both akm.schedule and on: at once, without touching its bytes", () => {
    const yaml = [
      "version: 3",
      "uses: commands/publish-report",
      "akm:",
      "  schedule: '@daily'",
      "on:",
      "  workflow_dispatch: {}",
      "",
    ].join("\n");
    const outcome = planTaskToV4File(memoryInput(yaml));
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toMatch(/schedul/i);
    expect(outcome.before.toString("utf8")).toBe(yaml);
  });

  test("blocks a v3 document with an unrecognized akm.* member instead of silently dropping it", () => {
    const yaml = ["version: 3", "uses: commands/publish-report", "akm:", "  schedule: '@daily'", "  bogus: 1", ""].join(
      "\n",
    );
    const outcome = planTaskToV4File(memoryInput(yaml));
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toMatch(/akm|unknown|unrecognized|invalid/i);
  });

  // F2: the frozen v3 reader rejects `on: {}` outright — "on must declare
  // schedule and/or workflow_dispatch." (task-source-v3-frozen.ts:396). A v3
  // document the oracle itself refuses to parse must never be laundered into
  // runnable v4 bytes; a schedule-less, trigger-less `on: {}` must block, not
  // fall through to the manual-dispatch notice as if workflow_dispatch had
  // actually been declared.
  test("blocks a v3 document whose on: declares no keys, instead of silently emitting a schedule-less v4 task", () => {
    const yaml = ["version: 3", "uses: commands/publish-report", "on: {}", ""].join("\n");
    const outcome = planTaskToV4File(memoryInput(yaml));
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toBe("invalid-v3-task");
    expect(outcome.before.toString("utf8")).toBe(yaml);
  });

  // F2: the frozen v3 reader also rejects a non-empty on.workflow_dispatch —
  // "must be null or an empty mapping; inputs are unsupported."
  // (task-source-v3-frozen.ts:426). Same fail-closed requirement as above.
  test("blocks a v3 document whose on.workflow_dispatch carries inputs, mirroring the frozen v3 reader's own rejection", () => {
    const yaml = [
      "version: 3",
      "uses: commands/publish-report",
      "on:",
      "  workflow_dispatch:",
      "    inputs:",
      "      foo:",
      "        type: string",
      "",
    ].join("\n");
    const outcome = planTaskToV4File(memoryInput(yaml));
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toBe("invalid-v3-task");
    expect(outcome.before.toString("utf8")).toBe(yaml);
  });

  test("blocks a task source whose version is neither 3 nor 4", () => {
    const outcome = planTaskToV4File(memoryInput("version: 5\nuses: commands/publish-report\nschedule: '@daily'\n"));
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toBe("unsupported-task-version");
  });

  test("a version: 4 document is skipped, never rewritten", () => {
    const outcome = planTaskToV4File(memoryInput("version: 4\nuses: commands/publish-report\nschedule: '@daily'\n"));
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("already-v4");
  });

  test("a version: 4 document with source-owned schedule enablement is rewritten for the strict runtime", () => {
    const outcome = planTaskToV4File(
      memoryInput("version: 4\nuses: commands/publish-report\nschedule:\n  - cron: '@daily'\n    enabled: true\n"),
    );
    expect(outcome.status).toBe("changed");
    expect(outcome.reason).toBe("source-enablement-removed");
    if (outcome.status !== "changed") throw new Error("expected changed migration outcome");
    expect(outcome.after.toString("utf8")).not.toContain("enabled:");
    expect(outcome.after.toString("utf8")).toContain("cron: '@daily'");
  });

  test("classifies changed, skipped, and blocked files in stable path order with a deterministic generation", () => {
    const alreadyV4 = Buffer.from("version: 4\nuses: commands/publish-report\nschedule: '@daily'\n");
    const files = [
      fixtureInput("deterministic/trigger-akm-schedule.yml"),
      { filePath: "/z/already.yml", bytes: alreadyV4, mode: 0o600, writable: true },
      fixtureInput("blocked/github-action.yml"),
    ];
    const first = planTaskToV4Migration(files);
    const second = planTaskToV4Migration([...files].reverse());
    expect(first.generation).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toEqual(first);
    expect(first.files.map(({ status, reason }: { status: string; reason: string }) => [status, reason])).toEqual([
      ["blocked", "github-action-target-removed"],
      ["changed", "task-converted"],
      ["skipped", "already-v4"],
    ]);
  });

  test("duplicate task migration file paths fail closed", () => {
    const source = memoryInput("version: 3\nuses: commands/publish-report\nakm:\n  schedule: '@daily'\n");
    expect(() => planTaskToV4Migration([source, { ...source }])).toThrow(/duplicate|file path/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// "task v3 to v4 filesystem boundary" — mirrors tests/migrate/task-v2-to-v3-files.test.ts
// ─────────────────────────────────────────────────────────────────────────

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; task: string; backup: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-v3-to-v4-"));
  roots.push(root);
  const task = path.join(root, "tasks", "demo.yml");
  fs.mkdirSync(path.dirname(task), { recursive: true });
  fs.writeFileSync(task, "version: 3\nuses: commands/publish-report\nakm:\n  schedule: '@daily'\n", { mode: 0o640 });
  return { root, task, backup: path.join(root, "backup") };
}

function plan(root: string) {
  return planTaskToV4Migration(
    inspectTaskToV4Files([{ bundleId: "fixture", root, bundleRoot: root, writable: true, layout: "akm-stash" }]),
  );
}

describe("task v3 to v4 filesystem boundary", () => {
  test("preview is read-only and apply writes v4 plus an exact backup, preserving mode, then converges on re-inspect", () => {
    const { root, task, backup } = fixture();
    const before = fs.readFileSync(task);
    const preview = plan(root);
    expect(preview.files.map((file: { status: string }) => file.status)).toEqual(["changed"]);
    expect(fs.readFileSync(task)).toEqual(before);

    const applied = applyTaskToV4MigrationPlan(preview, { backupRoot: backup });
    expect(applied.changed).toEqual([task]);
    const migrated = fs.readFileSync(task, "utf8");
    expect(migrated).toContain("version: 4");
    expect(parseTaskSourceV4({ yaml: migrated, filePath: task }).version).toBe(4);
    expect(fs.readFileSync(taskMigrationBackupPathV4(backup, task))).toEqual(before);
    expect(fs.statSync(task).mode & 0o777).toBe(0o640);

    const reInspected = plan(root);
    expect(reInspected.files.map((file: { status: string }) => file.status)).toEqual(["skipped"]);
  });

  test("one blocked file is skipped, not fatal: the rest of the batch still migrates", () => {
    const { root, task, backup } = fixture();
    const bad = path.join(root, "tasks", "bad.yml");
    fs.writeFileSync(bad, "version: 3\nuses: evilcorp/tool@v1\nakm:\n  schedule: '@daily'\n");
    const preview = plan(root);
    expect(preview.files.some((file: { status: string }) => file.status === "blocked")).toBe(true);
    expect(
      preview.files.some(
        (file: { filePath: string; status: string }) => file.filePath === task && file.status === "changed",
      ),
    ).toBe(true);

    const applied = applyTaskToV4MigrationPlan(preview, { backupRoot: backup });

    // The good file was migrated and backed up...
    expect(applied.changed).toEqual([task]);
    expect(fs.readFileSync(task, "utf8")).toContain("version: 4");
    expect(fs.readFileSync(taskMigrationBackupPathV4(backup, task))).toBeInstanceOf(Buffer);
    // ...while the blocked file was left untouched.
    expect(fs.readFileSync(bad, "utf8")).toContain("uses: evilcorp/tool@v1");
  });

  test("source drift after preview aborts before creating any backups", () => {
    const { root, task, backup } = fixture();
    const preview = plan(root);
    fs.writeFileSync(task, "version: 3\nuses: commands/publish-report\nakm:\n  schedule: '@hourly'\n");
    expect(() => applyTaskToV4MigrationPlan(preview, { backupRoot: backup })).toThrow(/changed after preview/);
    expect(fs.existsSync(backup)).toBe(false);
  });

  test("backups for every changed file are written before any mutation begins", () => {
    const { root, task, backup } = fixture();
    const before = fs.readFileSync(task);
    const preview = plan(root);
    // Force backup-root creation itself to fail: a plain file where the
    // migrator needs to mkdir a "files" subdirectory. If replace happened
    // before (or interleaved with) backup writing, this file would still end
    // up mutated despite the failed backup — it must not.
    fs.writeFileSync(backup, "not a directory");
    expect(() => applyTaskToV4MigrationPlan(preview, { backupRoot: backup })).toThrow();
    expect(fs.readFileSync(task)).toEqual(before);
  });

  test("apply re-validates every changed file's emitted bytes through the real v4 parser before any backup is written", () => {
    const { root, task, backup } = fixture();
    const before = fs.readFileSync(task);
    const preview = plan(root);
    const [first] = preview.files;
    if (!first || first.status !== "changed") throw new Error("expected a changed outcome");
    // A plan whose `after` bytes do not parse as valid task source v4 must
    // never reach the filesystem — even though planTaskToV4File itself would
    // never hand back invalid bytes, applyTaskToV4MigrationPlan re-checks
    // independently (mirrors task-files-to-v3.ts's own parseTaskV3Yaml
    // recheck immediately before backups are written).
    const tampered = { ...preview, files: [{ ...first, after: Buffer.from("version: 4\nuses: []\n") }] };
    expect(() => applyTaskToV4MigrationPlan(tampered, { backupRoot: backup })).toThrow();
    expect(fs.existsSync(backup)).toBe(false);
    expect(fs.readFileSync(task)).toEqual(before);
  });

  test("a later file's replace failure restores every already-replaced file to its original bytes and mode", () => {
    // A permission-based sabotage (chmod a directory read-only) does not
    // force this failure here — tests run as root, which bypasses Unix
    // permission checks entirely. A per-path filename-length ceiling is not:
    // even root cannot open a path segment over NAME_MAX (255 bytes on every
    // Linux filesystem this repo targets, tmpfs included). b's basename is
    // sized so its OWN backup name (+17 bytes: a 16-hex digest and a dash)
    // still fits, but replaceAtomically's temporary name (+46 bytes: a
    // leading dot, ".migrate-", and a 36-char UUID) does not — so its backup
    // is written like every other changed file, and only its own replace
    // fails with ENAMETOOLONG, after a's replace has already succeeded
    // (sorted path order: "demo.yml" < "z...z.yml"). CI is ubuntu-only
    // (.github/workflows/ci.yml), but a local Windows run has a different
    // path-length ceiling (classic MAX_PATH is a whole-path budget, not a
    // per-segment one) — skip there rather than assert a platform-specific
    // failure mode this test does not own.
    if (process.platform === "win32") return;
    const { root, task: taskA, backup } = fixture();
    const longName = `${"z".repeat(216)}.yml`;
    expect(longName.length).toBe(220);
    const taskB = path.join(root, "tasks", longName);
    const bodyB = "version: 3\nuses: commands/publish-report\nakm:\n  schedule: '@hourly'\n";
    fs.writeFileSync(taskB, bodyB, { mode: 0o640 });
    const bodyA = fs.readFileSync(taskA, "utf8");

    const preview = plan(root);
    expect(preview.files.map((file: { status: string }) => file.status)).toEqual(["changed", "changed"]);

    expect(() => applyTaskToV4MigrationPlan(preview, { backupRoot: backup })).toThrow();

    expect(fs.readFileSync(taskA, "utf8")).toBe(bodyA);
    expect(fs.statSync(taskA).mode & 0o777).toBe(0o640);
    expect(fs.readFileSync(taskB, "utf8")).toBe(bodyB);
    expect(fs.statSync(taskB).mode & 0o777).toBe(0o640);
    // Both backups were captured before either replace was attempted.
    expect(fs.readFileSync(taskMigrationBackupPathV4(backup, taskA), "utf8")).toBe(bodyA);
    expect(fs.readFileSync(taskMigrationBackupPathV4(backup, taskB), "utf8")).toBe(bodyB);
  });

  test("symlinked task sources are rejected", () => {
    const { root, task } = fixture();
    const linked = path.join(root, "tasks", "linked.yml");
    fs.symlinkSync(task, linked);
    expect(() => plan(root)).toThrow(/does not follow symbolic link/);
  });

  test("standalone akm-task roots inspect top-level yml files", () => {
    const { root } = fixture();
    const standalone = path.join(root, "standalone");
    fs.mkdirSync(standalone);
    fs.writeFileSync(
      path.join(standalone, "flat.yml"),
      "version: 4\nname: flat\nuses: commands/publish-report\nschedule: '@daily'\n",
    );
    const inputs = inspectTaskToV4Files([
      { bundleId: "flat", root: standalone, bundleRoot: standalone, writable: true, layout: "akm-task" },
    ]);
    expect(inputs.map((input: { filePath: string }) => path.basename(input.filePath))).toEqual(["flat.yml"]);
  });
});
