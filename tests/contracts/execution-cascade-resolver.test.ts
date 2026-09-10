// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { ConfigError } from "../../src/core/errors";
import {
  canonicalResolvedExecutionRequest,
  createResolvedCommand,
  createResolvedPersona,
} from "../../src/execution/resolved-request";
import { createAdapterRenderedExecutionSource } from "../../src/execution/source";
import {
  type ExecutionCascadeLayerInput,
  type ExecutionEngineDefinition,
  planExecutionCascade,
  requireAuthorizedExecutionPlan,
} from "../../src/integrations/agent/execution-cascade";
import { executionEngineDefinitionsFromConfig } from "../../src/integrations/agent/execution-definitions";
import { mergeModelMapLayers, parseModelMapLayer, resolveModelMapAlias } from "../../src/integrations/agent/model-map";

const modelMap = mergeModelMapLayers(
  parseModelMapLayer(
    JSON.stringify({
      version: 1,
      aliases: {
        reasoning: {
          claude: {
            model: "claude-opus-exact",
            inference: { effort: "high", nested: { alias: true, replace: "alias" } },
          },
          "opencode-sdk": "anthropic/claude-opus-exact",
        },
        mapped: { claude: "claude-sonnet-exact" },
      },
    }),
    "cascade fixture models.json",
  ),
);

function source(kind: "command" | "persona", name: string, defaults: Record<string, unknown> = {}) {
  return createAdapterRenderedExecutionSource({
    kind,
    content: kind === "command" ? `Run ${name}.` : `You are ${name}.`,
    defaults,
    identity: {
      ref: `fixture//${kind === "command" ? "commands" : "agents"}/${name}`,
      bundle: "fixture",
      adapter: "akm",
      file: `${kind === "command" ? "commands" : "agents"}/${name}.md`,
      hash: name
        .padEnd(64, "a")
        .slice(0, 64)
        .replace(/[^a-f0-9]/g, "a"),
    },
  });
}

function command() {
  const rendered = source("command", "review", { model: "reasoning" });
  if (rendered.kind !== "command") throw new Error("fixture command kind drifted");
  return createResolvedCommand({ source: rendered, content: rendered.content });
}

function persona() {
  const rendered = source("persona", "reviewer", { model: "mapped", tools: ["read"] });
  if (rendered.kind !== "persona") throw new Error("fixture persona kind drifted");
  return createResolvedPersona(rendered);
}

const engines: Readonly<Record<string, ExecutionEngineDefinition>> = {
  reviewer: {
    selection: { name: "reviewer", kind: "agent", platform: "claude", settings: { bin: "claude" } },
    defaults: {
      model: "mapped",
      inference: { effort: "low", temperature: 0.7, nested: { engine: true, replace: "engine" } },
      timeout: "20m",
      workspace: "/engine",
    },
  },
  "opencode-sdk": {
    selection: { name: "opencode-sdk", kind: "sdk", platform: "opencode-sdk" },
    defaults: { model: "reasoning" },
  },
};

function layer(id: string, values: Record<string, unknown>): ExecutionCascadeLayerInput {
  return { id, values };
}

function baseInput() {
  return {
    command: command(),
    persona: persona(),
    modelMap,
    engines,
    layers: {
      installation: layer("installation", { engine: "reviewer", model: "mapped", tools: ["install"] }),
      agent: layer("fixture//agents/reviewer", {
        model: "mapped",
        tools: ["read"],
        inference: { nested: { agent: true, replace: "agent" } },
      }),
      command: layer("fixture//commands/review", {
        agent: "fixture//agents/reviewer",
        model: "reasoning",
        tools: ["shell"],
        inference: { effort: "medium", nested: { command: true, replace: "command" } },
      }),
      invocationDefaults: layer("task-defaults", {
        timeout: "5m",
        environment: { FAR: "yes" },
      }),
      current: layer("current", {
        timeout: 0,
        workspace: null,
        environment: {},
        runtime: {},
        outputSchema: null,
        inference: { temperature: 0, enabled: false, stops: [], nested: { current: true } },
      }),
    },
    invocationKind: "direct" as const,
  };
}

