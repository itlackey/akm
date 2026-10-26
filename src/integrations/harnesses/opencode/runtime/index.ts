// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * akm's own agent runtime: a pinned OpenCode 2 binary run as a process over a
 * connection (`./command.ts`), for agent work when no harness is enabled. It is
 * what the application's port (`integrations/agent/runtime-port.ts`) asks for.
 *
 * The binary is fetched on first use (`./binary.ts`). Each run is its own process,
 * run through the same spawn path as a harness's, so the deadline, the caller's
 * signal and the capture of its output are the ones every agent run has. The
 * process keeps nothing between runs but akm's runtime directory, where its
 * sessions are (`../roots.ts`); nothing here reads config.
 */

import fs from "node:fs";
import path from "node:path";
import akmPlugin from "../../../../assets/opencode/akm-plugin.js" with { type: "text" };
import { toErrorMessage } from "../../../../core/common";
import {
  createLockPayload,
  probeLock,
  reclaimStaleLock,
  releaseLock,
  tryAcquireLockSync,
} from "../../../../core/file-lock";
import { PORTABLE_INFERENCE_KEYS } from "../../../../core/llm-inference";
import { resolveAkmInvocation } from "../../../../tasks/resolve-akm-bin";
import type { AgentRuntime } from "../../../agent/runtime-port";
import { buildChildEnv, type ReadyCommand, type RunAgentOptions, runBuiltCommand } from "../../../agent/spawn";
import type { LowerTarget } from "../../harness";
import { akmOpencodeDatabasePath, akmRuntimeDir } from "../roots";
import { ensureRuntimeBinary, OPENCODE_RUNTIME_VERSION } from "./binary";
import { type RuntimeLocations, runtimeArgv, runtimeConfig, runtimeEnv, runtimePrepareArgv } from "./command";

/**
 * What a request is lowered for when it runs here. The persona goes in the prompt, as for the opencode harness
 * (`opencode run` has no system prompt flag); every portable setting is carried, as request fields the plugin lays over
 * the model requests.
 */
const runtimeLowerer: LowerTarget = {
  id: "akm-runtime",
  systemPrompt: false,
  nativeAgent: true,
  // Model work on a connection is a chat call (`buildExecution`), so no run here is confined; if one were lowered here, say so.
  confinable: false,
  inference: PORTABLE_INFERENCE_KEYS,
};

/** How long preparing the database may take: it is a few milliseconds of work and a process start. */
const PREPARE_TIMEOUT_MS = 60_000;

/** Write the plugin where OpenCode loads it from (a directory, whose `index.mjs` is the module), when it is not already there. */
function installPlugin(directory: string): string {
  const pluginDirectory = path.join(directory, "config", "akm-plugin");
  const file = path.join(pluginDirectory, "index.mjs");
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== akmPlugin) {
    fs.mkdirSync(pluginDirectory, { recursive: true });
    const partial = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(partial, akmPlugin);
    fs.renameSync(partial, file);
  }
  return pluginDirectory;
}

/**
 * OpenCode makes and migrates its database when a process starts, and two processes doing that to one database break
 * each other (one fails with "Standalone server exited before reporting readiness"; on 2.1.4 two runs started together
 * on a fresh directory lose one of them every time). So the first start of this OpenCode version is a preparing run of
 * its own, under a lock file in the runtime directory that every run, of this akm process or another, waits on, and it
 * leaves a marker naming the version; a run that finds the marker and the database starts at once. A dead holder's
 * lock is reclaimed. The run itself reports anything the preparation does not.
 */
async function prepareDatabase(directory: string, command: ReadyCommand, opts: RunAgentOptions): Promise<void> {
  const marker = path.join(directory, `prepared-${OPENCODE_RUNTIME_VERSION}`);
  const lock = path.join(directory, "prepare.lock");
  const prepared = (): boolean => fs.existsSync(marker) && fs.existsSync(akmOpencodeDatabasePath());
  const deadline = Date.now() + PREPARE_TIMEOUT_MS;
  while (!prepared() && !opts.signal?.aborted) {
    const ownership = tryAcquireLockSync(lock, createLockPayload());
    if (ownership) {
      try {
        if (prepared()) return;
        const result = await runBuiltCommand("akm's runtime preparing its database", command, {
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
          timeoutMs: PREPARE_TIMEOUT_MS,
        });
        if (result.ok) fs.writeFileSync(marker, "");
        return;
      } finally {
        releaseLock(ownership);
      }
    }
    const probe = probeLock(lock);
    if (probe.state === "stale" && reclaimStaleLock(lock, probe)) continue;
    if (Date.now() >= deadline) {
      throw new Error(`Another akm process is still preparing the database of akm's runtime (lock ${lock}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export const opencodeRuntime: AgentRuntime = {
  lowering: runtimeLowerer,
  async run(profile, opts, connection) {
    const label = `akm's runtime on connection "${profile.name}"`;
    const dispatch = opts.dispatch;
    if (dispatch?.prompt === undefined) throw new TypeError("A run on akm's runtime is given a prompt.");
    const start = Date.now();
    try {
      const binary = await ensureRuntimeBinary();
      const directory = akmRuntimeDir();
      for (const name of ["config", "data", "cache", "state", "tmp"]) {
        fs.mkdirSync(path.join(directory, name), { recursive: true });
      }
      const where: RuntimeLocations = {
        binary,
        directory,
        pluginDirectory: installPlugin(directory),
        akm: resolveAkmInvocation().argv,
      };
      // The user's own OPENCODE_* variables configure their OpenCode, not this one.
      const ambient = Object.fromEntries(
        Object.entries(buildChildEnv(opts)).filter(([name]) => !name.startsWith("OPENCODE_")),
      );
      const config = runtimeConfig(connection, where.pluginDirectory, ambient);
      const env = { ...ambient, ...runtimeEnv(config, where) };
      await prepareDatabase(directory, { argv: runtimePrepareArgv(binary), env }, opts);
      return await runBuiltCommand(
        label,
        { argv: runtimeArgv(connection, dispatch, binary), env, stdin: dispatch.prompt },
        opts,
        "captured",
      );
    } catch (error) {
      return {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: toErrorMessage(error),
        durationMs: Date.now() - start,
        reason: "spawn_failed",
        error: toErrorMessage(error),
      };
    }
  },
};
