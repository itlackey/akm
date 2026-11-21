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
import type { HealthCheckResult } from "../../../src/commands/health/types";
import { openStateDatabase } from "../../../src/core/state-db";
import { _setOpencodeVersionProbeForTests } from "../../../src/integrations/harnesses/opencode/version";
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
  function configureHarness() {
    const bin = path.join(storage.root, "bin", "opencode");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeSandboxConfig({ harnesses: { opencode: { platform: "opencode", bin } } });
    return bin;
  }

  test("advises on an OpenCode 1 harness, with the run notice's wording", async () => {
    const bin = configureHarness();
    _setOpencodeVersionProbeForTests(() => "1.18.25");
    const advisory = check(await akmHealth({ since: "1h" }), "opencode-major");
    expect(advisory.status).toBe("warn");
    expect(advisory.message).toContain(`OpenCode 1 (${bin} 1.18.25) is deprecated and is removed in 0.11`);
  });

  test("is absent for OpenCode 2 and unknown when the version cannot be read", async () => {
    configureHarness();
    _setOpencodeVersionProbeForTests(() => "2.0.26");
    const two = await akmHealth({ since: "1h" });
    expect(two.advisories.find((c) => c.name === "opencode-major")).toBeUndefined();
    _setOpencodeVersionProbeForTests(() => undefined);
    const unreadable = check(await akmHealth({ since: "1h" }), "opencode-major");
    expect(unreadable.status).toBe("unknown");
  });
});

describe("the md report renders everything the result holds (B10-45)", () => {
  test("checks, comparison, runs and the proposal queue", async () => {
    const result = await runCliCapture(["doctor", "--no-probe", "--report", "--format", "md"]);
    expect(result.stdout).toContain("## Checks");
    expect(result.stdout).toContain("task-fail-rate");
    expect(result.stdout).toContain("## Window comparison");
    expect(result.stdout).toContain("## Runs");
    expect(result.stdout).toContain("## Pending proposals");
  });
});
