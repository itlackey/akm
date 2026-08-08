// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Fan-out defaults (0.9.1) — `map` steps are parallel by default.
 *
 * Before 0.9.1 BOTH `map.concurrency` and an LLM engine's `concurrency` froze
 * to 1 when unset, so a fan-out over 500 items ran one at a time unless the
 * author opted in at two independent layers, and the two limits that actually
 * encode machine capacity (`workflow.maxConcurrency`, the host CPU cap) never
 * bound anything.
 *
 * This suite pins the whole contract of that change:
 *   - the new defaults land in NEWLY frozen plans,
 *   - an explicit `concurrency: 1` is still honored and is still
 *     distinguishable from "unset",
 *   - `workflow.defaultMapConcurrency` is the install-wide escape hatch,
 *   - a plan frozen BEFORE the change keeps the width it froze,
 *   - the four-way min still clamps.
 */

import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../src/core/config/config";
import {
  DEFAULT_LOCAL_LLM_ENGINE_CONCURRENCY,
  DEFAULT_MAP_CONCURRENCY,
  DEFAULT_REMOTE_LLM_ENGINE_CONCURRENCY,
  defaultLlmEngineConcurrency,
  defaultMapConcurrency,
  isLoopbackEndpoint,
  isLoopbackHost,
} from "../../src/workflows/concurrency-policy";
import { scheduleUnits } from "../../src/workflows/exec/scheduler";
import { computeStepWorkList } from "../../src/workflows/exec/step-work";
import { compileWorkflowPlan } from "../../src/workflows/ir/compile";
import { compileResolveFreezeWorkflow, type FreezeOptions } from "../../src/workflows/ir/freeze";
import {
  decodeWorkflowPlanV3,
  type FrozenLlmEngine,
  type IrMapNode,
  type IrUnitNode,
  type WorkflowPlanGraph,
} from "../../src/workflows/ir/schema";
import { parseWorkflow } from "../../src/workflows/parser";
import { WORKFLOW_MAX_CONCURRENCY } from "../../src/workflows/resource-limits";

// `remote` is deliberately NOT loopback and `local` deliberately is — the LLM
// engine default is endpoint-derived, so both branches need a fixture.
const BASE_CONFIG = {
  configVersion: "0.9.0",
  semanticSearchMode: "off",
  engines: {
    remote: { kind: "llm", endpoint: "https://api.example.test/v1/chat/completions", model: "test-model" },
    local: { kind: "llm", endpoint: "http://localhost:1234/v1/chat/completions", model: "local-model" },
    // A local model server on a NON-.1 loopback address. `127.0.0.0/8` is a
    // /8: binding a second LM Studio / Ollama to 127.0.0.2 is an ordinary way
    // to run two of them, and such a server is exactly as single-model as one
    // on 127.0.0.1.
    "local-alt": { kind: "llm", endpoint: "http://127.0.0.2:11434/v1/chat/completions", model: "local-model" },
    pinned: {
      kind: "llm",
      endpoint: "https://api.example.test/v1/chat/completions",
      model: "test-model",
      concurrency: 3,
    },
    "over-cap": {
      kind: "llm",
      endpoint: "https://api.example.test/v1/chat/completions",
      model: "test-model",
      concurrency: 1000,
    },
  },
  defaults: { engine: "remote" },
  workflow: { judgeEngine: "remote" },
} as const satisfies AkmConfig;

function freeze(markdown: string, config: AkmConfig = BASE_CONFIG, options: FreezeOptions = {}): WorkflowPlanGraph {
  const parsed = parseWorkflow(markdown, { path: "workflows/demo.md" });
  if (!parsed.ok) throw new Error(parsed.errors.map((error) => `${error.line}: ${error.message}`).join(" | "));
  return compileResolveFreezeWorkflow(
    {
      ref: "workflows/demo",
      path: "workflows/demo.md",
      sourcePath: "/tmp",
      title: "demo",
      steps: [],
      document: parsed.document,
    },
    config,
    options,
  ).plan;
}