describe("common execution cascade resolver", () => {
  test("resolves every fixed layer far-to-near while preserving explicit empty, false, zero, and null values", () => {
    const plan = planExecutionCascade(baseInput());

    expect(plan.selectedAgent).toBe("fixture//agents/reviewer");
    expect(plan.request.engine).toEqual({
      name: "reviewer",
      kind: "agent",
      platform: "claude",
      settings: { bin: "claude" },
    });
    expect(plan.request.model).toEqual({
      input: "reasoning",
      interpretation: "alias",
      resolved: "claude-opus-exact",
    });
    expect(plan.request.inference).toEqual({
      effort: "medium",
      temperature: 0,
      enabled: false,
      stops: [],
      nested: {
        engine: true,
        agent: true,
        alias: true,
        command: true,
        current: true,
        replace: "command",
      },
    });
    expect(plan.request.outputSchema).toBeNull();
    expect(plan.request.tools).toEqual(["shell"]);
    expect(plan.request.runtime).toEqual({ timeoutMs: 0, workspace: null, environment: {}, settings: {} });
    expect(plan.request.authorization.status).toBe("denied");

    expect(plan.provenance.engine).toEqual({ layer: "installation", kind: "installation", via: "explicit" });
    expect(plan.provenance.model).toEqual({
      layer: "fixture//commands/review",
      kind: "command",
      via: "explicit",
    });
    expect(plan.provenance["/inference/effort"]).toEqual({
      layer: "fixture//commands/review",
      kind: "command",
      via: "explicit",
    });
    expect(plan.provenance["/inference/nested/alias"]).toEqual({
      layer: "fixture//commands/review",
      kind: "command",
      via: "model-alias",
    });
    expect(plan.provenance["runtime.timeoutMs"]).toEqual({ layer: "current", kind: "current", via: "explicit" });
    expect(plan.provenance["runtime.environment"]).toEqual({
      layer: "current",
      kind: "current",
      via: "explicit",
    });
  });

  test("authorizes only the final nearest tool selection and never silently intersects or widens it", () => {
    const seen: unknown[] = [];
    const plan = planExecutionCascade({
      ...baseInput(),
      authorizeTools(input) {
        seen.push(input);
        return { status: "denied", policy: "operator-tools-v1" };
      },
    });

    expect(seen).toEqual([
      {
        tools: ["shell"],
        engine: { name: "reviewer", kind: "agent", platform: "claude" },
        invocationKind: "direct",
        commandRef: "fixture//commands/review",
        personaRef: "fixture//agents/reviewer",
      },
    ]);
    expect(plan.request.tools).toEqual(["shell"]);
    expect(plan.request.authorization).toEqual({
      status: "denied",
      reason: "Selected tools are not authorized by operator policy.",
      policy: { id: "operator-tools-v1" },
    });
    expect(() => requireAuthorizedExecutionPlan(plan)).toThrow(ConfigError);
    try {
      requireAuthorizedExecutionPlan(plan);
    } catch (error) {
      expect((error as ConfigError).code).toBe("EXECUTION_NOT_AUTHORIZED");
    }
  });

  test("does not invoke authorization for omitted or explicitly empty tool spellings", () => {
    for (const tools of [undefined, null, "", [], {}] as const) {
      let calls = 0;
      const currentValues = tools === undefined ? {} : { tools };
      const plan = planExecutionCascade({
        ...baseInput(),
        layers: {
          ...baseInput().layers,
          command: layer("command", {}),
          current: layer("current", currentValues),
        },
        authorizeTools() {
          calls += 1;
          return { status: "allowed", policy: "must-not-run" };
        },
      });
      expect(calls).toBe(tools === undefined ? 1 : 0);
      if (tools === undefined) expect(plan.request.authorization.status).toBe("allowed");
      else expect(plan.request.authorization.status).toBe("not-required");
    }
  });

  test("uses the announced fixed fallback only when no layer selects an engine", () => {
    const input = baseInput();
    const plan = planExecutionCascade({
      ...input,
      layers: {
        installation: layer("installation", {}),
        command: layer("command", { model: "reasoning", tools: [] }),
      },
    });
    expect(plan.request.engine.name).toBe("opencode-sdk");
    expect(plan.request.notices).toEqual([
      {
        code: "engine-fallback",
        severity: "info",
        adapter: "akm",
        field: "engine",
        message: "No engine was selected; using the fixed opencode-sdk fallback.",
      },
    ]);
    expect(plan.provenance.engine).toEqual({ layer: "opencode-sdk", kind: "fallback", via: "fallback" });

    expect(() =>
      planExecutionCascade({ ...input, engines: { reviewer: engines.reviewer! }, layers: planLayers() }),
    ).toThrow(/opencode-sdk.*unavailable/i);
  });

  test("fails invalid engines before authorization; a known-unmapped alias now resolves as exact instead", () => {
    let calls = 0;
    const authorizeTools = () => {
      calls += 1;
      return { status: "allowed" as const, policy: "operator" };
    };
    const input = baseInput();
    expect(() =>
      planExecutionCascade({
        ...input,
        authorizeTools,
        layers: { ...input.layers, current: layer("current", { model: "mapped", tools: ["read"] }) },
        engines: {
          ...engines,
          custom: { selection: { name: "custom", kind: "agent", platform: "gemini" }, defaults: {} },
        },
      }),
    ).not.toThrow();
    expect(calls).toBe(1);

    expect(() =>
      planExecutionCascade({
        ...input,
        authorizeTools,
        layers: { ...input.layers, current: layer("current", { engine: "missing", tools: ["read"] }) },
      }),
    ).toThrow(/engine.*missing.*configured/i);
    expect(calls).toBe(1);

    const plan = planExecutionCascade({
      ...input,
      authorizeTools,
      layers: { ...input.layers, current: layer("current", { engine: "custom", model: "mapped", tools: ["read"] }) },
      engines: {
        ...engines,
        custom: { selection: { name: "custom", kind: "agent", platform: "gemini" }, defaults: {} },
      },
    });
    expect(plan.request.model).toEqual({ input: "mapped", interpretation: "exact", resolved: "mapped" });
    expect(calls).toBe(2);
  });

  test("keeps provenance canonical and free of prompt, environment, model, and policy values", () => {
    const secret = "AKM_SECRET_PROVENANCE_SENTINEL";
    const input = baseInput();
    const plan = planExecutionCascade({
      ...input,
      layers: {
        ...input.layers,
        current: layer("current", {
          model: `vendor/${secret}`,
          environment: { TOKEN: secret },
          tools: ["read"],
        }),
      },
      authorizeTools: () => ({ status: "allowed", policy: "operator-tools-v1" }),
    });
    const provenance = JSON.stringify(plan.provenance);
    expect(provenance).not.toContain(secret);
    expect(provenance).not.toContain("Run review");
  });

  test("removes provenance for nested inference leaves replaced by a nearer scalar", () => {
    const input = baseInput();
    const plan = planExecutionCascade({
      ...input,
      layers: {
        ...input.layers,
        current: layer("current", { inference: { nested: "replace-object" }, tools: [] }),
      },
    });
    expect(plan.request.inference?.nested).toBe("replace-object");
    expect(plan.provenance["/inference/nested"]).toEqual({
      layer: "current",
      kind: "current",
      via: "explicit",
    });
    expect(Object.keys(plan.provenance).some((key) => key.startsWith("/inference/nested/"))).toBe(false);
  });

  test("keeps an explicit null engine selection distinguishable from omission while applying the same fallback", () => {
    const input = baseInput();
    const omitted = planExecutionCascade({ ...input, layers: planLayers() });
    const cleared = planExecutionCascade({
      ...input,
      layers: {
        installation: layer("installation", {}),
        command: layer("command", { engine: null, tools: [] }),
      },
    });
    expect(omitted.request.engine.name).toBe("opencode-sdk");
    expect(cleared.request.engine.name).toBe("opencode-sdk");
    expect(cleared.provenance["engine.requested"]).toEqual({
      layer: "command",
      kind: "command",
      via: "explicit",
    });
    expect(omitted.provenance).not.toHaveProperty("engine.requested");
  });

  test("applies the selected agent consistently to the resolved persona", () => {
    const input = baseInput();
    const cleared = planExecutionCascade({
      ...input,
      layers: { ...input.layers, current: layer("current", { agent: null, tools: [] }) },
    });
    expect(cleared.selectedAgent).toBeNull();
    expect(cleared.request.persona).toBeNull();
    expect(cleared.provenance).not.toHaveProperty("persona");

    const mismatched = source("persona", "other");
    if (mismatched.kind !== "persona") throw new Error("fixture persona kind drifted");
    expect(() =>
      planExecutionCascade({
        ...input,
        persona: createResolvedPersona(mismatched),
        layers: {
          ...input.layers,
          current: layer("current", { agent: "fixture//agents/reviewer", tools: [] }),
        },
      }),
    ).toThrow(/selected agent.*persona/i);

    const nativeSelector = planExecutionCascade({
      ...input,
      persona: null,
      layers: { ...input.layers, current: layer("current", { agent: "native-reviewer", tools: [] }) },
    });
    expect(nativeSelector.selectedAgent).toBe("native-reviewer");
    expect(nativeSelector.request.agent).toBe("native-reviewer");
    expect(nativeSelector.request.persona).toBeNull();
    expect(requireAuthorizedExecutionPlan(nativeSelector).agent).toBe("native-reviewer");

    const differentNativeSelector = planExecutionCascade({
      ...input,
      persona: null,
      layers: { ...input.layers, current: layer("current", { agent: "different-native-reviewer", tools: [] }) },
    });
    expect(canonicalResolvedExecutionRequest(nativeSelector.request)).not.toBe(
      canonicalResolvedExecutionRequest(differentNativeSelector.request),
    );
  });

  test("expands every model alias at its selecting layer before sibling and nearer inference overlays", () => {
    const layeredMap = mergeModelMapLayers(
      parseModelMapLayer(
        JSON.stringify({
          version: 1,
          aliases: {
            far: {
              claude: { model: "far-exact", inference: { far: 1, nested: { far: true, replace: "far" } } },
            },
            near: {
              claude: { model: "near-exact", inference: { near: 2, nested: { near: true, replace: "near" } } },
            },
          },
        }),
        "layered cascade models.json",
      ),
    );
    const input = baseInput();
    const plan = (nearModel: string) =>
      planExecutionCascade({
        ...input,
        modelMap: layeredMap,
        layers: {
          installation: layer("installation", { engine: "reviewer", model: "far" }),
          current: layer("current", { model: nearModel, inference: { nested: { current: true } }, tools: [] }),
        },
      });

    const exact = plan("vendor/exact");
    expect(exact.request.model).toEqual({
      input: "vendor/exact",
      interpretation: "exact",
      resolved: "vendor/exact",
    });
    expect(exact.request.inference).toEqual({
      far: 1,
      effort: "low",
      temperature: 0.7,
      nested: { far: true, engine: true, replace: "engine", current: true },
    });

    const alias = plan("near");
    expect(alias.request.model).toEqual({ input: "near", interpretation: "alias", resolved: "near-exact" });
    expect(alias.request.inference).toEqual({
      far: 1,
      near: 2,
      effort: "low",
      temperature: 0.7,
      nested: { far: true, engine: true, near: true, replace: "near", current: true },
    });
    expect(alias.provenance["/inference/far"]).toEqual({
      layer: "installation",
      kind: "installation",
      via: "model-alias",
    });
    expect(alias.provenance["/inference/near"]).toEqual({
      layer: "current",
      kind: "current",
      via: "model-alias",
    });
  });

  test("uses segment-safe JSON Pointer provenance for inference keys", () => {
    const input = baseInput();
    const plan = planExecutionCascade({
      ...input,
      layers: {
        installation: layer("installation", {
          engine: "reviewer",
          inference: { "a.b": 1, "slash/key": { "tilde~key": true } },
        }),
        current: layer("current", { inference: { a: "near" }, tools: [] }),
      },
    });
    expect(plan.request.inference).toEqual({
      "a.b": 1,
      "slash/key": { "tilde~key": true },
      a: "near",
      effort: "low",
      temperature: 0.7,
      nested: { engine: true, replace: "engine" },
    });
    expect(plan.provenance["/inference/a.b"]).toEqual({
      layer: "installation",
      kind: "installation",
      via: "explicit",
    });
    expect(plan.provenance["/inference/slash~1key/tilde~0key"]).toEqual({
      layer: "installation",
      kind: "installation",
      via: "explicit",
    });
    expect(plan.provenance["/inference/a"]).toEqual({
      layer: "current",
      kind: "current",
      via: "explicit",
    });
  });

  test("validates the entire request before invoking machine/user policy", () => {
    let calls = 0;
    const input = baseInput();
    expect(() =>
      planExecutionCascade({
        ...input,
        layers: { ...input.layers, current: layer("current", { timeout: -1, tools: ["read"] }) },
        authorizeTools: () => {
          calls += 1;
          return { status: "allowed", policy: "operator" };
        },
      }),
    ).toThrow(/timeout/i);
    expect(calls).toBe(0);

    const withoutMap = { ...input } as Record<string, unknown>;
    delete withoutMap.modelMap;
    expect(() => planExecutionCascade(withoutMap as never)).toThrow(/modelMap.*required/i);

    const withoutSelectedModel = {
      ...input,
      layers: { installation: layer("installation", { engine: "reviewer", tools: [] }) },
    } as Record<string, unknown>;
    delete withoutSelectedModel.modelMap;
    expect(() => planExecutionCascade(withoutSelectedModel as never)).toThrow(/modelMap.*required/i);
  });

  test("rejects unknown fields and accessors without reading them or mutating inputs", () => {
    let reads = 0;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "engine", {
      enumerable: true,
      get() {
        reads += 1;
        return "reviewer";
      },
    });
    expect(() =>
      planExecutionCascade({
        ...baseInput(),
        layers: { installation: layer("installation", hostile) },
      }),
    ).toThrow(/accessor|data property/i);
    expect(reads).toBe(0);

    expect(() =>
      planExecutionCascade({
        ...baseInput(),
        layers: { installation: layer("installation", { engine: "reviewer", capabilities: {} }) },
      }),
    ).toThrow(/capabilities/i);
  });

  test("validates branded command, persona, and model-map inputs before dereferencing them", () => {
    const input = baseInput();
    for (const field of ["command", "persona"] as const) {
      let reads = 0;
      const hostile = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(hostile, "source", {
        enumerable: true,
        get() {
          reads += 1;
          return null;
        },
      });
      expect(() => planExecutionCascade({ ...input, [field]: hostile } as never)).toThrow(
        /constructed by the execution boundary/,
      );
      expect(reads).toBe(0);
    }

    let modelMapReads = 0;
    const hostileMap = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostileMap, "version", { enumerable: true, value: 1 });
    Object.defineProperty(hostileMap, "aliases", {
      enumerable: true,
      get() {
        modelMapReads += 1;
        return {};
      },
    });
    expect(() => planExecutionCascade({ ...input, modelMap: hostileMap } as never)).toThrow(/accessor|data property/);
    expect(modelMapReads).toBe(0);
  });

  test("rejects prototype-like engine keys and unsafe provenance identifiers", () => {
    const input = baseInput();
    expect(() =>
      planExecutionCascade({
        ...input,
        engines: {
          ...engines,
          constructor: { selection: { name: "constructor", kind: "agent" as const, platform: "claude" } },
        },
      }),
    ).toThrow(/engines\.constructor|engine name|canonical/i);

    expect(() =>
      planExecutionCascade({
        ...input,
        layers: { ...input.layers, current: layer("hidden\u202E-layer", { tools: [] }) },
      }),
    ).toThrow(/stable NFC identifier|control|format/i);

    expect(() =>
      planExecutionCascade({
        ...input,
        layers: { ...input.layers, current: layer("broken-\ud800", { tools: [] }) },
      }),
    ).toThrow(/stable NFC identifier|Unicode/i);
  });

  test("rejects accessor-backed policy output without invoking the getter", () => {
    let reads = 0;
    const decision = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(decision, "status", { enumerable: true, value: "allowed" });
    Object.defineProperty(decision, "policy", {
      enumerable: true,
      get() {
        reads += 1;
        return "operator";
      },
    });
    expect(() =>
      planExecutionCascade({
        ...baseInput(),
        authorizeTools: () => decision as never,
      }),
    ).toThrow(/accessor|data property/i);
    expect(reads).toBe(0);
  });
});

