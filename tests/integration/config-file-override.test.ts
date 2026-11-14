import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withoutBundleDirNotice } from "../_helpers/bundle-dir-notice";

const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");
const dirs: string[] = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-config-file-"));
  dirs.push(dir);
  const env = {
    ...process.env,
    AKM_CONFIG_FILE: undefined,
    AKM_CONFIG_DIR: path.join(dir, "old-config"),
    AKM_DATA_DIR: path.join(dir, "data"),
    AKM_STATE_DIR: path.join(dir, "state"),
    AKM_CACHE_DIR: path.join(dir, "cache"),
    AKM_BUNDLE_DIR: path.join(dir, "bundle"),
  };
  const selected = path.join(dir, "custom", "chosen.json");
  fs.mkdirSync(path.dirname(selected), { recursive: true });
  fs.writeFileSync(selected, JSON.stringify({ output: { format: "json" } }));
  return { dir, env, selected };
}
function cli(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const result = spawnSync("bun", [cliPath, ...args], { env, cwd, encoding: "utf8" });
  return { ...result, stderr: withoutBundleDirNotice(result.stderr) };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("real CLI config file bootstrap", () => {
  test.each(
    [
      ["--config", "custom/chosen.json", "config", "path"],
      ["config", "--config=custom/chosen.json", "path"],
      ["config", "--config", "custom/chosen.json", "path"],
      ["config", "path", "--config", "custom/chosen.json"],
    ].map((args) => ({ args })),
  )("selects a relative file at every command level: %j", ({ args }) => {
    const { dir, env, selected } = fixture();
    const result = cli(args, env, dir);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(selected);
  });

  test("flag beats environment, selects before loading, and writes only selected file", () => {
    const { dir, env, selected } = fixture();
    fs.mkdirSync(env.AKM_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.AKM_CONFIG_DIR, "config.json"), "invalid old config");
    const result = cli(
      ["config", "set", "output.detail", "full", "--config", selected],
      {
        ...env,
        AKM_CONFIG_FILE: path.join(dir, "bad.json"),
      },
      dir,
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(selected, "utf8")).output.detail).toBe("full");
    expect(fs.readFileSync(path.join(env.AKM_CONFIG_DIR, "config.json"), "utf8")).toBe("invalid old config");
  });

  test("environment selects the file, and absence retains old directory override", () => {
    const { dir, env, selected } = fixture();
    expect(cli(["config", "path"], { ...env, AKM_CONFIG_FILE: "custom/chosen.json" }, dir).stdout.trim()).toBe(
      selected,
    );
    expect(cli(["config", "path"], env, dir).stdout.trim()).toBe(path.join(env.AKM_CONFIG_DIR, "config.json"));
  });

  test("setup preflight uses the selected file before the non-interactive guard", () => {
    const { dir, env, selected } = fixture();
    fs.mkdirSync(env.AKM_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.AKM_CONFIG_DIR, "config.json"), "invalid old config");
    const result = cli(["setup", "--config", selected], env, dir);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr.trim()).code).toBe("NON_INTERACTIVE_REQUIRES_YES");
    expect(fs.readFileSync(path.join(env.AKM_CONFIG_DIR, "config.json"), "utf8")).toBe("invalid old config");
  });

  test("a new file is usable for config writes", () => {
    const { dir, env } = fixture();
    const selected = path.join(dir, "new", "fresh.json");
    const result = cli(["--config", selected, "config", "set", "output.detail", "full"], env, dir);
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(selected, "utf8")).output.detail).toBe("full");
  });

  test.each(
    [["--config"], ["--config="], ["--config", "--quiet"]].map((args) => ({ args })),
  )("missing config value fails clearly: %j", ({ args }) => {
    const { dir, env } = fixture();
    const result = cli(["config", "path", ...args], env, dir);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--config requires a non-empty file path");
  });

  test("an empty environment path is warned about once and ignored; a directory instead of a file fails clearly", () => {
    const { dir, env, selected } = fixture();
    const empty = cli(["config", "path"], { ...env, AKM_CONFIG_FILE: " " }, dir);
    expect(empty.status).toBe(0);
    expect(empty.stdout.trim()).toBe(path.join(env.AKM_CONFIG_DIR, "config.json"));
    expect(empty.stderr.match(/AKM_CONFIG_FILE is empty/g)?.length).toBe(1);
    const directory = cli(["--config", path.dirname(selected), "config", "get", "output.detail"], env, dir);
    expect(directory.status).toBe(78);
    expect(directory.stderr).toContain(path.dirname(selected));
  });

  test("literal values and passthrough do not select a config file", () => {
    const { dir, env } = fixture();
    const literal = cli(["task", "add", "example", "--prompt", "--config", "--help"], env, dir);
    expect(literal.status).toBe(0);
    expect(literal.stderr).not.toContain("--config requires");
    const pass = cli(["config", "path", "--", "--config", "other.json"], env, dir);
    expect(pass.status).toBe(0);
    expect(pass.stdout.trim()).toBe(path.join(env.AKM_CONFIG_DIR, "config.json"));
  });

  test.each(["sample.json", true, "--config"])("task config input remains %p with a root selector", (value) => {
    const { dir, env, selected } = fixture();
    fs.mkdirSync(path.join(env.AKM_BUNDLE_DIR, "tasks"), { recursive: true });
    fs.writeFileSync(
      path.join(env.AKM_BUNDLE_DIR, "tasks", "example.yml"),
      [
        "version: 4",
        "name: Example",
        "description: Config input test",
        "inputs:",
        "  config:",
        `    type: ${typeof value === "boolean" ? "boolean" : "string"}`,
        "    required: true",
        "run: echo safe",
        "",
      ].join("\n"),
    );
    const args = ["--config", selected, "task", "explain", "example", "--config"];
    if (value === "--config") args[args.length - 1] = "--config=--config";
    else if (typeof value === "string") args.push(value);
    const result = cli(args, env, dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(typeof value === "string" ? value : "true");
    const runArgs = ["--config", selected, "run", "tasks/example", "--config"];
    if (value === "--config") runArgs[runArgs.length - 1] = "--config=--config";
    else if (typeof value === "string") runArgs.push(value);
    const runResult = cli(runArgs, env, dir);
    expect(runResult.status).toBe(0);
    expect(JSON.parse(runResult.stdout).shape).toBe("task-run");
  });

  test("misplaced selectors on a dynamic path never select the asset's config input", () => {
    const { dir, env, selected } = fixture();
    const invalidInput = path.join(dir, "asset-input.json");
    fs.writeFileSync(invalidInput, "not AKM configuration");
    const result = cli(
      ["--config", selected, "task", "--config", "misplaced.json", "explain", "example", "--config", invalidInput],
      env,
      dir,
    );
    expect(result.status).toBe(2);
    expect(result.stderr).not.toContain("Unable to parse");
    expect(result.stderr).not.toContain("INVALID_CONFIG_FILE");
  });

  test("nested AKM in another cwd inherits the absolute selected file", () => {
    const { dir, env, selected } = fixture();
    fs.mkdirSync(path.join(env.AKM_BUNDLE_DIR, "env"), { recursive: true });
    fs.writeFileSync(path.join(env.AKM_BUNDLE_DIR, "env", "empty.env"), "");
    const script = `process.chdir(${JSON.stringify(env.AKM_BUNDLE_DIR)}); const child = Bun.spawnSync(["bun", ${JSON.stringify(cliPath)}, "config", "path"], {stdout:"pipe", stderr:"pipe"}); process.stdout.write(child.stdout); process.exit(child.exitCode);`;
    const result = cli(
      ["--config", "custom/chosen.json", "env", "run", "env/empty", "--", "bun", "-e", script],
      env,
      dir,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(selected);
  });
});
