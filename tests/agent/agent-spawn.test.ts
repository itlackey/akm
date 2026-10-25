/**
 * Tests for the agent CLI spawn wrapper (`runAgent`), against small real
 * programs that stand in for the agent CLIs: one prints what reached it (argv,
 * stdin, env, working directory), one sleeps until it is killed, one fails.
 *
 * What it owns: the command its harness builds from the dispatch, the child's
 * env, and the failure vocabulary (`timeout`, `aborted`, `spawn_failed`,
 * `non_zero_exit`) that a workflow's `retry.on` is written against.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "../../src/core/errors";
import { getCacheDir, getConfigDir, getDataDir, getStateDir } from "../../src/core/paths";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import { getBuiltinAgentProfile } from "../../src/integrations/agent/profiles";
import { runAgent } from "../../src/integrations/agent/spawn";
import { makeSandboxDir, type SandboxedDir, withEnv } from "../_helpers/sandbox";

/** What the `probe` program saw. */
interface Probed {
  argv: string[];
  stdin: string;
  env: Record<string, string>;
  cwd: string;
}

const PROGRAMS: Record<string, string> = {
  // Prints what reached it, as JSON.
  probe: `#!${process.execPath}\nconst fs = require("node:fs");\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), stdin: fs.readFileSync(0, "utf8"), env: process.env, cwd: process.cwd() }));\n`,
  // Notes that it ran beside itself, then prints a line on each stream.
  ran: `#!/bin/sh\ntouch "$0.ran"\necho out\necho err >&2\n`,
  fail: `#!/bin/sh\necho boom >&2\nexit 7\n`,
  // Records its pid beside itself, then outlives any timeout a test sets.
  hang: `#!/bin/sh\necho $$ > "$0.pid"\nexec sleep 30\n`,
};

let bins: SandboxedDir;

beforeAll(() => {
  bins = makeSandboxDir("akm-agent-spawn-bin");
  for (const [name, script] of Object.entries(PROGRAMS)) {
    fs.writeFileSync(path.join(bins.dir, name), script, { mode: 0o755 });
  }
});

afterAll(() => {
  bins.cleanup();
});

function program(name: string): string {
  return path.join(bins.dir, name);
}

/** A gemini-shaped profile (its prompt rides on `-p`) running `name`. */
function profileFor(name: string, overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: "test-agent",
    platform: "gemini",
    bin: program(name),
    args: [],
    stdio: "captured",
    envPassthrough: ["PATH"],
    ...overrides,
  };
}

function probed(stdout: string): Probed {
  return JSON.parse(stdout) as Probed;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runAgent — captured stdio", () => {
  test("returns ok:true with stdout/stderr on exit 0", async () => {
    const result = await runAgent(profileFor("ran"), { dispatch: { prompt: "go" } });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toBe("err\n");
    expect(result.reason).toBeUndefined();
    expect(typeof result.durationMs).toBe("number");
  });

  test("non-zero exit yields structured `non_zero_exit`", async () => {
    const result = await runAgent(profileFor("fail"), { dispatch: { prompt: "go" } });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("non_zero_exit");
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toBe("boom\n");
    expect(result.error).toContain("exited with code 7");
  });

  test("a program that cannot start yields `spawn_failed`", async () => {
    const result = await runAgent(profileFor("missing"), { dispatch: { prompt: "go" } });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("spawn_failed");
    expect(result.exitCode).toBeNull();
  });

  test("a platform with no harness is a configuration error, before anything runs", async () => {
    fs.rmSync(`${program("ran")}.ran`, { force: true });
    await expect(runAgent(profileFor("ran", { platform: "nope" }), { dispatch: { prompt: "go" } })).rejects.toThrow(
      ConfigError,
    );
    expect(fs.existsSync(`${program("ran")}.ran`)).toBe(false);
  });
});

