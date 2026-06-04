import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCliCapture } from "../_helpers/cli";
import { withEnv } from "../_helpers/sandbox";

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

// In-process replacement for the former spawnSync("bun", [CLI, ...]). Each call
// gets fresh, isolated XDG dirs (cache/config/data/state) and the test's stash,
// installed via the allowlisted `withEnv` wrapper so the env is restored after
// the run and the per-test isolation tripwire stays satisfied. The harness
// (runCliCapture) resets the config/output singletons per call, matching
// fresh-subprocess semantics. Throws on a non-zero exit, like the spawn version.
async function runCli(stashDir: string, args: string[], config?: Record<string, unknown>): Promise<string> {
  const xdgCache = makeTempDir("akm-agent-cache-");
  const xdgConfig = makeTempDir("akm-agent-config-");
  const xdgData = makeTempDir("akm-agent-data-");
  const xdgState = makeTempDir("akm-agent-state-");
  if (config) writeConfig(xdgConfig, config);
  return withEnv(
    {
      AKM_STASH_DIR: stashDir,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
    },
    async () => {
      const { code, stdout, stderr } = await runCliCapture(args);
      if (code !== 0) {
        throw new Error(`CLI exited ${code}:\n${stderr}`);
      }
      return stdout.trim();
    },
  );
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

  test("--for-agent search output has only: name, ref, type, description, action, score", async () => {
    const stashDir = makeStash();
    const output = await runCli(stashDir, ["search", "architect", "--format=json", "--for-agent"]);
    const json = JSON.parse(output) as { hits: Array<Record<string, unknown>> };

    expect(json.hits.length).toBeGreaterThan(0);
    const hit = json.hits[0];
    const keys = Object.keys(hit);

    // Must have these agent-essential fields (when present)
    expect(keys).toContain("name");
    expect(keys).toContain("type");
    expect(keys).toContain("action");

    // Only allowed keys (estimatedTokens is optional — present when fileSize is known)
    const allowedKeys = new Set(["name", "ref", "type", "description", "action", "score", "estimatedTokens"]);
    for (const key of keys) {
      expect(allowedKeys.has(key)).toBe(true);
    }
  });

  test("--for-agent search output does NOT have: schemaVersion, stashDir, path, whyMatched, origin, editable", async () => {
    const stashDir = makeStash();
    const output = await runCli(stashDir, ["search", "architect", "--format=json", "--for-agent"]);
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

  test("--for-agent show output strips non-essential fields", async () => {
    const stashDir = makeStash();
    const output = await runCli(stashDir, ["show", "command:release.md", "--format=json", "--for-agent"]);
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

  test("--for-agent show output keeps content/run/action", async () => {
    const stashDir = makeStash();

    // Command has template content
    const cmdOutput = await runCli(stashDir, ["show", "command:release.md", "--format=json", "--for-agent"]);
    const cmdJson = JSON.parse(cmdOutput) as Record<string, unknown>;
    expect(cmdJson).toHaveProperty("template");
    expect(cmdJson).toHaveProperty("action");

    // Script has run field
    const scriptOutput = await runCli(stashDir, ["show", "script:deploy.sh", "--format=json", "--for-agent"]);
    const scriptJson = JSON.parse(scriptOutput) as Record<string, unknown>;
    expect(scriptJson).toHaveProperty("run");
    expect(scriptJson).toHaveProperty("action");
  }, 30_000);

  test("standard output (without --for-agent) is unchanged", async () => {
    const stashDir = makeStash();

    // Default brief search still has same shape
    const searchOutput = await runCli(stashDir, ["search", "architect", "--format=json"]);
    const searchJson = JSON.parse(searchOutput) as { hits: Array<Record<string, unknown>> };
    // hits is always present; warnings may appear when semantic search is pending
    expect(Object.keys(searchJson)).toContain("hits");
    // Standard brief output includes at least name, type, action (may also include estimatedTokens etc.)
    const hit = searchJson.hits[0] ?? {};
    expect(hit).toHaveProperty("name");
    expect(hit).toHaveProperty("type");
    expect(hit).toHaveProperty("action");

    // Default show still has origin
    const showOutput = await runCli(stashDir, ["show", "command:release.md", "--format=json"]);
    const showJson = JSON.parse(showOutput) as Record<string, unknown>;
    expect(showJson).toHaveProperty("origin");
  });
});

// ── WS2: --shape agent is the canonical spelling; --for-agent is deprecated ───
describe("--shape agent output mode", () => {
  function makeStash(): string {
    const stashDir = makeTempDir("akm-shape-stash-");
    writeFile(
      path.join(stashDir, "agents", "architect.md"),
      "---\ndescription: System architecture agent\ntags: [arch, design]\n---\nYou are an architect.\n",
    );
    writeFile(
      path.join(stashDir, "commands", "release.md"),
      "---\ndescription: Release process\n---\nRun release {{version}}\n",
    );
    return stashDir;
  }

  test("--shape agent search output matches the --for-agent shape", async () => {
    const stashDir = makeStash();
    const output = await runCli(stashDir, ["search", "architect", "--format=json", "--shape=agent"]);
    const json = JSON.parse(output) as { hits: Array<Record<string, unknown>> };
    expect(json.hits.length).toBeGreaterThan(0);
    const allowedKeys = new Set(["name", "ref", "type", "description", "action", "score", "estimatedTokens"]);
    for (const key of Object.keys(json.hits[0])) {
      expect(allowedKeys.has(key)).toBe(true);
    }
  });

  test("--shape agent show output strips non-essential fields", async () => {
    const stashDir = makeStash();
    const output = await runCli(stashDir, ["show", "command:release.md", "--format=json", "--shape=agent"]);
    const json = JSON.parse(output) as Record<string, unknown>;
    expect(json).not.toHaveProperty("path");
    expect(json).not.toHaveProperty("origin");
    // commands carry their body in `template`; the agent shape keeps it.
    expect(json).toHaveProperty("template");
  });

  test("--for-agent still works but emits a stderr deprecation warning", async () => {
    const stashDir = makeStash();
    const xdgCache = makeTempDir("akm-shape-cache-");
    const xdgConfig = makeTempDir("akm-shape-config-");
    const xdgData = makeTempDir("akm-shape-data-");
    const xdgState = makeTempDir("akm-shape-state-");
    const res = await withEnv(
      {
        AKM_STASH_DIR: stashDir,
        XDG_CACHE_HOME: xdgCache,
        XDG_CONFIG_HOME: xdgConfig,
        XDG_DATA_HOME: xdgData,
        XDG_STATE_HOME: xdgState,
      },
      async () => runCliCapture(["search", "architect", "--format=json", "--for-agent"]),
    );
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("'--for-agent' is deprecated");
    expect(res.stderr).toContain("--shape agent");
    // stdout stays clean JSON — the warning is stderr-only.
    expect(() => JSON.parse(res.stdout.trim())).not.toThrow();
  });

  test("--for-agent deprecation warning is suppressed under --quiet", async () => {
    const stashDir = makeStash();
    const xdgCache = makeTempDir("akm-shape-cache-q-");
    const xdgConfig = makeTempDir("akm-shape-config-q-");
    const xdgData = makeTempDir("akm-shape-data-q-");
    const xdgState = makeTempDir("akm-shape-state-q-");
    const res = await withEnv(
      {
        AKM_STASH_DIR: stashDir,
        XDG_CACHE_HOME: xdgCache,
        XDG_CONFIG_HOME: xdgConfig,
        XDG_DATA_HOME: xdgData,
        XDG_STATE_HOME: xdgState,
      },
      async () => runCliCapture(["search", "architect", "--format=json", "--for-agent", "--quiet"]),
    );
    expect(res.code).toBe(0);
    expect(res.stderr).not.toContain("deprecated");
  });

  test("legacy --detail agent maps to --shape agent and warns", async () => {
    const stashDir = makeStash();
    const xdgCache = makeTempDir("akm-shape-cache-d-");
    const xdgConfig = makeTempDir("akm-shape-config-d-");
    const xdgData = makeTempDir("akm-shape-data-d-");
    const xdgState = makeTempDir("akm-shape-state-d-");
    const res = await withEnv(
      {
        AKM_STASH_DIR: stashDir,
        XDG_CACHE_HOME: xdgCache,
        XDG_CONFIG_HOME: xdgConfig,
        XDG_DATA_HOME: xdgData,
        XDG_STATE_HOME: xdgState,
      },
      async () => runCliCapture(["search", "architect", "--format=json", "--detail=agent"]),
    );
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("'--detail agent' is deprecated");
    const json = JSON.parse(res.stdout.trim()) as { hits: Array<Record<string, unknown>> };
    const allowedKeys = new Set(["name", "ref", "type", "description", "action", "score", "estimatedTokens"]);
    for (const key of Object.keys(json.hits[0] ?? {})) {
      expect(allowedKeys.has(key)).toBe(true);
    }
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

  test("JSONL format outputs one JSON object per line for search hits", async () => {
    const stashDir = makeStash();
    // QA #14: empty query now rejects; use a real keyword that matches stash assets.
    // Use "architect" since architect.md has that word in both name and content.
    const output = await runCli(stashDir, ["search", "architect", "--format=jsonl"]);
    const lines = output.split("\n").filter((line) => line.trim().length > 0);

    // Should have at least 1 hit
    expect(lines.length).toBeGreaterThanOrEqual(1);

    // Each line must be its own object, not wrapped in an envelope
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(typeof parsed).toBe("object");
      expect(parsed).toHaveProperty("name");
    }
  });

  test("each JSONL line is valid parseable JSON", async () => {
    const stashDir = makeStash();
    const output = await runCli(stashDir, ["search", "deploy", "--format=jsonl"]);
    const lines = output.split("\n").filter((line) => line.trim().length > 0);

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      const parsed = JSON.parse(line);
      expect(typeof parsed).toBe("object");
      expect(Array.isArray(parsed)).toBe(false);
    }
  });

  test("JSONL combined with --for-agent uses agent shaping", async () => {
    const stashDir = makeStash();
    const output = await runCli(stashDir, ["search", "deploy", "--format=jsonl", "--for-agent"]);
    const lines = output.split("\n").filter((line) => line.trim().length > 0);

    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const allowedKeys = new Set(["name", "ref", "type", "description", "action", "score", "estimatedTokens"]);
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
