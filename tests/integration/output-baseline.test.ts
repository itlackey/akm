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

interface CliEnvDirs {
  xdgCache: string;
  xdgConfig: string;
  xdgData?: string;
  xdgState?: string;
}

// In-process replacement for the former spawnSync("bun", [CLI, ...]). Isolated
// XDG dirs (or the caller-supplied shared ones via envDirs) plus the test stash
// are installed through the allowlisted `withEnv` wrapper and restored after
// the run; the harness (runCliCapture) resets the config/output singletons per
// call. Asserts exit 0 and returns trimmed stdout, exactly like the spawn
// version did.
async function runCli(
  stashDir: string,
  args: string[],
  config?: Record<string, unknown>,
  envDirs?: CliEnvDirs,
): Promise<string> {
  const xdgCache = envDirs?.xdgCache ?? makeTempDir("akm-output-cache-");
  const xdgConfig = envDirs?.xdgConfig ?? makeTempDir("akm-output-config-");
  const xdgData = envDirs?.xdgData ?? makeTempDir("akm-output-data-");
  const xdgState = envDirs?.xdgState ?? makeTempDir("akm-output-state-");
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
      const { code, stdout } = await runCliCapture(args);
      expect(code).toBe(0);
      return stdout.trim();
    },
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("output baseline", () => {
  test("search default JSON brief shape stays stable", async () => {
    const stashDir = makeTempDir("akm-output-stash-");
    writeFile(
      path.join(stashDir, "agents", "architect.md"),
      "---\ndescription: This is a deliberately long agent description that should be truncated in brief search output so the default response stays compact and easy to scan for both humans and agents.\n---\nYou are an architect.\n",
    );

    const output = await runCli(stashDir, ["search", "architect", "--format=json"]);
    const json = JSON.parse(output) as { hits: Array<Record<string, unknown>> };

    // hits is always present; warnings may appear when semantic search is pending
    expect(Object.keys(json)).toContain("hits");
    // REC-03: ref is now included at brief detail so agents can run `akm show <ref>`
    expect(Object.keys(json.hits[0] ?? {}).sort()).toEqual(["action", "estimatedTokens", "name", "ref", "type"]);
  });

  test("search normal detail includes description capped at 250 characters", async () => {
    const stashDir = makeTempDir("akm-output-stash-");
    const description =
      "This is a deliberately long agent description that should be truncated at the normal detail level. It contains enough words to exceed two hundred and fifty characters so we can verify the cap is applied correctly by the CLI output shaping logic and does not let full descriptions through.";
    writeFile(
      path.join(stashDir, "agents", "architect.md"),
      `---\ndescription: ${description}\n---\nYou are an architect.\n`,
    );

    const output = await runCli(stashDir, ["search", "architect", "--format=json", "--detail=normal"]);
    const json = JSON.parse(output) as { hits: Array<Record<string, unknown>> };

    expect(json.hits[0]?.score).toBeDefined();
    expect(typeof json.hits[0]?.description).toBe("string");
    expect(String(json.hits[0]?.description).length).toBeLessThanOrEqual(253); // 250 + "..."
    expect(Object.keys(json.hits[0] ?? {})).not.toContain("ref");
  });

  test("search text output includes score for local hits at normal detail", async () => {
    const stashDir = makeTempDir("akm-output-stash-");
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    const output = await runCli(stashDir, ["search", "deploy", "--format=text", "--detail=normal"]);

    expect(output).toContain("score:");
    expect(output).toContain("action: akm show");
  });

  test("show default JSON shape stays stable", async () => {
    const stashDir = makeTempDir("akm-output-stash-");
    writeFile(
      path.join(stashDir, "commands", "release.md"),
      "---\ndescription: Release\n---\nRun release {{version}}\n",
    );

    const output = await runCli(stashDir, ["show", "command:release.md", "--format=json"]);
    const json = JSON.parse(output) as Record<string, unknown>;

    // QA #7: path and editable are now always projected in JSON shape
    expect(Object.keys(json).sort()).toEqual([
      "action",
      "description",
      "editable",
      "name",
      "origin",
      "parameters",
      "path",
      "related",
      "template",
      "type",
    ]);
    expect(json.origin).toBeNull();
  });

  test("show text output includes null origin for local assets", async () => {
    const stashDir = makeTempDir("akm-output-stash-");
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    const output = await runCli(stashDir, ["show", "script:deploy.sh", "--format=text"]);

    expect(output).toContain("# origin: null");
    expect(output).toContain("run:");
  });

  test("show shaped output includes action across all asset types", async () => {
    const stashDir = makeTempDir("akm-output-stash-");
    const envDirs = {
      xdgCache: makeTempDir("akm-output-cache-shared-"),
      xdgConfig: makeTempDir("akm-output-config-shared-"),
    };
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");
    writeFile(path.join(stashDir, "skills", "ops", "SKILL.md"), "# Ops\nFollow this.\n");
    writeFile(
      path.join(stashDir, "commands", "release.md"),
      "---\ndescription: Release\n---\nRun release {{version}}\n",
    );
    writeFile(path.join(stashDir, "agents", "coach.md"), "---\ndescription: Coach\n---\nYou are a coach.\n");
    writeFile(path.join(stashDir, "knowledge", "guide.md"), "# Guide\nUse this.\n");

    const refs = ["script:deploy.sh", "skill:ops", "command:release.md", "agent:coach.md", "knowledge:guide.md"];
    for (const ref of refs) {
      const output = await runCli(stashDir, ["show", ref, "--format=json"], undefined, envDirs);
      const json = JSON.parse(output) as Record<string, unknown>;
      expect(json.origin).toBeNull();
      expect(typeof json.action).toBe("string");
      expect(String(json.action).length).toBeGreaterThan(0);
    }
  }, 30_000);

  test("show full JSON shape keeps schemaVersion gated to full detail", async () => {
    const stashDir = makeTempDir("akm-output-stash-");
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    const output = await runCli(stashDir, ["show", "script:deploy.sh", "--format=json", "--detail=full"]);
    const json = JSON.parse(output) as Record<string, unknown>;

    expect(json.schemaVersion).toBe(1);
    expect(Object.keys(json)).toContain("path");
    expect(Object.keys(json)).toContain("editable");
  });

  // ── WS2: --shape summary on show projects the compact metadata set ──────────
  test("show --shape summary returns compact metadata (no content/template body)", async () => {
    const stashDir = makeTempDir("akm-output-stash-");
    writeFile(
      path.join(stashDir, "commands", "release.md"),
      "---\ndescription: Release\n---\nRun release {{version}}\n",
    );

    const output = await runCli(stashDir, ["show", "command:release.md", "--format=json", "--shape=summary"]);
    const json = JSON.parse(output) as Record<string, unknown>;
    expect(json.type).toBe("command");
    expect(json.name).toBe("release.md");
    // summary omits the heavyweight template/content body.
    expect(json).not.toHaveProperty("template");
    expect(json).not.toHaveProperty("content");
  });
});
