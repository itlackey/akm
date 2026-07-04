// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmHealth } from "../src/commands/health";
import { buildHealthHtmlReplacements, type HealthHtmlReportOptions } from "../src/commands/health/html-report";
import type { AkmHealthResult } from "../src/commands/health/types";
import type { AkmImproveResult } from "../src/commands/improve/improve";
import { appendEvent } from "../src/core/events";
import { openStateDatabase } from "../src/core/state-db";
import { renderHtml, resolveTemplatePath } from "../src/output/html-render";
import { recordImproveRun } from "../src/storage/repositories/improve-runs-repository";
import { type Cleanup, type IsolatedAkmStorage, makeSandboxDir, withIsolatedAkmStorage } from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;
let cleanup: Cleanup = () => {};

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** Seed one realistic improve run into the isolated state.db. */
function seedImproveRun(id = "run-html-1", ok = true): void {
  const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const completedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const db = openStateDatabase();
  try {
    recordImproveRun(db, {
      id,
      startedAt,
      completedAt,
      stashDir: storage.stashDir,
      dryRun: false,
      profile: null,
      scopeMode: "all",
      scopeValue: null,
      guidance: null,
      ok,
      result: {
        schemaVersion: 1,
        ok,
        scope: { mode: "all" },
        dryRun: false,
        memorySummary: { eligible: 8, derived: 3 },
        plannedRefs: [{ ref: "memory:a" }, { ref: "memory:b" }],
        actions: [
          { ref: "memory:a", mode: "reflect", result: { ok: true } },
          { ref: "memory:b", mode: "distill", result: { outcome: "queued" } },
          { ref: "memory:c", mode: "distill-skipped", result: { reason: "type-filter" } },
        ],
        consolidation: {
          processed: 4,
          promoted: ["memory:p1", "memory:p2"],
          merged: 1,
          deleted: 0,
          contradicted: 0,
          judgedNoAction: 1,
          failedChunks: 0,
          totalChunks: 2,
          durationMs: 60_000,
        },
        memoryInference: {
          considered: 5,
          cacheHits: 1,
          writtenFacts: 2,
          skippedNoFacts: 2,
          durationMs: 30_000,
        },
        memoryInferenceDurationMs: 30_000,
        graphExtraction: {
          quality: { extractedFiles: 2 },
          totalEntities: 12,
          totalRelations: 7,
          telemetry: { cacheHits: 3, cacheMisses: 1, truncationCount: 0, failureCount: 0, retryAttempts: 0 },
        },
        graphExtractionDurationMs: 20_000,
      } as unknown as AkmImproveResult,
    });
  } finally {
    db.close();
  }
}

function buildOpts(partial: Partial<HealthHtmlReportOptions> = {}): HealthHtmlReportOptions {
  return {
    window: "24h",
    compare: "24h",
    proposals: [],
    echarts: "cdn",
    ...partial,
  };
}

function healthResult(): AkmHealthResult {
  return akmHealth({ since: "24h", groupBy: "run" });
}

