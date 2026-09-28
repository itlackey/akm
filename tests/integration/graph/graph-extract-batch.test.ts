/**
 * Unit tests for `extractGraphFromBodies` — the batched graph-extraction helper.
 *
 * The real `../src/llm/client` transport is exercised against a local Bun HTTP
 * server so no module-level mocks leak across files under newer Bun versions.
 * The real implementation of `extractGraphFromBodies` (and
 * `extractGraphFromBody`) is exercised.
 *
 * Coverage:
 *   (a) Successful 3-asset batch returns 3 correctly-matched results.
 *   (b) Partial response (model returns fewer items than assets) falls back to
 *       individual `extractGraphFromBody` calls for the missing indices.
 *   (c) Batch size=1 (single body) delegates to the single-asset path and
 *       returns a 1-element array identical to `extractGraphFromBody`.
 *   (d) Empty bodies array returns an empty array without calling the LLM.
 *   (e) All-whitespace bodies return all-empty extractions without LLM calls.
 *   (f) LLM returns non-array JSON → falls back to individual calls for all assets.
 *   (i) A provider_error (5xx) on the batch call does not fall back per-asset (R2).
 *   (i2) A network_error (unreachable endpoint) does not fall back per-asset either.
 *   (i3) Nor does a provider_html_error (5xx with an HTML body).
 *   (i4) A parse_error (malformed JSON envelope) DOES still fall back per-asset —
 *        it is not part of the transport-failure family.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { AkmConfig, LlmConnectionConfig } from "../../../src/core/config/config";
import type { GraphExtraction } from "../../../src/llm/graph-extract";
import { testLlmRunner } from "../../_helpers/llm-runner";

// ── Local LLM server ─────────────────────────────────────────────────────────

/**
 * Call-count and response queues for the local OpenAI-compatible endpoint.
 *
 * Strategy: the user message in a batch call always contains "N=" (from the
 * buildBatchUserPrompt template). We use that to distinguish batch calls from
 * individual (single-asset) fallback calls and route to separate queues.
 */
let chatCallCount = 0;
/** Queue of raw strings for batch calls (the user prompt contains "N="). */
const batchRawQueue: string[] = [];
/** Queue of raw strings for individual (single-asset fallback) calls. */
const singleRawQueue: string[] = [];
/** Queue of HTTP status codes to return instead of a 200, for provider-error tests. */
const errorStatusQueue: number[] = [];
/** Queue of HTTP status codes to return with an HTML body, for provider_html_error tests. */
const htmlErrorStatusQueue: number[] = [];
/** When true, the next 200 response has a body that is not valid JSON (parse_error). */
let malformedJsonNext = false;
/**
 * Per-request response delays in ms, consumed in request order. The response is
 * chosen before the delay, so a request the client has given up on never
 * takes a later test's queued response.
 */
const delayQueue: number[] = [];
/** Extra ms every response is held, so overlapping requests are observable. */
let holdMs = 0;
/** This test's requests in flight; a new set per test, so a late request from an earlier test is not counted. */
let inFlight = new Set<Request>();
let maxInFlight = 0;

const llmServer = Bun.serve({
  port: 0,
  async fetch(request) {
    const tracked = inFlight;
    tracked.add(request);
    maxInFlight = Math.max(maxInFlight, inFlight.size);
    try {
      const delayMs = (delayQueue.shift() ?? 0) + holdMs;
      const response = await respond(request);
      if (delayMs > 0) await Bun.sleep(delayMs);
      return response;
    } finally {
      tracked.delete(request);
    }
  },
});

