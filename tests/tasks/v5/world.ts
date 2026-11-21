// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The reference program's `World` as a real bundle: the tasks, env assets, secrets, prompt assets, scripts and agents
 * a test names are written as files under the isolated stash and a second bundle named `team`. `check` calls the code
 * a start, `doctor explain` and the scheduler call; `start` and `resume` call `runTask`, which `akm run <task>` and
 * `akm task run` call. A script and an `exec:` command are real processes; an agent is a function standing in for the
 * agent program, run where the agent program would be spawned.
 */

import { afterEach, beforeEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { saveConfig } from "../../../src/core/config/config";
import { getStateDir } from "../../../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../../src/core/warn";
import type { InputFlag } from "../../../src/execution/input-contract";
import { akmIndex } from "../../../src/indexer/indexer";
import { buildChildEnv } from "../../../src/integrations/agent/spawn";
import { runTask } from "../../../src/tasks/run/run-task";
import { readTaskHistory } from "../../../src/tasks/run/task-history";
import { checkTaskV5, type TaskV5StartFlags } from "../../../src/tasks/v5/check";
import { TASK_SOURCE_V5_VERSION } from "../../../src/tasks/v5/source";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
} from "../../_helpers/sandbox";

export interface WorldSpec {
  /** Task ref → the task as the file holds it (`version:` is added). */
  tasks?: Record<string, object>;
  /** `env/<name>` → its variables. A value may hold `${secrets/…}`. */
  envAssets?: Record<string, Record<string, string>>;
  /** `secrets/<name>` → its value. */
  secrets?: Record<string, string>;
  /** `commands/<name>` → the prompt asset's text. */
  commands?: Record<string, string>;
  /** `scripts/<file>` and `agents/<name>` → the file's text. */
  assets?: Record<string, string>;
  /** The environment akm runs in, which a clean step takes what it keeps and `inherit:` from. Default: this process's. */
  host?: NodeJS.ProcessEnv;
  /** Stands in for the agent program. `signal` fires when the agent's limit or the run's is reached. */
  agent?: (input: AgentInput) => Promise<string> | string;
}

export interface AgentInput {
  prompt: string;
  env: Record<string, string>;
  cwd: string;
  signal: AbortSignal;
  /** The limit akm gave the agent, in milliseconds. */
  timeoutMs: number | null | undefined;
}

/** The flags of a start, as `akm run <task>` takes them. */
export interface StartWorldFlags {
  env?: string[];
  secret?: string[];
  cwd?: string;
  timeout?: string | number;
  maxRetries?: number;
  inherit?: string[];
  scheduled?: boolean;
  skipIfLocked?: boolean;
}

/** What `history()` says of one run. */
export interface RunSummary {
  id: string;
  task: string;
  status: "running" | "failed" | "succeeded" | "discarded";
  /** The run's state is kept, and the run can be resumed. */
  hasState: boolean;
  steps: { name: string; status: "pending" | "completed" | "failed" }[];
}

export interface World {
  /** Reads the task and everything it runs, as a start does. */
  check(ref: string, values?: Record<string, string | number | boolean>, flags?: TaskV5StartFlags): Promise<unknown>;
  /** The same check a start makes, with the flags of a start. */
  lint(ref: string, values?: Record<string, string | number | boolean>, flags?: TaskV5StartFlags): Promise<unknown>;
  /** Starts the task and returns its result. A run that fails throws `RUN_FAILED`; a held lock throws `LOCKED`; a skipped start returns undefined. */
  start(ref: string, values?: Record<string, string | number | boolean>, flags?: StartWorldFlags): Promise<unknown>;
  /** Starts the task as a caller of `runTask` that gives its inputs as flags and nothing else. */
  startWithInputFlags(ref: string, inputs: readonly InputFlag[]): Promise<unknown>;
  /** `akm run <task> --resume`. */
  resume(ref: string): Promise<unknown>;
  /** Every run, oldest first. */
  history(): RunSummary[];
  /** What the checker warned about, in order. */
  readonly warnings: string[];
  /** A folder outside every bundle, for a test that names one. */
  readonly scratch: string;
}

let storage: IsolatedAkmStorage;
let team: SandboxedDir;
let warnings: string[] = [];

/** Call at the top of a test file: each test gets its own isolated akm storage and `team` bundle. */
export function useWorlds(): void {
  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    team = makeSandboxDir("akm-v5-team");
    warnings = [];
    _resetWarnOnceForTests();
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(String(args[0]));
    });
  });
  afterEach(() => {
    _setWarnSinkForTests(undefined);
    team.cleanup();
    storage.cleanup();
  });
}