describe("runAgent — timeout and cancellation", () => {
  test("a child past its deadline is killed and reported as `timeout`", async () => {
    const result = await runAgent(profileFor("hang"), { dispatch: { prompt: "go" }, timeoutMs: 300 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(result.error).toContain("300ms");
    const pid = Number(fs.readFileSync(`${program("hang")}.pid`, "utf8").trim());
    await Bun.sleep(100);
    expect(processAlive(pid)).toBe(false);
  });

  test("a pre-aborted signal reports `aborted` without starting the program", async () => {
    fs.rmSync(`${program("ran")}.ran`, { force: true });
    const controller = new AbortController();
    controller.abort();
    const result = await runAgent(profileFor("ran"), { dispatch: { prompt: "go" }, signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("aborted");
    expect(fs.existsSync(`${program("ran")}.ran`)).toBe(false);
  });

  test("aborting mid-run kills the child and reports `aborted`, not `timeout`", async () => {
    const controller = new AbortController();
    const running = runAgent(profileFor("hang"), {
      dispatch: { prompt: "go" },
      timeoutMs: null,
      signal: controller.signal,
    });
    await Bun.sleep(300);
    controller.abort();
    const result = await running;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("aborted");
    expect(result.error).toContain("aborted by caller signal");
  });

  test("a clean exit is not misreported when the signal aborts afterwards", async () => {
    const controller = new AbortController();
    const result = await runAgent(profileFor("ran"), { dispatch: { prompt: "go" }, signal: controller.signal });
    controller.abort();
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

describe("runAgent — the command", () => {
  test("is built by the harness from the dispatch: its flags, and a prompt on stdin where the harness takes it there", async () => {
    const gemini = probed(
      (await runAgent(profileFor("probe", { args: ["--profile-arg"] }), { dispatch: { prompt: "the prompt" } })).stdout,
    );
    expect(gemini.argv).toEqual(["--profile-arg", "-p", "the prompt"]);

    const claude = probed(
      (await runAgent(profileFor("probe", { platform: "claude" }), { dispatch: { prompt: "the prompt" } })).stdout,
    );
    expect(claude.argv).toEqual(["-p"]);
    expect(claude.stdin).toBe("the prompt");
  });

  test("a harness that carries its model in the environment gets it there", async () => {
    const result = await runAgent(profileFor("probe", { platform: "openhands" }), {
      dispatch: { prompt: "task", model: "provider/exact" },
    });
    expect(probed(result.stdout).env.LLM_MODEL).toBe("provider/exact");
  });

  test("no dispatch is the program started for a person: no prompt, no stdin", async () => {
    const result = await runAgent(profileFor("probe", { platform: "claude" }));
    const seen = probed(result.stdout);
    expect(seen.argv).toEqual([]);
    expect(seen.stdin).toBe("");
  });
});

describe("runAgent — the child's environment", () => {
  test("is the names the profile passes through, the directories akm resolved, and the call's env: nothing else", async () => {
    const env = await withEnv({ KEEP_ME: "yes", DROP_ME: "no", AKM_BUNDLE_DIR: "/sandbox/bundle" }, async () => {
      const result = await runAgent(profileFor("probe", { envPassthrough: ["PATH", "KEEP_ME"] }), {
        dispatch: { prompt: "go" },
        env: { CALL_VAR: "2" },
      });
      return probed(result.stdout).env;
    });
    expect(env.KEEP_ME).toBe("yes");
    expect(env.CALL_VAR).toBe("2");
    expect(env).not.toHaveProperty("DROP_ME");
    expect(env).toMatchObject({
      AKM_CONFIG_DIR: getConfigDir(),
      AKM_DATA_DIR: getDataDir(),
      AKM_CACHE_DIR: getCacheDir(),
      AKM_STATE_DIR: getStateDir(),
      AKM_BUNDLE_DIR: "/sandbox/bundle",
    });
  });

  test("the call's env wins over what is passed through and over the resolved directories", async () => {
    const env = await withEnv({ KEEP_ME: "ambient" }, async () => {
      const result = await runAgent(profileFor("probe", { envPassthrough: ["PATH", "KEEP_ME"] }), {
        dispatch: { prompt: "go" },
        env: { KEEP_ME: "call", AKM_CONFIG_DIR: "/call/config" },
      });
      return probed(result.stdout).env;
    });
    expect(env.KEEP_ME).toBe("call");
    expect(env.AKM_CONFIG_DIR).toBe("/call/config");
  });

  // Usage-event provenance (AKM_EVENT_SOURCE) must survive the agent boundary: a nested agent
  // inherits the source its parent stamped, so its own akm reads log as machine traffic, not
  // user demand.
  test("built-in profiles pass AKM_EVENT_SOURCE through to the spawned agent", async () => {
    const opencode = getBuiltinAgentProfile("opencode");
    if (!opencode) throw new Error("opencode built-in profile missing");
    expect(opencode.envPassthrough).toContain("AKM_EVENT_SOURCE");

    const env = await withEnv({ AKM_EVENT_SOURCE: "task" }, async () => {
      const result = await runAgent(
        { ...opencode, bin: program("probe"), stdio: "captured" },
        {
          dispatch: { prompt: "go" },
        },
      );
      return probed(result.stdout).env;
    });
    expect(env.AKM_EVENT_SOURCE).toBe("task");
  });

  // opencode finds its provider config, auth, package cache and state through the XDG base-directory
  // variables, so an akm that runs under a custom XDG_CONFIG_HOME must hand it to the child, or the
  // child reads $HOME's defaults instead.
  test("the XDG base-directory variables reach an opencode child with the values akm was given", async () => {
    const opencode = getBuiltinAgentProfile("opencode");
    if (!opencode) throw new Error("opencode built-in profile missing");
    const env = await withEnv(
      {
        XDG_CONFIG_HOME: "/sandbox/config",
        XDG_DATA_HOME: "/sandbox/data",
        XDG_CACHE_HOME: "/sandbox/cache",
        XDG_STATE_HOME: "/sandbox/state",
        AMBIENT_CLOUD_TOKEN: "must-not-leak",
      },
      async () => {
        const result = await runAgent(
          { ...opencode, bin: program("probe"), stdio: "captured" },
          {
            dispatch: { prompt: "go" },
          },
        );
        return probed(result.stdout).env;
      },
    );
    expect(env).toMatchObject({
      XDG_CONFIG_HOME: "/sandbox/config",
      XDG_DATA_HOME: "/sandbox/data",
      XDG_CACHE_HOME: "/sandbox/cache",
      XDG_STATE_HOME: "/sandbox/state",
    });
    expect(env).not.toHaveProperty("AMBIENT_CLOUD_TOKEN");
  });
});

describe("runAgent — cwd authority", () => {
  test("does not invent a cwd when options.cwd is absent", async () => {
    const result = await runAgent(profileFor("probe"), { dispatch: { prompt: "go" } });
    expect(fs.realpathSync(probed(result.stdout).cwd)).toBe(fs.realpathSync(process.cwd()));
  });

  test("options.cwd is the sole cwd authority", async () => {
    const work = makeSandboxDir("akm-agent-spawn-cwd");
    try {
      const result = await runAgent(profileFor("probe"), { dispatch: { prompt: "go" }, cwd: work.dir });
      expect(fs.realpathSync(probed(result.stdout).cwd)).toBe(fs.realpathSync(work.dir));
    } finally {
      work.cleanup();
    }
  });
});
