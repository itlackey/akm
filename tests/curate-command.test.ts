import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(__dirname, "..", "src", "cli.ts");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function runCli(stashDir: string, args: string[]): string {
  const xdgCache = makeTempDir("akm-curate-cache-");
  const xdgConfig = makeTempDir("akm-curate-config-");
  const result = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      AKM_STASH_DIR: stashDir,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
    },
  });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("curate command", () => {
  function makeStash(): string {
    const stashDir = makeTempDir("akm-curate-stash-");
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");
    writeFile(
      path.join(stashDir, "commands", "release.md"),
      "---\ndescription: Release the app\n---\nnpm version {{version}} && git push --follow-tags\n",
    );
    writeFile(
      path.join(stashDir, "skills", "release-review", "SKILL.md"),
      "---\ndescription: Review a release plan\n---\n# Release Review\nCheck rollout, rollback, and validation.\n",
    );
    writeFile(
      path.join(stashDir, "knowledge", "release-guide.md"),
      "# Release Guide\n\nUse this guide to explain the release workflow.\n",
    );
    return stashDir;
  }

  test("returns curated JSON with follow-up commands and previews", () => {
    const stashDir = makeStash();
    const output = runCli(stashDir, ["curate", "release deploy", "--format=json"]);
    const json = JSON.parse(output) as { query: string; items: Array<Record<string, unknown>>; summary: string };

    expect(json.query).toBe("release deploy");
    expect(json.summary).toContain("Selected");
    expect(json.items.length).toBeGreaterThanOrEqual(2);
    expect(new Set(json.items.map((item) => item.type)).size).toBeGreaterThanOrEqual(2);

    for (const item of json.items) {
      if (item.source === "stash") {
        expect(typeof item.ref).toBe("string");
        expect(String(item.followUp)).toContain("akm show");
        expect(typeof item.reason).toBe("string");
      }
    }
  });

  test("prefers one strong match per asset type by default", () => {
    const stashDir = makeStash();
    writeFile(
      path.join(stashDir, "commands", "release-notes.md"),
      "---\ndescription: Draft release notes\n---\nWrite release notes for {{version}}\n",
    );

    const output = runCli(stashDir, ["curate", "release", "--format=json"]);
    const json = JSON.parse(output) as { items: Array<Record<string, unknown>> };
    const commandItems = json.items.filter((item) => item.type === "command");

    expect(commandItems.length).toBe(1);
  });

  test("text output includes direct refs and follow-up commands", () => {
    const stashDir = makeStash();
    const output = runCli(stashDir, ["curate", "release deploy", "--format=text"]);

    expect(output).toContain('Curated results for "release deploy"');
    expect(output).toContain("[command]");
    expect(output).toContain("ref: command:release");
    expect(output).toContain("show: akm show command:release");
  });

  test("returns a tip when no curated results are found", () => {
    const stashDir = makeTempDir("akm-curate-empty-stash-");
    const output = runCli(stashDir, ["curate", "totally unmatched request", "--format=json"]);
    const json = JSON.parse(output) as { items: Array<Record<string, unknown>>; tip?: string; summary: string };

    expect(json.items).toEqual([]);
    // Auto-index runs but finds nothing in the empty stash
    expect(json.tip).toContain("Index is empty");
  });
});
