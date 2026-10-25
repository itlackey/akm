// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `targets` health check: one table of the connections and harnesses and
 * the work that runs on them, with reachability and versions from the probes
 * the caller supplies. Registered in place of the per-engine advisories.
 */

import { describe, expect, test } from "bun:test";
import type { spawnSync } from "node:child_process";
import { HEALTH_CHECKS, type HealthCheckContext } from "../src/commands/health/checks";
import { type ReachabilityProbe, runTargetsCheck } from "../src/commands/health/targets-check";
import type { HealthCheckResult } from "../src/commands/health/types";
import type { AkmConfig } from "../src/core/config/config";

const cfg = (partial: Partial<AkmConfig> = {}): AkmConfig => ({ semanticSearchMode: "off", ...partial });
const MODELS = { fast: "small", balanced: "mid", reasoning: "big" };
const onPath =
  (...bins: string[]) =>
  (bin: string) =>
    bins.includes(bin) ? `/usr/bin/${bin}` : undefined;

/** A stand-in for `spawnSync`: the version a binary prints, or a failing exit. */
const versions = (byBin: Record<string, string>): typeof spawnSync =>
  ((bin: string) =>
    bin in byBin
      ? { status: 0, stdout: `${byBin[bin]}\nmore`, stderr: "" }
      : { status: 1, stdout: "", stderr: "" }) as unknown as typeof spawnSync;

const rowsOf = (result: HealthCheckResult) =>
  (result.evidence?.rows as Array<Record<string, unknown>>).map((row) => ({ ...row }));

describe("runTargetsCheck", () => {
  const config = cfg({
    connections: { default: { endpoint: "http://localhost:11434/v1", models: MODELS } },
    harnesses: { claude: {} },
  });

  test("passes, with one table, when every connection answers and every harness is installed", async () => {
    const probed: string[] = [];
    const probeReachable: ReachabilityProbe = async ({ endpoint }) => {
      probed.push(endpoint);
      return { reachable: true };
    };

    const result = await runTargetsCheck({
      loadConfig: () => config,
      probeReachable,
      which: onPath("claude"),
      spawnSync: versions({ claude: "2.1.0 (Claude Code)" }),
      env: {},
    });

    expect(result).toMatchObject({ name: "targets", status: "pass", kind: "deterministic" });
    expect(result.message).toBe("1 connection and 1 harness, all ready.");
    const rows = rowsOf(result);
    expect(rows.map((row) => `${row.type}:${row.name ?? row.process}`)).toEqual([
      "connection:default",
      "harness:claude",
      "process:improve",
      "process:judges",
      "process:agents",
      "process:extract",
      "process:enrich",
      "process:index",
      "process:embedding",
      "process:curate-rerank",
    ]);
    expect(rows[0]).toMatchObject({ reachable: true, key: "none", default: true });
    expect(rows[1]).toMatchObject({ installed: true, version: "2.1.0 (Claude Code)" });
    expect(probed).toEqual(["http://localhost:11434/v1"]);
  });

  test("an endpoint that does not answer is a warning naming the connection and why", async () => {
    const result = await runTargetsCheck({
      loadConfig: () => config,
      probeReachable: async () => ({ reachable: false, error: "connection refused" }),
      which: onPath("claude"),
      spawnSync: versions({}),
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain('connection "default" is not reachable (connection refused)');
  });

  test("a harness that is not installed is a warning", async () => {
    const result = await runTargetsCheck({ loadConfig: () => config, which: onPath(), spawnSync: versions({}) });
    expect(result.status).toBe("warn");
    expect(result.message).toContain('harness "claude" (claude) was not found on PATH');
    expect(rowsOf(result)[1]).toMatchObject({ installed: false });
    expect(rowsOf(result)[1]).not.toHaveProperty("version");
  });

  test("a key variable that is not set is a warning that never names the variable", async () => {
    const result = await runTargetsCheck({
      loadConfig: () =>
        cfg({ connections: { lab: { endpoint: "http://lab/v1", apiKey: "$LAB_SECRET_VAR", models: MODELS } } }),
      env: {},
      which: onPath(),
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain('connection "lab": the variable holding its key is not set');
    expect(JSON.stringify(result)).not.toContain("LAB_SECRET_VAR");
  });

  test("a version that cannot be read is no reason to warn", async () => {
    const result = await runTargetsCheck({
      loadConfig: () => config,
      which: onPath("claude"),
      spawnSync: versions({}),
    });
    expect(result.status).toBe("pass");
    expect(rowsOf(result)[1]).not.toHaveProperty("version");
  });

  test("without a probe nothing is contacted, and the message says so", async () => {
    const result = await runTargetsCheck({
      loadConfig: () => config,
      which: onPath("claude"),
      spawnSync: versions({}),
    });
    expect(result.status).toBe("pass");
    expect(result.message).toBe("1 connection and 1 harness, all ready. Reachability was not probed.");
    expect(rowsOf(result)[0]).not.toHaveProperty("reachable");
  });

  test("an endpoint two connections share is asked once", async () => {
    let asked = 0;
    await runTargetsCheck({
      loadConfig: () =>
        cfg({
          connections: {
            a: { endpoint: "http://shared/v1", models: MODELS },
            b: { endpoint: "http://shared/v1/", models: MODELS },
          },
        }),
      probeReachable: async () => {
        asked += 1;
        return { reachable: true };
      },
    });
    expect(asked).toBe(1);
  });

  test("nothing configured is unknown, and says how to get started", async () => {
    const result = await runTargetsCheck({ loadConfig: () => cfg() });
    expect(result.status).toBe("unknown");
    expect(result.message).toContain("akm setup");
    expect(rowsOf(result).every((row) => row.type === "process" && row.kind === null)).toBe(true);
  });

  test("a work row that cannot resolve because of the config is reported with its reason", async () => {
    const result = await runTargetsCheck({
      loadConfig: () => cfg({ connections: { default: { endpoint: "http://a/v1" } } }),
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain('improve: Connection "default" lists no models');
  });
});

describe("the health-check registry", () => {
  test("`targets` is one hard check in place of the engine, model-alias and improve-strategy advisories", () => {
    const names = HEALTH_CHECKS.map((check) => check.name);
    expect(names).toContain("targets");
    expect(HEALTH_CHECKS.find((check) => check.name === "targets")?.channel).toBe("hard");
    for (const gone of [
      "default-engine",
      "default-llm-engine",
      "configured-engines",
      "selected-model-aliases",
      "model-map-files",
      "active-improve-strategy",
      "thinking-control",
      "engine-last-used",
    ]) {
      expect(names).not.toContain(gone);
    }
  });

  test("is a pure projection of ctx.targets", () => {
    const targets: HealthCheckResult = {
      name: "targets",
      kind: "deterministic",
      status: "pass",
      confidence: "high",
      message: "ok",
    };
    const check = HEALTH_CHECKS.find((c) => c.name === "targets");
    expect(check?.run({ targets } as unknown as HealthCheckContext)).toBe(targets);
  });
});
