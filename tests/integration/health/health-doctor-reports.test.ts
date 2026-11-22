// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm doctor` reports what it counted and why: v5 agent steps in `agentFailureRate`, the runs behind
 * `task-fail-rate`, the configured strategy in `proposal-queue`, the unscanned sources in `index-sources`, OpenCode 1
 * in `opencode-major`, and every part of the result in the md report.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmHealth } from "../../../src/commands/health";
import { collectOpencodeMajorAdvisory } from "../../../src/commands/health/opencode-major";
import type { HealthCheckResult } from "../../../src/commands/health/types";
import { recordImproveRunResult } from "../../../src/commands/improve/improve-result-file";
import { createProposal } from "../../../src/commands/proposal/repository";
import type { ImproveResultEnvelope } from "../../../src/core/improve-result";
import type { AkmImproveResult } from "../../../src/core/improve-types";
import { openStateDatabase } from "../../../src/core/state-db";
import { _setOpencodeVersionProbeForTests } from "../../../src/integrations/harnesses/opencode/version";
import { recordImproveRun } from "../../../src/storage/repositories/improve-runs-repository";
import { upsertTaskHistory } from "../../../src/storage/repositories/task-history-repository";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  _setOpencodeVersionProbeForTests();
  storage.cleanup();
});

function check(result: { hardChecks: HealthCheckResult[]; advisories: HealthCheckResult[] }, name: string) {
  const found = [...result.hardChecks, ...result.advisories].find((c) => c.name === name);
  if (!found) throw new Error(`no check named ${name}`);
  return found;
}

let tick = 0;
function seed(row: {
  task: string;
  status: "completed" | "failed";
  kind: string;
  metadata: Record<string, unknown>;
}): void {
  const at = new Date(Date.now() - 1000 + tick++).toISOString();
  const db = openStateDatabase();
  try {
    upsertTaskHistory(db, {
      task_id: row.task,
      status: row.status,
      started_at: at,
      completed_at: at,
      failed_at: row.status === "failed" ? at : null,
      log_path: null,
      target_kind: row.kind,
      target_ref: null,
      metadata_json: JSON.stringify({ metadataVersion: 2, durationMs: 5, detail: null, ...row.metadata }),
    });
  } finally {
    db.close();
  }
}

const step = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  kind: "run",
  status: "completed",
  durationMs: 1,
  attempts: 1,
  ...extra,
});

describe("agentFailureRate counts every agent dispatch (B10-10)", () => {
  test("v5 agent steps are counted with their reasons; steps without the agent fact are not", async () => {
    for (let i = 0; i < 2; i++) {
      seed({
        task: "v5-agent",
        status: "failed",
        kind: "steps",
        metadata: {
          trigger: "schedule",
          steps: [
            step("script"),
            step("ask", { kind: "prompt", status: "failed", agent: { engine: "fake", reason: "parse_error" } }),
          ],
        },
      });
    }
    // Written before the agent fact was recorded: unknown, not counted.
    seed({
      task: "old-v5",
      status: "completed",
      kind: "steps",
      metadata: { steps: [step("ask", { kind: "prompt" })] },
    });
    const result = await akmHealth({ since: "1h" });
    expect(result.metrics.agentFailureRate).toBe(1);
    expect(result.metrics.agentFailureReasonCounts).toEqual({ parse_error: 2 });
    expect(check(result, "task-fail-rate").evidence?.agentFailureReasonCounts).toEqual({ parse_error: 2 });
  });

  test("with no agent dispatch the rate is unknown (null), not 0", async () => {
    seed({ task: "script-only", status: "completed", kind: "shell", metadata: { trigger: "manual" } });
    const result = await akmHealth({ since: "1h" });
    expect(result.metrics.agentFailureRate).toBeNull();
    expect(result.metrics.taskFailRate).toBe(0);
  });

  test("with no task run at all the task fail rate is unknown too", async () => {
    expect((await akmHealth({ since: "1h" })).metrics.taskFailRate).toBeNull();
  });

  test("a succeeded agent step is a dispatch that did not fail", async () => {
    seed({
      task: "v5-agent",
      status: "completed",
      kind: "steps",
      metadata: { steps: [step("ask", { kind: "prompt", agent: { engine: "fake" } })] },
    });
    seed({
      task: "v5-agent",
      status: "failed",
      kind: "steps",
      metadata: {
        steps: [step("ask", { kind: "prompt", status: "failed", agent: { engine: "fake", reason: "timeout" } })],
      },
    });
    const result = await akmHealth({ since: "1h" });
    expect(result.metrics.agentFailureRate).toBe(0.5);
  });
});

