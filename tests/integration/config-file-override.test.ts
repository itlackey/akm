import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  };
  const bundle = path.join(dir, "bundle");
  fs.mkdirSync(bundle, { recursive: true });
  const selected = path.join(dir, "custom", "chosen.json");
  fs.mkdirSync(path.dirname(selected), { recursive: true });
  fs.writeFileSync(
    selected,
    JSON.stringify({ output: { format: "json" }, defaultBundle: "main", bundles: { main: { path: bundle } } }),
  );
  return { dir, env, selected, bundle };
}
function cli(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  return spawnSync("bun", [cliPath, ...args], { env, cwd, encoding: "utf8" });
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
    expect(result.stderr).toContain("--config needs the path of a config file");
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

  test("passthrough after -- does not select a config file", () => {
    const { dir, env } = fixture();
    const pass = cli(["config", "path", "--", "--config", "other.json"], env, dir);
    expect(pass.status).toBe(0);
    expect(pass.stdout.trim()).toBe(path.join(env.AKM_CONFIG_DIR, "config.json"));
  });

  test("nested AKM in another cwd inherits the absolute selected file", () => {
    const { dir, env, selected, bundle } = fixture();
    fs.mkdirSync(path.join(bundle, "env"), { recursive: true });
    fs.writeFileSync(path.join(bundle, "env", "empty.env"), "");
    const script = `process.chdir(${JSON.stringify(bundle)}); const child = Bun.spawnSync(["bun", ${JSON.stringify(cliPath)}, "config", "path"], {stdout:"pipe", stderr:"pipe"}); process.stdout.write(child.stdout); process.exit(child.exitCode);`;
    const result = cli(
      ["--config", "custom/chosen.json", "env", "run", "env/empty", "--", "bun", "-e", script],
      env,
      dir,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(selected);
  });
});