describe("buildHealthHtmlReplacements", () => {
  test("the replacement token set exactly matches the health template tokens", () => {
    seedImproveRun();
    const replacements = buildHealthHtmlReplacements(healthResult(), buildOpts());

    const templateTokens = new Set(fs.readFileSync(resolveTemplatePath("health"), "utf8").match(/%%[A-Z_]+%%/g) ?? []);
    const replacementTokens = new Set(Object.keys(replacements));

    // 18 tokens: COMMANDS_HTML was removed when the "Command Set Used" section
    // was dropped from the report. Previously 19.
    expect(replacementTokens.size).toBe(18);
    expect([...replacementTokens].sort()).toEqual([...templateTokens].sort());
    expect(replacementTokens.has("%%OVERALL_STATUS%%")).toBe(false);
    expect(replacementTokens.has("%%ACTION_ITEMS_HTML%%")).toBe(true);
    expect(replacementTokens.has("%%LLM_BY_STAGE_JSON%%")).toBe(true);
    expect(replacementTokens.has("%%SLICE_OPTIONS_HTML%%")).toBe(true);
    expect(replacementTokens.has("%%AKM_VERSION%%")).toBe(true);
    expect(replacementTokens.has("%%ADVISORY_CARDS_HTML%%")).toBe(false);
    expect(replacementTokens.has("%%WATCH_ITEMS_HTML%%")).toBe(false);
  });

  test("akm version is stamped and the hidden distill reason is excluded from the chart", () => {
    seedImproveRun("run-html-ver");
    const replacements = buildHealthHtmlReplacements(healthResult(), buildOpts());
    // Version token is non-empty (semver-ish), used in header + footer.
    expect(replacements["%%AKM_VERSION%%"]).toMatch(/\d+\.\d+/);
    // The steady-state "no new signal since last proposal" reason is filtered
    // out of the distill skip-reason chart categories.
    expect(replacements["%%DISTILL_REASONS_JSON%%"]).not.toContain("no new signal since last proposal");
  });

  test("slice options are derived from the report window (not hard-coded days)", () => {
    seedImproveRun();
    // 24h window → only sub-day slices (6h/12h), no day-based options, default All.
    const opts24 = buildHealthHtmlReplacements(healthResult(), buildOpts({ window: "24h" }));
    const slices24 = opts24["%%SLICE_OPTIONS_HTML%%"];
    expect(slices24).toContain('value="all" selected>All (24h)');
    expect(slices24).toContain("Last 12h");
    expect(slices24).toContain("Last 6h");
    expect(slices24).not.toContain("Last 1d");
    expect(slices24).not.toContain("21d");

    // 7d window → day-based sub-windows, capped below the window.
    const opts7 = buildHealthHtmlReplacements(healthResult(), buildOpts({ window: "7d" }));
    const slices7 = opts7["%%SLICE_OPTIONS_HTML%%"];
    expect(slices7).toContain("All (7d)");
    expect(slices7).toContain("Last 3d");
    expect(slices7).toContain("Last 1d");
    expect(slices7).not.toContain("Last 7d"); // not strictly shorter than the window
    expect(slices7).not.toContain("Last 14d");
  });

  test("run taskId from the health summary flows into the report payload (not scope)", () => {
    seedImproveRun("run-html-task");
    const result = healthResult();
    // Stamp a taskId on the summary as akmHealth's task_history join would.
    if (result.runs?.[0]) (result.runs[0] as { taskId: string }).taskId = "akm-improve-frequent";
    const replacements = buildHealthHtmlReplacements(result, buildOpts());
    expect(replacements["%%RUNS_JS_CONST%%"]).toContain('"taskId":"akm-improve-frequent"');
  });

  test("rendering the health template leaves no unreplaced tokens", () => {
    seedImproveRun();
    const replacements = buildHealthHtmlReplacements(healthResult(), buildOpts());
    const html = renderHtml(resolveTemplatePath("health"), replacements);
    expect(html).not.toMatch(/%%[A-Z_]+%%/);
    expect(html).toContain("AKM Health Report");
    expect(html).toContain('id="chartWallTime"');
  });

  test("run data and aggregates flow into the chart payload and KPI cards", () => {
    seedImproveRun("run-html-kpi");
    const replacements = buildHealthHtmlReplacements(healthResult(), buildOpts());

    expect(replacements["%%RUN_COUNT%%"]).toBe("1");
    expect(replacements["%%RUNS_JS_CONST%%"]).toStartWith("const RUNS = [");
    expect(replacements["%%RUNS_JS_CONST%%"]).toContain('"id":"run-html-kpi"');
    expect(replacements["%%RUNS_JS_CONST%%"]).toContain('"promoted":2');
    expect(replacements["%%RUNS_JS_CONST%%"]).toContain('"miWritten":2');
    expect(replacements["%%DISTILL_REASONS_JSON%%"]).toBe('["type-filter"]');
    expect(replacements["%%KPI_CARDS_HTML%%"]).toContain("Graph Entities");
    expect(replacements["%%KPI_CARDS_HTML%%"]).toContain("12");
    // GENERATED_AT derives from the latest run, not wall-clock — deterministic.
    expect(replacements["%%GENERATED_AT%%"]).not.toBe("");
    const again = buildHealthHtmlReplacements(healthResult(), buildOpts());
    expect(again["%%GENERATED_AT%%"]).toBe(replacements["%%GENERATED_AT%%"]);
  });

  test("#576 real LLM token/time aggregate renders into the KPI card and summary rows", () => {
    seedImproveRun("run-html-llm");
    // Seed two llm_usage events into the sandboxed state.db (default path under
    // the isolated XDG_DATA_HOME); akmHealth aggregates them into metrics.llmUsage.
    appendEvent({
      eventType: "llm_usage",
      metadata: {
        stage: "reflect",
        model: "m",
        durationMs: 1000,
        promptTokens: 100,
        completionTokens: 40,
        totalTokens: 140,
        reasoningTokens: 10,
      },
    });
    appendEvent({
      eventType: "llm_usage",
      metadata: {
        stage: "distill",
        model: "m",
        durationMs: 2000,
        promptTokens: 60,
        completionTokens: 20,
        totalTokens: 80,
        reasoningTokens: 5,
      },
    });

    const replacements = buildHealthHtmlReplacements(healthResult(), buildOpts());

    // KPI card: total tokens (140+80=220), call count (2), reasoning (10+5=15).
    expect(replacements["%%KPI_CARDS_HTML%%"]).toContain("🧠 LLM Work");
    expect(replacements["%%KPI_CARDS_HTML%%"]).toContain("220");
    expect(replacements["%%KPI_CARDS_HTML%%"]).toContain("2 calls");
    expect(replacements["%%KPI_CARDS_HTML%%"]).toContain("15 reasoning");

    // Summary rows expose the per-field breakdown (real tokens, not a GPU proxy).
    const rows = replacements["%%SUMMARY_ROWS_HTML%%"];
    expect(rows).toContain("LLM total tokens");
    expect(rows).toContain("LLM prompt tokens");
    expect(rows).toContain("LLM completion tokens");
    expect(rows).toContain("LLM reasoning tokens");
    expect(rows).toContain("LLM calls");
  });

  test("pending proposals are listed, counted, and HTML-escaped", () => {
    seedImproveRun();
    const replacements = buildHealthHtmlReplacements(
      healthResult(),
      buildOpts({
        proposals: [
          { ref: "lesson:<script>alert(1)</script>", source: "extract", createdAt: "2026-06-10T12:00:00.000Z" },
          { ref: "memory:safe", source: "consolidate", createdAt: "2026-06-10T13:00:00.000Z" },
        ],
      }),
    );
    expect(replacements["%%PROPOSAL_COUNT%%"]).toBe("2");
    expect(replacements["%%PROPOSAL_ROWS_HTML%%"]).toContain("&lt;script&gt;");
    expect(replacements["%%PROPOSAL_ROWS_HTML%%"]).not.toContain("<script>alert");
    expect(replacements["%%PROPOSAL_ROWS_HTML%%"]).toContain("tag-extract");
    expect(replacements["%%PROPOSAL_ROWS_HTML%%"]).toContain("tag-consolidate");
    // Advisories + what-to-watch are now merged into a single Action Items list.
    expect(replacements["%%ACTION_ITEMS_HTML%%"]).toContain("Drain 2 pending proposals");
    expect(replacements["%%ACTION_ITEMS_HTML%%"]).toContain("akm proposal list");
  });

  test("deltas drive the trend pills in the executive summary", () => {
    seedImproveRun();
    const replacements = buildHealthHtmlReplacements(
      healthResult(),
      buildOpts({
        deltas: {
          "improve.consolidation.promoted": { from: 10, to: 25, pctChange: 150 },
          "improve.wallTime.medianMs": { from: 0, to: 60_000, pctChange: "+inf" },
        },
      }),
    );
    expect(replacements["%%EXEC_SUMMARY_HTML%%"]).toContain("▲ +150%");
    // +inf on a lower-is-better latency metric renders as a bad "new" pill.
    expect(replacements["%%EXEC_SUMMARY_HTML%%"]).toContain("▲ new");
    // promoted up → output volume trends up → overall improving.
    expect(replacements["%%EXEC_SUMMARY_HTML%%"]).toContain("<b>improving</b>");
  });

  test("echarts cdn mode emits a script src tag; inline mode embeds the lib escaped", () => {
    seedImproveRun();
    const result = healthResult();

    const cdn = buildHealthHtmlReplacements(result, buildOpts({ echarts: "cdn" }));
    expect(cdn["%%ECHARTS_TAG%%"]).toBe(
      '<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>',
    );

    const lib = makeSandboxDir("akm-echarts-fixture-");
    try {
      const libPath = path.join(lib.dir, "echarts.min.js");
      fs.writeFileSync(libPath, "var echarts={};/*</script>*/");
      const inline = buildHealthHtmlReplacements(result, buildOpts({ echarts: "inline", echartsLibPath: libPath }));
      expect(inline["%%ECHARTS_TAG%%"]).toStartWith("<script>");
      expect(inline["%%ECHARTS_TAG%%"]).toContain("var echarts={};");
      // Embedded payload must not be able to close the script tag early.
      expect(inline["%%ECHARTS_TAG%%"]).toContain("<\\/script>*/");
    } finally {
      lib.cleanup();
    }
  });

  test("empty window renders the no-runs snapshot and pass cards", () => {
    const replacements = buildHealthHtmlReplacements(healthResult(), buildOpts());
    expect(replacements["%%RUN_COUNT%%"]).toBe("0");
    expect(replacements["%%EXEC_SUMMARY_HTML%%"]).toContain("No runs in window");
    expect(replacements["%%PROPOSAL_ROWS_HTML%%"]).toContain("No pending proposals");
    expect(replacements["%%LLM_BY_STAGE_JSON%%"]).toBe("{}");
    const html = renderHtml(resolveTemplatePath("health"), replacements);
    expect(html).not.toMatch(/%%[A-Z_]+%%/);
  });

  test("taskId falls back to 'manual' when no scheduled improve task matches the run", () => {
    seedImproveRun("run-html-task");
    const replacements = buildHealthHtmlReplacements(healthResult(), buildOpts());
    // The seeded run has no enclosing akm-improve task_history row, so the
    // task_history join yields "manual" — NOT the run's scope.mode ("all").
    expect(replacements["%%RUNS_JS_CONST%%"]).toContain('"taskId":"manual"');
    expect(replacements["%%RUNS_JS_CONST%%"]).not.toContain('"taskId":"all"');
  });

  test("per-stage LLM token aggregate flows into the LLM_BY_STAGE_JSON token", () => {
    seedImproveRun("run-html-stages");
    appendEvent({
      eventType: "llm_usage",
      metadata: {
        stage: "reflect",
        model: "m",
        durationMs: 1000,
        promptTokens: 100,
        completionTokens: 40,
        totalTokens: 140,
        reasoningTokens: 10,
      },
    });
    const replacements = buildHealthHtmlReplacements(healthResult(), buildOpts());
    const byStage = JSON.parse(replacements["%%LLM_BY_STAGE_JSON%%"]) as Record<
      string,
      { promptTokens: number; completionTokens: number; reasoningTokens: number }
    >;
    expect(byStage.reflect).toBeDefined();
    expect(byStage.reflect.promptTokens).toBe(100);
    expect(byStage.reflect.completionTokens).toBe(40);
    expect(byStage.reflect.reasoningTokens).toBe(10);
    // The template wires the by-stage chart panel.
    const html = renderHtml(resolveTemplatePath("health"), replacements);
    expect(html).toContain('id="chartLlmStages"');
    expect(html).toContain("LLM_BY_STAGE");
  });

  test("a synthesized verdict line renders under the exec summary", () => {
    seedImproveRun("run-html-verdict", false); // failed run → drivers include failures
    const replacements = buildHealthHtmlReplacements(healthResult(), buildOpts());
    const exec = replacements["%%EXEC_SUMMARY_HTML%%"];
    expect(exec).toContain("Verdict:");
    expect(exec).toContain('class="verdict');
    expect(exec).toContain("1 failed run");
  });

  test("advisories and what-to-watch merge into one prioritized, de-duplicated Action Items list", () => {
    seedImproveRun("run-html-actions", false); // failed run
    const replacements = buildHealthHtmlReplacements(
      healthResult(),
      buildOpts({
        proposals: [{ ref: "memory:x", source: "extract", createdAt: "2026-06-10T12:00:00.000Z" }],
      }),
    );
    const actions = replacements["%%ACTION_ITEMS_HTML%%"];
    // Failed-run item (P1) and drain-proposals item (P2) both present, once each.
    expect(actions).toContain("failed run");
    expect(actions).toContain("Drain 1 pending proposal");
    expect((actions.match(/Drain 1 pending proposal/g) ?? []).length).toBe(1);
    // Priority badges present and P1 sorts before P2 in the output.
    expect(actions).toContain('class="prio p1"');
    expect(actions).toContain('class="prio p2"');
    expect(actions.indexOf("p1")).toBeLessThan(actions.indexOf("p2"));
  });

  test("the rendered template includes the filter bar, Task column, and dataZoom", () => {
    seedImproveRun("run-html-filterbar");
    const replacements = buildHealthHtmlReplacements(healthResult(), buildOpts());
    const html = renderHtml(resolveTemplatePath("health"), replacements);
    expect(html).toContain('class="filter-bar"');
    expect(html).toContain('id="taskFilter"');
    expect(html).toContain("<th>Task</th>");
    expect(html).toContain("dataZoom");
    expect(html).toContain("getInstanceByDom");
    expect(html).toContain("Action Items");
  });
});
