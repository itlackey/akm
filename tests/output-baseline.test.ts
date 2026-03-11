import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
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
  const xdgCache = makeTempDir("akm-output-cache-");
  const xdgConfig = makeTempDir("akm-output-config-");
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
    writeFile(path.join(stashDir, "tools", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    const output = runCli(stashDir, ["search", "deploy", "--format=json"]);
    const json = JSON.parse(output) as { hits: Array<Record<string, unknown>> };

    expect(Object.keys(json)).toEqual(["hits"]);
    expect(Object.keys(json.hits[0] ?? {}).sort()).toEqual(["action", "name", "ref", "size", "type"]);
  });

  test("search text output includes null origin for local hits", () => {
    const stashDir = makeTempDir("akm-output-stash-");
    writeFile(path.join(stashDir, "tools", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    const output = runCli(stashDir, ["search", "deploy", "--format=text", "--detail=normal"]);

    expect(output).toContain("origin: null");
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

    expect(Object.keys(json).sort()).toEqual([
      "action",
      "description",
      "name",
      "origin",
      "parameters",
      "template",
      "type",
    ]);
    expect(json.origin).toBeNull();
  });

  test("show text output includes null origin for local assets", () => {
    const stashDir = makeTempDir("akm-output-stash-");
    writeFile(path.join(stashDir, "tools", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    const output = runCli(stashDir, ["show", "tool:deploy.sh", "--format=text"]);

    expect(output).toContain("# origin: null");
    expect(output).toContain("run:");
  });

  test("show shaped output includes action across all asset types", () => {
    const stashDir = makeTempDir("akm-output-stash-");
    writeFile(path.join(stashDir, "tools", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");
    writeFile(path.join(stashDir, "skills", "ops", "SKILL.md"), "# Ops\nFollow this.\n");
    writeFile(
      path.join(stashDir, "commands", "release.md"),
      "---\ndescription: Release\n---\nRun release {{version}}\n",
    );
    writeFile(path.join(stashDir, "agents", "coach.md"), "---\ndescription: Coach\n---\nYou are a coach.\n");
    writeFile(path.join(stashDir, "knowledge", "guide.md"), "# Guide\nUse this.\n");

    const refs = ["tool:deploy.sh", "skill:ops", "command:release.md", "agent:coach.md", "knowledge:guide.md"];
    for (const ref of refs) {
      const output = runCli(stashDir, ["show", ref, "--format=json"]);
      const json = JSON.parse(output) as Record<string, unknown>;
      expect(json.origin).toBeNull();
      expect(typeof json.action).toBe("string");
      expect(String(json.action).length).toBeGreaterThan(0);
    }
  });

  test("show full JSON shape keeps schemaVersion gated to full detail", () => {
    const stashDir = makeTempDir("akm-output-stash-");
    writeFile(path.join(stashDir, "tools", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    const output = runCli(stashDir, ["show", "tool:deploy.sh", "--format=json", "--detail=full"]);
    const json = JSON.parse(output) as Record<string, unknown>;

    expect(json.schemaVersion).toBe(1);
    expect(Object.keys(json)).toContain("path");
    expect(Object.keys(json)).toContain("editable");
  });

  test("config defaults drive output mode and CLI flags override them", () => {
    const stashDir = makeTempDir("akm-output-stash-");
    writeFile(path.join(stashDir, "tools", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    const config = { output: { format: "text", detail: "normal" } };
    const configDriven = runCli(stashDir, ["search", "deploy"], config);
    expect(configDriven).toContain("origin: null");

    const overridden = runCli(stashDir, ["search", "deploy", "--format=json", "--detail=brief"], config);
    const json = JSON.parse(overridden) as { hits: Array<Record<string, unknown>> };
    expect(Object.keys(json)).toEqual(["hits"]);
    expect(Object.keys(json.hits[0] ?? {})).not.toContain("origin");
  });

  test("search shaped output includes action for local and registry hits", async () => {
    const stashDir = makeTempDir("akm-output-stash-");
    const registryDir = makeTempDir("akm-output-registry-");
    writeFile(path.join(stashDir, "tools", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");
    writeFile(
      path.join(registryDir, "index.json"),
      JSON.stringify({
        version: 1,
        updatedAt: "2026-03-11T00:00:00Z",
        kits: [
          {
            id: "npm:@scope/deploy-kit",
            name: "deploy-kit",
            description: "Registry deploy kit",
            ref: "@scope/deploy-kit",
            source: "npm",
            tags: ["deploy"],
          },
        ],
      }),
    );
    const port = 19000 + Math.floor(Math.random() * 1000);
    const server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], {
      cwd: registryDir,
      stdio: "ignore",
    });
    await new Promise((resolve) => setTimeout(resolve, 250));

    try {
      const output = runCli(stashDir, ["search", "deploy", "--format=json", "--detail=brief", "--source=both"], {
        registryUrls: [`http://127.0.0.1:${port}/index.json`],
      });
      const json = JSON.parse(output) as { hits: Array<Record<string, unknown>> };
      const localHit = json.hits.find((hit) => hit.type === "script");
      const registryHit = json.hits.find((hit) => hit.type === "registry");

      expect(localHit?.action).toBeTruthy();
      expect(registryHit?.action).toBeTruthy();
    } finally {
      server.kill("SIGTERM");
    }
  });
});