async function respond(request: Request): Promise<Response> {
  chatCallCount++;
  if (errorStatusQueue.length > 0) {
    const status = errorStatusQueue.shift() as number;
    return new Response("simulated provider error", { status });
  }
  if (htmlErrorStatusQueue.length > 0) {
    const status = htmlErrorStatusQueue.shift() as number;
    return new Response("<html><body>Service Unavailable</body></html>", { status });
  }
  if (malformedJsonNext) {
    malformedJsonNext = false;
    return new Response("not valid json", { status: 200 });
  }
  const body = (await request.json()) as {
    messages?: Array<{ role?: string; content?: string }>;
  };
  const userContent = body.messages?.find((m) => m.role === "user")?.content ?? "";
  let content = "";
  if (userContent.includes("N=")) {
    content = batchRawQueue.shift() ?? "";
  } else {
    content = singleRawQueue.shift() ?? "";
  }
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

const { extractGraphFromBodies, extractGraphFromBody } = await import("../../../src/llm/graph-extract");

// ── Shared fixtures ──────────────────────────────────────────────────────────

const SAMPLE_CONNECTION: LlmConnectionConfig = {
  endpoint: `http://localhost:${llmServer.port}/v1/chat/completions`,
  model: "llama3.2",
};
const SAMPLE_LLM = testLlmRunner(SAMPLE_CONNECTION, "test-graph-extraction");

/**
 * A raw TCP listener that accepts every connection and immediately closes it
 * without sending a response. `fetch` sees this as a mid-flight socket drop
 * ("The socket connection was closed unexpectedly."), which
 * `chatCompletionReal` maps to a `network_error` `LlmCallError` — used to
 * prove the storm guard covers unreachable/dying endpoints, not just non-2xx
 * responses from a live one. `deadConnAttempts` counts accepted connections,
 * standing in for `chatCallCount` against a server that can never send a real
 * HTTP response.
 */
let deadConnAttempts = 0;
const deadServer = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    open(socket) {
      deadConnAttempts++;
      socket.end();
    },
    data() {},
    close() {},
    error() {},
  },
});
const DEAD_CONNECTION: LlmConnectionConfig = {
  endpoint: `http://127.0.0.1:${deadServer.port}/v1/chat/completions`,
  model: "llama3.2",
};
const DEAD_LLM = testLlmRunner(DEAD_CONNECTION, "test-graph-extraction");

const AKM_CFG_WITH_GATE: AkmConfig = {
  configVersion: "0.9.0",
  semanticSearchMode: "auto" as const,
  engines: {
    test: { kind: "llm", ...SAMPLE_CONNECTION },
  },
  defaults: { engine: "test", llmEngine: "test" },
  index: { defaults: { engine: "test" } },
};

const AKM_CFG_DEAD: AkmConfig = {
  ...AKM_CFG_WITH_GATE,
  engines: {
    test: { kind: "llm", ...DEAD_CONNECTION },
  },
};

beforeEach(() => {
  chatCallCount = 0;
  batchRawQueue.length = 0;
  singleRawQueue.length = 0;
  errorStatusQueue.length = 0;
  htmlErrorStatusQueue.length = 0;
  malformedJsonNext = false;
  deadConnAttempts = 0;
  delayQueue.length = 0;
  holdMs = 0;
  inFlight = new Set();
  maxInFlight = 0;
});

afterAll(() => {
  llmServer.stop(true);
  deadServer.stop(true);
});

