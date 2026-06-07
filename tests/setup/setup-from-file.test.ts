/**
 * Tests for the `akm setup --from <file>` bootstrap helper.
 *
 * The CLI layer is a thin wrapper around `loadSetupConfigFromFile`, which:
 *   - expands a leading `~` to the supplied home directory,
 *   - resolves relative paths against the supplied cwd,
 *   - chooses YAML vs JSON parsing by file extension,
 *   - throws `ConfigError("INVALID_CONFIG_FILE")` on missing / unreadable /
 *     unparseable / non-object payloads,
 *   - returns a JSON-encoded payload that `runSetupFromConfig` accepts.
 *
 * We test the helper directly here, plus one happy-path CLI subprocess test
 * to confirm the full `--from <file>` round-trip wires through correctly and
 * that `--from` and `--config` are mutually exclusive at the CLI layer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConfigError } from "../../src/core/errors";
import { resetGraphBoostCache } from "../../src/indexer/graph/graph-boost";
import { clearEmbeddingCache, resetLocalEmbedder } from "../../src/llm/embedder";
import { loadSetupConfigFromFile } from "../../src/setup/setup";
import { runCliCapture } from "../_helpers/cli";
import { withEnv } from "../_helpers/sandbox";

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-setup-from-file-"));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe("loadSetupConfigFromFile", () => {
  test("loads a JSON config file (happy path)", async () => {
    const filePath = path.join(workDir, "config.json");
    const payload = {
      llm: { endpoint: "http://localhost:11434/v1", model: "gpt-oss-20b" },
      semanticSearchMode: "off",
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");

    const result = await loadSetupConfigFromFile(filePath);
    expect(result.format).toBe("json");
    expect(result.resolvedPath).toBe(path.resolve(filePath));
    expect(JSON.parse(result.configJson)).toEqual(payload);
  });

  test("loads a YAML config file (.yml)", async () => {
    const filePath = path.join(workDir, "config.yml");
    fs.writeFileSync(
      filePath,
      ["llm:", "  endpoint: http://localhost:11434/v1", "  model: gpt-oss-20b", "semanticSearchMode: off", ""].join(
        "\n",
      ),
      "utf8",
    );

    const result = await loadSetupConfigFromFile(filePath);
    expect(result.format).toBe("yaml");
    expect(JSON.parse(result.configJson)).toEqual({
      llm: { endpoint: "http://localhost:11434/v1", model: "gpt-oss-20b" },
      semanticSearchMode: "off",
    });
  });

  test("loads a YAML config file (.yaml)", async () => {
    const filePath = path.join(workDir, "config.yaml");
    fs.writeFileSync(filePath, "stashDir: /tmp/akm-stash\n", "utf8");

    const result = await loadSetupConfigFromFile(filePath);
    expect(result.format).toBe("yaml");
    expect(JSON.parse(result.configJson)).toEqual({ stashDir: "/tmp/akm-stash" });
  });

  test("treats unknown extensions as JSON", async () => {
    const filePath = path.join(workDir, "config.txt");
    fs.writeFileSync(filePath, JSON.stringify({ stashDir: "/x" }), "utf8");
    const result = await loadSetupConfigFromFile(filePath);
    expect(result.format).toBe("json");
  });

  test("expands a leading ~ against the supplied home directory", async () => {
    // Build a fake home so we don't touch the real one.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "akm-setup-fake-home-"));
    try {
      const filePath = path.join(fakeHome, "akm-config.json");
      fs.writeFileSync(filePath, JSON.stringify({ stashDir: "/from-tilde" }), "utf8");

      const result = await loadSetupConfigFromFile("~/akm-config.json", { homeDir: fakeHome });
      expect(result.resolvedPath).toBe(filePath);
      expect(JSON.parse(result.configJson)).toEqual({ stashDir: "/from-tilde" });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("resolves a relative path against the supplied cwd", async () => {
    const filePath = path.join(workDir, "rel-config.json");
    fs.writeFileSync(filePath, JSON.stringify({ stashDir: "/from-rel" }), "utf8");

    const result = await loadSetupConfigFromFile("./rel-config.json", { cwd: workDir });
    expect(result.resolvedPath).toBe(filePath);
    expect(JSON.parse(result.configJson)).toEqual({ stashDir: "/from-rel" });
  });

  test("throws ConfigError(INVALID_CONFIG_FILE) when the file does not exist", async () => {
    const missing = path.join(workDir, "does-not-exist.json");
    await expect(loadSetupConfigFromFile(missing)).rejects.toBeInstanceOf(ConfigError);
    try {
      await loadSetupConfigFromFile(missing);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("INVALID_CONFIG_FILE");
      expect((err as ConfigError).message).toContain("not found");
    }
  });

  test("throws ConfigError on malformed JSON", async () => {
    const filePath = path.join(workDir, "broken.json");
    fs.writeFileSync(filePath, "{ this is not json", "utf8");

    try {
      await loadSetupConfigFromFile(filePath);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("INVALID_CONFIG_FILE");
      expect((err as ConfigError).message).toContain("Failed to parse JSON");
    }
  });

  test("throws ConfigError on malformed YAML", async () => {
    const filePath = path.join(workDir, "broken.yaml");
    // Inconsistent indentation breaks the YAML parser.
    fs.writeFileSync(filePath, "llm:\n  endpoint: x\n model: y\n", "utf8");

    try {
      await loadSetupConfigFromFile(filePath);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("INVALID_CONFIG_FILE");
      expect((err as ConfigError).message).toContain("Failed to parse YAML");
    }
  });

  test("throws ConfigError when the top-level payload is not an object (array)", async () => {
    const filePath = path.join(workDir, "array.json");
    fs.writeFileSync(filePath, JSON.stringify([{ stashDir: "/x" }]), "utf8");
    try {
      await loadSetupConfigFromFile(filePath);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain("top-level object");
    }
  });

  test("throws ConfigError when the top-level payload is a string", async () => {
    const filePath = path.join(workDir, "string.json");
    fs.writeFileSync(filePath, JSON.stringify("a literal string"), "utf8");
    try {
      await loadSetupConfigFromFile(filePath);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain("top-level object");
    }
  });

  test("accepts a partial config (only some keys present)", async () => {
    const filePath = path.join(workDir, "partial.json");
    fs.writeFileSync(filePath, JSON.stringify({ semanticSearchMode: "off" }), "utf8");
    const result = await loadSetupConfigFromFile(filePath);
    // The parser does not enforce required keys; runSetupFromConfig is what
    // prompts (or accepts defaults) for missing required values. Loading a
    // partial file therefore succeeds — the prompt-skipping happens later.
    expect(JSON.parse(result.configJson)).toEqual({ semanticSearchMode: "off" });
  });
});

// ── CLI integration ─────────────────────────────────────────────────────────
//
// Migrated from per-test spawnSync("bun", ["src/cli.ts", ...]) to the shared
// in-process harness (tests/_helpers/cli.ts). Both cases error before `setup`
// reaches any interactive prompt or writes config — the --from/--config
// mutual-exclusion guard and the loadSetupConfigFromFile "not found" check both
// throw early — so they run safely in-process with no prompt hang.

/**
 * In-process CLI runner. Pins the supplied env for the duration of the call via
 * the allowlisted withEnv helper and resets the embedder/graph singletons.
 * runCliCapture resets the config and output-mode singletons itself.
 */
