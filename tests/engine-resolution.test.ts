// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deepMergeConfig } from "../src/core/config/deep-merge";
import { ConfigError } from "../src/core/errors";
import { resolveDispatchModel } from "../src/integrations/agent/builder-shared";
import {
  collectEngineCredentialValues,
  lookupApiKeyFileValue,
  lookupApiKeySecretRefValue,
  materializeLlmConnection,
  resolveEngine,
  resolveLlmCredentialValue,
  resolveLlmEngineUse,
} from "../src/integrations/agent/engine-resolution";
import { buildSdkConfig } from "../src/integrations/harnesses/opencode-sdk/sdk-runner";

const config = {
  configVersion: "0.9.0",
  engines: {
    fast: {
      kind: "llm" as const,
      endpoint: "https://example.test/v1/chat/completions",
      model: "base-model",
      apiKey: `\${FAST_API_KEY}`,
      extraParams: { seed: 1, nested: { keep: true } },
    },
    reviewer: {
      kind: "agent" as const,
      platform: "pi" as const,
      model: "review-model",
    },
    sdk: {
      kind: "agent" as const,
      platform: "opencode-sdk" as const,
      llmEngine: "fast",
    },
  },
  defaults: { engine: "reviewer", llmEngine: "fast" },
};

describe("deepMergeConfig", () => {
  test("recursively merges plain objects while replacing arrays and preserving explicit values", () => {
    const merged = deepMergeConfig(
      { nested: { keep: 1, replace: true }, values: ["old"], nullable: 100 },
      { nested: { replace: false, added: 0 }, values: [], nullable: null },
    );

    expect(merged).toEqual({
      nested: { keep: 1, replace: false, added: 0 },
      values: [],
      nullable: null,
    });
  });

  test("rejects prototype-pollution keys at every depth", () => {
    expect(() => deepMergeConfig({}, JSON.parse('{"nested":{"__proto__":{"polluted":true}}}'))).toThrow(
      "Unsafe configuration key",
    );
  });
});

