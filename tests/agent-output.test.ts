import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPromptStdin } from "../src/commands/agent/contribute-cli";
import { _resetWarnOnceForTests } from "../src/core/warn";
import { runCliCapture } from "./_helpers/cli";
import { withBundle, withEnv } from "./_helpers/sandbox";

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
      XDG_CACHE_HOME: runtime.xdgCache,
      XDG_CONFIG_HOME: runtime.xdgConfig,
      XDG_DATA_HOME: runtime.xdgData,
      XDG_STATE_HOME: runtime.xdgState,
    },
    () =>
      withBundle(stashDir, async () => {
        const { code, stdout, stderr } = await runCliCapture(args);
        if (code !== 0) {
          throw new Error(`CLI exited ${code}:\n${stderr}`);
        }
        return stdout.trim();
      }),
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("search, show and curate output", () => {
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

  test("--detail agent warns once and gives the normal output", async () => {
    _resetWarnOnceForTests(); // an earlier file in the same process may already have warned
    const stashDir = makeStash();
    const normal = await runCli(stashDir, ["search", "architect", "--format=json", "--detail=normal"]);
    const runtime = makeCliRuntime();
    const { code, stdout, stderr } = await withEnv(
      {
        XDG_CACHE_HOME: runtime.xdgCache,
        XDG_CONFIG_HOME: runtime.xdgConfig,
        XDG_DATA_HOME: runtime.xdgData,
        XDG_STATE_HOME: runtime.xdgState,
      },
      () => withBundle(stashDir, () => runCliCapture(["search", "architect", "--format=json", "--detail=agent"])),
    );
    expect(code).toBe(0);
    expect(stderr.match(/Unknown --detail value "agent"/g)).toHaveLength(1);
    expect(stdout.trim()).toBe(normal);
  }, 30_000);

  test("default search output is brief and carries `results`", async () => {
    const stashDir = makeStash();

    // Default brief search still has same shape
    const searchOutput = await runCli(stashDir, ["search", "architect", "--format=json"]);
    const searchJson = JSON.parse(searchOutput) as { results: Array<Record<string, unknown>> };
    // results is always present; warnings may appear when semantic search is pending
    expect(Object.keys(searchJson)).toContain("results");
    expect(Object.keys(searchJson)).not.toContain("hits");
    // Standard brief output includes at least name, type (may also include description, estimatedTokens etc.)
    const hit = searchJson.results[0] ?? {};
    expect(hit).toHaveProperty("name");
    expect(hit).toHaveProperty("type");
    expect(hit).not.toHaveProperty("action");

    // Default show still has origin
    const showOutput = await runCli(stashDir, ["show", "commands/release.md", "--format=json"]);
    const showJson = JSON.parse(showOutput) as Record<string, unknown>;
    expect(showJson).toHaveProperty("origin");
  });

  test("read-only local assets expose secondary edit hints", async () => {
    const stashDir = makeStash();
    const teamDir = makeTempDir("akm-agent-readonly-");
    const assetPath = path.join(teamDir, "knowledge", "readonly-guide.md");
    writeFile(assetPath, "# Read-only guide\n\nUse this reference.\n");
    const config = {
      semanticSearchMode: "off",
      bundles: { team: { path: teamDir, writable: false } },
    };

    const search = JSON.parse(
      await runCli(stashDir, ["search", "readonly guide", "--format=json", "--detail=normal"], config),
    ) as { results: Array<Record<string, unknown>> };
    const searchHit = search.results.find((hit) => hit.ref === "team//knowledge/readonly-guide");
    expect(searchHit).toBeDefined();
    expect(searchHit).not.toHaveProperty("action");

    const show = JSON.parse(
      await runCli(stashDir, ["show", "team//knowledge/readonly-guide", "--format=json", "--detail=full"], config),
    ) as Record<string, unknown>;
    expect(show).toMatchObject({ ref: "team//knowledge/readonly-guide", path: assetPath, editable: false });
    expect(show.editHint).toContain("akm clone team//knowledge/readonly-guide");
    expect(show.action).not.toContain("clone");

    const curate = JSON.parse(
      await runCli(stashDir, ["curate", "readonly guide", "--format=json", "--detail=normal"], config),
    ) as { results: Array<Record<string, unknown>> };
    const curated = curate.results.find((item) => item.ref === "team//knowledge/readonly-guide");
    expect(curated).toMatchObject({ ref: "team//knowledge/readonly-guide", path: assetPath, editable: false });
    expect(curated?.editHint).toContain("akm clone team//knowledge/readonly-guide");
    expect(curated).not.toHaveProperty("followUp");
  }, 30_000);
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

  test("agent dispatch uses the rendered agent prompt and keeps one JSON result envelope", async () => {
    const stashDir = makeTempDir("akm-agent-dispatch-stash-");
    writeFile(
      path.join(stashDir, "agents", "reviewer.md"),
      "---\ndescription: Reviewer\n---\nRendered system prompt.\n",
    );
    // Claude Code reads the prompt on stdin; this one prints its arguments and then its stdin.
    const bin = path.join(stashDir, "echo-claude.sh");
    writeFile(bin, '#!/bin/sh\necho "$@"\ncat\n');
    fs.chmodSync(bin, 0o755);
    const config = {
      semanticSearchMode: "off",
      harnesses: { test: { platform: "claude", bin } },
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
      semanticSearchMode: "off",
      defaultBundle: "fixture",
      bundles: {
        fixture: {
          path: stashDir,
          writable: false,
          components: { main: { root: ".", adapter: "okf", writable: false } },
        },
      },
      harnesses: { test: { platform: "opencode", bin: "/bin/echo" } },
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
