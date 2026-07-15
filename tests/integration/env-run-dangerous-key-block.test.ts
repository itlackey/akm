import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runCliCapture } from "../_helpers/cli";
import { makeSandboxDir, makeStashDir, type SandboxedDir, withEnv, writeSandboxConfig } from "../_helpers/sandbox";

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
        AKM_STASH_DIR: makeTempStash(),
        HOME: makeTempDir("akm-env-run-home-"),
        XDG_CONFIG_HOME: makeTempDir("akm-env-run-config-"),
        XDG_CACHE_HOME: makeTempDir("akm-env-run-cache-"),
        XDG_DATA_HOME: makeTempDir("akm-env-run-data-"),
        XDG_STATE_HOME: makeTempDir("akm-env-run-state-"),
      },
      async () => {
        writeSandboxConfig({
          sources: [{ type: "filesystem", name: "vendor", path: sourceDir }],
        });
        return runCliCapture(["env", "run", "vendor//env:danger", "--", "true"]);
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
});
