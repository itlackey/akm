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

function writeConfig(configDir: string, config: Record<string, unknown>): void {
  const configPath = path.join(configDir, "akm", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function runCli(stashDir: string, args: string[], config?: Record<string, unknown>): string {
  const xdgCache = makeTempDir("akm-agent-cache-");
  const xdgConfig = makeTempDir("akm-agent-config-");
  if (config) writeConfig(xdgConfig, config);
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
  if (result.status !== 0) {
    throw new Error(`CLI exited ${result.status}:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("--for-agent output mode", () => {
  function makeStash(): string {
    const stashDir = makeTempDir("akm-agent-stash-");
    writeFile(
      path.join(stashDir, "agents", "architect.md"),
      "---\ndescription: System architecture agent\ntags: [arch, design]\n---\nYou are an architect.\n",
    );
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");
    writeFile(
      path.join(stashDir, "commands", "release.md"),
      "---\ndescription: Release process\n---\nRun release {{version}}\n",
    );
    return stashDir;
  }

  test("--for-agent search output has only: name, ref, type, description, action, score", () => {
    const stashDir = makeStash();
    const output = runCli(stashDir, ["search", "architect", "--format=json", "--for-agent"]);
    const json = JSON.parse(output) as { hits: Array<Record<string, unknown>> };

    expect(json.hits.length).toBeGreaterThan(0);
    const hit = json.hits[0];
    const keys = Object.keys(hit);

    // Must have these agent-essential fields (when present)
    expect(keys).toContain("name");
    expect(keys).toContain("type");
    expect(keys).toContain("action");

    // Only allowed keys
    const allowedKeys = new Set(["name", "ref", "type", "description", "action", "score"]);
    for (const key of keys) {
      expect(allowedKeys.has(key)).toBe(true);
    }
  });

  test("--for-agent search output does NOT have: schemaVersion, stashDir, path, whyMatched, origin, editable", () => {
    const stashDir = makeStash();
    const output = runCli(stashDir, ["search", "architect", "--format=json", "--for-agent"]);
    const json = JSON.parse(output) as Record<string, unknown>;

    // Top-level envelope must not have these
    expect(json).not.toHaveProperty("schemaVersion");
    expect(json).not.toHaveProperty("stashDir");
    expect(json).not.toHaveProperty("timing");

    // Hits must not have these
    const hits = json.hits as Array<Record<string, unknown>>;
    for (const hit of hits) {
      expect(hit).not.toHaveProperty("path");
      expect(hit).not.toHaveProperty("whyMatched");
      expect(hit).not.toHaveProperty("origin");
      expect(hit).not.toHaveProperty("editable");
      expect(hit).not.toHaveProperty("editHint");
      expect(hit).not.toHaveProperty("tags");
      expect(hit).not.toHaveProperty("size");
    }
  });

  test("--for-agent show output strips non-essential fields", () => {
    const stashDir = makeStash();
    const output = runCli(stashDir, ["show", "command:release.md", "--format=json", "--for-agent"]);
    const json = JSON.parse(output) as Record<string, unknown>;

    // Must have essential fields
    expect(json).toHaveProperty("name");
    expect(json).toHaveProperty("type");

    // Must NOT have non-essential fields
    expect(json).not.toHaveProperty("schemaVersion");
    expect(json).not.toHaveProperty("path");
    expect(json).not.toHaveProperty("origin");
    expect(json).not.toHaveProperty("editable");
    expect(json).not.toHaveProperty("editHint");
  });

  test("--for-agent show output keeps content/run/action", () => {
    const stashDir = makeStash();

    // Command has template content
    const cmdOutput = runCli(stashDir, ["show", "command:release.md", "--format=json", "--for-agent"]);
    const cmdJson = JSON.parse(cmdOutput) as Record<string, unknown>;
    expect(cmdJson).toHaveProperty("template");
    expect(cmdJson).toHaveProperty("action");

    // Script has run field
    const scriptOutput = runCli(stashDir, ["show", "script:deploy.sh", "--format=json", "--for-agent"]);
    const scriptJson = JSON.parse(scriptOutput) as Record<string, unknown>;
    expect(scriptJson).toHaveProperty("run");
    expect(scriptJson).toHaveProperty("action");
  });

  test("standard output (without --for-agent) is unchanged", () => {
    const stashDir = makeStash();

    // Default brief search still has same shape
    const searchOutput = runCli(stashDir, ["search", "architect", "--format=json"]);
    const searchJson = JSON.parse(searchOutput) as { hits: Array<Record<string, unknown>> };
    expect(Object.keys(searchJson)).toEqual(["hits"]);
    // Standard brief output includes at least name, type, action (may also include estimatedTokens etc.)
    const hit = searchJson.hits[0] ?? {};
    expect(hit).toHaveProperty("name");
    expect(hit).toHaveProperty("type");
    expect(hit).toHaveProperty("action");

    // Default show still has origin
    const showOutput = runCli(stashDir, ["show", "command:release.md", "--format=json"]);
    const showJson = JSON.parse(showOutput) as Record<string, unknown>;
    expect(showJson).toHaveProperty("origin");
  });
});

describe("--format jsonl", () => {
  function makeStash(): string {
    const stashDir = makeTempDir("akm-jsonl-stash-");
    writeFile(
      path.join(stashDir, "agents", "architect.md"),
      "---\ndescription: System architecture agent\n---\nYou are an architect.\n",
    );
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");
    return stashDir;
  }

  test("JSONL format outputs one JSON object per line for search hits", () => {
    const stashDir = makeStash();
    const output = runCli(stashDir, ["search", "", "--format=jsonl"]);
    const lines = output.split("\n").filter((line) => line.trim().length > 0);

    // Should have at least 2 hits (architect + deploy)
    expect(lines.length).toBeGreaterThanOrEqual(2);

    // Each line must be its own object, not wrapped in an envelope
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(typeof parsed).toBe("object");
      expect(parsed).toHaveProperty("name");
    }
  });

  test("each JSONL line is valid parseable JSON", () => {
    const stashDir = makeStash();
    const output = runCli(stashDir, ["search", "", "--format=jsonl"]);
    const lines = output.split("\n").filter((line) => line.trim().length > 0);

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      const parsed = JSON.parse(line);
      expect(typeof parsed).toBe("object");
      expect(Array.isArray(parsed)).toBe(false);
    }
  });

  test("JSONL combined with --for-agent uses agent shaping", () => {
    const stashDir = makeStash();
    const output = runCli(stashDir, ["search", "", "--format=jsonl", "--for-agent"]);
    const lines = output.split("\n").filter((line) => line.trim().length > 0);

    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const allowedKeys = new Set(["name", "ref", "type", "description", "action", "score"]);
      for (const key of Object.keys(parsed)) {
        expect(allowedKeys.has(key)).toBe(true);
      }
      // Must not have stripped fields
      expect(parsed).not.toHaveProperty("path");
      expect(parsed).not.toHaveProperty("origin");
      expect(parsed).not.toHaveProperty("whyMatched");
    }
  });
});