describe("a state.db that cannot be read (B10-36)", () => {
  test("every metric and the improve summary are unknown (null), not zero", async () => {
    const stateDb = path.join(storage.root, "unreadable-state.db");
    fs.writeFileSync(stateDb, "this is not a sqlite database, only bytes ".repeat(40));
    const result = await akmHealth({ since: "1h", stateDbPath: stateDb });
    expect(result.status).toBe("fail");
    expect(result.metrics).toEqual({
      taskFailRate: null,
      agentFailureRate: null,
      agentFailureReasonCounts: null,
      stuckActiveRuns: null,
      llmUsage: null,
    });
    expect(result.improve).toBeNull();
  });
});

describe("renderers show an unknown metric as unknown", () => {
  test("text and md", async () => {
    const text = (await runCliCapture(["doctor", "--no-probe", "--format", "text"])).stdout;
    expect(text).toContain("metrics.agentFailureRate=unknown");
    const md = (await runCliCapture(["doctor", "--no-probe", "--format", "md"])).stdout;
    expect(md).toMatch(/### agentFailureRate\n\nunknown/);
  });
});

describe("task-fail-rate and auto-accept report what they counted (B10-36)", () => {
  test("a fresh install is unknown (idle) for both", async () => {
    const result = await akmHealth({ since: "1h" });
    expect(check(result, "task-fail-rate")).toMatchObject({ status: "unknown", reason: "idle" });
    expect(check(result, "auto-accept-validation")).toMatchObject({ status: "unknown", reason: "idle" });
  });

  test("the message counts runs by trigger", async () => {
    seed({ task: "t", status: "failed", kind: "shell", metadata: { trigger: "manual" } });
    const result = await akmHealth({ since: "1h" });
    const advisory = check(result, "task-fail-rate");
    expect(advisory.message).toContain("1 run of 1 task (1 manual)");
    expect(advisory.message).not.toContain("Cron");
  });
});

describe("a corrupt history row (B10-36)", () => {
  test("warns once and is counted as unreadable, not as a run with no recorded trigger", async () => {
    seed({ task: "ok", status: "completed", kind: "shell", metadata: { trigger: "manual" } });
    const db = openStateDatabase();
    try {
      upsertTaskHistory(db, {
        task_id: "broken",
        status: "completed",
        started_at: new Date().toISOString(),
        completed_at: null,
        failed_at: null,
        log_path: null,
        target_kind: "command",
        target_ref: null,
        metadata_json: "{not json",
      });
    } finally {
      db.close();
    }
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
    try {
      const result = await akmHealth({ since: "1h" });
      expect(check(result, "task-fail-rate").message).toContain("1 unreadable");
      expect(check(result, "task-fail-rate").message).not.toContain("no recorded trigger");
    } finally {
      console.warn = original;
    }
    expect(warnings.filter((line) => line.includes("task_id=broken"))).toHaveLength(1);
  });
});

describe("a corrupt improve run (B10-36)", () => {
  test("warns once per row in per-run mode, and still shows the row", async () => {
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const db = openStateDatabase();
    try {
      recordImproveRun(db, {
        id: "bad-run",
        startedAt,
        completedAt: startedAt,
        stashDir: storage.stashDir,
        dryRun: false,
        strategy: "default",
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: { schemaVersion: 99, ok: true } as unknown as ImproveResultEnvelope,
      });
    } finally {
      db.close();
    }
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
    try {
      const result = await akmHealth({ since: "1h", groupBy: "run" });
      expect(result.runs?.map((run) => run.id)).toEqual(["bad-run"]);
      expect(result.improve?.resultRows?.skipped.invalid).toBe(1);
    } finally {
      console.warn = original;
    }
    expect(warnings.filter((line) => line.includes("id=bad-run"))).toHaveLength(1);
  });
});

describe("proposal-queue names what is off (B10-47)", () => {
  test("learning on, extraction not enabled: names extraction and the strategy", async () => {
    writeSandboxConfig({
      improve: { strategy: "quiet", strategies: { quiet: { processes: { extract: { enabled: false } } } } },
    });
    const result = await akmHealth({ since: "1h" });
    const message = check(result, "proposal-queue").message;
    expect(message).toContain('Session extraction is not enabled in improve strategy "quiet"');
    expect(message).not.toContain("Learning is off");
  });

  test("a removed strategy is blocked with the resolver's message, not 'not enabled'", async () => {
    writeSandboxConfig({ improve: { strategy: "thorough" } });
    const result = await akmHealth({ since: "1h" });
    const queue = check(result, "proposal-queue");
    expect(queue).toMatchObject({ status: "unknown", reason: "blocked" });
    expect(queue.message).toContain("was removed in 0.10");
    expect(queue.message).not.toContain("Session extraction is not enabled");
    expect(check(result, "session-extraction")).toMatchObject({ status: "unknown", reason: "blocked" });
  });

  test("improve.enabled false: learning is off", async () => {
    writeSandboxConfig({ improve: { enabled: false } });
    const result = await akmHealth({ since: "1h" });
    expect(check(result, "proposal-queue").message).toContain("Learning is off");
  });
});

describe("index-sources (B10-42)", () => {
  test("names a source the last index could not scan, with its reason; passes once it is back", async () => {
    const dir = path.join(storage.root, "team-notes");
    fs.mkdirSync(path.join(dir, "knowledge"), { recursive: true });
    fs.writeFileSync(path.join(dir, "knowledge", "note.md"), "---\ndescription: a note\n---\n\n# A note\n");
    expect((await runCliCapture(["bundle", "add", dir, "--name", "notes"])).code).toBe(0);
    expect((await runCliCapture(["index"])).code).toBe(0);
    expect(check(await akmHealth({ since: "1h" }), "index-sources").status).toBe("pass");

    fs.renameSync(dir, `${dir}.moved`);
    expect((await runCliCapture(["index"])).code).toBe(0);
    const warned = check(await akmHealth({ since: "1h" }), "index-sources");
    expect(warned.status).toBe("warn");
    expect(warned.message).toContain("notes");
    expect(warned.message).toContain("ENOENT");
    expect(warned.message).not.toContain("serves");

    fs.renameSync(`${dir}.moved`, dir);
    expect((await runCliCapture(["index"])).code).toBe(0);
    expect(check(await akmHealth({ since: "1h" }), "index-sources").status).toBe("pass");
  });

  test("an index that cannot be read is unknown, not pass", async () => {
    const { getDbPath } = await import("../../../src/core/paths");
    fs.mkdirSync(path.dirname(getDbPath()), { recursive: true });
    fs.writeFileSync(getDbPath(), "not a database");
    const result = check(await akmHealth({ since: "1h" }), "index-sources");
    expect(result.status).toBe("unknown");
    expect(result.reason).toBe("blocked");
  });
});

describe("opencode-major (R-01-DEP)", () => {
  function binary(name: string): string {
    const bin = path.join(storage.root, "bin", name);
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return bin;
  }
  function configure(...names: string[]) {
    const harnesses = Object.fromEntries(names.map((name) => [name, { platform: "opencode", bin: binary(name) }]));
    writeSandboxConfig({ harnesses });
    return harnesses as Record<string, { bin: string }>;
  }

  test("advises on an OpenCode 1 harness, with the run notice's wording", () => {
    const { opencode } = configure("opencode");
    _setOpencodeVersionProbeForTests(() => "1.18.25");
    const advisory = collectOpencodeMajorAdvisory(true);
    expect(advisory?.status).toBe("warn");
    expect(advisory?.message).toContain(`OpenCode 1 (${opencode?.bin} 1.18.25) is deprecated and is removed in 0.11`);
  });

  test("is absent for OpenCode 2", () => {
    configure("opencode");
    _setOpencodeVersionProbeForTests(() => "2.0.26");
    expect(collectOpencodeMajorAdvisory(true)).toBeUndefined();
  });

  test("--no-probe runs no binary and says it was not probed", async () => {
    configure("opencode");
    const probed: string[] = [];
    _setOpencodeVersionProbeForTests((bin) => {
      probed.push(bin);
      return "1.18.25";
    });
    const advisory = check(await akmHealth({ since: "1h", probe: false }), "opencode-major");
    expect(advisory).toMatchObject({ status: "unknown", reason: "not-probed" });
    expect(advisory.message).toContain('harness "opencode"');
    expect(probed).toEqual([]);
  });

  test("an unreadable harness is named beside an OpenCode 1 one", () => {
    const harnesses = configure("old", "odd");
    _setOpencodeVersionProbeForTests((bin) => (bin === harnesses.old?.bin ? "1.18.25" : "true (GNU coreutils) 9.7"));
    const advisory = collectOpencodeMajorAdvisory(true);
    expect(advisory?.status).toBe("warn");
    expect(advisory?.message).toContain('Harness "old"');
    expect(advisory?.message).toContain('harness "odd"');
    expect(JSON.stringify(advisory?.evidence)).toContain("odd");
  });

  test("an unreadable harness says what the binary printed, or that it did not run", () => {
    const harnesses = configure("odd");
    _setOpencodeVersionProbeForTests(() => "true (GNU coreutils) 9.7");
    const printed = collectOpencodeMajorAdvisory(true);
    expect(printed).toMatchObject({ status: "unknown", reason: "blocked" });
    expect(printed?.message).toContain("true (GNU coreutils) 9.7");
    _setOpencodeVersionProbeForTests(() => undefined);
    expect(collectOpencodeMajorAdvisory(true)?.message).toContain(`${harnesses.odd?.bin}) could not be run`);
  });
});

describe("the md report renders everything the result holds (B10-45)", () => {
  const improved = (): AkmImproveResult => ({
    schemaVersion: 2,
    ok: true,
    strategy: "default",
    scope: { mode: "all" },
    dryRun: false,
    memorySummary: { eligible: 0, derived: 0 },
    plannedRefs: [],
    actions: [],
  });

  test("the status, checks, comparison, runs, the queue and every other field", async () => {
    seed({ task: "flaky", status: "failed", kind: "shell", metadata: { trigger: "manual" } });
    const first = new Date(Date.now() - 120_000).toISOString();
    const second = new Date(Date.now() - 60_000).toISOString();
    recordImproveRunResult(storage.stashDir, "run-a", improved(), first);
    recordImproveRunResult(storage.stashDir, "run-b", improved(), second);
    createProposal(storage.stashDir, {
      ref: "knowledge/queued-note",
      source: "extract",
      sourceRun: "run-a",
      target: { source: "stash", root: storage.stashDir },
      payload: { content: "# note\n", frontmatter: { description: "queued" } },
    });

    const result = await runCliCapture(["doctor", "--no-probe", "--report", "--format", "md"]);
    const out = result.stdout;
    expect(out).toContain("## status");
    expect(out.indexOf("## status")).toBeLessThan(out.indexOf("## Checks"));
    expect(out).toMatch(/task-fail-rate\s+warn/);
    expect(out).toContain("## Window comparison");
    expect(out).toContain(first);
    expect(out).toContain(second);
    expect(out).toContain("knowledge/queued-note");
    for (const field of ["metrics", "improve", "scheduler", "report"]) expect(out).toContain(`## ${field}`);
    expect(out).toContain("acceptRateBySource");
    expect(out).not.toMatch(/^## (shape|schemaVersion)$/m);
  });

  test("a plain doctor md keeps the status, metrics, improve and scheduler sections", async () => {
    const out = (await runCliCapture(["doctor", "--no-probe", "--format", "md"])).stdout;
    for (const field of ["status", "metrics", "improve", "scheduler"]) expect(out).toContain(`## ${field}`);
    expect(out).not.toMatch(/^## (shape|schemaVersion)$/m);
  });
});