/** A body longer than one batch slot that splits into exactly two chunks. */
function longBody(first: string, second: string): string {
  return `# One\n\n${`${first} detail `.repeat(120)}\n\n# Two\n\n${`${second} detail `.repeat(120)}`;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("extractGraphFromBodies — unit", () => {
  test("graph_extraction defaults enabled when feature key is absent", async () => {
    singleRawQueue.push(JSON.stringify({ entities: ["Alpha", "Beta"], relations: [{ from: "Alpha", to: "Beta" }] }));

    const result = await extractGraphFromBody(SAMPLE_LLM, "Alpha references Beta.", undefined, {
      ...AKM_CFG_WITH_GATE,
    });

    expect(result.entities).toEqual(["Alpha", "Beta"]);
    expect(result.relations).toHaveLength(1);
    expect(chatCallCount).toBe(1);
  });

  test("graph_extraction explicit false disables calls and emits onFallback", async () => {
    const fallbackEvents: Array<{ feature: string; reason: string }> = [];

    const result = await extractGraphFromBody(
      SAMPLE_LLM,
      "Alpha references Beta.",
      undefined,
      {
        ...AKM_CFG_WITH_GATE,
        index: { ...AKM_CFG_WITH_GATE.index, graph: { enabled: false } },
      },
      (evt) => fallbackEvents.push({ feature: evt.feature, reason: evt.reason }),
    );

    // No model answer is a failure, never a cacheable "no entities" result.
    expect(result).toEqual({ entities: [], relations: [], status: "failed", reason: "llm_error" });
    expect(chatCallCount).toBe(0);
    expect(fallbackEvents).toEqual([{ feature: "graph_extraction", reason: "disabled" }]);
  });

  test("a single-asset call that times out is a failure, not an empty result", async () => {
    const fallbackReasons: string[] = [];
    delayQueue.push(400);

    const result = await extractGraphFromBody(
      testLlmRunner({ ...SAMPLE_CONNECTION, timeoutMs: 100 }, "test-graph-extraction"),
      "Alpha references Beta.",
      undefined,
      AKM_CFG_WITH_GATE,
      (evt) => fallbackReasons.push(evt.reason),
    );

    expect(result).toEqual({ entities: [], relations: [], status: "failed", reason: "llm_error" });
    expect(fallbackReasons).toEqual(["timeout"]);
  });

  test("an empty single-asset response is a failure, not an empty result", async () => {
    singleRawQueue.push("");

    const result = await extractGraphFromBody(SAMPLE_LLM, "Alpha references Beta.", undefined, AKM_CFG_WITH_GATE);

    expect(result).toEqual({ entities: [], relations: [], status: "failed", reason: "invalid_json" });
  });

  test("a batch call that times out fails every asset and makes no per-asset calls", async () => {
    const telemetry: Record<string, number> = {};
    delayQueue.push(400);
    singleRawQueue.push(JSON.stringify({ entities: ["Alpha"], relations: [] }));
    singleRawQueue.push(JSON.stringify({ entities: ["Beta"], relations: [] }));

    const results = await extractGraphFromBodies(
      testLlmRunner({ ...SAMPLE_CONNECTION, timeoutMs: 100 }, "test-graph-extraction"),
      ["Alpha body.", "Beta body."],
      undefined,
      AKM_CFG_WITH_GATE,
      undefined,
      { telemetry },
    );

    const failed: GraphExtraction = { entities: [], relations: [], status: "failed", reason: "llm_error" };
    expect(results).toEqual([failed, failed]);
    expect(chatCallCount).toBe(1);
    expect(telemetry.failureCount).toBe(2);
  });

  test("(a) successful 3-asset batch returns 3 correctly-matched results", async () => {
    const bodies = [
      "ServiceA integrates with ServiceB.",
      "Terraform provisions the ProdCluster.",
      "No graph content here.",
    ];

    batchRawQueue.push(
      JSON.stringify([
        {
          entities: ["ServiceA", "ServiceB"],
          relations: [{ from: "ServiceA", to: "ServiceB", type: "integrates with" }],
        },
        {
          entities: ["Terraform", "ProdCluster"],
          relations: [{ from: "Terraform", to: "ProdCluster", type: "provisions" }],
        },
        { entities: [], relations: [] },
      ]),
    );

    const results = await extractGraphFromBodies(SAMPLE_LLM, bodies, undefined, AKM_CFG_WITH_GATE);

    expect(results).toHaveLength(3);
    expect(results[0]?.entities).toEqual(["ServiceA", "ServiceB"]);
    expect(results[0]?.relations).toHaveLength(1);
    expect(results[0]?.relations[0]).toMatchObject({ from: "ServiceA", to: "ServiceB" });
    expect(results[1]?.entities).toEqual(["Terraform", "ProdCluster"]);
    expect(results[2]?.entities).toEqual([]);
    expect(results[2]?.relations).toHaveLength(0);
    // Only one LLM call was made (the batch call).
    expect(chatCallCount).toBe(1);
  });

  test("(b) partial response falls back gracefully for missing indices", async () => {
    const bodies = ["Body A mentioning Alpha.", "Body B mentioning Beta.", "Body C mentioning Gamma."];

    // Batch returns only 2 items (missing index 2).
    batchRawQueue.push(
      JSON.stringify([
        { entities: ["Alpha"], relations: [] },
        { entities: ["Beta"], relations: [] },
        // index 2 is intentionally omitted — partial failure
      ]),
    );

    // Individual fallback for index 2 (the single-asset prompt does NOT contain "N=").
    singleRawQueue.push(JSON.stringify({ entities: ["Gamma"], relations: [] }));

    const results = await extractGraphFromBodies(SAMPLE_LLM, bodies, undefined, AKM_CFG_WITH_GATE);

    expect(results).toHaveLength(3);
    expect(results[0]?.entities).toEqual(["Alpha"]);
    expect(results[1]?.entities).toEqual(["Beta"]);
    // Index 2 must have been filled by the fallback individual call.
    expect(results[2]?.entities).toEqual(["Gamma"]);
    // 1 batch call + 1 fallback individual call = 2 total.
    expect(chatCallCount).toBe(2);
  });

  test("(c) single body delegates to single-asset path and returns 1-element array", async () => {
    // When bodies.length === 1, extractGraphFromBodies delegates to extractGraphFromBody
    // which issues a NON-batch prompt (no "N=" prefix).
    singleRawQueue.push(
      JSON.stringify({
        entities: ["ServiceA", "ServiceB"],
        relations: [{ from: "ServiceA", to: "ServiceB", type: "uses" }],
      }),
    );

    const results = await extractGraphFromBodies(SAMPLE_LLM, ["ServiceA uses ServiceB."], undefined, AKM_CFG_WITH_GATE);

    expect(results).toHaveLength(1);
    expect(results[0]?.entities).toContain("ServiceA");
    expect(results[0]?.entities).toContain("ServiceB");
    expect(results[0]?.relations).toHaveLength(1);
    // Only one call was made, and it was NOT a batch call.
    expect(chatCallCount).toBe(1);
  });

  test("(c2) single-body result matches what extractGraphFromBody returns directly", async () => {
    const body = "Alpha depends on Beta.";
    const rawResp = JSON.stringify({
      entities: ["Alpha", "Beta"],
      relations: [{ from: "Alpha", to: "Beta", type: "depends on" }],
    });

    // Prime the queue twice — once for extractGraphFromBodies, once for extractGraphFromBody.
    singleRawQueue.push(rawResp);
    singleRawQueue.push(rawResp);

    const [batchResult] = await extractGraphFromBodies(SAMPLE_LLM, [body], undefined, AKM_CFG_WITH_GATE);
    const singleResult = await extractGraphFromBody(SAMPLE_LLM, body, undefined, AKM_CFG_WITH_GATE);

    expect(batchResult?.entities).toEqual(singleResult.entities);
    expect(batchResult?.relations).toHaveLength(singleResult.relations.length);
  });

  test("(d) empty bodies array returns empty array without LLM calls", async () => {
    const results = await extractGraphFromBodies(SAMPLE_LLM, [], undefined, AKM_CFG_WITH_GATE);
    expect(results).toHaveLength(0);
    expect(chatCallCount).toBe(0);
  });

  test("(e) all-whitespace bodies return all-empty extractions without LLM calls", async () => {
    const results = await extractGraphFromBodies(SAMPLE_LLM, ["   ", "\n\t\n", ""], undefined, AKM_CFG_WITH_GATE);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r?.entities).toEqual([]);
      expect(r?.relations).toEqual([]);
    }
    // All bodies are empty so nonEmptyBodies.length === 0 → no LLM call.
    expect(chatCallCount).toBe(0);
  });

  test("(f) genuinely non-array batch retries once, then falls back + surfaces the metric", async () => {
    const bodies = ["Alpha body.", "Beta body."];
    const telemetry: Record<string, number> = {};
    // First batch call AND the stricter retry both return a non-array object.
    batchRawQueue.push(JSON.stringify({ oops: true }));
    batchRawQueue.push(JSON.stringify({ still: "broken" }));
    // Individual fallback calls for both assets.
    singleRawQueue.push(JSON.stringify({ entities: ["Alpha"], relations: [] }));
    singleRawQueue.push(JSON.stringify({ entities: ["Beta"], relations: [] }));

    const results = await extractGraphFromBodies(SAMPLE_LLM, bodies, undefined, AKM_CFG_WITH_GATE, undefined, {
      telemetry,
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.entities).toEqual(["Alpha"]);
    expect(results[1]?.entities).toEqual(["Beta"]);
    // 1 batch call + 1 stricter retry + 2 fallback individual calls = 4 total.
    expect(chatCallCount).toBe(4);
    // The failure (after the retry) is counted and observable (#635 item 3).
    expect(telemetry.nonArrayBatchFailures).toBe(1);
    expect(telemetry.retryAttempts).toBe(1);
  });

  test("(g) batch response wrapped in prose with a leading object is salvaged (#635) — no fallback", async () => {
    const bodies = ["Alpha references Beta.", "Gamma uses Delta."];
    // Model wraps the valid array in prose AND emits a stray example object
    // first. Array-preferring salvage must recover the array — no per-asset
    // fallback, no retry.
    const validArray = JSON.stringify([
      { entities: ["Alpha", "Beta"], relations: [{ from: "Alpha", to: "Beta" }] },
      { entities: ["Gamma", "Delta"], relations: [{ from: "Gamma", to: "Delta" }] },
    ]);
    batchRawQueue.push(
      `Sure! For example {"from":"X","to":"Y"}.\nHere is the result:\n${validArray}\nHope that helps.`,
    );

    const results = await extractGraphFromBodies(SAMPLE_LLM, bodies, undefined, AKM_CFG_WITH_GATE);

    expect(results).toHaveLength(2);
    expect(results[0]?.entities).toEqual(["Alpha", "Beta"]);
    expect(results[1]?.entities).toEqual(["Gamma", "Delta"]);
    // Only the single batch call — salvage avoided both the retry and fallback.
    expect(chatCallCount).toBe(1);
  });

  test("(h) non-array batch recovered by the stricter retry — no per-asset fallback", async () => {
    const bodies = ["Alpha body.", "Beta body."];
    const telemetry: Record<string, number> = {};
    // First batch is non-array prose; the stricter retry returns a clean array.
    batchRawQueue.push("I cannot produce JSON, sorry.");
    batchRawQueue.push(
      JSON.stringify([
        { entities: ["Alpha"], relations: [] },
        { entities: ["Beta"], relations: [] },
      ]),
    );

    const results = await extractGraphFromBodies(SAMPLE_LLM, bodies, undefined, AKM_CFG_WITH_GATE, undefined, {
      telemetry,
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.entities).toEqual(["Alpha"]);
    expect(results[1]?.entities).toEqual(["Beta"]);
    // 1 batch + 1 stricter retry, no per-asset fallback.
    expect(chatCallCount).toBe(2);
    expect(telemetry.retryAttempts).toBe(1);
    // The retry recovered the batch → no surfaced non-array failure.
    expect(telemetry.nonArrayBatchFailures ?? 0).toBe(0);
  });

  test("(i) provider_error (5xx) on the batch call does not fall back per-asset (R2)", async () => {
    const bodies = ["Alpha body.", "Beta body."];
    // Provider is dead: both the first attempt and client.ts's single
    // built-in retry (5xx is retryable) return 500. No per-asset fallback
    // calls, and no stricter-reprompt retry, should follow.
    errorStatusQueue.push(500, 500);

    const results = await extractGraphFromBodies(SAMPLE_LLM, bodies, undefined, AKM_CFG_WITH_GATE);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ entities: [], relations: [], status: "failed", reason: "llm_error" });
    expect(results[1]).toEqual({ entities: [], relations: [], status: "failed", reason: "llm_error" });
    // 1 initial attempt + 1 built-in transient retry = 2. No per-asset fallback.
    expect(chatCallCount).toBe(2);
  });

  test("(i2) network_error (dropped connection) on the batch call does not fall back per-asset", async () => {
    const bodies = ["Alpha body.", "Beta body."];

    const results = await extractGraphFromBodies(DEAD_LLM, bodies, undefined, AKM_CFG_DEAD);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ entities: [], relations: [], status: "failed", reason: "llm_error" });
    expect(results[1]).toEqual({ entities: [], relations: [], status: "failed", reason: "llm_error" });
    // The dropped-connection message matches client.ts's connection-drop
    // heuristic, so the batch call itself pays one built-in transient retry
    // (2 accepted connections). If the fallback ran too, each of the 2
    // per-asset calls would add its own retry pair, for 6 total.
    expect(deadConnAttempts).toBe(2);
  });

  test("(i3) provider_html_error (5xx with an HTML body) on the batch call does not fall back per-asset", async () => {
    const bodies = ["Alpha body.", "Beta body."];
    // provider_html_error is not in client.ts's isRetryable set, so only the
    // single batch attempt is made — no built-in transient retry.
    htmlErrorStatusQueue.push(503);

    const results = await extractGraphFromBodies(SAMPLE_LLM, bodies, undefined, AKM_CFG_WITH_GATE);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ entities: [], relations: [], status: "failed", reason: "llm_error" });
    expect(results[1]).toEqual({ entities: [], relations: [], status: "failed", reason: "llm_error" });
    // 1 initial attempt only. No per-asset fallback.
    expect(chatCallCount).toBe(1);
  });

  test("(i4) parse_error (malformed JSON envelope) on the batch call DOES fall back per-asset", async () => {
    const bodies = ["Alpha body.", "Beta body."];
    // The outer HTTP response body itself is not valid JSON — not a transport
    // failure, so the per-asset fallback must still run.
    malformedJsonNext = true;
    singleRawQueue.push(JSON.stringify({ entities: ["Alpha"], relations: [] }));
    singleRawQueue.push(JSON.stringify({ entities: ["Beta"], relations: [] }));

    const results = await extractGraphFromBodies(SAMPLE_LLM, bodies, undefined, AKM_CFG_WITH_GATE);

    expect(results).toHaveLength(2);
    expect(results[0]?.entities).toEqual(["Alpha"]);
    expect(results[1]?.entities).toEqual(["Beta"]);
    // 1 batch call + 2 per-asset fallback calls = 3.
    expect(chatCallCount).toBe(3);
  });

  test("with batching disabled, an oversized body is extracted once", async () => {
    singleRawQueue.push(
      JSON.stringify({ entities: ["Alpha"], relations: [] }),
      JSON.stringify({ entities: ["Gamma"], relations: [] }),
      JSON.stringify({ entities: ["Small"], relations: [] }),
    );

    const results = await extractGraphFromBodies(
      SAMPLE_LLM,
      [longBody("Alpha", "Gamma"), "Small body."],
      undefined,
      AKM_CFG_WITH_GATE,
      undefined,
      { batchState: { batchingDisabled: true, nonArrayBatchFailures: 2 } },
    );

    // Two chunk calls for the long body and one for the small one.
    expect(chatCallCount).toBe(3);
    expect(results.map((r) => r.entities)).toEqual([["Alpha", "Gamma"], ["Small"]]);
  });

  test("per-asset fallback calls stay within the runner's concurrency", async () => {
    holdMs = 30;
    batchRawQueue.push(JSON.stringify({ oops: true }), JSON.stringify({ still: "broken" }));
    for (const name of ["Alpha", "Beta", "Gamma"]) {
      singleRawQueue.push(JSON.stringify({ entities: [name], relations: [] }));
    }

    const results = await extractGraphFromBodies(
      SAMPLE_LLM,
      ["Alpha body.", "Beta body.", "Gamma body."],
      undefined,
      AKM_CFG_WITH_GATE,
    );

    expect(results.map((r) => r.entities)).toEqual([["Alpha"], ["Beta"], ["Gamma"]]);
    expect(maxInFlight).toBe(1);
  });

  test("oversized bodies are extracted within the runner's concurrency", async () => {
    holdMs = 30;
    for (let i = 0; i < 4; i++) singleRawQueue.push(JSON.stringify({ entities: [`E${i}`], relations: [] }));
    batchRawQueue.push(JSON.stringify([{ entities: ["Small"], relations: [] }]));

    await extractGraphFromBodies(
      SAMPLE_LLM,
      [longBody("Alpha", "Gamma"), longBody("Beta", "Delta"), "Small body."],
      undefined,
      AKM_CFG_WITH_GATE,
    );

    expect(chatCallCount).toBe(5);
    expect(maxInFlight).toBe(1);
  });

  test("a batch makes its per-asset calls one at a time, whatever the runner's concurrency", async () => {
    // The pass runs batches side by side up to the runner's concurrency, so a
    // batch fanning out on its own would multiply it (GR-D14 follow-up).
    holdMs = 30;
    batchRawQueue.push(JSON.stringify({ oops: true }), JSON.stringify({ still: "broken" }));
    for (const name of ["Alpha", "Beta", "Gamma"]) {
      singleRawQueue.push(JSON.stringify({ entities: [name], relations: [] }));
    }

    await extractGraphFromBodies(
      testLlmRunner({ ...SAMPLE_CONNECTION, concurrency: 2 }, "test-graph-extraction"),
      ["Alpha body.", "Beta body.", "Gamma body."],
      undefined,
      AKM_CFG_WITH_GATE,
    );

    expect(chatCallCount).toBe(5);
    expect(maxInFlight).toBe(1);
  });

  test("normalizes entities/relation types and keeps confidence when provided", async () => {
    const body = "ServiceA uses ServiceB.";
    singleRawQueue.push(
      JSON.stringify({
        entities: ["  ServiceA  ", "serviceb", "ServiceA"],
        relations: [{ from: "ServiceA", to: "serviceb", type: "USE", confidence: 1.4 }],
        confidence: -0.2,
      }),
    );

    const [result] = await extractGraphFromBodies(SAMPLE_LLM, [body], undefined, AKM_CFG_WITH_GATE);

    expect(result?.entities).toEqual(["ServiceA", "serviceb"]);
    expect(result?.relations).toHaveLength(1);
    expect(result?.relations[0]).toMatchObject({ from: "ServiceA", to: "serviceb", type: "uses", confidence: 1 });
    expect(result?.confidence).toBe(0);
  });

  test("a long body with a failed chunk is failed, keeping what the other chunks found", async () => {
    // The second chunk's empty response is a failure; the body must be
    // retried, so the merge may not report it as extracted (and cacheable).
    singleRawQueue.push(JSON.stringify({ entities: ["Alpha"], relations: [] }), "");

    const result = await extractGraphFromBody(SAMPLE_LLM, longBody("Alpha", "Gamma"), undefined, AKM_CFG_WITH_GATE);

    expect(chatCallCount).toBe(2);
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("invalid_json");
    expect(result.entities).toEqual(["Alpha"]);
  });

  test("long bodies are chunked and merged instead of truncating to a fixed prefix", async () => {
    const longBody = `# One\n\n${"Alpha detail ".repeat(120)}\n\n# Two\n\n${"Gamma detail ".repeat(120)}`;
    singleRawQueue.push(
      JSON.stringify({ entities: ["Alpha", "Beta"], relations: [{ from: "Alpha", to: "Beta", type: "uses" }] }),
    );
    singleRawQueue.push(
      JSON.stringify({ entities: ["Gamma", "Delta"], relations: [{ from: "Gamma", to: "Delta", type: "depends on" }] }),
    );

    const result = await extractGraphFromBody(SAMPLE_LLM, longBody, undefined, AKM_CFG_WITH_GATE);

    expect(chatCallCount).toBe(2);
    expect(result.chunkCount).toBe(2);
    expect(result.entities).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
    expect(result.relations).toHaveLength(2);
  });
});