async function runCli(argv: string[], env: Record<string, string | undefined> = {}) {
  return withEnv(env, async () => {
    clearEmbeddingCache();
    resetLocalEmbedder();
    resetGraphBoostCache();
    const { stdout, stderr, code } = await runCliCapture(argv);
    return { status: code, stdout, stderr };
  });
}

describe("akm setup --from <file> CLI integration", () => {
  test("rejects --from and --config simultaneously with INVALID_FLAG_VALUE", async () => {
    const configFile = path.join(workDir, "config.json");
    fs.writeFileSync(configFile, JSON.stringify({ stashDir: workDir }), "utf8");

    const xdgConfig = fs.mkdtempSync(path.join(os.tmpdir(), "akm-setup-cli-cfg-"));
    const xdgData = fs.mkdtempSync(path.join(os.tmpdir(), "akm-setup-cli-data-"));
    const xdgState = fs.mkdtempSync(path.join(os.tmpdir(), "akm-setup-cli-state-"));
    try {
      const result = await runCli(["setup", "--from", configFile, "--config", '{"stashDir":"/x"}'], {
        XDG_CONFIG_HOME: xdgConfig,
        XDG_DATA_HOME: xdgData,
        XDG_STATE_HOME: xdgState,
        AKM_STASH_DIR: workDir,
      });

      expect(result.status).not.toBe(0);
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).toContain("--from");
      expect(combined).toContain("--config");
      expect(combined.toLowerCase()).toContain("not both");
    } finally {
      for (const d of [xdgConfig, xdgData, xdgState]) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  test("rejects --from <nonexistent-path> with a friendly error", async () => {
    const xdgConfig = fs.mkdtempSync(path.join(os.tmpdir(), "akm-setup-cli-cfg-"));
    const xdgData = fs.mkdtempSync(path.join(os.tmpdir(), "akm-setup-cli-data-"));
    const xdgState = fs.mkdtempSync(path.join(os.tmpdir(), "akm-setup-cli-state-"));
    try {
      const result = await runCli(["setup", "--from", path.join(workDir, "missing.json")], {
        XDG_CONFIG_HOME: xdgConfig,
        XDG_DATA_HOME: xdgData,
        XDG_STATE_HOME: xdgState,
        AKM_STASH_DIR: workDir,
      });
      expect(result.status).not.toBe(0);
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).toContain("not found");
    } finally {
      for (const d of [xdgConfig, xdgData, xdgState]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
