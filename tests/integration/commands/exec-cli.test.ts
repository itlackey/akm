// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Real subprocesses: `akm exec` hands its child the terminal, so only a process boundary can observe the child's output.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { withoutBundleDirNotice } from "../../_helpers/bundle-dir-notice";
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

function akm(stashDir: string, args: string[], extraEnv: Record<string, string> = {}) {
  const result = spawnSync("bun", [path.join(repoRoot, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    timeout: 15_000,
    cwd: repoRoot,
    env: { ...process.env, AKM_BUNDLE_DIR: stashDir, ...extraEnv },
  });
  return { stdout: result.stdout ?? "", stderr: withoutBundleDirNotice(result.stderr ?? ""), status: result.status };
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

  test("env run and secret run still work and name akm exec as their replacement", () => {
    const stash = makeStash({ "env/prod.env": "A=1\n", "secrets/token": "t" });
    const env = akm(stash, ["env", "run", "env/prod", "--", ...print("A")]);
    expect(env.stdout).toBe("1|");
    expect(env.stderr).toContain(
      "akm env run is deprecated and is removed in 0.11: use `akm exec --env <ref> -- <command>`",
    );
    const secret = akm(stash, ["secret", "run", "secrets/token", "X", "--", ...print("X")]);
    expect(secret.stdout).toBe("t|");
    expect(secret.stderr).toContain(
      "akm secret run is deprecated and is removed in 0.11: use `akm exec --secret <ref>:<VAR> -- <command>`",
    );
  });
});
