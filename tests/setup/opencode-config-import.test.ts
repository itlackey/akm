// OpenCode config import: the user's SELECTED model decides the provider, V1 and
// V2 config shapes both resolve, and credentials never leave as literals.
// Pure filesystem under a temp HOME/XDG dir (no database, network or process).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { openCodeImporter } from "../../src/integrations/harnesses/opencode/config-import";
import { withEnvSync } from "../_helpers/sandbox";

let root: string;
let warnings: string[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-oc-import-"));
  warnings = [];
  _resetWarnOnceForTests();
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  _setWarnSinkForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

function writeGlobal(name: string, body: string): void {
  const dir = path.join(root, ".config", "opencode");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);
}

function importConfig(extraEnv: Record<string, string | undefined> = {}) {
  return withEnvSync(
    {
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, ".config"),
      OPENCODE_CONFIG: undefined,
      OPENCODE_CONFIG_DIR: undefined,
      ...extraEnv,
    },
    () => openCodeImporter.importConfig(),
  );
}

describe("OpenCode config import", () => {
  test("reads a V2 config: model object, providers map, settings, env reference", () => {
    writeGlobal(
      "opencode.jsonc",
      `// V2
{
  "model": { "providerID": "local", "model": "fast" },
  "providers": {
    "other": { "settings": { "baseURL": "http://other.example/v1", "apiKey": "{env:OTHER_KEY}" } },
    "local": {
      "settings": { "baseURL": "http://127.0.0.1:8080/v1", "apiKey": "{env:LOCAL_KEY}" },
      "models": { "fast": { "modelID": "qwen3-8b" } },
    },
  },
}`,
    );
    expect(importConfig()).toEqual({
      harnessName: "OpenCode",
      provider: "local",
      model: "qwen3-8b",
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKeyEnvVar: "LOCAL_KEY",
    });
  });

  test("reads a V1 config: provider/model string, options, models id", () => {
    writeGlobal(
      "opencode.json",
      JSON.stringify({
        model: "gateway/big/model",
        provider: {
          first: { options: { baseURL: "http://first.example/v1", apiKey: "{env:FIRST_KEY}" } },
          gateway: {
            options: { baseURL: "http://gw.example/v1", apiKey: "$GW_KEY" },
            models: { "big/model": { id: "org/big-model" } },
          },
        },
      }),
    );
    expect(importConfig()).toMatchObject({
      provider: "gateway",
      model: "org/big-model",
      baseUrl: "http://gw.example/v1",
      apiKeyEnvVar: "GW_KEY",
    });
  });

  test("an absent selection never falls back to a defined provider", () => {
    writeGlobal(
      "opencode.json",
      JSON.stringify({ providers: { only: { settings: { baseURL: "http://x/v1", apiKey: "{env:K}" } } } }),
    );
    expect(importConfig()).toEqual({ harnessName: "OpenCode" });
  });

  test("a selected provider the config does not define gets no other provider's details", () => {
    writeGlobal(
      "opencode.json",
      JSON.stringify({
        model: "github-copilot/claude-sonnet-4.6",
        providers: { other: { settings: { baseURL: "http://o/v1", apiKey: "{env:O}" } } },
      }),
    );
    expect(importConfig()).toEqual({
      harnessName: "OpenCode",
      provider: "github-copilot",
      model: "claude-sonnet-4.6",
    });
  });

  test("never copies a literal or file-referenced key; warns without printing it", () => {
    writeGlobal(
      "opencode.json",
      JSON.stringify({
        model: "p/m",
        providers: { p: { settings: { baseURL: "http://p/v1", apiKey: "sk-super-secret-literal" } } },
      }),
    );
    const result = importConfig();
    expect(result).toEqual({ harnessName: "OpenCode", provider: "p", model: "m", baseUrl: "http://p/v1" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(warnings.join("\n")).toContain('provider "p"');
    expect(warnings.join("\n")).not.toContain("sk-super-secret-literal");

    writeGlobal(
      "opencode.json",
      JSON.stringify({ model: "p/m", providers: { p: { settings: { apiKey: "{file:~/.keys/p}" } } } }),
    );
    expect(importConfig()?.apiKeyEnvVar).toBeUndefined();
  });

  test("a single V2 env name stands in only when no apiKey is set", () => {
    writeGlobal("opencode.json", JSON.stringify({ model: "p/m", providers: { p: { env: ["P_KEY"] } } }));
    expect(importConfig()?.apiKeyEnvVar).toBe("P_KEY");
    writeGlobal("opencode.json", JSON.stringify({ model: "p/m", providers: { p: { env: ["A", "B"] } } }));
    expect(importConfig()?.apiKeyEnvVar).toBeUndefined();
  });

  test("a later config file overrides the model and merges providers", () => {
    writeGlobal(
      "opencode.json",
      JSON.stringify({
        model: "a/one",
        providers: { a: { settings: { baseURL: "http://a/v1", apiKey: "{env:A_KEY}" } } },
      }),
    );
    const override = path.join(root, "override.json");
    fs.writeFileSync(
      override,
      JSON.stringify({ model: "a/two", provider: { a: { options: { baseURL: "http://a2/v1" } } } }),
    );
    expect(importConfig({ OPENCODE_CONFIG: override })).toMatchObject({
      model: "two",
      baseUrl: "http://a2/v1",
      apiKeyEnvVar: "A_KEY",
    });
  });

  test("an unreadable file is skipped with a warning; none readable gives null", () => {
    writeGlobal("opencode.json", "{ this is not json");
    expect(importConfig()).toBeNull();
    expect(warnings.some((w) => w.includes("could not be read"))).toBe(true);
  });
});
