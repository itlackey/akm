// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What the built artifacts (the Node entry and the standalone binary) are asked
 * to do with models, whichever runtime runs them: `setup --endpoint`, `models`,
 * `health` and `info` on a config with a connection and on a config with only a
 * harness. Each runtime's smoke test supplies a `run` that executes one `akm`
 * command in its own sandbox; the sequences are the same, so they live here.
 *
 * Nothing contacts the network: the endpoint is a discard port and every
 * command that would ask it passes `--no-probe`.
 */

import { expect } from "bun:test";

export interface SmokeResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs one `akm` command in the sandbox under test. */
export type SmokeRun = (args: string[]) => SmokeResult;

const UNREACHABLE_ENDPOINT = "http://127.0.0.1:9/v1";

function json(result: SmokeResult, label: string): Record<string, unknown> {
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`${label} printed no JSON:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

interface TargetRow {
  type: string;
  name?: string;
  default?: boolean;
  installed?: boolean;
  key?: string;
}

/** The rows of the `targets` check `akm health` reports. */
function healthRows(result: SmokeResult): TargetRow[] {
  const checks = (json(result, "health").hardChecks ?? []) as Array<{
    name: string;
    evidence?: { rows?: TargetRow[] };
  }>;
  return checks.find((check) => check.name === "targets")?.evidence?.rows ?? [];
}

/** The same rows as `akm info` prints them, without probing. */
function infoRows(result: SmokeResult): TargetRow[] {
  return (json(result, "info").targets ?? []) as TargetRow[];
}

/** A config with one connection: set up from flags, its models listed and changed, and reported by health and info. */
export function expectConnectionConfig(run: SmokeRun): void {
  const setup = run(["setup", "--yes", "--no-probe", "--endpoint", UNREACHABLE_ENDPOINT]);
  expect(setup.status, `setup --endpoint\n${setup.stderr}`).toBe(0);
  expect(json(setup, "setup").shape).toBe("setup");

  const set = run(["models", "set", "fast", "smoke-model", "--no-probe"]);
  expect(set.status, `models set\n${set.stderr}`).toBe(0);
  expect(json(set, "models set")).toMatchObject({ shape: "models-set", connection: "default", model: "smoke-model" });

  const models = run(["models", "--no-probe"]);
  expect(models.status, `models\n${models.stderr}`).toBe(0);
  expect(json(models, "models")).toMatchObject({
    shape: "models",
    connection: "default",
    aliases: { fast: "smoke-model" },
    available: [],
  });

  // Without a key variable or a stored key the connection is `none`; a warn from anything else is not this test's business.
  const health = run(["health", "--no-probe"]);
  expect([0, 4], `health --no-probe\n${health.stderr}`).toContain(health.status);
  expect(healthRows(health)).toContainEqual(
    expect.objectContaining({ type: "connection", name: "default", key: "none" }),
  );

  const info = run(["info"]);
  expect(info.status, `info\n${info.stderr}`).toBe(0);
  expect(infoRows(info)).toContainEqual(expect.objectContaining({ type: "connection", name: "default" }));
}

/**
 * A config with only a harness: nothing to list or change on `akm models`, which says so and points at `akm setup`,
 * while health and info report the harness.
 */
/**
 * The error envelope akm prints on stderr. A runtime may print its own warnings
 * on stderr around it (Node 26 does), so the envelope is the JSON object between
 * the first `{` and the last `}`, not the whole stream.
 */
function errorEnvelope(stderr: string): { code?: string; hint?: string } {
  const start = stderr.indexOf("{");
  const end = stderr.lastIndexOf("}");
  expect(start, `no JSON error envelope on stderr:\n${stderr}`).toBeGreaterThanOrEqual(0);
  return JSON.parse(stderr.slice(start, end + 1)) as { code?: string; hint?: string };
}

export function expectHarnessOnlyConfig(run: SmokeRun): void {
  const set = run(["config", "set", "harnesses.claude", "{}", "--silent"]);
  expect(set.status, `config set harnesses.claude\n${set.stderr}`).toBe(0);

  const models = run(["models", "--no-probe"]);
  expect(models.status, `models without a connection\n${models.stdout}`).toBe(78);
  const failure = errorEnvelope(models.stderr);
  expect(failure.code).toBe("LLM_NOT_CONFIGURED");
  expect(failure.hint).toContain("akm setup");

  const health = run(["health", "--no-probe"]);
  expect([0, 4], `health --no-probe\n${health.stderr}`).toContain(health.status);
  expect(healthRows(health)).toContainEqual(
    expect.objectContaining({ type: "harness", name: "claude", default: true }),
  );

  const info = run(["info"]);
  expect(info.status, `info\n${info.stderr}`).toBe(0);
  expect(infoRows(info)).toContainEqual(expect.objectContaining({ type: "harness", name: "claude" }));
}
