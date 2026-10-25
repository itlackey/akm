import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dirs: string[] = [];
const cliPath = path.join(import.meta.dir, "..", "..", "src", "cli.ts");

function spawnCli(
  args: string[],
  env: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bun", [cliPath, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("format exemptions use the resolved Citty command path", () => {
  test("fresh Bun exit status normalizes an undefined saved exitCode to zero", () => {
    const shared = JSON.stringify(new URL("../../src/cli/shared.ts", import.meta.url).pathname);
    const result = spawnSync(
      "bun",
      [
        "-e",
        `import { emitJsonError } from ${shared};
if (process.exitCode !== undefined) throw new Error("expected pristine undefined exitCode");
const before = process.exitCode;
console.error = () => {};
try { emitJsonError(new Error("expected")); } finally { process.exitCode = before ?? 0; }
console.log(JSON.stringify({ before: before ?? null, after: process.exitCode }));`,
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout ?? "")).toEqual({ before: null, after: 0 });
  });

  test("global value flags before env run still identify the exempt leaf", () => {
    const stash = tempDir("akm-exempt-stash-");
    fs.mkdirSync(path.join(stash, "env"), { recursive: true });
    fs.writeFileSync(path.join(stash, "env", "prod.env"), "FOO=bar\n");

    const result = spawnCli(["--format", "text", "env", "run", "env/prod", "--", "/bin/true"], {
      AKM_BUNDLE_DIR: stash,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("'--format' has no effect on 'akm env run'");
  });

  test("a format suffix before `--` identifies the full exempt leaf", () => {
    const stash = tempDir("akm-exempt-suffix-");
    fs.mkdirSync(path.join(stash, "env"), { recursive: true });
    fs.writeFileSync(path.join(stash, "env", "prod.env"), "FOO=bar\n");

    const result = spawnCli(["env", "run", "env/prod", "--format", "text", "--", "/bin/true"], {
      AKM_BUNDLE_DIR: stash,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("'--format' has no effect on 'akm env run'");
  });

  test("a child --format after `--` does not trigger an akm warning", () => {
    const stash = tempDir("akm-exempt-boundary-");
    fs.mkdirSync(path.join(stash, "env"), { recursive: true });
    fs.writeFileSync(path.join(stash, "env", "prod.env"), "FOO=bar\n");

    const result = spawnCli(["env", "run", "env/prod", "--", "/bin/true", "--format", "text"], {
      AKM_BUNDLE_DIR: stash,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("'--format' has no effect");
  });

  test("child --quiet does not suppress akm's pre-boundary exemption warning", () => {
    const stash = tempDir("akm-exempt-child-quiet-");
    fs.mkdirSync(path.join(stash, "env"), { recursive: true });
    fs.writeFileSync(path.join(stash, "env", "prod.env"), "FOO=bar\n");

    const result = spawnCli(["--format", "text", "env", "run", "env/prod", "--", "/bin/true", "--quiet"], {
      AKM_BUNDLE_DIR: stash,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("'--format' has no effect on 'akm env run'");
  });

  test("scheduler-context discovery ignores a child argument after `--`", () => {
    const stash = tempDir("akm-scheduler-child-arg-");
    fs.mkdirSync(path.join(stash, "env"), { recursive: true });
    fs.writeFileSync(path.join(stash, "env", "prod.env"), "FOO=bar\n");

    const result = spawnCli(
      ["env", "run", "env/prod", "--", "/bin/true", "--scheduler-context", "/does/not/exist.json"],
      { AKM_BUNDLE_DIR: stash },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("scripted setup formats its result instead of warning as exempt", () => {
    const stash = tempDir("akm-setup-format-");
    const result = spawnCli(["--format", "text", "setup", "--yes", "--no-init", "--dir", stash], {
      AKM_FORCE_SETUP_TMP_STASH: "1",
      AKM_BUNDLE_DIR: stash,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toStartWith("{");
    expect(result.stderr).not.toContain("'--format' has no effect");
  });

  test("agent inherited output stays raw while its final result uses the requested format", () => {
    const root = tempDir("akm-agent-format-");
    const stash = path.join(root, "stash");
    const configHome = path.join(root, "config");
    const bin = path.join(root, "fake-agent");
    fs.mkdirSync(stash, { recursive: true });
    fs.mkdirSync(path.join(configHome, "akm"), { recursive: true });
    fs.writeFileSync(bin, "#!/bin/sh\nprintf 'CHILD_RAW\\n'\n");
    fs.chmodSync(bin, 0o755);
    fs.writeFileSync(
      path.join(configHome, "akm", "config.json"),
      JSON.stringify({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        harnesses: { test: { platform: "aider", bin } },
      }),
    );

    const result = spawnCli(["--format", "text", "agent", "--engine", "test"], {
      AKM_BUNDLE_DIR: stash,
      XDG_CONFIG_HOME: configHome,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toStartWith("CHILD_RAW\n");
    expect(result.stdout).toContain("engine=test");
    expect(result.stderr).not.toContain("'--format' has no effect");
  });
});