describe("engine resolution", () => {
  test("projects invocation overrides over one selected LLM engine without resolving its credential", () => {
    const resolved = resolveLlmEngineUse(config, [
      { engine: "fast", llm: { extraParams: { nested: { override: true } }, temperature: 0.1 } },
      { model: "leaf-model", timeoutMs: null },
    ]);

    expect(resolved).toMatchObject({
      engine: "fast",
      timeoutMs: null,
      credential: { names: ["FAST_API_KEY"], required: true },
      connection: {
        endpoint: "https://example.test/v1/chat/completions",
        model: "leaf-model",
        temperature: 0.1,
        extraParams: { seed: 1, nested: { keep: true, override: true } },
      },
    });
    expect(JSON.stringify(resolved)).not.toContain(process.env.FAST_API_KEY ?? "not-set");
  });

  test("projects first-class reasoning effort through engine and invocation resolution", () => {
    const configured = {
      ...config,
      engines: {
        ...config.engines,
        fast: { ...config.engines.fast, reasoningEffort: "high" },
      },
    };
    expect(resolveLlmEngineUse(configured, [{ engine: "fast" }]).connection.reasoningEffort).toBe("high");
    expect(
      resolveLlmEngineUse(configured, [{ engine: "fast", llm: { reasoningEffort: "none" } }]).connection
        .reasoningEffort,
    ).toBe("none");
  });

  test("preserves exact direct and SDK fallback model selectors", () => {
    const exact = {
      ...config,
      engines: {
        ...config.engines,
        fast: { ...config.engines.fast, model: "provider/exact", apiKey: undefined },
      },
    };
    expect(resolveLlmEngineUse(exact, [{ engine: "fast" }]).connection.model).toBe("provider/exact");
    const sdk = resolveEngine("sdk", exact);
    expect(sdk.kind === "sdk" && sdk.fallbackConnection?.model).toBe("provider/exact");
  });

  test("materializes an explicit symbolic credential only at dispatch", () => {
    // ISOLATION-01/02: FAST_API_KEY is not one of the AKM_*/XDG_*/HOME vars
    // tests/_preload.ts owns (HARNESSED + the leak tripwire only cover those
    // prefixes), so an unrestored set here would leak into every later test
    // in the shard. Snapshot + restore explicitly, even on assertion failure.
    const originalFastApiKey = process.env.FAST_API_KEY;
    process.env.FAST_API_KEY = "engine-secret";
    try {
      const resolved = resolveLlmEngineUse(config, [{ engine: "fast" }]);
      expect(materializeLlmConnection(resolved)?.apiKey).toBe("engine-secret");
    } finally {
      if (originalFastApiKey === undefined) delete process.env.FAST_API_KEY;
      else process.env.FAST_API_KEY = originalFastApiKey;
    }
  });

  test("revalidates extraParams at the dispatch boundary", () => {
    expect(() =>
      materializeLlmConnection({
        engine: "bypassed-validation",
        connection: {
          endpoint: "https://example.test/v1/chat/completions",
          model: "test",
          extraParams: { nested: [{ Authorization: "leak" }] },
        },
        timeoutMs: null,
      }),
    ).toThrow("cannot carry credentials");
  });

  test("uses the agent platform, rather than the engine name, to lower an SDK engine", () => {
    const resolved = resolveEngine("sdk", config);
    expect(resolved.kind).toBe("sdk");
    if (resolved.kind === "sdk") {
      expect(resolved.engine).toBe("sdk");
      expect(resolved.profile.platform).toBe("opencode-sdk");
      expect(resolved.fallbackConnection?.endpoint).toBe("https://example.test/v1/chat/completions");
    }
  });

  test("lowers an OpenCode SDK engine without requiring an LLM fallback", () => {
    const resolved = resolveEngine("native-sdk", {
      engines: { "native-sdk": { kind: "agent", platform: "opencode-sdk" } },
      defaults: { engine: "native-sdk" },
    });
    expect(resolved).toMatchObject({ kind: "sdk", engine: "native-sdk" });
    if (resolved.kind !== "sdk") throw new Error("fixture must lower to SDK");
    expect(resolved.fallbackConnection).toBeUndefined();
    expect(resolved.fallbackCredential).toBeUndefined();
  });

  test("applies exact timeout precedence and preserves explicit null in direct HTTP materialization", () => {
    // ISOLATION-01/02 fallout: `materializeLlmConnection` throws unless the
    // "fast" engine's required FAST_API_KEY credential resolves (see
    // src/integrations/agent/engine-resolution.ts:242-247). This test only
    // cares about timeoutMs, but before FAST_API_KEY was brought under
    // explicit save/restore in the "materializes an explicit symbolic
    // credential" test above, this test silently depended on that other
    // test's UNRESTORED leak of `process.env.FAST_API_KEY` to avoid throwing
    // here — a hidden order dependency masked by the very isolation bug this
    // package fixes. Set and restore it locally so this test is hermetic on
    // its own.
    const originalFastApiKey = process.env.FAST_API_KEY;
    process.env.FAST_API_KEY = "timeout-precedence-fixture-key";
    try {
      const defaults = resolveLlmEngineUse(config, [{ engine: "fast" }]);
      expect(defaults.timeoutMs).toBe(600_000);
      expect(materializeLlmConnection(defaults).timeoutMs).toBe(600_000);

      const disabled = resolveLlmEngineUse(config, [{ engine: "fast", timeoutMs: null }]);
      expect(disabled.timeoutMs).toBeNull();
      expect(Object.hasOwn(materializeLlmConnection(disabled), "timeoutMs")).toBe(true);
      expect(materializeLlmConnection(disabled).timeoutMs).toBeNull();

      const overridden = resolveLlmEngineUse(
        { ...config, engines: { ...config.engines, fast: { ...config.engines.fast, timeoutMs: 90_000 } } },
        [{ engine: "fast" }, { timeoutMs: 12_000 }],
      );
      expect(overridden.timeoutMs).toBe(12_000);
    } finally {
      if (originalFastApiKey === undefined) delete process.env.FAST_API_KEY;
      else process.env.FAST_API_KEY = originalFastApiKey;
    }
  });

  test("uses no timeout for CLI agents and inherits the fallback LLM timeout for SDK agents", () => {
    const direct = resolveEngine("reviewer", config);
    expect(direct.timeoutMs).toBeNull();

    const inherited = resolveEngine("sdk", {
      ...config,
      engines: { ...config.engines, fast: { ...config.engines.fast, timeoutMs: 345_000 } },
    });
    expect(inherited.timeoutMs).toBe(345_000);

    const explicitNull = resolveEngine("sdk", {
      ...config,
      engines: { ...config.engines, sdk: { ...config.engines.sdk, timeoutMs: null } },
    });
    expect(explicitNull.timeoutMs).toBeNull();
  });

  test("preserves an exact lowered agent model through SDK dispatch", () => {
    const lowered = resolveEngine("sdk", {
      ...config,
      engines: { ...config.engines, sdk: { ...config.engines.sdk, model: "provider/exact" } },
    });
    if (lowered.kind !== "sdk") throw new Error("fixture must lower to SDK");
    expect(lowered.profile.model).toBe("provider/exact");
    expect(buildSdkConfig(lowered.profile, lowered.fallbackConnection).model).toBe("akm-custom/provider/exact");
    expect(resolveDispatchModel({ model: "provider/exact" }, lowered.profile, "opencode-sdk")).toBe("provider/exact");
  });

  test("rejects non-canonical harness ids", () => {
    expect(() =>
      resolveEngine("invalid-claude", {
        engines: {
          "invalid-claude": { kind: "agent", platform: "claude-code" as "claude", model: "sonnet" },
        },
      }),
    ).toThrow(/cannot dispatch agents/);
  });

  // resolveLlmEngineUse used to reject an agent
  // engine outright, even when the exact fallback machinery lowerAgentEngine
  // already uses (AgentEngineConfig.llmEngine, then defaults.llmEngine)
  // names a real LLM engine. Falling back is strictly less capable than the
  // agent engine (never an interactive/tool-capable runner), so it is safe.
  describe("resolveLlmEngineUse falls back off an agent engine's llmEngine", () => {
    test("falls back to the agent engine's OWN llmEngine when set", () => {
      const withOwnFallback = {
        ...config,
        engines: { ...config.engines, reviewer: { ...config.engines.reviewer, llmEngine: "fast" } },
      };
      const resolved = resolveLlmEngineUse(withOwnFallback, [{ engine: "reviewer" }]);
      expect(resolved.engine).toBe("fast");
      expect(resolved.connection.model).toBe("base-model");
    });

    test("falls back to defaults.llmEngine when the agent engine names no fallback of its own", () => {
      // `config.defaults.llmEngine` is "fast"; `reviewer` itself declares none.
      const resolved = resolveLlmEngineUse(config, [{ engine: "reviewer" }]);
      expect(resolved.engine).toBe("fast");
    });

    test("an agent engine's own llmEngine wins over defaults.llmEngine", () => {
      const withBoth = {
        ...config,
        engines: {
          ...config.engines,
          reviewer: { ...config.engines.reviewer, llmEngine: "sdk-fallback-target" },
          "sdk-fallback-target": { kind: "llm" as const, endpoint: "https://example.test/other", model: "other-model" },
        },
      };
      expect(resolveLlmEngineUse(withBoth, [{ engine: "reviewer" }]).engine).toBe("sdk-fallback-target");
    });

    test("optional resolution returns undefined, not a throw, when no fallback exists", () => {
      const noFallback = { ...config, defaults: { engine: "reviewer" } };
      expect(resolveLlmEngineUse(noFallback, [{ engine: "reviewer" }], { optional: true })).toBeUndefined();
    });

    test("aborts only when truly no LLM engine exists anywhere — even the fallback names a non-LLM engine", () => {
      const selfReferential = {
        configVersion: "0.9.0",
        engines: { wrong: { kind: "agent" as const, platform: "pi" as const } },
        defaults: { llmEngine: "wrong" },
      };
      expect(() => resolveLlmEngineUse(selfReferential, [{ engine: "wrong" }])).toThrow(/is not an LLM engine/);
    });
  });
});

