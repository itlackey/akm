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

interface CliEnvDirs {
  xdgCache: string;
  xdgConfig: string;
  xdgData?: string;
  xdgState?: string;
}

function runCli(stashDir: string, args: string[], config?: Record<string, unknown>, envDirs?: CliEnvDirs): string {
  const xdgCache = envDirs?.xdgCache ?? makeTempDir("akm-output-cache-");
  const xdgConfig = envDirs?.xdgConfig ?? makeTempDir("akm-output-config-");
  const xdgData = envDirs?.xdgData ?? makeTempDir("akm-output-data-");
  const xdgState = envDirs?.xdgState ?? makeTempDir("akm-output-state-");
  if (config) writeConfig(xdgConfig, config);
  const result = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      AKM_STASH_DIR: stashDir,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
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

describe("output baseline", () => {
  test("search default JSON brief shape stays stable", () => {
    const stashDir = makeTempDir("akm-output-stash-");
    writeFile(
      path.join(stashDir, "agents", "architect.md"),
      "---\ndescription: This is a deliberately long agent description that should be truncated in brief search output so the default response stays compact and easy to scan for both humans and agents.\n---\nYou are an architect.\n",
    );

    const output = runCli(stashDir, ["search", "architect", "--format=json"]);
    const json = JSON.parse(output) as { hits: Array<Record<string, unknown>> };

    // hits is always present; warnings may appear when semantic search is pending
    expect(Object.keys(json)).toContain("hits");
    // REC-03: ref is now included at brief detail so agents can run `akm show <ref>`
    expect(Object.keys(json.hits[0] ?? {}).sort()).toEqual(["action", "estimatedTokens", "name", "ref", "type"]);
  });

  test("search normal detail includes description capped at 250 characters", () => {
    const stashDir = makeTempDir("akm-output-stash-");
    const description =
      "This is a deliberately long agent description that should be truncated at the normal detail level. It contains enough words to exceed two hundred and fifty characters so we can verify the cap is applied correctly by the CLI output shaping logic and does not let full descriptions through.";
    writeFile(
      path.join(stashDir, "agents", "architect.md"),
      `---\ndescription: ${description}\n---\nYou are an architect.\n`,
    );

    const output = runCli(stashDir, ["search", "architect", "--format=json", "--detail=normal"]);
    const json = JSON.parse(output) as { hits: Array<Record<string, unknown>> };

    expect(json.hits[0]?.score).toBeDefined();
    expect(typeof json.hits[0]?.description).toBe("string");
    expect(String(json.hits[0]?.description).length).toBeLessThanOrEqual(253); // 250 + "..."
    expect(Object.keys(json.hits[0] ?? {})).not.toContain("ref");
  });

  test("search text output includes score for local hits at normal detail", () => {
    const stashDir = makeTempDir("akm-output-stash-");
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    const output = runCli(stashDir, ["search", "deploy", "--format=text", "--detail=normal"]);

    expect(output).toContain("score:");
    expect(output).toContain("action: akm show");
  });

  test("show default JSON shape stays stable", () => {
    const stashDir = makeTempDir("akm-output-stash-");
    writeFile(
      path.join(stashDir, "commands", "release.md"),
      "---\ndescription: Release\n---\nRun release {{version}}\n",
    );

    const output = runCli(stashDir, ["show", "command:release.md", "--format=json"]);
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

  test("show text output includes null origin for local assets", () => {
    const stashDir = makeTempDir("akm-output-stash-");
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    const output = runCli(stashDir, ["show", "script:deploy.sh", "--format=text"]);

    expect(output).toContain("# origin: null");
    expect(output).toContain("run:");
  });

  test("show shaped output includes action across all asset types", () => {
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
      const output = runCli(stashDir, ["show", ref, "--format=json"], undefined, envDirs);
      const json = JSON.parse(output) as Record<string, unknown>;
      expect(json.origin).toBeNull();
      expect(typeof json.action).toBe("string");
      expect(String(json.action).length).toBeGreaterThan(0);
    }
  }, 15_000);

  test("show full JSON shape keeps schemaVersion gated to full detail", () => {
    const stashDir = makeTempDir("akm-output-stash-");
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    const output = runCli(stashDir, ["show", "script:deploy.sh", "--format=json", "--detail=full"]);
    const json = JSON.parse(output) as Record<string, unknown>;

    expect(json.schemaVersion).toBe(1);
    expect(Object.keys(json)).toContain("path");
    expect(Object.keys(json)).toContain("editable");
  });
});
