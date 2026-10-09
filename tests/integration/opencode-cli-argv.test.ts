/**
 * Integration classification (AGENTS.md ORG-03..06): spawns a real process (the OpenCode 1 and OpenCode 2 binaries).
 *
 * Gated by `AKM_OPENCODE_V1_BIN` / `AKM_OPENCODE_V2_BIN` (absolute paths to the `opencode` executables); each half
 * skips cleanly when its variable is unset. No model credentials are needed: the argv akm builds must get past the
 * binary's flag parser and fail at the model/provider, never with a usage error, and the run must leave no child or
 * background service process behind (the OpenCode 2 `run` default attaches to a shared service; akm passes `--standalone`).
 */

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import { opencodeBuilder } from "../../src/integrations/harnesses/opencode/agent-builder";

const sandboxes: string[] = [];
afterAll(() => {
  for (const dir of sandboxes) fs.rmSync(dir, { recursive: true, force: true });
});

/** Pids whose environment carries `HOME=<sandbox>`: everything a run spawned, a surviving service included. */
function processesIn(sandbox: string): number[] {
  const pids: number[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return pids;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const env = fs.readFileSync(`/proc/${entry}/environ`, "utf8");
      if (env.split("\0").includes(`HOME=${sandbox}`)) pids.push(Number(entry));
    } catch {
      // Gone or not ours.
    }
  }
  return pids;
}

const USAGE_ERROR =
  /Unknown argument|Not enough non-option|Invalid values|Missing required|Unknown flag|Unexpected flag/i;
// Both binaries print `run`'s usage when its flag parser rejects the argv.
const USAGE_BANNER = /run opencode with a message|Run OpenCode with a message/i;

async function dispatch(
  bin: string,
  opencodeVersion: 1 | 2,
  request: Parameters<typeof opencodeBuilder.build>[1],
): Promise<{ output: string; leaked: number[] }> {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "akm-oc-argv-")));
  sandboxes.push(sandbox);
  const cwd = path.join(sandbox, "work");
  fs.mkdirSync(cwd);
  const profile: AgentProfile = {
    name: "opencode",
    bin,
    args: ["run"],
    stdio: "captured",
    envPassthrough: [],
    parseOutput: "text",
    opencodeVersion,
  };
  const cmd = opencodeBuilder.build(profile, request);
  const proc = Bun.spawn([...cmd.argv], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: sandbox,
      XDG_CONFIG_HOME: path.join(sandbox, "config"),
      XDG_DATA_HOME: path.join(sandbox, "data"),
      XDG_CACHE_HOME: path.join(sandbox, "cache"),
      ...cmd.env,
      // Keep the plugin state of model work inside the sandbox too.
      XDG_STATE_HOME: path.join(sandbox, "state"),
    },
  });
  const timer = setTimeout(() => proc.kill(), 90_000);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  clearTimeout(timer);
  // Give a straggling child a moment to exit before counting survivors.
  await Bun.sleep(1500);
  return { output: `${stdout}\n${stderr}`, leaked: processesIn(sandbox) };
}

for (const [label, envVar, major] of [
  ["OpenCode 1", "AKM_OPENCODE_V1_BIN", 1],
  ["OpenCode 2", "AKM_OPENCODE_V2_BIN", 2],
] as const) {
  const bin = process.env[envVar];
  describe.skipIf(!bin)(`${label} CLI accepts the argv akm builds (${envVar})`, () => {
    test("an ordinary dispatch with an agent and a model gets past the flag parser and leaves nothing running", async () => {
      const { output, leaked } = await dispatch(bin as string, major, {
        prompt: "hello",
        agent: "build",
        model: "no-such-provider/no-such-model",
      });
      expect(output).not.toMatch(USAGE_ERROR);
      expect(output).not.toMatch(USAGE_BANNER);
      expect(leaked).toEqual([]);
    }, 120_000);

    test("a model-work dispatch finds its injected agent and leaves nothing running", async () => {
      const { output, leaked } = await dispatch(bin as string, major, {
        prompt: "hello",
        modelWork: true,
        model: "no-such-provider/no-such-model",
      });
      expect(output).not.toMatch(USAGE_ERROR);
      expect(output).not.toMatch(USAGE_BANNER);
      // OpenCode 2 reports an agent it could not load by name; its definition (the injected config) must be valid.
      expect(output).not.toContain("Agent not found");
      expect(leaked).toEqual([]);
    }, 120_000);
  });
}