describe("file-backed engine credential (#905)", () => {
  function makeTmpFile(content: string): { filePath: string; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-apikeyfile-test-"));
    const filePath = path.join(dir, "api-key");
    fs.writeFileSync(filePath, content);
    return { filePath, dir };
  }

  function withApiKeyFileEngine(filePath: string) {
    return {
      ...config,
      engines: {
        ...config.engines,
        filed: {
          kind: "llm" as const,
          endpoint: "https://example.test/v1/chat/completions",
          model: "base-model",
          apiKeyFile: filePath,
        },
      },
    };
  }

  test("resolves apiKeyFile onto ResolvedLlmUse without reading it, and expands a leading ~", () => {
    // A path under a home directory that does not exist proves the resolve
    // step never opens the file: if it did, this test would throw here
    // instead of only at materializeLlmConnection.
    const resolved = resolveLlmEngineUse(withApiKeyFileEngine("~/secrets/does-not-exist"), [{ engine: "filed" }]);
    expect(resolved.apiKeyFile).toBe(path.join(os.homedir(), "secrets/does-not-exist"));
    expect(resolved.credential).toBeUndefined();
    expect(Object.hasOwn(resolved.connection, "apiKey")).toBe(false);
    expect(Object.hasOwn(resolved.connection, "apiKeyFile")).toBe(false);
  });

  test("materializeLlmConnection reads apiKeyFile and trims exactly one trailing newline", () => {
    const { filePath, dir } = makeTmpFile("sk-file-secret\n");
    try {
      const resolved = resolveLlmEngineUse(withApiKeyFileEngine(filePath), [{ engine: "filed" }]);
      expect(materializeLlmConnection(resolved).apiKey).toBe("sk-file-secret");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not trim interior whitespace, only a single trailing newline", () => {
    const { filePath, dir } = makeTmpFile("sk-file-secret\n\n");
    try {
      const resolved = resolveLlmEngineUse(withApiKeyFileEngine(filePath), [{ engine: "filed" }]);
      expect(materializeLlmConnection(resolved).apiKey).toBe("sk-file-secret\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an env credential wins over apiKeyFile when both would resolve (env checked first)", () => {
    // The schema already rejects apiKey + apiKeyFile together; this exercises
    // resolveLlmCredentialValue's own precedence directly, since it is the
    // shared seam every dispatch path (incl. SDK fallback) calls through.
    const { filePath, dir } = makeTmpFile("from-file\n");
    try {
      const value = resolveLlmCredentialValue("filed", { names: ["SOME_VAR"], required: false }, filePath, undefined, {
        SOME_VAR: "from-env",
      });
      expect(value).toBe("from-env");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails closed with a config error naming the engine and path, never the value, when the file is missing", () => {
    const missingPath = path.join(os.tmpdir(), "akm-apikeyfile-test-missing", "does-not-exist");
    const resolved = resolveLlmEngineUse(withApiKeyFileEngine(missingPath), [{ engine: "filed" }]);
    let threw: unknown;
    try {
      materializeLlmConnection(resolved);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(Error);
    const message = (threw as Error).message;
    expect(message).toContain("filed");
    expect(message).toContain(missingPath);
    expect(message).toMatch(/does not exist/);
  });

  test("fails closed with a config error naming the engine and path, never the value, when the file is empty", () => {
    const { filePath, dir } = makeTmpFile("");
    try {
      const resolved = resolveLlmEngineUse(withApiKeyFileEngine(filePath), [{ engine: "filed" }]);
      let threw: unknown;
      try {
        materializeLlmConnection(resolved);
      } catch (err) {
        threw = err;
      }
      expect(threw).toBeInstanceOf(Error);
      const message = (threw as Error).message;
      expect(message).toContain("filed");
      expect(message).toContain(filePath);
      expect(message).toMatch(/is empty/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file containing only a newline resolves to empty and is rejected the same as a truly empty file", () => {
    const { filePath, dir } = makeTmpFile("\n");
    try {
      const resolved = resolveLlmEngineUse(withApiKeyFileEngine(filePath), [{ engine: "filed" }]);
      expect(() => materializeLlmConnection(resolved)).toThrow(/is empty/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("lookupApiKeyFileValue is best-effort: undefined for a missing or empty file, never throws", () => {
    expect(lookupApiKeyFileValue(path.join(os.tmpdir(), "akm-apikeyfile-test-missing-2", "nope"))).toBeUndefined();
    const { filePath, dir } = makeTmpFile("");
    try {
      expect(lookupApiKeyFileValue(filePath)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("collectEngineCredentialValues includes a file-backed engine's current value for redaction", () => {
    const { filePath, dir } = makeTmpFile("collect-me-secret\n");
    try {
      const values = collectEngineCredentialValues(withApiKeyFileEngine(filePath));
      expect(values).toContain("collect-me-secret");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("secret-store engine credential (#953)", () => {
  function withSecretRefEngine(ref: string) {
    return {
      ...config,
      engines: {
        ...config.engines,
        secreted: {
          kind: "llm" as const,
          endpoint: "https://example.test/v1/chat/completions",
          model: "base-model",
          apiKey: ref,
        },
      },
    };
  }

  test("resolves secret:// onto ResolvedLlmUse without reading it", () => {
    const resolved = resolveLlmEngineUse(withSecretRefEngine("secret://953-lab-key"), [{ engine: "secreted" }]);
    expect(resolved.apiKeySecretRef).toBe("secret://953-lab-key");
    expect(resolved.credential).toBeUndefined();
    expect(resolved.apiKeyFile).toBeUndefined();
    expect(Object.hasOwn(resolved.connection, "apiKey")).toBe(false);
  });

  test("resolveEngine forwards apiKeySecretRef through to the lowered llm runner", () => {
    const resolved = resolveEngine("secreted", withSecretRefEngine("secret://953-lab-key"));
    expect(resolved.kind).toBe("llm");
    if (resolved.kind !== "llm") throw new Error("fixture must lower to llm");
    expect(resolved.apiKeySecretRef).toBe("secret://953-lab-key");
    expect(resolved.credential).toBeUndefined();
  });

  test("a literal (non-reference) apiKey is still rejected — only $VAR/${VAR}/secret:// are accepted here", () => {
    expect(() =>
      resolveLlmEngineUse(withSecretRefEngine("sk-literal-not-a-reference"), [{ engine: "secreted" }]),
    ).toThrow(/invalid symbolic apiKey reference/);
  });

  test("an unresolved secret:// reference throws SECRET_REFERENCE_UNRESOLVED naming only the reference, never a value", () => {
    // No secret store is configured in this sandboxed test HOME, so the
    // reference deterministically fails to resolve.
    const resolved = resolveLlmEngineUse(withSecretRefEngine("secret://953-unset-lab-key"), [{ engine: "secreted" }]);
    let threw: unknown;
    try {
      materializeLlmConnection(resolved);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(ConfigError);
    const err = threw as ConfigError;
    expect(err.code).toBe("SECRET_REFERENCE_UNRESOLVED");
    expect(err.message).toContain("secret://953-unset-lab-key");
  });

  test("lookupApiKeySecretRefValue is best-effort: undefined when unresolved, never throws", () => {
    expect(lookupApiKeySecretRefValue("secret://953-unset-lab-key")).toBeUndefined();
  });

  test("collectEngineCredentialValues never throws for a secret-store-backed engine whose reference cannot resolve", () => {
    expect(() => collectEngineCredentialValues(withSecretRefEngine("secret://953-unset-lab-key"))).not.toThrow();
    expect(collectEngineCredentialValues(withSecretRefEngine("secret://953-unset-lab-key"))).toEqual([]);
  });
});
