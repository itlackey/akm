// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HEALTH_CHECKS, runModelMapProbe, runSelectedModelAliasesProbe } from "../src/commands/health/checks";
import type { AkmConfig } from "../src/core/config/config";
import { ConfigError } from "../src/core/errors";
import { runCliCapture } from "./_helpers/cli";
import { withEnv, withIsolatedAkmStorage } from "./_helpers/sandbox";

describe("models.json health diagnostics", () => {
  test("treats an absent optional user file as healthy", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-model-health-absent-"));
    try {
      expect(runModelMapProbe({ env: { XDG_CONFIG_HOME: root } })).toMatchObject({
        name: "model-map-files",
        status: "pass",
        evidence: { userStatus: "absent", userPath: path.join(root, "akm", "models.json") },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports invalid or unreadable user files as actionable warnings", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-model-health-user-"));
    const env = { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv;
    const target = path.join(root, "akm", "models.json");
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '{"version":1,"aliases":{"reasoning":{"claude":{"inference":false}}}}');
      const invalid = runModelMapProbe({ env });
      expect(invalid.status).toBe("warn");
      expect(invalid.message).toContain(target);
      expect(invalid.message).toContain("$.aliases.reasoning.claude.inference");
      expect(invalid.message).toMatch(/remove.*installed defaults/i);

      fs.rmSync(target);
      fs.mkdirSync(target);
      const unreadable = runModelMapProbe({ env });
      expect(unreadable.status).toBe("warn");
      expect(unreadable.message).toMatch(/readable regular file/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports an invalid installed map as an installation failure", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-model-health-installed-"));
    try {
      const result = runModelMapProbe({ env: { XDG_CONFIG_HOME: root }, installedText: "not-json" });
      expect(result.status).toBe("fail");
      expect(result.message).toMatch(/installed models\.json.*installation/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("Bun CLI health never echoes invalid user JSON or version values", async () => {
    const storage = withIsolatedAkmStorage();
    const userMap = path.join(storage.configDir, "akm", "models.json");
    fs.mkdirSync(path.dirname(userMap), { recursive: true });
    try {
      for (const [text, sentinel] of [
        ["BUNJSONPARSESECRETSENTINEL802", "BUNJSONPARSESECRETSENTINEL802"],
        [JSON.stringify({ version: "BUNVERSIONSECRETSENTINEL802", aliases: {} }), "BUNVERSIONSECRETSENTINEL802"],
      ] as const) {
        fs.writeFileSync(userMap, text, { mode: 0o600 });
        const result = await withEnv(
          {
            AKM_BUNDLE_DIR: storage.stashDir,
            XDG_CONFIG_HOME: storage.configDir,
            XDG_DATA_HOME: storage.dataDir,
            XDG_CACHE_HOME: storage.cacheDir,
            XDG_STATE_HOME: storage.stateDir,
          },
          () => runCliCapture(["health"]),
        );
        expect(result.stdout + result.stderr).not.toContain(sentinel);
        const output = JSON.parse(result.stdout) as {
          hardChecks?: Array<{ name?: string; status?: string }>;
        };
        expect(output.hardChecks?.find((check) => check.name === "model-map-files")).toMatchObject({
          status: "warn",
        });
      }
    } finally {
      storage.cleanup();
    }
  });

  test("is registered as an ordered hard health check", () => {
    expect(HEALTH_CHECKS.find((check) => check.name === "model-map-files")?.channel).toBe("hard");
  });

  test("catches a broken engine reference against real config.engines (#946)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-model-health-engine-"));
    const env = { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv;
    const target = path.join(root, "akm", "models.json");
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify({ version: 1, aliases: { fast: { opencode: { engine: "typo" } } } }));
      const config: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "off", engines: {} };
      const result = runModelMapProbe({ env, loadConfig: () => config });
      expect(result.status).toBe("warn");
      expect(result.message).toMatch(/unknown engine "typo"/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a broken config.json reports as itself, not a models.json warning (#946)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-model-health-config-broken-"));
    const env = { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv;
    const target = path.join(root, "akm", "models.json");
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify({ version: 1, aliases: { fast: { opencode: "literal-model" } } }));
      const configErrorMessage = "config.json is not valid JSON";
      const result = runModelMapProbe({
        env,
        loadConfig: () => {
          throw new ConfigError(configErrorMessage);
        },
      });
      // The model-map file itself is fine (shape-only validation, no engine
      // resolution, matching pre-#946 behavior) — this check must still pass
      // and must not carry the config error's own text.
      expect(result.status).toBe("pass");
      expect(result.message).not.toContain(configErrorMessage);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("validates an engine-backed models.json as healthy when the engine is real", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-model-health-engine-ok-"));
    const env = { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv;
    const target = path.join(root, "akm", "models.json");
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(
        target,
        JSON.stringify({ version: 1, aliases: { fast: { opencode: { engine: "local-fast" } } } }),
      );
      const config: AkmConfig = {
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        engines: { "local-fast": { kind: "agent", platform: "opencode", model: "krang/qwen3.5-9b" } },
      };
      expect(runModelMapProbe({ env, loadConfig: () => config }).status).toBe("pass");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("selected model alias health diagnostics", () => {
  const installedText = JSON.stringify({
    version: 1,
    aliases: {
      balanced: {
        claude: "claude/exact",
      },
    },
  });

  test("warns when a selected known alias has no mapping for its engine", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        gemini: { kind: "agent", platform: "gemini", model: "balanced" },
        claude: { kind: "agent", platform: "claude", model: "balanced" },
      },
    };

    expect(runSelectedModelAliasesProbe({ loadConfig: () => config, installedText })).toEqual({
      name: "selected-model-aliases",
      kind: "deterministic",
      status: "warn",
      confidence: "high",
      message: "1 of 2 configured model selections has no mapping for its selected engine.",
      evidence: {
        checked: [
          { engine: "claude", alias: "balanced", modelMapKey: "claude" },
          { engine: "gemini", alias: "balanced", modelMapKey: "gemini" },
        ],
        missing: [{ engine: "gemini", alias: "balanced", modelMapKey: "gemini" }],
      },
    });
  });

  test("treats an unknown model identifier as an exact pass-through", () => {
    const sentinel = "vendor/private-model-v2-SENTINEL";
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        gemini: { kind: "agent", platform: "gemini", model: sentinel },
      },
    };

    const result = runSelectedModelAliasesProbe({ loadConfig: () => config, installedText });
    expect(result).toMatchObject({
      status: "pass",
      evidence: {
        checked: [],
        missing: [],
      },
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  test("reports an invalid map generically without echoing parser detail", () => {
    const sentinel = "PRIVATE_MODEL_MAP_SENTINEL";
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { claude: { kind: "agent", platform: "claude", model: "balanced" } },
    };

    const result = runSelectedModelAliasesProbe({
      loadConfig: () => config,
      installedText: JSON.stringify({ version: sentinel, aliases: {} }),
    });
    expect(result).toEqual({
      name: "selected-model-aliases",
      kind: "deterministic",
      status: "unknown",
      confidence: "high",
      message: "Configured model selections could not be checked because the model map is invalid.",
      evidence: { checked: [], missing: [] },
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(JSON.stringify(result)).not.toContain("$.version");
  });

  test("resolves a selected alias through an engine-backed models.json column (#946)", () => {
    const engineBackedInstalledText = JSON.stringify({
      version: 1,
      aliases: { balanced: { opencode: { engine: "local-fast" } } },
    });
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        "local-fast": { kind: "agent", platform: "opencode", model: "krang/qwen3.5-9b" },
        opencode: { kind: "agent", platform: "opencode", model: "balanced" },
      },
    };
    expect(
      runSelectedModelAliasesProbe({ loadConfig: () => config, installedText: engineBackedInstalledText }),
    ).toMatchObject({ status: "pass", evidence: { missing: [] } });
  });

  test("is ordered between model-map-files and default-llm-engine", () => {
    const names = HEALTH_CHECKS.map((check) => check.name);
    expect(names.indexOf("selected-model-aliases")).toBe(names.indexOf("model-map-files") + 1);
    expect(names.indexOf("default-llm-engine")).toBe(names.indexOf("selected-model-aliases") + 1);
    expect(HEALTH_CHECKS.find((check) => check.name === "selected-model-aliases")?.channel).toBe("hard");
  });
});
