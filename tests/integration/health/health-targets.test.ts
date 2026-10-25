// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `targets` table as `akm health` and `akm info` emit it: the same rows in
 * the JSON of both, the last recorded call of each connection read from the real
 * `llm_usage` events, and the text rendering. `akm info` contacts nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmHealth } from "../../../src/commands/health";
import { ENGINE_LAST_USED_LOOKBACK_DAYS } from "../../../src/commands/health/engine-usage";
import { appendEvent } from "../../../src/core/events";
import { runCliCapture } from "../../_helpers/cli";
import {
  type IsolatedAkmStorage,
  withIsolatedAkmStorage,
  withMockedFetch,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({
    connections: {
      default: { endpoint: "http://localhost:11434/v1", models: { fast: "small", balanced: "mid", reasoning: "big" } },
    },
  });
});

afterEach(() => storage.cleanup());

type Row = Record<string, unknown>;
const targetRowsOf = async (since = "7d"): Promise<Row[]> => {
  const result = await akmHealth({ since });
  return (result.hardChecks.find((check) => check.name === "targets")?.evidence?.rows as Row[]) ?? [];
};

/** An `llm_usage` event for `engine`, `daysAgo` days in the past. */
function seedLlmUsage(engine: string, daysAgo: number): string {
  const ts = Date.now() - daysAgo * 24 * 60 * 60_000;
  appendEvent({ eventType: "llm_usage", metadata: { engine, process: "reflect", durationMs: 500 } }, { now: () => ts });
  return new Date(ts).toISOString();
}

describe("the targets table in akm health", () => {
  test("its rows carry exactly the documented fields", async () => {
    const rows = await targetRowsOf();
    expect(rows[0]).toEqual({
      type: "connection",
      name: "default",
      default: true,
      endpoint: "http://localhost:11434/v1",
      key: "none",
      lastUsedAt: null,
    });
    expect(rows.slice(1).map((row) => Object.keys(row).sort())).toEqual(
      rows.slice(1).map(() => ["kind", "model", "process", "target", "type"]),
    );
    expect(rows.find((row) => row.process === "improve")).toEqual({
      type: "process",
      process: "improve",
      kind: "connection",
      target: "default",
      model: "small",
    });
  });

  test("a connection's last recorded call is read from llm_usage, inside the lookback window only", async () => {
    const recent = seedLlmUsage("default", 2);
    expect((await targetRowsOf())[0]).toMatchObject({ name: "default", lastUsedAt: recent });
  });

  test("a call older than the lookback window does not count", async () => {
    seedLlmUsage("default", ENGINE_LAST_USED_LOOKBACK_DAYS + 5);
    expect((await targetRowsOf())[0]).toMatchObject({ lastUsedAt: null });
  });

  test("the text format always shows the table, brief or not", async () => {
    const { stdout } = await runCliCapture(["health", "--no-probe", "--format", "text"]);
    expect(stdout).toContain("targets  [pass, deterministic, high]  1 connection and 0 harnesses, all ready.");
    expect(stdout).toContain("connections:");
    expect(stdout).toContain("improve        connection default  small");
  });
});

describe("the targets table in akm info", () => {
  test("is the same rows, with nothing contacted", async () => {
    let fetchCalls = 0;
    const { stdout } = await withMockedFetch(
      () => runCliCapture(["info", "--format", "json"]),
      () => {
        fetchCalls += 1;
        return new Response("no", { status: 500 });
      },
    );
    expect(fetchCalls).toBe(0);
    const rows = (JSON.parse(stdout) as { targets: Row[] }).targets;
    expect(rows[0]).toEqual({
      type: "connection",
      name: "default",
      default: true,
      endpoint: "http://localhost:11434/v1",
      key: "none",
    });
    expect(rows).toEqual((await targetRowsOf()).map((row) => ("lastUsedAt" in row ? withoutLastUsed(row) : row)));
  });

  test("the text format prints the three tables", async () => {
    const { stdout } = await runCliCapture(["info", "--format", "text"]);
    expect(stdout).toContain("connections:");
    expect(stdout).toContain("work:");
    expect(stdout).toContain("agents         connection default  mid");
  });
});

function withoutLastUsed(row: Row): Row {
  const { lastUsedAt: _lastUsedAt, ...rest } = row;
  return rest;
}
