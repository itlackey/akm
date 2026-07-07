// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Parent-side helpers shared by the MULTI-PROCESS workflow chaos integration
 * tests. They spawn the fake-driven `workflow-chaos-runner.ts` entrypoint as a
 * real `bun` child against the parent's isolated storage, and synchronize on
 * marker files / journal polling (never a bare sleep) with generous timeouts so
 * the scenarios are deterministic and non-flaky.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { computeStepWorkList } from "../../../src/workflows/exec/step-work";
import type { WorkflowPlanGraph } from "../../../src/workflows/ir/schema";

export const RUNNER = path.join(__dirname, "workflow-chaos-runner.ts");

/** True when a real `bun` subprocess can be spawned (else the suite skips). */
export function bunAvailable(): boolean {
  try {
    return spawnSync("bun", ["--version"], { timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
}

/** A spawned runner child with captured stderr and a settled-exit promise. */
export interface RunnerChild {
  readonly proc: ChildProcess;
  readonly pid: number;
  /** True once the child has exited (poll without awaiting). */
  exited: boolean;
  /** Exit code once exited (null if killed by signal). */
  code: number | null;
  /** Accumulated stderr text. */
  stderr(): string;
  /** Resolves when the child exits; yields the exit code (null on signal). */
  done(): Promise<number | null>;
  kill(signal?: NodeJS.Signals): void;
}

/** Spawn the chaos runner driving `runId` with the given CHAOS_* overrides. */
export function spawnRunner(env: Record<string, string>): RunnerChild {
  const proc = spawn("bun", [RUNNER], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });
  const handle: RunnerChild = {
    proc,
    pid: proc.pid ?? -1,
    exited: false,
    code: null,
    stderr: () => err,
    done: () =>
      new Promise<number | null>((resolve) => {
        if (handle.exited) return resolve(handle.code);
        proc.on("exit", (code) => resolve(code));
      }),
    kill: (signal: NodeJS.Signals = "SIGKILL") => proc.kill(signal),
  };
  proc.on("exit", (code) => {
    handle.exited = true;
    handle.code = code;
  });
  return handle;
}

/** Poll `predicate` until it returns true, or throw after `timeoutMs`. */
export async function pollUntil(
  predicate: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const intervalMs = opts.intervalMs ?? 30;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`pollUntil timed out after ${timeoutMs}ms${opts.label ? ` waiting for: ${opts.label}` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function unitKey(unitId: string): string {
  return Buffer.from(unitId, "utf8").toString("base64url");
}

/** Existence of the marker the runner writes when a unit begins holding. */
export function holdStartExists(markerDir: string, unitId: string): boolean {
  return fs.existsSync(path.join(markerDir, `holdstart.${unitKey(unitId)}`));
}

/** The pids that dispatched a given unit (one line appended per dispatch). */
export function dispatchPids(markerDir: string, unitId: string): number[] {
  const file = path.join(markerDir, `dispatch.${unitKey(unitId)}`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map(Number);
}

/** Total dispatch count for a unit across all processes. */
export function dispatchCount(markerDir: string, unitId: string): number {
  return dispatchPids(markerDir, unitId).length;
}

/** Every pid that appears in ANY dispatch marker file. */
export function allDispatchPids(markerDir: string): Set<number> {
  const pids = new Set<number>();
  if (!fs.existsSync(markerDir)) return pids;
  for (const name of fs.readdirSync(markerDir)) {
    if (!name.startsWith("dispatch.")) continue;
    for (const l of fs.readFileSync(path.join(markerDir, name), "utf8").split("\n")) {
      const n = Number(l.trim());
      if (l.trim()) pids.add(n);
    }
  }
  return pids;
}

/**
 * Force the engine lease to expire (simulate its 90s TTL elapsing) so a fresh
 * invocation can reclaim a run whose driver was SIGKILLed without releasing it.
 * Uses the holder-guarded `renewEngineLease` with a past expiry — the exact
 * crash-recovery contract (a dead holder's lease becomes claimable at TTL),
 * without a 90s wall-clock wait.
 */
export async function expireLease(runId: string): Promise<void> {
  await withWorkflowRunsRepo((repo) => {
    const holder = repo.getRunById(runId)?.engine_lease_holder;
    if (!holder) return;
    repo.renewEngineLease(runId, holder, new Date(Date.now() - 5_000).toISOString());
  });
}

/**
 * The engine's own content-derived journal ids for a step (default: the first
 * step), in fan-out (array) order — the same ids `runWorkflowSteps` journals,
 * so the parent can key marker/journal assertions on them.
 */
export async function unitIds(
  runId: string,
  params: Record<string, unknown>,
  stepIndex = 0,
): Promise<string[]> {
  const row = await withWorkflowRunsRepo((repo) => repo.getRunById(runId));
  const plan = JSON.parse(row?.plan_json ?? "null") as WorkflowPlanGraph;
  const computed = computeStepWorkList(plan.steps[stepIndex], { runId, params, stepOutputs: {} });
  if (!computed.ok) throw new Error(computed.error);
  return computed.list.units.map((u) => u.journalBaseId);
}

/** Write a workflow program YAML into the isolated stash. */
export function writeProgram(stashDir: string, name: string, yamlText: string): void {
  const file = path.join(stashDir, "workflows", `${name}.yaml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yamlText, "utf8");
}
