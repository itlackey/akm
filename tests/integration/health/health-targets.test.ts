// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `targets` table as `akm health` and `akm info` emit it: the same rows in
 * the JSON of both, and the text rendering. `akm info` contacts nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmHealth } from "../../../src/commands/health";
import { runTargetsCheck } from "../../../src/commands/health/targets-check";
import { probeLlmEndpoint } from "../../../src/llm/client";
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

describe("the targets table in akm health", () => {
  test("its rows carry exactly the documented fields", async () => {
    const rows = await targetRowsOf();
    expect(rows[0]).toEqual({
      type: "connection",
      name: "default",
      default: true,
      endpoint: "http://localhost:11434/v1",
      key: "none",
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
    expect(rows).toEqual(await targetRowsOf());
  });

  test("the text format prints the three tables", async () => {
    const { stdout } = await runCliCapture(["info", "--format", "text"]);
    expect(stdout).toContain("connections:");
    expect(stdout).toContain("work:");
    expect(stdout).toContain("agents         connection default  mid");
  });
});

describe("the targets check over HTTP", () => {
  test("a loopback endpoint that answers is reachable; a closed port is not, and says why", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ data: [] }) });
    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const closedPort = closed.port;
    closed.stop(true);
    try {
      const result = await runTargetsCheck({
        loadConfig: () => ({
          semanticSearchMode: "off",
          connections: {
            up: { endpoint: `http://127.0.0.1:${server.port}/v1`, models: { fast: "m" } },
            down: { endpoint: `http://127.0.0.1:${closedPort}/v1`, models: { fast: "m" } },
          },
        }),
        probeReachable: probeLlmEndpoint,
      });
      const rows = result.evidence?.rows as Row[];
      expect(rows.find((row) => row.name === "up")).toMatchObject({ reachable: true });
      expect(rows.find((row) => row.name === "down")).toMatchObject({ reachable: false });
      expect(result.status).toBe("warn");
      expect(result.message).toContain('connection "down" is not reachable');
    } finally {
      server.stop(true);
    }
  });
});