/** A one-map-step document; `mapKeys` are extra lines inside the `map:` block. */
function mapWorkflow(mapKeys: string[] = []): string {
  return [
    "---",
    "type: workflow",
    "steps:",
    "  - id: discover",
    "  - id: review",
    "    map:",
    "      over: steps.discover.output.files",
    ...mapKeys.map((line) => `      ${line}`),
    "---",
    "",
    "## discover",
    "",
    "List the files.",
    "",
    "## review",
    "",
    "Review the file.",
    "",
  ].join("\n");
}

function mapNode(plan: WorkflowPlanGraph): IrMapNode {
  const root = plan.steps.find((step) => step.stepId === "review")?.root;
  if (!root || root.kind !== "map") throw new Error("fixture requires a map step");
  return root;
}

function llmEngine(plan: WorkflowPlanGraph, name: string): FrozenLlmEngine {
  const engine = plan.execution.engines[name];
  if (!engine || engine.kind !== "llm") throw new Error(`fixture requires LLM engine ${name}`);
  return engine;
}

/** Track the high-water mark of concurrent in-flight dispatches. */
function concurrencyProbe(delayMs = 5) {
  let inFlight = 0;
  let peak = 0;
  return {
    dispatch: async (item: number) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      inFlight--;
      return item;
    },
    peak: () => peak,
  };
}

describe("map fan-out default", () => {
  test("a map step that declares no concurrency freezes the parallel default", () => {
    expect(DEFAULT_MAP_CONCURRENCY).toBeGreaterThan(1);
    expect(mapNode(freeze(mapWorkflow())).concurrency).toBe(DEFAULT_MAP_CONCURRENCY);
  });

  test("an explicit `concurrency: 1` still serializes — opt-out survives the new default", () => {
    // The whole point of `?? ` over a truthiness check: an authored 1 must be
    // distinguishable from an unset field, and must win.
    expect(mapNode(freeze(mapWorkflow(["concurrency: 1"]))).concurrency).toBe(1);
  });

  test("an explicit concurrency above and below the default is honored verbatim", () => {
    expect(mapNode(freeze(mapWorkflow(["concurrency: 2"]))).concurrency).toBe(2);
    expect(mapNode(freeze(mapWorkflow(["concurrency: 16"]))).concurrency).toBe(16);
    expect(mapNode(freeze(mapWorkflow([`concurrency: ${WORKFLOW_MAX_CONCURRENCY}`]))).concurrency).toBe(
      WORKFLOW_MAX_CONCURRENCY,
    );
  });

  test("workflow.defaultMapConcurrency: 1 restores the pre-0.9.1 serial default install-wide", () => {
    const config = { ...BASE_CONFIG, workflow: { judgeEngine: "remote", defaultMapConcurrency: 1 } } as AkmConfig;
    expect(mapNode(freeze(mapWorkflow(), config)).concurrency).toBe(1);
    // ...but it is only a DEFAULT: an authored value still wins over it.
    expect(mapNode(freeze(mapWorkflow(["concurrency: 6"]), config)).concurrency).toBe(6);
  });

  test("workflow.defaultMapConcurrency raises the default and is clamped to the shared ceiling", () => {
    const raise = { ...BASE_CONFIG, workflow: { judgeEngine: "remote", defaultMapConcurrency: 12 } } as AkmConfig;
    expect(mapNode(freeze(mapWorkflow(), raise)).concurrency).toBe(12);
    // Above the decoder's bound the value is CLAMPED, not rejected — freezing
    // 1000 here would produce a plan `decodeWorkflowPlanV3` then refuses to load.
    const absurd = { ...BASE_CONFIG, workflow: { judgeEngine: "remote", defaultMapConcurrency: 9999 } } as AkmConfig;
    expect(mapNode(freeze(mapWorkflow(), absurd)).concurrency).toBe(WORKFLOW_MAX_CONCURRENCY);
  });

  test("the resolved default is a pure function of config, with unset meaning the built-in", () => {
    expect(defaultMapConcurrency(undefined)).toBe(DEFAULT_MAP_CONCURRENCY);
    expect(defaultMapConcurrency(1)).toBe(1);
    expect(defaultMapConcurrency(0)).toBe(1);
    expect(defaultMapConcurrency(Number.NaN)).toBe(DEFAULT_MAP_CONCURRENCY);
    expect(defaultMapConcurrency(10_000)).toBe(WORKFLOW_MAX_CONCURRENCY);
  });

  test("a solo (non-map) step is untouched — it is one unit, not a fan-out", () => {
    const plan = freeze(mapWorkflow());
    const solo = plan.steps.find((step) => step.stepId === "discover")?.root as IrUnitNode;
    expect(solo.kind).toBe("unit");
    expect((solo as unknown as { concurrency?: number }).concurrency).toBeUndefined();
  });
});

