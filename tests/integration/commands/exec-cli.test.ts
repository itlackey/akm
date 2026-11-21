// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Real subprocesses: `akm exec` hands its child the terminal, so only a process boundary can observe the child's output.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { withoutBundleDirNotice } from "../../_helpers/bundle-dir-notice";
import { harnessCalls, promptOf, writeFakeHarness } from "../../_helpers/engine-stubs";
import { makeStashDir, type SandboxedDir, writeSandboxConfig } from "../../_helpers/sandbox";

const disposers: SandboxedDir[] = [];
afterAll(() => {
  for (const d of disposers) d.cleanup();
});

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");

function makeStash(files: Record<string, string>): string {
  const stash = makeStashDir();
  disposers.push(stash);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(stash.dir, name)), { recursive: true });
    fs.writeFileSync(path.join(stash.dir, name), content);
  }
  return stash.dir;
}

function akm(stashDir: string, args: string[], extraEnv: Record<string, string> = {}, input?: string) {
  const result = spawnSync("bun", [path.join(repoRoot, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    timeout: 15_000,
    cwd: repoRoot,
    ...(input !== undefined ? { input } : {}),
    env: { ...process.env, AKM_BUNDLE_DIR: stashDir, ...extraEnv },
  });
  const stderr = result.stderr ?? "";
  return {
    stdout: result.stdout ?? "",
    stderr: withoutBundleDirNotice(stderr),
    rawStderr: stderr,
    status: result.status,
  };
}

const print = (...names: string[]) => ["sh", "-c", `printf '%s|' ${names.map((name) => `"$${name}"`).join(" ")}`];

describe("akm exec", () => {
  beforeEach(() => writeSandboxConfig({ experimental: { exec: true } }));

  test.each([
    {},
    { exec: false },
  ])("is off unless experimental.exec is true (%j): nothing runs and the refusal names the key", (experimental) => {
    writeSandboxConfig({ experimental });
    const stash = makeStash({ "env/prod.env": "A=1\n" });
    const { stdout, stderr, status } = akm(stash, ["exec", "--env", "env/prod", "--", "sh", "-c", "echo ran"]);
    expect(status).toBe(78);
    expect(stdout).not.toContain("ran");
    expect(stderr).toContain("experimental.exec");
    expect(stderr).toContain("akm config set experimental.exec true");
  });

  test("injects every env asset and secret given, later flags over earlier, secrets over env assets", () => {
    const stash = makeStash({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${ref}` token an env file holds
      "env/base.env": "A=base\nB=base\nURL=https://u:${secrets/token}@host\n",
      "env/over.env": "B=over\nC=over\n",
      "secrets/token": "tok-value\n",
    });
    const { stdout, stderr, status } = akm(stash, [
      "exec",
      "--env",
      "env/base",
      "--env=env/over",
      "--secret",
      "secrets/token:C",
      "--secret",
      "secrets/token:GH_TOKEN",
      "--",
      ...print("A", "B", "C", "URL", "GH_TOKEN"),
    ]);
    expect(stderr.trim()).toBe("");
    expect(status).toBe(0);
    expect(stdout).toBe("base|over|tok-value|https://u:tok-value@host|tok-value|");
  });

  test("runs a command with nothing injected, exits with its status, and leaves flags after -- to the command", () => {
    const stash = makeStash({ "env/prod.env": "A=1\n" });
    const { stdout, status } = akm(stash, ["exec", "--", "sh", "-c", 'printf "%s" "$*"; exit 7', "sh", "--env", "x"]);
    expect(stdout).toBe("--env x");
    expect(status).toBe(7);
  });

  test("--clean keeps only the minimal environment, --inherit names, and what was injected", () => {
    const stash = makeStash({ "env/prod.env": "A=1\n" });
    const { stdout } = akm(
      stash,
      ["exec", "--env", "env/prod", "--clean", "--inherit", "KEPT", "--", ...print("A", "KEPT", "DROPPED")],
      { KEPT: "kept", DROPPED: "dropped" },
    );
    expect(stdout).toBe("1|kept||");
  });

  test.each([
    [["exec", "--env", "env/prod"], "Missing command"],
    [["exec", "--secret", "secrets/token", "--"], "--secret takes <secret-ref>:<VAR>"],
    [["exec", "--secret", "secrets/token:1BAD", "--"], "--secret takes <secret-ref>:<VAR>"],
    [["exec", "--env", "env/absent", "--"], "env/absent"],
    [["exec", "--secret", "secrets/absent:X", "--"], "secrets/absent"],
  ])("%j is refused before anything runs", (args, message) => {
    const stash = makeStash({ "env/prod.env": "A=1\n", "secrets/token": "t" });
    const { stdout, stderr, status } = akm(stash, [...args, ...(args.includes("--") ? ["sh", "-c", "echo ran"] : [])]);
    expect(status).not.toBe(0);
    expect(stdout).not.toContain("ran");
    expect(stderr).toContain(message);
  });

  test("env run and secret run still work and name their replacements", () => {
    const stash = makeStash({ "env/prod.env": "A=1\n", "secrets/token": "t" });
    const env = akm(stash, ["env", "run", "env/prod", "--", ...print("A")]);
    expect(env.stdout).toBe("1|");
    expect(env.rawStderr).toContain(
      "akm env run is deprecated and is removed in 0.11: use a script asset under scripts/, run with `akm run --env <ref> scripts/<file>`",
    );
    const secret = akm(stash, ["secret", "run", "secrets/token", "X", "--", ...print("X")]);
    expect(secret.stdout).toBe("t|");
    expect(secret.rawStderr).toContain(
      "akm secret run is deprecated and is removed in 0.11: use `akm exec --secret <ref>:<VAR> -- <command>`",
    );
  });

  test("one argument is a shell line; several are a program and arguments, unsplit", () => {
    const stash = makeStash({});
    expect(akm(stash, ["exec", "--", "echo one | tr a-z A-Z"]).stdout).toBe("ONE\n");
    const many = akm(stash, ["exec", "--", "printf", "%s|", "a b", "$HOME", "c;d"]);
    expect(many.stdout).toBe("a b|$HOME|c;d|");
  });

  test("the child's exit status is the command's", () => {
    expect(akm(makeStash({}), ["exec", "--", "exit 7"]).status).toBe(7);
  });

  test("--cwd runs there; a missing nested folder is made and kept, relative from where akm started", () => {
    const stash = makeStash({});
    const base = fs.mkdtempSync(path.join(stash, "cwd-"));
    const abs = path.join(base, "a", "b");
    const first = akm(stash, ["exec", "--cwd", abs, "--", "pwd"]);
    expect(fs.realpathSync(first.stdout.trim())).toBe(fs.realpathSync(abs));
    expect(fs.existsSync(abs)).toBe(true);
    const rel = path.relative(repoRoot, path.join(base, "r", "s"));
    akm(stash, ["exec", "--cwd", rel, "--", "true"]);
    expect(fs.existsSync(path.join(base, "r", "s"))).toBe(true);
  });

  test("--timeout stops the command at the limit and the status says so", () => {
    const started = Date.now();
    const { status, stderr } = akm(makeStash({}), ["exec", "--timeout", "500ms", "--", "sleep", "30"]);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(status).toBe(1);
    expect(stderr).toContain("timed out after 500ms");
  });

  test("--max-retries runs a failing command exactly N more times and stops on success", () => {
    const stash = makeStash({});
    const log = path.join(stash, "tries");
    const failing = akm(stash, ["exec", "--max-retries", "2", "--", `echo x >> '${log}'; exit 3`]);
    expect(failing.status).toBe(3);
    expect(fs.readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(3);
    const flaky = path.join(stash, "flaky");
    const once = akm(stash, [
      "exec",
      "--max-retries",
      "5",
      "--",
      `test -e '${flaky}' || { touch '${flaky}'; exit 1; }`,
    ]);
    expect(once.status).toBe(0);
  });

  test("--inherit alone starts the child clean plus the named variables", () => {
    const { stdout } = akm(makeStash({}), ["exec", "--inherit", "KEEP_ME", "--", ...print("KEEP_ME", "DROP_ME")], {
      KEEP_ME: "kept",
      DROP_ME: "dropped",
    });
    expect(stdout).toBe("kept||");
  });

  test("--clean keeps akm's location variables but not AKM_BUNDLE_DIR", () => {
    const stash = makeStash({});
    const { stdout } = akm(stash, [
      "exec",
      "--clean",
      "--",
      ...print("AKM_CONFIG_DIR", "AKM_DATA_DIR", "AKM_CACHE_DIR", "AKM_STATE_DIR", "AKM_BUNDLE_DIR"),
    ]);
    const [config, data, cache, state, bundle] = stdout.split("|");
    expect([config, data, cache, state].every((v) => v && path.isAbsolute(v))).toBe(true);
    expect(bundle).toBe("");
  });

  describe("--prompt", () => {
    function withAgent(replies: readonly string[], options?: Parameters<typeof writeFakeHarness>[3]) {
      const bins = makeStashDir();
      disposers.push(bins);
      const bin = writeFakeHarness(bins.dir, "claude", replies, options);
      writeSandboxConfig({ experimental: { exec: true }, harnesses: { fake: { platform: "claude", bin } } });
      return bin;
    }

    test("runs the prompt whole on the agent and prints the reply alone", () => {
      const bin = withAgent(["the reply"]);
      const prompt = 'say "hi" {{x}} $HOME\nsecond line';
      const { stdout, status } = akm(makeStash({}), ["exec", "--harness", "fake", "--prompt", prompt]);
      expect(status).toBe(0);
      expect(stdout).toBe("the reply\n");
      expect(promptOf(harnessCalls(bin)[0])).toContain(prompt);
    });

    test("--prompt-stdin reads the whole prompt from stdin", () => {
      const bin = withAgent(["ok"]);
      const prompt = "line one\nline two\n".repeat(5000);
      const { stdout, status } = akm(makeStash({}), ["exec", "--harness", "fake", "--prompt-stdin"], {}, prompt);
      expect(status).toBe(0);
      expect(stdout).toBe("ok\n");
      expect(promptOf(harnessCalls(bin)[0])).toContain(prompt);
    });

    test("--model reaches the command the harness is started with", () => {
      const bin = withAgent(["ok"]);
      expect(akm(makeStash({}), ["exec", "--harness", "fake", "--model", "model-x", "--prompt", "p"]).status).toBe(0);
      const argv = harnessCalls(bin)[0]?.argv ?? [];
      expect(argv[argv.indexOf("--model") + 1]).toBe("model-x");
    });

    test.each([
      [["--prompt", "p", "--prompt-stdin"]],
      [["--prompt", "p", "--", "true"]],
      [["--prompt-stdin", "--", "true"]],
    ])("%j is a usage error and nothing runs", (flags) => {
      const bin = withAgent(["ok"]);
      const { status, stdout } = akm(makeStash({}), ["exec", "--harness", "fake", ...flags], {}, "p");
      expect(status).toBe(2);
      expect(stdout).toBe("");
      expect(harnessCalls(bin)).toEqual([]);
    });

    test("an agent that gives no reply fails with the reason on stderr", () => {
      withAgent([""]);
      const { stdout, stderr, status } = akm(makeStash({}), ["exec", "--harness", "fake", "--prompt", "p"]);
      expect(status).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("returned no answer");
    });

    test("is off unless experimental.exec is true: the agent is not started", () => {
      const bin = withAgent(["ok"]);
      writeSandboxConfig({ experimental: { exec: false } });
      const { status, stderr } = akm(makeStash({}), ["exec", "--harness", "fake", "--prompt", "p"]);
      expect(status).toBe(78);
      expect(stderr).toContain("experimental.exec");
      expect(harnessCalls(bin)).toEqual([]);
    });

    test("--env and --secret are in the agent's environment; --clean leaves the rest of the parent's out", () => {
      const bin = withAgent(["ok"]);
      const stash = makeStash({ "env/prod.env": "A=1\n", "secrets/token": "tok\n" });
      const flags = ["exec", "--harness", "fake", "--prompt", "p", "--env", "env/prod", "--secret", "secrets/token:T"];
      expect(akm(stash, flags, { PARENT_ONLY: "x" }).status).toBe(0);
      expect(akm(stash, [...flags, "--clean"], { PARENT_ONLY: "x" }).status).toBe(0);
      const [open, clean] = harnessCalls(bin);
      expect([open?.env.A, open?.env.T, open?.env.PARENT_ONLY]).toEqual(["1", "tok", "x"]);
      expect([clean?.env.A, clean?.env.T, clean?.env.PARENT_ONLY]).toEqual(["1", "tok", undefined]);
    });

    test("--timeout stops a hanging agent and exits 1", () => {
      withAgent([""], { hang: true });
      const { status, stderr } = akm(makeStash({}), ["exec", "--harness", "fake", "--prompt", "p", "--timeout", "1s"]);
      expect(status).toBe(1);
      expect(stderr).toContain("timed out after 1s");
    });

    test("--max-retries runs a failing agent N more times", () => {
      const bin = withAgent([""]);
      expect(akm(makeStash({}), ["exec", "--harness", "fake", "--prompt", "p", "--max-retries", "2"]).status).toBe(1);
      expect(harnessCalls(bin)).toHaveLength(3);
    });

    test("--cwd: a missing nested folder is made and kept, and the agent starts in it", () => {
      const bin = withAgent(["ok"]);
      const base = fs.mkdtempSync(path.join(makeStash({}), "cwd-"));
      const nested = path.join(base, "a", "b");
      expect(akm(makeStash({}), ["exec", "--harness", "fake", "--prompt", "p", "--cwd", nested]).status).toBe(0);
      expect(fs.realpathSync(harnessCalls(bin)[0]?.cwd ?? "")).toBe(fs.realpathSync(nested));
    });
  });
});
