// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * How akm ends and what it reports around the processes it starts, measured with real processes:
 * a child's signal death, a program that cannot be run, a working folder that cannot be made, a descendant
 * left holding the output pipe, a signal that two owners both act on, and an env value that starts with `#`.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setSecret } from "../../src/commands/env/secret";
import { runManagedSubprocess } from "../../src/core/subprocess";
import { makeStashDir, type SandboxedDir, writeSandboxConfig } from "../_helpers/sandbox";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");
const posix = process.platform === "linux" || process.platform === "darwin";

beforeEach(() => writeSandboxConfig({ semanticSearchMode: "off", experimental: { exec: true } }));

const disposers: SandboxedDir[] = [];
afterAll(() => {
  for (const d of disposers) d.cleanup();
});

function makeStash(): string {
  const stash = makeStashDir();
  disposers.push(stash);
  fs.mkdirSync(path.join(stash.dir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(stash.dir, "env"), { recursive: true });
  return stash.dir;
}

function akm(stashDir: string, args: string[]) {
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    cwd: repoRoot,
    env: { ...process.env, AKM_BUNDLE_DIR: stashDir },
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status, signal: result.signal };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!posix)("a child that dies of a signal ends akm by that signal", () => {
  const stashDir = makeStash();
  fs.writeFileSync(path.join(stashDir, "scripts", "sig.sh"), '#!/bin/sh\nkill -"$1" $$\n', { mode: 0o755 });
  fs.writeFileSync(path.join(stashDir, "env", "e.env"), "A=1\n");
  setSecret(path.join(stashDir, "secrets", "s"), Buffer.from("v"));

  for (const name of ["TERM", "INT", "KILL"] as const) {
    const signal = `SIG${name}` as NodeJS.Signals;
    test(`akm run: SIG${name}`, () => {
      const result = akm(stashDir, ["run", "scripts/sig.sh", name]);
      expect(result.signal).toBe(signal);
    });
    test(`akm exec: SIG${name}`, () => {
      expect(akm(stashDir, ["exec", "--", "sh", "-c", `kill -${name} $$`]).signal).toBe(signal);
    });
    test(`akm env run: SIG${name}`, () => {
      expect(akm(stashDir, ["env", "run", "env/e", "--", "sh", "-c", `kill -${name} $$`]).signal).toBe(signal);
    });
    test(`akm secret run: SIG${name}`, () => {
      expect(akm(stashDir, ["secret", "run", "secrets/s", "V", "--", "sh", "-c", `kill -${name} $$`]).signal).toBe(
        signal,
      );
    });
  }

  test("a child that exits with a status keeps it", () => {
    const result = akm(stashDir, ["exec", "--", "sh", "-c", "exit 7"]);
    expect(result.status).toBe(7);
    expect(result.signal).toBeNull();
  });
});

describe.skipIf(!posix)("a program that cannot be executed", () => {
  test("a file without execute permission is COMMAND_NOT_EXECUTABLE, exit 1", () => {
    const stashDir = makeStash();
    const file = path.join(stashDir, "scripts", "plain.txt");
    fs.writeFileSync(file, "x\n", { mode: 0o644 });
    const result = akm(stashDir, ["exec", "--", file, "arg"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("COMMAND_NOT_EXECUTABLE");
  });

  test("a folder is named as a folder, with no chmod hint", () => {
    const stashDir = makeStash();
    const result = akm(stashDir, ["exec", "--", path.join(stashDir, "scripts"), "arg"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is a folder, not a program");
    expect(result.stderr).not.toContain("chmod");
  });
});

describe.skipIf(!posix || process.getuid?.() === 0)("a working folder that cannot be made", () => {
  test("--cwd under a folder that cannot be written is a usage refusal naming the folder and the code", () => {
    const stashDir = makeStash();
    const locked = path.join(stashDir, "locked");
    fs.mkdirSync(locked, { mode: 0o555 });
    const target = path.join(locked, "work", "deep");
    try {
      const result = akm(stashDir, ["exec", "--cwd", target, "--", "true"]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(target);
      expect(result.stderr).toContain("EACCES");
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });
});

describe("an unquoted env value that starts with #", () => {
  test("is kept; a # after a space still starts a comment", () => {
    const stashDir = makeStash();
    fs.writeFileSync(path.join(stashDir, "env", "h.env"), "PASSWORD=#abc\nEMPTY= #c\nURL=x#frag\n");
    const result = akm(stashDir, [
      "exec",
      "--env",
      "env/h",
      "--",
      "sh",
      "-c",
      'printf "[%s][%s][%s]" "$PASSWORD" "$EMPTY" "$URL"',
    ]);
    expect(result.stdout).toBe("[#abc][][x#frag]");
  });
});

describe.skipIf(!posix)("a descendant left holding the output pipe", () => {
  for (const timeoutMs of [null, 20_000]) {
    test(`the leader's result is kept and the descendant is stopped (${timeoutMs === null ? "no timeout" : "with a timeout"})`, async () => {
      const dir = makeStash();
      const pidFile = path.join(dir, "leftover.pid");
      const started = Date.now();
      const result = await runManagedSubprocess(["sh", "-c", `(sleep 30 & echo $! > ${pidFile}); echo reply`], {
        capture: true,
        timeoutMs,
      });
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      try {
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("reply\n");
        expect(result.stdoutRead.timedOut).toBe(false);
        expect(Date.now() - started).toBeLessThan(6_000);
        const end = Date.now() + 3_000;
        while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
        expect(alive(pid)).toBe(false);
      } finally {
        if (alive(pid)) process.kill(pid, "SIGKILL");
      }
    }, 30_000);
  }
});

describe.skipIf(!posix)("one signal, two owners", () => {
  test("the child's kill ladder runs once when the host aborts the run and the guard stops it too", async () => {
    const dir = makeStash();
    const hits = path.join(dir, "hits");
    const entry = path.join(dir, "host.ts");
    fs.writeFileSync(
      entry,
      [
        `import { runManagedSubprocess } from ${JSON.stringify(path.join(repoRoot, "src/core/subprocess.ts"))};`,
        "const abort = new AbortController();",
        'process.once("SIGTERM", () => abort.abort());',
        // The child traps INT and TERM, records INT, and leaves on TERM, so a second ladder would record a second INT.
        `const script = ${JSON.stringify(`trap 'echo INT >> ${hits}' INT; trap 'exit 0' TERM; echo READY; while true; do sleep 0.1; done`)};`,
        'const result = await runManagedSubprocess(["bash", "-c", script], { capture: true, timeoutMs: null, signal: abort.signal, graceMs: 300 });',
        "console.log(JSON.stringify({ aborted: result.aborted }));",
      ].join("\n"),
    );
    const host = spawn("bun", [entry], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    host.stdout.on("data", (d) => {
      out += String(d);
    });
    try {
      const end = Date.now() + 10_000;
      // The host prints only once the run is over; give the child time to install its traps.
      await new Promise((r) => setTimeout(r, 1_500));
      host.kill("SIGTERM");
      await new Promise<void>((resolve) => host.once("exit", () => resolve()));
      expect(Date.now()).toBeLessThan(end + 10_000);
      expect(JSON.parse(out.trim().split("\n").pop() as string)).toEqual({ aborted: true });
      expect(fs.readFileSync(hits, "utf8")).toBe("INT\n");
    } finally {
      host.kill("SIGKILL");
    }
  }, 30_000);
});