describe("LLM engine concurrency default (per endpoint)", () => {
  test("a remote endpoint defaults to the parallel width, a loopback one stays at 1", () => {
    // Kept at 1 for loopback on purpose: a local model server holds ONE loaded
    // model and parallel inference triggers reload thrash / HTTP 500 — a hard
    // failure, not a slow one (AGENTS.md "lowest common denominator").
    expect(DEFAULT_LOCAL_LLM_ENGINE_CONCURRENCY).toBe(1);
    const plan = freeze(
      [
        "---",
        "type: workflow",
        "steps:",
        "  - id: near",
        "    unit: { engine: local }",
        "  - id: far",
        "    unit: { engine: remote }",
        "---",
        "",
        "## near",
        "",
        "Do it locally.",
        "",
        "## far",
        "",
        "Do it remotely.",
        "",
      ].join("\n"),
    );
    expect(llmEngine(plan, "local").concurrency).toBe(DEFAULT_LOCAL_LLM_ENGINE_CONCURRENCY);
    expect(llmEngine(plan, "remote").concurrency).toBe(DEFAULT_REMOTE_LLM_ENGINE_CONCURRENCY);
  });

  test("an explicit engines.<name>.concurrency always wins, and is clamped into the decoder's range", () => {
    const pinned = freeze(
      [
        "---",
        "type: workflow",
        "steps:",
        "  - id: only",
        "    unit: { engine: pinned }",
        "---",
        "",
        "## only",
        "",
        "Go.",
        "",
      ].join("\n"),
    );
    expect(llmEngine(pinned, "pinned").concurrency).toBe(3);

    const overCap = freeze(
      [
        "---",
        "type: workflow",
        "steps:",
        "  - id: only",
        "    unit: { engine: over-cap }",
        "---",
        "",
        "## only",
        "",
        "Go.",
        "",
      ].join("\n"),
    );
    expect(llmEngine(overCap, "over-cap").concurrency).toBe(WORKFLOW_MAX_CONCURRENCY);
  });

  test("a local model server on a NON-.1 loopback address freezes at 1, not at the remote width", () => {
    // The regression this pins: classifying loopback by an exact `127.0.0.1`
    // string comparison froze `http://127.0.0.2:11434` at the REMOTE width of
    // 4 and drove exactly the parallel-inference failure (single loaded model,
    // reload thrash, HTTP 500) the policy exists to prevent.
    const plan = freeze(
      [
        "---",
        "type: workflow",
        "steps:",
        "  - id: near",
        "    unit: { engine: local-alt }",
        "---",
        "",
        "## near",
        "",
        "Do it on the second local server.",
        "",
      ].join("\n"),
    );
    expect(llmEngine(plan, "local-alt").concurrency).toBe(DEFAULT_LOCAL_LLM_ENGINE_CONCURRENCY);
  });

  test("endpoint classification covers loopback spellings and unparseable values", () => {
    expect(isLoopbackEndpoint("http://localhost:1234/v1")).toBe(true);
    expect(isLoopbackEndpoint("http://127.0.0.1:8080/v1")).toBe(true);
    expect(isLoopbackEndpoint("http://127.0.0.2:11434/v1")).toBe(true);
    expect(isLoopbackEndpoint("http://[::1]:8080/v1")).toBe(true);
    expect(isLoopbackEndpoint("http://[::ffff:127.0.0.1]:8080/v1")).toBe(true);
    expect(isLoopbackEndpoint("http://lmstudio.localhost/v1")).toBe(true);
    expect(isLoopbackEndpoint("https://api.example.test/v1")).toBe(false);
    expect(isLoopbackEndpoint("https://127.0.0.1.evil.com/v1")).toBe(false);
    // Unknown shapes fail SAFE (treated as local): guessing "remote" would
    // widen the pool on exactly the configs we understand least.
    expect(isLoopbackEndpoint(undefined)).toBe(true);
    expect(isLoopbackEndpoint("not a url")).toBe(true);
    // `new URL("localhost:1234")` PARSES — as the scheme `localhost:` with an
    // empty host — so the empty host has to fail safe too, not fall through to
    // "remote".
    expect(isLoopbackEndpoint("localhost:1234")).toBe(true);
    expect(defaultLlmEngineConcurrency("not a url")).toBe(DEFAULT_LOCAL_LLM_ENGINE_CONCURRENCY);
    expect(defaultLlmEngineConcurrency("http://127.0.0.2:11434/v1")).toBe(DEFAULT_LOCAL_LLM_ENGINE_CONCURRENCY);
    expect(defaultLlmEngineConcurrency("https://api.example.test/v1")).toBe(DEFAULT_REMOTE_LLM_ENGINE_CONCURRENCY);
  });
});

