import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPromptStdin } from "../src/commands/agent/contribute-cli";
import { runCliCapture } from "./_helpers/cli";
import { withEnv } from "./_helpers/sandbox";

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

interface CliRuntime {
  xdgCache: string;
  xdgConfig: string;
  xdgData: string;
  xdgState: string;
}

function makeCliRuntime(): CliRuntime {
  return {
    xdgCache: makeTempDir("akm-agent-cache-"),
    xdgConfig: makeTempDir("akm-agent-config-"),
    xdgData: makeTempDir("akm-agent-data-"),
    xdgState: makeTempDir("akm-agent-state-"),
  };
}

// In-process replacement for the former spawnSync("bun", [CLI, ...]). Calls use
// isolated XDG dirs (cache/config/data/state) and may share them when a fixture
// needs an index produced by an earlier CLI invocation with the same stash,
// installed via the allowlisted `withEnv` wrapper so the env is restored after
// the run and the per-test isolation tripwire stays satisfied. The harness
// (runCliCapture) resets the config/output singletons per call, matching
// fresh-subprocess semantics. Throws on a non-zero exit, like the spawn version.
async function runCli(
  stashDir: string,
  args: string[],
  config?: Record<string, unknown>,
  runtime = makeCliRuntime(),
): Promise<string> {
  if (config) writeConfig(runtime.xdgConfig, config);
  return withEnv(
    {
      AKM_BUNDLE_DIR: stashDir,
      XDG_CACHE_HOME: runtime.xdgCache,
      XDG_CONFIG_HOME: runtime.xdgConfig,
      XDG_DATA_HOME: runtime.xdgData,
      XDG_STATE_HOME: runtime.xdgState,
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

describe("--shape agent field projection", () => {
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

  test("--shape agent search output includes canonical location and edit authorization", async () => {
    const stashDir = makeStash();
    const output = await runCli(stashDir, ["search", "architect", "--format=json", "--shape=agent"]);
    const json = JSON.parse(output) as { hits: Array<Record<string, unknown>> };

    expect(json.hits.length).toBeGreaterThan(0);
    const hit = json.hits[0];
    if (!hit) throw new Error("expected a matching search hit");
    const keys = Object.keys(hit);

    // Must have these agent-essential fields (when present)
    expect(keys).toContain("name");
    expect(keys).toContain("type");
    expect(keys).toContain("action");
    expect(hit).toHaveProperty("ref");
    expect(hit).toHaveProperty("path");
    expect(path.isAbsolute(String(hit?.path))).toBe(true);
    expect(hit).toHaveProperty("editable", true);
    expect(hit).not.toHaveProperty("editHint");

    // Only allowed keys (estimatedTokens is optional — present when fileSize is known)
    const allowedKeys = new Set([
      "name",
      "ref",
      "type",
      "path",
      "editable",
      "editHint",
      "description",
      "action",
      "score",
      "estimatedTokens",
    ]);
    for (const key of keys) {
      expect(allowedKeys.has(key)).toBe(true);
    }
  });

  test("--shape agent search output omits envelope and ranking internals", async () => {
    const stashDir = makeStash();
    const output = await runCli(stashDir, ["search", "architect", "--format=json", "--shape=agent"]);
    const json = JSON.parse(output) as Record<string, unknown>;

    // Top-level envelope must not have these
    expect(json).not.toHaveProperty("schemaVersion");
    expect(json).not.toHaveProperty("stashDir");
    expect(json).not.toHaveProperty("timing");

    // Hits must not have these
    const hits = json.hits as Array<Record<string, unknown>>;
    for (const hit of hits) {
      expect(hit).not.toHaveProperty("whyMatched");
      expect(hit).not.toHaveProperty("origin");
      expect(hit).not.toHaveProperty("tags");
      expect(hit).not.toHaveProperty("size");
    }
  });

  test("--shape agent show output strips non-essential fields", async () => {
    const stashDir = makeStash();
    const output = await runCli(stashDir, ["show", "commands/release.md", "--format=json", "--shape=agent"]);
    const json = JSON.parse(output) as Record<string, unknown>;

    // Must have essential fields
    expect(json).toHaveProperty("name");
    expect(json).toHaveProperty("type");

    // Must expose exact local access information but omit unrelated metadata.
    expect(json).not.toHaveProperty("schemaVersion");
    expect(json).toHaveProperty("ref");
    expect(json).toHaveProperty("path");
    expect(path.isAbsolute(String(json.path))).toBe(true);
    expect(json).toHaveProperty("editable", true);
    expect(json).not.toHaveProperty("editHint");
    expect(json).not.toHaveProperty("origin");
  });

  test("--shape agent show output keeps content/run/action", async () => {
    const stashDir = makeStash();

    // Command has template content
    const cmdOutput = await runCli(stashDir, ["show", "commands/release.md", "--format=json", "--shape=agent"]);
    const cmdJson = JSON.parse(cmdOutput) as Record<string, unknown>;
    expect(cmdJson).toHaveProperty("template");
    expect(cmdJson).toHaveProperty("action");

    // Script has run field
    const scriptOutput = await runCli(stashDir, ["show", "scripts/deploy.sh", "--format=json", "--shape=agent"]);
    const scriptJson = JSON.parse(scriptOutput) as Record<string, unknown>;
    expect(scriptJson).toHaveProperty("run");
    expect(scriptJson).toHaveProperty("action");
  }, 30_000);

  test("standard output (without --shape agent) is unchanged", async () => {
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
    const showOutput = await runCli(stashDir, ["show", "commands/release.md", "--format=json"]);
    const showJson = JSON.parse(showOutput) as Record<string, unknown>;
    expect(showJson).toHaveProperty("origin");
  });

  test("read-only local assets expose secondary edit hints without replacing use actions", async () => {
    const stashDir = makeStash();
    const teamDir = makeTempDir("akm-agent-readonly-");
    const assetPath = path.join(teamDir, "knowledge", "readonly-guide.md");
    writeFile(assetPath, "# Read-only guide\n\nUse this reference.\n");
    const config = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: { team: { path: teamDir, writable: false } },
    };

    const search = JSON.parse(
      await runCli(stashDir, ["search", "readonly guide", "--format=json", "--shape=agent"], config),
    ) as { hits: Array<Record<string, unknown>> };
    const searchHit = search.hits.find((hit) => hit.ref === "team//knowledge/readonly-guide");
    expect(searchHit).toMatchObject({
      ref: "team//knowledge/readonly-guide",
      path: assetPath,
      editable: false,
    });
    expect(searchHit?.editHint).toContain("akm clone team//knowledge/readonly-guide");
    expect(searchHit?.action).toContain("akm show team//knowledge/readonly-guide");
    expect(searchHit?.action).not.toContain("clone");

    const show = JSON.parse(
      await runCli(stashDir, ["show", "team//knowledge/readonly-guide", "--format=json", "--shape=agent"], config),
    ) as Record<string, unknown>;
    expect(show).toMatchObject({ ref: "team//knowledge/readonly-guide", path: assetPath, editable: false });
    expect(show.editHint).toContain("akm clone team//knowledge/readonly-guide");
    expect(show.action).not.toContain("clone");

    const curate = JSON.parse(
      await runCli(stashDir, ["curate", "readonly guide", "--format=json", "--shape=agent"], config),
    ) as { items: Array<Record<string, unknown>> };
    const curated = curate.items.find((item) => item.ref === "team//knowledge/readonly-guide");
    expect(curated).toMatchObject({ ref: "team//knowledge/readonly-guide", path: assetPath, editable: false });
    expect(curated?.editHint).toContain("akm clone team//knowledge/readonly-guide");
    expect(curated?.followUp).toBe("akm show team//knowledge/readonly-guide");
  }, 30_000);
});

// WS2 ("--shape agent is the canonical spelling") removed (D1): it was a
// strict subset of the "--shape agent field projection" describe block above
// (:78-113 covers the same allowedKeys set plus essential-field checks;
// :135-152 and :154-168 cover show fields + `template`). Its private
// makeStash helper was local to the deleted describe block and needed no
// separate removal.

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

  test("JSONL combined with --shape agent uses agent shaping", async () => {
    const stashDir = makeStash();
    const output = await runCli(stashDir, ["search", "deploy", "--format=jsonl", "--shape=agent"]);
    const lines = output.split("\n").filter((line) => line.trim().length > 0);

    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const allowedKeys = new Set([
        "name",
        "ref",
        "type",
        "path",
        "editable",
        "editHint",
        "description",
        "action",
        "score",
        "estimatedTokens",
      ]);
      for (const key of Object.keys(parsed)) {
        expect(allowedKeys.has(key)).toBe(true);
      }
      // Must not have stripped fields
      expect(parsed).not.toHaveProperty("origin");
      expect(parsed).not.toHaveProperty("whyMatched");
    }
  });

  test("agent dispatch uses the rendered agent prompt and keeps one JSON result envelope", async () => {
    const stashDir = makeTempDir("akm-agent-dispatch-stash-");
    writeFile(
      path.join(stashDir, "agents", "reviewer.md"),
      "---\ndescription: Reviewer\n---\nRendered system prompt.\n",
    );
    const config = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { test: { kind: "agent", platform: "opencode", bin: "/bin/echo" } },
      defaults: { engine: "test" },
    };
    const runtime = makeCliRuntime();
    await runCli(stashDir, ["index", "--full", "--format=json", "-q"], config, runtime);
    const output = await runCli(
      stashDir,
      ["agent", "agents/reviewer", "--prompt", "Review this task.", "--format=json", "-q"],
      config,
      runtime,
    );
    const result = JSON.parse(output) as { ok: boolean; stdout: string };

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("Rendered system prompt.");
    expect(result.stdout).toContain("Review this task.");
  });

  test("agent rejects refs that render as a non-agent asset", async () => {
    const stashDir = makeTempDir("akm-agent-dispatch-type-stash-");
    // OKF keeps path identity independent of its open type, so this has an
    // `agents/` selector while indexing as knowledge and reaches the loader's
    // exact persona type guard.
    writeFile(
      path.join(stashDir, "agents", "guide.md"),
      "---\ntype: knowledge\ntitle: Guide\ndescription: Guide\n---\nA guide.\n",
    );

    const config = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      defaultBundle: "fixture",
      bundles: {
        fixture: {
          path: stashDir,
          writable: false,
          components: { main: { root: ".", adapter: "okf", writable: false } },
        },
      },
      engines: { test: { kind: "agent", platform: "opencode", bin: "/bin/echo" } },
      defaults: { engine: "test" },
    };
    const runtime = makeCliRuntime();
    await runCli(stashDir, ["index", "--full", "--format=json", "-q"], config, runtime);
    await expect(
      runCli(
        stashDir,
        ["agent", "fixture//agents/guide", "--prompt", "Review this task.", "--format=json", "-q"],
        config,
        runtime,
      ),
    ).rejects.toThrow(/expected/);
  });

  test("prompt-stdin reads the task from stdin when requested", () => {
    expect(readPromptStdin(() => "task from stdin\n")).toBe("task from stdin\n");
  });
});