function planLayers() {
  return { installation: layer("installation", {}), command: layer("command", { tools: [] }) };
}

// #946 acceptance: an `engine`-backed models.json column resolves to the
// configured engine's own model, so `akm agent --engine local-fast --model
// fast` hits the engine `local-fast` was configured with — not a hardcoded
// per-platform literal. Combines `executionEngineDefinitionsFromConfig`
// (config -> modelMapKey) with `mergeModelMapLayers`/`resolveModelMapAlias`
// (models.json -> resolved model), the same two pieces the common cascade
// already stitches together, without editing any existing case above.
describe("engine-backed model-map alias resolution (#946)", () => {
  test("akm agent --engine local-fast --model fast resolves the engine's own model", () => {
    const config = {
      configVersion: "0.9.0" as const,
      semanticSearchMode: "off" as const,
      engines: {
        "local-fast": {
          kind: "agent" as const,
          platform: "opencode" as const,
          model: "krang/qwen3.5-9b",
        },
      },
    };
    const definitions = executionEngineDefinitionsFromConfig(config);
    expect(definitions["local-fast"]?.modelMapKey).toBe("opencode");

    const map = mergeModelMapLayers(
      parseModelMapLayer(
        JSON.stringify({ version: 1, aliases: { fast: { opencode: { engine: "local-fast" } } } }),
        "installed models.json",
      ),
      undefined,
      config.engines,
    );

    const selection = resolveModelMapAlias("fast", definitions["local-fast"]?.modelMapKey ?? "", map);
    expect(selection).toEqual({
      input: "fast",
      interpretation: "alias",
      model: "krang/qwen3.5-9b",
    });
  });
});