describe("loopback host classification — the whole loopback space, and its boundaries", () => {
  test.each([
    // ── the IPv4 loopback block is a /8, not one address ────────────────────
    ["127.0.0.1", true],
    ["127.0.0.2", true],
    ["127.0.0.0", true],
    ["127.255.255.255", true],
    ["127.1.2.3", true],
    // ── names ──────────────────────────────────────────────────────────────
    ["localhost", true],
    ["LOCALHOST", true],
    // RFC 6761 §6.3 reserves the whole `.localhost` TLD to loopback.
    ["lmstudio.localhost", true],
    // A trailing dot is the DNS root label, not a different name.
    ["localhost.", true],
    // ── IPv6 ───────────────────────────────────────────────────────────────
    ["::1", true],
    ["[::1]", true],
    ["0:0:0:0:0:0:0:1", true],
    // IPv4-mapped, in both the dotted spelling an author writes and the hex
    // one WHATWG `URL` re-serializes it to.
    ["::ffff:127.0.0.1", true],
    ["::ffff:7f00:1", true],
    ["::ffff:127.0.0.2", true],
    // Deprecated IPv4-compatible form.
    ["::127.0.0.1", true],
    // ── the unspecified addresses: a CLIENT connecting there reaches local ──
    ["0.0.0.0", true],
    ["::", true],
    // ── empty host: nothing to judge, fail safe ────────────────────────────
    ["", true],

    // ── NEAR-MISSES: none of these is a loopback address ────────────────────
    // A name that merely CONTAINS a loopback address. The classic attack on a
    // prefix/substring check.
    ["127.0.0.1.evil.com", false],
    ["127.0.0.1.example.com", false],
    // A name that merely STARTS with "127." but is not an address at all.
    ["127.example.com", false],
    ["127.0.0.1-attacker.test", false],
    // Not four octets: the first "octet" is 1270.
    ["1270.0.0.1", false],
    // Five parts, and the first octet is 12.
    ["12.7.0.0.1", false],
    // Leading zeros are not the decimal-octet grammar (they read as octal).
    ["0127.0.0.1", false],
    // Out of range, so not an IPv4 address at all.
    ["127.0.0.256", false],
    // Neighbouring /8s.
    ["128.0.0.1", false],
    ["126.255.255.255", false],
    ["12.7.0.1", false],
    // A name that merely ENDS with "localhost" without the label boundary.
    ["notlocalhost", false],
    // ...and one where "localhost" is only the first label.
    ["localhost.evil.com", false],
    // Ordinary remote hosts and non-loopback IPv6.
    ["api.example.test", false],
    ["::2", false],
    ["2001:db8::1", false],
    ["::ffff:8.8.8.8", false],
    // Malformed IPv6 (two `::` runs) is not an address, so it is not loopback.
    ["1::2::3", false],
    // A dotted quad may only be the LAST component of an IPv6 address.
    ["::ffff:127.0.0.1.5", false],
  ])("isLoopbackHost(%p) === %p", (host, expected) => {
    expect(isLoopbackHost(host as string)).toBe(expected);
  });

  test("classification is pure and syntactic — a name that would RESOLVE to loopback still reads remote", () => {
    // Freeze must produce the same plan on a laptop, in CI, and on a machine
    // with no network at all, so the predicate never resolves anything. The
    // cost of that is real and accepted: an author who points an engine at a
    // hosts-file alias for their local server sets
    // `engines.<name>.concurrency: 1` explicitly.
    expect(isLoopbackHost("my-lm-studio.internal")).toBe(false);
    expect(isLoopbackHost("host.docker.internal")).toBe(false);
  });
});

