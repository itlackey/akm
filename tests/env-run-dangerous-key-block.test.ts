import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runCliCapture } from "./_helpers/cli";
import { makeSandboxDir, makeStashDir, type SandboxedDir, withEnv, writeSandboxConfig } from "./_helpers/sandbox";

const disposers: SandboxedDir[] = [];

function makeTempDir(prefix: string): string {
  const d = makeSandboxDir(prefix);
  disposers.push(d);
  return d.dir;
}

function makeTempStash(): string {
  const d = makeStashDir();
  disposers.push(d);
  return d.dir;
}

afterAll(() => {
  for (const d of disposers) d.cleanup();
  disposers.length = 0;
});

describe("env run dangerous-key blocking", () => {
  test("blocks GIT_CONFIG_* keys for non-primary named sources", async () => {
    const sourceDir = makeTempStash();
    fs.mkdirSync(path.join(sourceDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "env", "danger.env"), "GIT_CONFIG_GLOBAL=/tmp/evil.gitconfig\n", "utf8");

    const result = await withEnv(
      {
        AKM_BUNDLE_DIR: makeTempStash(),
        HOME: makeTempDir("akm-env-run-home-"),
        XDG_CONFIG_HOME: makeTempDir("akm-env-run-config-"),
        XDG_CACHE_HOME: makeTempDir("akm-env-run-cache-"),
        XDG_DATA_HOME: makeTempDir("akm-env-run-data-"),
        XDG_STATE_HOME: makeTempDir("akm-env-run-state-"),
      },
      async () => {
        writeSandboxConfig({
          bundles: { vendor: { path: sourceDir } },
        });
        return runCliCapture(["env", "run", "vendor//env/danger", "--", "true"]);
      },
    );

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    const parsed = JSON.parse(result.stderr) as { ok?: boolean; error?: string; code?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("Refusing to inject env from a third-party stash");
    expect(parsed.error).toContain("GIT_CONFIG_GLOBAL");
  });

  test("blocks a genuine RCE-class key (GIT_SSH_COMMAND) for a third-party stash without --allow-dangerous-env-keys", async () => {
    const sourceDir = makeTempStash();
    fs.mkdirSync(path.join(sourceDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "env", "danger.env"), "GIT_SSH_COMMAND=/tmp/evil-ssh\n", "utf8");

    const result = await withEnv(
      {
        AKM_BUNDLE_DIR: makeTempStash(),
        HOME: makeTempDir("akm-env-run-home-"),
        XDG_CONFIG_HOME: makeTempDir("akm-env-run-config-"),
        XDG_CACHE_HOME: makeTempDir("akm-env-run-cache-"),
        XDG_DATA_HOME: makeTempDir("akm-env-run-data-"),
        XDG_STATE_HOME: makeTempDir("akm-env-run-state-"),
      },
      async () => {
        writeSandboxConfig({
          bundles: { vendor: { path: sourceDir } },
        });
        return runCliCapture(["env", "run", "vendor//env/danger", "--", "true"]);
      },
    );

    expect(result.code).toBe(2);
    const parsed = JSON.parse(result.stderr) as { ok?: boolean; error?: string; code?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Refusing to inject env from a third-party stash");
    expect(parsed.error).toContain("GIT_SSH_COMMAND");
    expect(parsed.error).toContain("--allow-dangerous-env-keys");
  });

  test("--allow-dangerous-env-keys warns and injects the same RCE-class key from a third-party stash", async () => {
    const sourceDir = makeTempStash();
    fs.mkdirSync(path.join(sourceDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "env", "danger.env"), "GIT_SSH_COMMAND=/tmp/evil-ssh\n", "utf8");
    const markerDir = makeTempDir("akm-env-run-marker-");
    const markerFile = path.join(markerDir, "git-ssh-command.txt");

    const result = await withEnv(
      {
        AKM_BUNDLE_DIR: makeTempStash(),
        HOME: makeTempDir("akm-env-run-home-"),
        XDG_CONFIG_HOME: makeTempDir("akm-env-run-config-"),
        XDG_CACHE_HOME: makeTempDir("akm-env-run-cache-"),
        XDG_DATA_HOME: makeTempDir("akm-env-run-data-"),
        XDG_STATE_HOME: makeTempDir("akm-env-run-state-"),
      },
      async () => {
        writeSandboxConfig({
          bundles: { vendor: { path: sourceDir } },
        });
        return runCliCapture([
          "env",
          "run",
          "vendor//env/danger",
          "--allow-dangerous-env-keys",
          "--",
          process.execPath,
          "-e",
          `require("fs").writeFileSync(${JSON.stringify(markerFile)}, process.env.GIT_SSH_COMMAND || "")`,
        ]);
      },
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("GIT_SSH_COMMAND");
    expect(result.stderr).toContain("--allow-dangerous-env-keys");
    expect(fs.readFileSync(markerFile, "utf8")).toBe("/tmp/evil-ssh");
  });
});
