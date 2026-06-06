/**
 * `akm env set` / `akm env unset` — single-key management of `.env` files.
 *
 * Locks in: value never echoed; comments + key order preserved; create-on-set;
 * quoting of values with spaces; multi-key unset with removed/missing report;
 * invalid-key rejection; and that the `--format` value never leaks into the
 * key list (the citty space-separated-flag quirk).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadEnv, setEnvKey, unsetEnvKeys } from "../../src/commands/env";
import { runCliCapture } from "../_helpers/cli";
import { type Cleanup, sandboxStashDir, writeSandboxConfig } from "../_helpers/sandbox";

let stashCleanup: Cleanup = () => {};
let stashDir = "";

async function runCli(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await runCliCapture(args);
  return { status: code, stdout, stderr };
}

function envFile(): string {
  return path.join(stashDir, "env", "prod.env");
}

beforeEach(() => {
  const stash = sandboxStashDir();
  stashDir = stash.dir;
  stashCleanup = stash.cleanup;
  writeSandboxConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  stashCleanup();
  stashCleanup = () => {};
  stashDir = "";
  delete process.env.AKM_TEST_ENV_VALUE;
});

describe("akm env set", () => {
  test("creates the file and the key from --from-env; value is never echoed", async () => {
    process.env.AKM_TEST_ENV_VALUE = "topsecret-value";
    const result = await runCli(["env", "set", "env:prod", "API_TOKEN", "--from-env", "AKM_TEST_ENV_VALUE"]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("topsecret-value");
    expect(result.stderr).not.toContain("topsecret-value");

    const content = fs.readFileSync(envFile(), "utf8");
    expect(content).toContain("API_TOKEN=topsecret-value");
  });

  test("updates an existing key in place, preserving comments and order", async () => {
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(envFile(), "# production config\nAPI_URL=https://old\nDEBUG=false\n");
    process.env.AKM_TEST_ENV_VALUE = "true";

    const result = await runCli(["env", "set", "env:prod", "DEBUG", "--from-env", "AKM_TEST_ENV_VALUE"]);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(envFile(), "utf8")).toBe("# production config\nAPI_URL=https://old\nDEBUG=true\n");
  });

  test("quotes a value containing spaces so it round-trips", async () => {
    process.env.AKM_TEST_ENV_VALUE = "hello world";
    await runCli(["env", "set", "env:prod", "GREETING", "--from-env", "AKM_TEST_ENV_VALUE"]);
    expect(fs.readFileSync(envFile(), "utf8")).toContain('GREETING="hello world"');
  });

  test("rejects an invalid key name", async () => {
    process.env.AKM_TEST_ENV_VALUE = "x";
    const result = await runCli(["env", "set", "env:prod", "bad-key!", "--from-env", "AKM_TEST_ENV_VALUE"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).error).toMatch(/Invalid env key/);
  });
});

describe("setEnvKey — dotenv-verified value round-trip", () => {
  test("every value style is read back exactly by dotenv.parse", () => {
    const f = envFile();
    const cases: Record<string, string> = {
      SIMPLE: "abc123",
      SPACES: "hello world",
      QUOTE_D: 'he said "hi"',
      QUOTE_S: "it's ok",
      NEWLINE: "line1\nline2",
      TAB: "a\tb",
      DOLLAR: "${secret:foo}", // secret-token form must survive verbatim
      URL: "https://x.y/z?a=1&b=2",
    };
    for (const [k, v] of Object.entries(cases)) setEnvKey(f, k, v);
    const got = loadEnv(f);
    for (const [k, v] of Object.entries(cases)) expect(got[k]).toBe(v);
  });

  test("unset preserves the exact values of surviving keys", () => {
    const f = envFile();
    setEnvKey(f, "A", 'quote "x"');
    setEnvKey(f, "B", "keep me");
    unsetEnvKeys(f, ["A"]);
    const got = loadEnv(f);
    expect(got.A).toBeUndefined();
    expect(got.B).toBe("keep me");
  });
});

describe("akm env unset", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(envFile(), "# cfg\nAPI_URL=https://old\nDEBUG=false\nKEEP=yes\n");
  });

  test("removes a key and preserves the rest + comments; reports removed/missing", async () => {
    const result = await runCli(["env", "unset", "env:prod", "DEBUG", "NOPE", "--format", "json"]);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as { removed: string[]; missing: string[] };
    expect(json.removed).toEqual(["DEBUG"]);
    expect(json.missing).toEqual(["NOPE"]); // the --format value "json" must NOT appear here
    expect(fs.readFileSync(envFile(), "utf8")).toBe("# cfg\nAPI_URL=https://old\nKEEP=yes\n");
  });

  test("requires at least one key", async () => {
    const result = await runCli(["env", "unset", "env:prod"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).error).toMatch(/one or more keys/);
  });

  test("errors when the env file does not exist", async () => {
    const result = await runCli(["env", "unset", "env:absent", "KEY"]);
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stderr).error).toMatch(/not found/i);
  });
});