describe("frozen plans are unaffected by the new defaults", () => {
  /**
   * A plan as 0.9.0 would have written it into `workflow_runs.plan_json`:
   * every fan-out serial, every engine 1-wide. Loading it after the default
   * change must reproduce those exact widths — concurrency is frozen at run
   * start precisely so an in-flight run cannot change behavior mid-flight.
   */
  const legacyPlanJson = () =>
    JSON.stringify({
      irVersion: 3,
      title: "legacy",
      execution: {
        maxConcurrency: 8,
        engines: {
          far: {
            name: "far",
            kind: "llm",
            endpoint: "https://api.example.test/v1/chat/completions",
            model: "test-model",
            concurrency: 1,
          },
        },
      },
      steps: [
        {
          stepId: "review",
          title: "review",
          sequenceIndex: 0,
          root: {
            kind: "map",
            id: "review.map",
            over: "params.files",
            template: {
              kind: "unit",
              id: "review.unit",
              instructions: "Review the file.",
              templating: "verbatim",
              invocation: { engine: "far", model: "test-model", timeoutMs: 600000 },
              onError: "fail",
              isolation: "none",
            },
            concurrency: 1,
            reducer: "collect",
          },
          gate: { kind: "gate", id: "review.gate", stepId: "review", criteria: [], maxLoops: 1, judge: null },
        },
      ],
    });

  test("a 0.9.0 plan_json with concurrency 1 still decodes to width 1 (no re-defaulting on load)", () => {
    const plan = decodeWorkflowPlanV3(JSON.parse(legacyPlanJson()));
    expect(mapNode(plan).concurrency).toBe(1);
    expect(llmEngine(plan, "far").concurrency).toBe(1);
    // The decoder is a validator, not a migrator: it must not have edited the
    // persisted document on the way through.
    expect(JSON.parse(JSON.stringify(plan))).toEqual(JSON.parse(legacyPlanJson()));
  });

  test("the frozen 1 reaches dispatch and really runs serially", async () => {
    const plan = decodeWorkflowPlanV3(JSON.parse(legacyPlanJson()));
    const work = computeStepWorkList(plan.steps[0]!, {
      runId: "run-legacy",
      params: { files: ["a", "b", "c", "d", "e", "f"] },
      stepOutputs: {},
      engines: plan.execution.engines,
    });
    expect(work.ok).toBe(true);
    if (!work.ok) throw new Error("fixture requires a work list");
    expect(work.list.concurrency).toBe(1);

    const probe = concurrencyProbe();
    await scheduleUnits([1, 2, 3, 4, 5, 6], probe.dispatch, {
      concurrency: work.list.concurrency,
      maxConcurrency: plan.execution.maxConcurrency,
      llmConcurrency: llmEngine(plan, "far").concurrency,
      hostConcurrency: 16,
    });
    expect(probe.peak()).toBe(1);
  });

  test("the map default is a FREEZE-time decision — the decoder rejects a plan that omits it", () => {
    // This is what makes the frozen-plan guarantee structural rather than a
    // convention: `concurrency` is required on every persisted map node, so a
    // stored plan can never fall through to whatever today's default happens
    // to be.
    const missing = JSON.parse(legacyPlanJson());
    delete missing.steps[0].root.concurrency;
    expect(() => decodeWorkflowPlanV3(missing)).toThrow("map review.map is invalid");
  });
});

