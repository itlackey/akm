// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The pure task v3 -> task source v4 planner (`src/tasks/source/task-to-v4.ts`):
 * the translation table, the blocked catalog, and classification/generation
 * determinism, driven off the fixture corpus at
 * tests/fixtures/execution-contracts/tasks/v3-to-v4/ (deterministic|blocked
 * split, mirroring tests/tasks/migrate-v2-to-v3.test.ts and the tasks/v2
 * manifest.json shape). The same planner runs in memory on every task read
 * (`parse-task-source.ts`) and on disk under `akm migrate apply`
 * (`scripts/akm-migrate/migrate/task-files.ts`, tests/migrate/task-files.test.ts).
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
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