const FOLDERS = ["tasks", "commands", "scripts", "agents", "env", "secrets"];

/** The file a ref is kept in, in the bundle it names. */
function fileFor(ref: string): string {
  const [bundle, conceptId] = ref.includes("//") ? (ref.split("//") as [string, string]) : [undefined, ref];
  const root = bundle === "team" ? team.dir : storage.stashDir;
  const [folder] = conceptId.split("/");
  const extension =
    folder === "tasks" ? ".yml" : folder === "commands" || folder === "agents" ? ".md" : folder === "env" ? ".env" : "";
  return path.join(root, `${conceptId}${extension}`);
}

function write(ref: string, text: string): void {
  const file = fileFor(ref);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A fresh world: what an earlier one wrote is gone. */
export function world(spec: WorldSpec = {}): World {
  for (const root of [storage.stashDir, team.dir]) {
    for (const folder of FOLDERS) fs.rmSync(path.join(root, folder), { recursive: true, force: true });
  }
  saveConfig({
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    harnesses: { opencode: { platform: "opencode" } },
    defaultBundle: "stash",
    bundles: { stash: { path: storage.stashDir, writable: true }, team: { path: team.dir, writable: true } },
  });
  for (const [ref, task] of Object.entries(spec.tasks ?? {})) {
    write(ref, stringify({ version: TASK_SOURCE_V5_VERSION, ...task }));
  }
  for (const [ref, variables] of Object.entries(spec.envAssets ?? {})) {
    write(
      ref,
      `${Object.entries(variables)
        .map(([name, value]) => `${name}=${value}`)
        .join("\n")}\n`,
    );
  }
  for (const [ref, value] of Object.entries(spec.secrets ?? {})) write(ref, value);
  for (const [ref, text] of Object.entries(spec.commands ?? {})) write(ref, text);
  for (const [ref, text] of Object.entries(spec.assets ?? {})) write(ref, text);
  const bundle = { name: "stash", dir: storage.stashDir };
  const check: World["check"] = (ref, values = {}, flags) =>
    checkTaskV5({ ref, bundle, inputs: Object.entries(values).map(([name, value]) => inputFlag(name, value)), flags });
  // `run: commands/…` and `run: agents/…` find their asset through the index, as `akm run` does.
  const indexed =
    Object.keys(spec.commands ?? {}).length > 0 ||
    Object.keys(spec.assets ?? {}).some((ref) => ref.includes("agents/"));
  let built = false;
  const go = async (ref: string, start: StartedRun): Promise<unknown> => {
    if (indexed && !built) {
      built = true;
      await akmIndex({ stashDir: storage.stashDir, full: true });
    }
    const result = await runTask(ref.replace(/^tasks\//, ""), {
      bundleDir: storage.stashDir,
      bundleName: "stash",
      adapterId: "akm",
      scheduled: start.scheduled === true,
      ...(start.start ? { start: start.start } : {}),
      ...(start.inputFlags ? { inputFlags: () => start.inputFlags as readonly InputFlag[] } : {}),
      hostEnv: spec.host ?? process.env,
      ...(spec.agent ? { runAgentImpl: standIn(spec.agent) } : {}),
    }).catch((error: unknown) => {
      if ((error as { code?: string }).code === "RUN_LEASE_HELD")
        throw new WorldError("LOCKED", (error as Error).message);
      throw error;
    });
    if (result.status === "failed") throw new WorldError("RUN_FAILED", `step ${result.detail?.error}`);
    return result.status === "active" ? undefined : result.result;
  };
  return {
    check,
    lint: check,
    start: (ref, values = {}, flags = {}) =>
      go(ref, {
        scheduled: flags.scheduled,
        start: () => ({
          flags: {
            ...(flags.env ? { env: flags.env } : {}),
            ...(flags.secret ? { secret: flags.secret } : {}),
            ...(flags.inherit ? { inherit: flags.inherit } : {}),
            ...(flags.cwd !== undefined ? { cwd: flags.cwd } : {}),
            ...(flags.timeout !== undefined ? { timeout: flags.timeout } : {}),
            ...(flags.maxRetries !== undefined ? { maxRetries: flags.maxRetries } : {}),
          },
          resume: false,
          skipIfLocked: flags.skipIfLocked === true,
          inputs: Object.entries(values).map(([name, value]) => inputFlag(name, value)),
        }),
      }),
    startWithInputFlags: (ref, inputs) => go(ref, { inputFlags: inputs }),
    resume: (ref) => go(ref, { start: () => ({ flags: {}, resume: true, skipIfLocked: false, inputs: [] }) }),
    history: () => summarize(),
    get warnings() {
      return warnings;
    },
    scratch: storage.root,
  };
}

const inputFlag = (name: string, value: string | number | boolean): InputFlag => ({
  name,
  value: typeof value === "boolean" ? value : String(value),
});

interface StartedRun {
  scheduled?: boolean;
  start?: NonNullable<Parameters<typeof runTask>[1]["start"]>;
  inputFlags?: readonly InputFlag[];
}

/** A failed run or a held lock, as the reference program names them. */
export class WorldError extends Error {
  constructor(
    readonly code: "RUN_FAILED" | "LOCKED",
    message: string,
  ) {
    super(message);
  }
}

/** The function a test gives as the agent, run where the agent program would be spawned. */
function standIn(agent: NonNullable<WorldSpec["agent"]>) {
  return async (
    _profile: unknown,
    opts: {
      dispatch?: { prompt?: string };
      env?: Record<string, string>;
      baseEnv?: Record<string, string>;
      cwd?: string;
      signal?: AbortSignal;
      timeoutMs?: number | null;
    },
  ) => {
    const stop = new AbortController();
    opts.signal?.addEventListener("abort", () => stop.abort(), { once: true });
    const failed = (reason: "timeout" | "aborted") => ({
      ok: false as const,
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: 0,
      reason,
      error: `agent ${reason === "timeout" ? "timed out" : "was aborted"}`,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<ReturnType<typeof failed>>((resolve) => {
      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          resolve(failed("timeout"));
          stop.abort();
        }, opts.timeoutMs);
      }
      stop.signal.addEventListener("abort", () => resolve(failed("aborted")), { once: true });
    });
    const reply = Promise.resolve(
      agent({
        prompt: opts.dispatch?.prompt ?? "",
        env: buildChildEnv(opts),
        cwd: opts.cwd ?? "",
        signal: stop.signal,
        timeoutMs: opts.timeoutMs,
      }),
    ).then((stdout) => ({ ok: true as const, exitCode: 0, stdout, stderr: "", durationMs: 1 }));
    try {
      return await Promise.race([reply, limit]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Every run in the history, oldest first: its latest attempt's outcome, and whether its state is still kept. */
function summarize(): RunSummary[] {
  const runs = new Map<string, RunSummary>();
  for (const row of readTaskHistory({ limit: 1000 }).reverse()) {
    if (!row.run) continue;
    const kept = fs.existsSync(
      path.join(getStateDir(), "runs", encodeURIComponent(row.id), `${row.run.id}.state.json`),
    );
    const steps = (row.steps ?? []).map((step) => ({
      name: step.name,
      status:
        step.status === "failed"
          ? ("failed" as const)
          : step.status === "skipped"
            ? ("pending" as const)
            : ("completed" as const),
    }));
    runs.set(row.run.id, {
      id: row.run.id,
      task: `tasks/${row.id}`,
      status:
        row.status === "completed" ? "succeeded" : row.status === "active" ? "running" : kept ? "failed" : "discarded",
      hasState: kept,
      steps,
    });
  }
  return [...runs.values()];
}

/** Message phrases that tell the one code `TASK_SOURCE_INVALID` apart: the rule the reference names. */
const RULES: readonly [string, RegExp][] = [
  ["LOOP", /tasks run each other in a loop/],
  ["SHAPE", /is one command|names an agent/],
  ["BAD_RUN", /takes a ref/],
  ["DUPLICATE_STEP", /has two steps named/],
  ["NAME_CLASH", /has the name of an input|collides with akm run/],
  ["BAD_ENV_NAME", /is not a variable name/],
  ["BAD_REFERENCE", /must be a whole item|does not take a state entry/],
  ["UNKNOWN_REFERENCE", /is not an input or an earlier step/],
  ["SECRET_IN_FILE", /holds a secret ref/],
  ["VALUE_IN_EXEC", /does not put/],
];
export const rule = async (attempt: Promise<unknown>): Promise<string> => {
  try {
    await attempt;
  } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    if (code === "TASK_SOURCE_INVALID")
      return `${code}/${RULES.find(([, phrase]) => phrase.test(message))?.[0] ?? "BAD_OPTION"}`;
    if (code === "INPUT_BINDING_INVALID") return `${code}/${/is required/.test(message) ? "missing" : "value"}`;
    return code ?? `not an akm error: ${error}`;
  }
  return "no error";
};
