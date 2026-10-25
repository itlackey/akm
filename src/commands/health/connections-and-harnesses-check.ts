// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `connections-and-harnesses` health check: the table of connections, harnesses and the work
 * that runs on them (`../targets.ts`), with what only health asks for added to
 * it. Whether a connection's endpoint answers is one bounded `GET /models`,
 * once per distinct endpoint; a harness's version is its own `--version`, one
 * process per harness. Both are probes: with `--no-probe` neither the endpoints
 * are contacted nor any harness run.
 */
import { spawnSync } from "node:child_process";
import { type AkmConfig, ambiguousDefaultAdvice, loadConfig } from "../../core/config/config";
import { defaultWhich, type WhichFn } from "../../integrations/agent/detect";
import { resolveTarget } from "../../integrations/agent/resolution";
import { type ChatCompletionConfig, probeEndpointOnce } from "../../llm/client";
import { type TargetRow, targetRows } from "../targets";
import type { HealthCheckResult } from "./types";

export interface ReachabilityResult {
  reachable: boolean;
  error?: string;
}
export type ReachabilityProbe = (connection: Pick<ChatCompletionConfig, "endpoint">) => Promise<ReachabilityResult>;

export interface ConnectionsAndHarnessesCheckDependencies {
  loadConfig?: () => AkmConfig;
  /** Asks whether an endpoint answers. Absent: not asked, which keeps every caller that does not opt in offline. */
  probeReachable?: ReachabilityProbe;
  spawnSync?: typeof spawnSync;
  which?: WhichFn;
  env?: NodeJS.ProcessEnv;
}

const VERSION_TIMEOUT_MS = 5_000;

/** Each connection's reachability, asked once per distinct endpoint. */
async function probeConnections(config: AkmConfig, probe: ReachabilityProbe): Promise<Map<string, ReachabilityResult>> {
  const cache = new Map<string, Promise<ReachabilityResult>>();
  const entries = await Promise.all(
    Object.entries(config.connections ?? {}).map(
      async ([name, connection]) => [name, await probeEndpointOnce(connection, cache, probe)] as const,
    ),
  );
  return new Map(entries);
}

/** Each installed harness's `--version`, its first line; none when it will not say. */
function harnessVersions(config: AkmConfig, which: WhichFn, spawn: typeof spawnSync): Map<string, string | undefined> {
  const versions = new Map<string, string | undefined>();
  for (const name of Object.keys(config.harnesses ?? {})) {
    try {
      const target = resolveTarget({ config, layers: [{ harness: name }] });
      if (target.kind !== "harness" || !which(target.bin)) continue;
      const result = spawn(target.bin, ["--version"], { encoding: "utf8", timeout: VERSION_TIMEOUT_MS });
      if ((result.status ?? 1) === 0) versions.set(name, String(result.stdout).trim().split("\n")[0] || undefined);
    } catch {
      // A harness that cannot be resolved or run has no version to report.
    }
  }
  return versions;
}

/** What is wrong in the table, one phrase each. A key variable's name is never quoted. */
function problems(rows: readonly TargetRow[], ambiguous: string | undefined): string[] {
  // No default among several connections or harnesses is the config's problem, said once whatever work it leaves
  // without a place to run (work may still find one: model work falls to a harness).
  const found: string[] = ambiguous ? [ambiguous] : [];
  // A problem that several kinds of work share is said once.
  const shared = new Map<string, string[]>();
  for (const row of rows) {
    if (row.type === "connection") {
      if (row.key === "env-unset") found.push(`connection "${row.name}": the variable holding its key is not set`);
      if (row.reachable === false) {
        found.push(`connection "${row.name}" is not reachable${row.error ? ` (${row.error})` : ""}`);
      }
    } else if (row.type === "harness") {
      if (!row.installed) found.push(`harness "${row.name}" (${row.platform}) was not found on PATH`);
    } else if (row.problem) {
      const problem = row.problem.replace(/\.$/, "");
      if (problem !== ambiguous) shared.set(problem, [...(shared.get(problem) ?? []), row.process]);
    }
  }
  for (const [problem, processes] of shared) found.push(`${processes.join(", ")}: ${problem}`);
  return found;
}

/** The check for a table. `unknown` when nothing is configured: there is nothing to be wrong. */
export function connectionsAndHarnessesCheck(
  rows: readonly TargetRow[],
  probed: boolean,
  ambiguous?: string,
): HealthCheckResult {
  const connections = rows.filter((row) => row.type === "connection").length;
  const harnesses = rows.filter((row) => row.type === "harness").length;
  const base = {
    name: "connections-and-harnesses",
    kind: "deterministic",
    confidence: "high",
    evidence: { rows },
  } as const;
  if (connections + harnesses === 0) {
    return {
      ...base,
      status: "unknown",
      message: "No connection or harness is configured: model features and agentic work are off. Run `akm setup`.",
    };
  }
  const found = problems(rows, ambiguous);
  const counts = `${connections} connection${connections === 1 ? "" : "s"} and ${harnesses} harness${harnesses === 1 ? "" : "es"}`;
  const notProbed = connections > 0 && !probed ? " Reachability was not probed." : "";
  return {
    ...base,
    status: found.length > 0 ? "warn" : "pass",
    message: found.length > 0 ? `${counts}: ${found.join("; ")}.${notProbed}` : `${counts}, all ready.${notProbed}`,
  };
}

export async function runConnectionsAndHarnessesCheck(
  deps: ConnectionsAndHarnessesCheckDependencies = {},
): Promise<HealthCheckResult> {
  const config = deps.loadConfig?.() ?? loadConfig();
  const which = deps.which ?? defaultWhich;
  const reachability = deps.probeReachable ? await probeConnections(config, deps.probeReachable) : undefined;
  const rows = targetRows({
    config,
    env: deps.env,
    which,
    ...(reachability ? { reachability, versions: harnessVersions(config, which, deps.spawnSync ?? spawnSync) } : {}),
  });
  return connectionsAndHarnessesCheck(rows, reachability !== undefined, ambiguousDefaultAdvice(config));
}