describe("the four-way min still clamps", () => {
  test.each([
    ["the run cap binds", { concurrency: DEFAULT_MAP_CONCURRENCY, maxConcurrency: 2, hostConcurrency: 16 }, 2],
    [
      "a loopback LLM engine binds — the new map default cannot hammer a local model server",
      { concurrency: DEFAULT_MAP_CONCURRENCY, maxConcurrency: 16, llmConcurrency: 1, hostConcurrency: 16 },
      1,
    ],
    [
      "a small host binds — a plan frozen on a big box narrows when it resumes on a laptop",
      { concurrency: DEFAULT_MAP_CONCURRENCY, maxConcurrency: 16, llmConcurrency: 16, hostConcurrency: 2 },
      2,
    ],
    [
      "the map default itself binds when every ceiling is higher",
      { concurrency: DEFAULT_MAP_CONCURRENCY, maxConcurrency: 16, llmConcurrency: 16, hostConcurrency: 16 },
      DEFAULT_MAP_CONCURRENCY,
    ],
  ])("%s", async (_name, options, expected) => {
    const probe = concurrencyProbe();
    await scheduleUnits([1, 2, 3, 4, 5, 6, 7, 8], probe.dispatch, options);
    expect(probe.peak()).toBe(expected);
  });
});

describe("override attribution is keyed by stepId, not array position", () => {
  const document = [
    "---",
    "type: workflow",
    "steps:",
    "  - id: alpha",
    "    unit: { engine: local }",
    "  - id: beta",
    "    unit: { engine: pinned }",
    "  - id: gamma",
    "    unit: { engine: remote }",
    "---",
    "",
    "## alpha",
    "",
    "First.",
    "",
    "## beta",
    "",
    "Second.",
    "",
    "## gamma",
    "",
    "Third.",
    "",
  ].join("\n");

  const engineOf = (plan: WorkflowPlanGraph, stepId: string): string => {
    const root = plan.steps.find((step) => step.stepId === stepId)?.root;
    if (!root || root.kind !== "unit") throw new Error(`no unit step ${stepId}`);
    return root.invocation!.engine;
  };

  test("the ordinary 1:1 compile attributes each step its own engine", () => {
    const plan = freeze(document);
    expect(engineOf(plan, "alpha")).toBe("local");
    expect(engineOf(plan, "beta")).toBe("pinned");
    expect(engineOf(plan, "gamma")).toBe("remote");
  });

  test("a compile pass that REORDERS and FILTERS draft steps still attributes correctly", () => {
    // The positional lookup (`asset.document.steps[index]`) was correct only
    // because compile happens to be 1:1 and order-preserving — nothing enforced
    // it. Under this seam the old code would have handed draft[0] (`gamma`) the
    // source overrides of document.steps[0] (`alpha`) and frozen the wrong
    // engine, model, and timeout onto every step.
    const plan = freeze(document, BASE_CONFIG, {
      compile: (asset) => {
        const compiled = compileWorkflowPlan(asset.document, asset.title);
        if (!compiled.ok) throw new Error("fixture must compile");
        const byId = new Map(compiled.plan.steps.map((step) => [step.stepId, step]));
        // `sequenceIndex` is renumbered only to satisfy the decoder's
        // contiguity rule; the ATTRIBUTION under test keys off `stepId`.
        const reordered = ["gamma", "alpha"].map((id, sequenceIndex) => {
          const step = byId.get(id);
          if (!step) throw new Error(`fixture requires step ${id}`);
          return { ...step, sequenceIndex };
        });
        return { ...compiled.plan, steps: reordered, warnings: compiled.warnings };
      },
    });
    expect(plan.steps.map((step) => step.stepId)).toEqual(["gamma", "alpha"]);
    expect(engineOf(plan, "gamma")).toBe("remote");
    expect(engineOf(plan, "alpha")).toBe("local");
  });

  test("a draft step with no surviving source step degrades to defaults instead of stealing another step's", () => {
    // Nothing produces this today, but the lookup must not silently borrow a
    // neighbour's overrides if it ever does.
    const plan = freeze(document, BASE_CONFIG, {
      compile: (asset) => {
        const compiled = compileWorkflowPlan(asset.document, asset.title);
        if (!compiled.ok) throw new Error("fixture must compile");
        const source = compiled.plan.steps[1]!;
        const orphan = {
          ...source,
          stepId: "delta",
          title: "delta",
          sequenceIndex: 0,
          root: { ...source.root!, id: "delta" },
          gate: { ...source.gate, id: "delta.gate", stepId: "delta" },
        };
        return { ...compiled.plan, steps: [orphan], warnings: compiled.warnings };
      },
    });
    // `defaults.engine` (remote), not `beta`'s pinned engine.
    expect(engineOf(plan, "delta")).toBe("remote");
  });
});
