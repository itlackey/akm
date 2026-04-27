/**
 * Unit tests for per-asset attribution (spec §6.5).
 *
 * Coverage:
 *   • `extractAssetLoads` — parses both events.jsonl event objects and
 *     verifierStdout substrings (literal `akm show` and tool-call JSON).
 *   • `computePerAssetAttribution` — counts pass/fail loads, computes pass
 *     rate, sorts by load count then pass rate then ref.
 *   • `runMaskedCorpus` — picks top-N, masks each asset from the source
 *     fixture, computes marginal contribution. Cost accounting verified
 *     against the injected runUtility callable. Source fixture is untouched.
 *   • CLI `attribute --top` clamping when top exceeds asset count.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAttributeCli } from "./cli";
import type { TaskMetadata } from "./corpus";
import type { RunResult } from "./driver";
import {
  type Arm,
  computePerAssetAttribution,
  extractAssetLoads,
  type PerAssetAttribution,
  type RunUtilityOptionsForMask,
  runMaskedCorpus,
} from "./metrics";
import { renderAttributionTable, type UtilityRunReport } from "./report";

function makeRun(overrides: Partial<RunResult> = {}): RunResult {
  return {
    schemaVersion: 1,
    taskId: "t",
    arm: "akm",
    seed: 0,
    model: "m",
    outcome: "pass",
    tokens: { input: 0, output: 0 },
    wallclockMs: 0,
    trajectory: { correctAssetLoaded: null, feedbackRecorded: null },
    events: [],
    verifierStdout: "",
    verifierExitCode: 0,
    assetsLoaded: [],
    ...overrides,
  };
}

function makeReport(akmRuns: RunResult[]): UtilityRunReport {
  return {
    timestamp: "2026-04-27T00:00:00Z",
    branch: "test",
    commit: "abc",
    model: "m",
    corpus: { domains: 1, tasks: 1, slice: "all", seedsPerArm: akmRuns.length },
    aggregateNoakm: { passRate: 0, tokensPerPass: null, wallclockMs: 0 },
    aggregateAkm: {
      passRate: akmRuns.filter((r) => r.outcome === "pass").length / Math.max(1, akmRuns.length),
      tokensPerPass: null,
      wallclockMs: 0,
    },
    aggregateDelta: { passRate: 0, tokensPerPass: null, wallclockMs: 0 },
    trajectoryAkm: { correctAssetLoaded: null, feedbackRecorded: 0 },
    tasks: [],
    warnings: [],
    akmRuns,
  };
}

describe("extractAssetLoads", () => {
  test("parses literal `akm show <ref>` from verifierStdout", () => {
    const r = makeRun({ verifierStdout: "tool: akm show skill:docker-homelab\nresult: ok\n" });
    expect(extractAssetLoads(r)).toEqual(["skill:docker-homelab"]);
  });

  test('parses tool-call JSON form `args:["show","<ref>"]`', () => {
    const r = makeRun({
      verifierStdout: '{"command":"akm","args":["show","skill:az-cli"]} done',
    });
    expect(extractAssetLoads(r)).toEqual(["skill:az-cli"]);
  });

  test("dedupes refs and preserves first-seen order", () => {
    const r = makeRun({
      verifierStdout: "akm show skill:foo\nakm show skill:bar\nakm show skill:foo\n",
    });
    expect(extractAssetLoads(r)).toEqual(["skill:foo", "skill:bar"]);
  });

  test("parses ref from events.jsonl `show` event", () => {
    const r = makeRun({
      events: [
        {
          schemaVersion: 1,
          id: 0,
          ts: "2026-04-27T00:00:00Z",
          eventType: "show",
          ref: "skill:from-event",
        },
      ],
    });
    expect(extractAssetLoads(r)).toEqual(["skill:from-event"]);
  });

  test("merges events + stdout sources, dedupes across sources", () => {
    const r = makeRun({
      events: [
        {
          schemaVersion: 1,
          id: 0,
          ts: "2026-04-27T00:00:00Z",
          eventType: "show",
          ref: "skill:shared",
        },
      ],
      verifierStdout: "akm show skill:shared\nakm show skill:only-stdout\n",
    });
    expect(extractAssetLoads(r)).toEqual(["skill:shared", "skill:only-stdout"]);
  });

  test("returns empty array when no `akm show` invocations are present", () => {
    const r = makeRun({ verifierStdout: "agent: I will not search\n" });
    expect(extractAssetLoads(r)).toEqual([]);
  });

  test("supports origin-prefixed refs (`team//skill:foo`)", () => {
    const r = makeRun({ verifierStdout: "akm show team//skill:foo\n" });
    expect(extractAssetLoads(r)).toEqual(["team//skill:foo"]);
  });
});

describe("computePerAssetAttribution", () => {
  test("counts pass/fail loads and computes pass rate", () => {
    const runs: RunResult[] = [
      // skill:a: 2 pass, 1 fail → 0.667
      makeRun({ outcome: "pass", assetsLoaded: ["skill:a"] }),
      makeRun({ outcome: "pass", assetsLoaded: ["skill:a"] }),
      makeRun({ outcome: "fail", assetsLoaded: ["skill:a"] }),
      // skill:b: 0 pass, 2 fail → 0
      makeRun({ outcome: "fail", assetsLoaded: ["skill:b"] }),
      makeRun({ outcome: "fail", assetsLoaded: ["skill:b"] }),
      // skill:c: 1 pass, 0 fail → 1.0
      makeRun({ outcome: "pass", assetsLoaded: ["skill:c"] }),
    ];
    const attr = computePerAssetAttribution(makeReport(runs));
    expect(attr.totalAkmRuns).toBe(6);
    const a = attr.rows.find((r) => r.assetRef === "skill:a");
    expect(a).toMatchObject({ loadCount: 3, loadCountPassing: 2, loadCountFailing: 1 });
    expect(a?.loadPassRate).toBeCloseTo(2 / 3, 5);
    const b = attr.rows.find((r) => r.assetRef === "skill:b");
    expect(b?.loadPassRate).toBe(0);
    const c = attr.rows.find((r) => r.assetRef === "skill:c");
    expect(c?.loadPassRate).toBe(1);
  });

  test("orders rows by load count desc, pass rate desc, ref asc", () => {
    const runs: RunResult[] = [
      // skill:high-load-fail — 4 loads, all fail
      makeRun({ outcome: "fail", assetsLoaded: ["skill:high-load-fail"] }),
      makeRun({ outcome: "fail", assetsLoaded: ["skill:high-load-fail"] }),
      makeRun({ outcome: "fail", assetsLoaded: ["skill:high-load-fail"] }),
      makeRun({ outcome: "fail", assetsLoaded: ["skill:high-load-fail"] }),
      // skill:high-load-pass — 4 loads, all pass (same count, higher pass_rate → first)
      makeRun({ outcome: "pass", assetsLoaded: ["skill:high-load-pass"] }),
      makeRun({ outcome: "pass", assetsLoaded: ["skill:high-load-pass"] }),
      makeRun({ outcome: "pass", assetsLoaded: ["skill:high-load-pass"] }),
      makeRun({ outcome: "pass", assetsLoaded: ["skill:high-load-pass"] }),
      // skill:low-load — 1 load, pass
      makeRun({ outcome: "pass", assetsLoaded: ["skill:low-load"] }),
    ];
    const attr = computePerAssetAttribution(makeReport(runs));
    expect(attr.rows.map((r) => r.assetRef)).toEqual([
      "skill:high-load-pass", // count=4, rate=1
      "skill:high-load-fail", // count=4, rate=0
      "skill:low-load", // count=1
    ]);
  });

  test("returns empty rows when no assets were loaded", () => {
    const runs = [makeRun({ outcome: "pass", assetsLoaded: [] })];
    const attr = computePerAssetAttribution(makeReport(runs));
    expect(attr.rows).toEqual([]);
    expect(attr.totalAkmRuns).toBe(1);
  });
});

describe("renderAttributionTable", () => {
  test("highlights well-used-and-working vs well-used-and-not-working", () => {
    const attr: PerAssetAttribution = {
      totalAkmRuns: 10,
      rows: [
        { assetRef: "skill:works", loadCount: 8, loadCountPassing: 7, loadCountFailing: 1, loadPassRate: 7 / 8 },
        { assetRef: "skill:broken", loadCount: 6, loadCountPassing: 1, loadCountFailing: 5, loadPassRate: 1 / 6 },
        { assetRef: "skill:rare", loadCount: 1, loadCountPassing: 1, loadCountFailing: 0, loadPassRate: 1 },
      ],
    };
    const md = renderAttributionTable(attr);
    expect(md).toContain("Well-used and working");
    expect(md).toContain("`skill:works`");
    expect(md).toContain("Well-used and NOT working");
    expect(md).toContain("`skill:broken`");
    // skill:rare is below the high-load cutoff so should NOT appear in the working callout (only in the table).
    const workingSection = md.split("Well-used and working")[1]?.split("Well-used and NOT working")[0] ?? "";
    expect(workingSection).not.toContain("`skill:rare`");
  });

  test("renders empty-state message when no rows", () => {
    const md = renderAttributionTable({ totalAkmRuns: 0, rows: [] });
    expect(md).toContain("No assets were loaded");
  });
});

describe("runMaskedCorpus", () => {
  function makeFixturesRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-bench-attr-fixtures-"));
    // fixture A: two assets in one .stash.json
    const fixA = path.join(root, "fixtureA");
    fs.mkdirSync(path.join(fixA, "skills"), { recursive: true });
    fs.writeFileSync(
      path.join(fixA, "MANIFEST.json"),
      JSON.stringify({ name: "fixtureA", description: "x", purpose: "x", assets: { skill: 2 }, consumers: [] }),
    );
    fs.writeFileSync(
      path.join(fixA, "skills", ".stash.json"),
      JSON.stringify({
        entries: [
          { name: "alpha", type: "skill", filename: "alpha.md" },
          { name: "beta", type: "skill", filename: "beta.md" },
        ],
      }),
    );
    fs.writeFileSync(path.join(fixA, "skills", "alpha.md"), "# alpha");
    fs.writeFileSync(path.join(fixA, "skills", "beta.md"), "# beta");
    return root;
  }

  function fakeTask(overrides: Partial<TaskMetadata> = {}): TaskMetadata {
    return {
      id: "fake/t",
      title: "t",
      domain: "fake",
      difficulty: "easy",
      stash: "fixtureA",
      verifier: "regex",
      expectedMatch: "ok",
      budget: { tokens: 100, wallMs: 1000 },
      taskDir: "/tmp",
      ...overrides,
    };
  }

  test("masks top-N assets, calls runUtility once per asset, leaves source fixture intact", async () => {
    const fixturesRoot = makeFixturesRoot();
    const sourceContents = fs.readFileSync(path.join(fixturesRoot, "fixtureA", "skills", "alpha.md"), "utf8");

    const baseRuns: RunResult[] = [
      // alpha: 3 pass, 1 fail → load_count 4
      makeRun({ outcome: "pass", assetsLoaded: ["skill:alpha"] }),
      makeRun({ outcome: "pass", assetsLoaded: ["skill:alpha"] }),
      makeRun({ outcome: "pass", assetsLoaded: ["skill:alpha"] }),
      makeRun({ outcome: "fail", assetsLoaded: ["skill:alpha"] }),
      // beta: 1 pass, 1 fail → load_count 2
      makeRun({ outcome: "pass", assetsLoaded: ["skill:beta"] }),
      makeRun({ outcome: "fail", assetsLoaded: ["skill:beta"] }),
    ];
    const baseReport = makeReport(baseRuns);
    baseReport.taskMetadata = [fakeTask()];

    let callCount = 0;
    const seenStashDirs: string[] = [];
    const runUtility = async (
      options: Omit<RunUtilityOptionsForMask, "spawn" | "materialiseStash"> & {
        tasks: TaskMetadata[];
        materialiseStash?: boolean;
      },
    ): Promise<UtilityRunReport> => {
      callCount += 1;
      // Each masked re-run sees a different tmp stash dir tunneled through `tasks[].stash`.
      seenStashDirs.push(options.tasks[0]?.stash ?? "");
      // Simulate that masking alpha drops the pass rate, masking beta does nothing.
      const stashDir = options.tasks[0]?.stash ?? "";
      const alphaMissing = !fs.existsSync(path.join(stashDir, "skills", "alpha.md"));
      const passRate = alphaMissing ? 0.25 : 0.6;
      return {
        ...baseReport,
        aggregateAkm: { passRate, tokensPerPass: null, wallclockMs: 0 },
        akmRuns: [],
      };
    };

    const result = await runMaskedCorpus({
      baseReport,
      topN: 5, // > 2 assets, should clamp
      runUtility,
      baseOptions: { arms: ["noakm", "akm"] as Arm[], model: "m", seedsPerArm: 1 },
      fixturesRoot,
    });

    // Only 2 unique assets exist in the base report → topN clamped to 2.
    expect(result.runsPerformed).toBe(2);
    expect(callCount).toBe(2);
    expect(result.attributions.length).toBe(2);

    // Asset ranking: alpha first (load_count 4), beta second.
    const alpha = result.attributions[0];
    expect(alpha?.assetRef).toBe("skill:alpha");
    expect(alpha?.basePassRate).toBeCloseTo(4 / 6, 5);
    expect(alpha?.maskedPassRate).toBe(0.25);
    expect(alpha?.marginalContribution).toBeCloseTo(4 / 6 - 0.25, 5);

    const beta = result.attributions[1];
    expect(beta?.assetRef).toBe("skill:beta");
    expect(beta?.maskedPassRate).toBe(0.6);

    // Source fixture content untouched.
    const sourceContentsAfter = fs.readFileSync(path.join(fixturesRoot, "fixtureA", "skills", "alpha.md"), "utf8");
    expect(sourceContentsAfter).toBe(sourceContents);
    // Source .stash.json still has both entries.
    const stashJsonAfter = JSON.parse(
      fs.readFileSync(path.join(fixturesRoot, "fixtureA", "skills", ".stash.json"), "utf8"),
    );
    expect(stashJsonAfter.entries.length).toBe(2);

    // The two stash dirs the runner saw should be different tmp dirs (not the source).
    expect(new Set(seenStashDirs).size).toBe(2);
    for (const d of seenStashDirs) {
      expect(d.startsWith(os.tmpdir())).toBe(true);
    }

    fs.rmSync(fixturesRoot, { recursive: true, force: true });
  });

  test("cost accounting: runs N times when N <= asset count", async () => {
    const fixturesRoot = makeFixturesRoot();
    const baseRuns: RunResult[] = [
      makeRun({ outcome: "pass", assetsLoaded: ["skill:alpha"] }),
      makeRun({ outcome: "fail", assetsLoaded: ["skill:beta"] }),
    ];
    const baseReport = makeReport(baseRuns);
    baseReport.taskMetadata = [fakeTask()];

    let callCount = 0;
    const result = await runMaskedCorpus({
      baseReport,
      topN: 1,
      runUtility: async () => {
        callCount += 1;
        return {
          ...baseReport,
          aggregateAkm: { passRate: 0, tokensPerPass: null, wallclockMs: 0 },
        };
      },
      baseOptions: { arms: ["akm"] as Arm[], model: "m", seedsPerArm: 1 },
      fixturesRoot,
    });
    expect(result.runsPerformed).toBe(1);
    expect(callCount).toBe(1);
    expect(result.attributions.length).toBe(1);
    fs.rmSync(fixturesRoot, { recursive: true, force: true });
  });
});

describe("bench attribute --top clamping", () => {
  test("clamps --top when fewer assets exist", async () => {
    // Write a §13.3 envelope to disk with only 2 perAsset rows.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akm-bench-attr-cli-"));
    const fixturesRoot = path.join(tmp, "stashes");
    fs.mkdirSync(fixturesRoot, { recursive: true });
    // Two-asset fixture so the masked re-runs find their assets to remove.
    const fixDir = path.join(fixturesRoot, "tiny");
    fs.mkdirSync(path.join(fixDir, "skills"), { recursive: true });
    fs.writeFileSync(
      path.join(fixDir, "MANIFEST.json"),
      JSON.stringify({ name: "tiny", description: "x", purpose: "x", assets: { skill: 2 }, consumers: [] }),
    );
    fs.writeFileSync(
      path.join(fixDir, "skills", ".stash.json"),
      JSON.stringify({
        entries: [
          { name: "alpha", type: "skill", filename: "alpha.md" },
          { name: "beta", type: "skill", filename: "beta.md" },
        ],
      }),
    );
    fs.writeFileSync(path.join(fixDir, "skills", "alpha.md"), "# alpha");
    fs.writeFileSync(path.join(fixDir, "skills", "beta.md"), "# beta");

    const envelope = {
      schemaVersion: 1,
      track: "utility",
      branch: "test",
      commit: "abc",
      timestamp: "2026-04-27T00:00:00Z",
      agent: { harness: "opencode", model: "test-model" },
      corpus: { domains: 1, tasks: 1, slice: "all", seedsPerArm: 1 },
      aggregate: {
        noakm: { pass_rate: 0, tokens_per_pass: null, wallclock_ms: 0 },
        akm: { pass_rate: 0.5, tokens_per_pass: null, wallclock_ms: 0 },
        delta: { pass_rate: 0.5, tokens_per_pass: null, wallclock_ms: 0 },
      },
      trajectory: { akm: { correct_asset_loaded: null, feedback_recorded: 0 } },
      tasks: [],
      warnings: [],
      perAsset: {
        total_akm_runs: 4,
        rows: [
          {
            asset_ref: "skill:alpha",
            load_count: 2,
            load_count_passing: 1,
            load_count_failing: 1,
            load_pass_rate: 0.5,
          },
          { asset_ref: "skill:beta", load_count: 1, load_count_passing: 1, load_count_failing: 0, load_pass_rate: 1 },
        ],
      },
    };
    const basePath = path.join(tmp, "run.json");
    fs.writeFileSync(basePath, JSON.stringify(envelope));

    let calls = 0;
    const result = await runAttributeCli({
      basePath,
      topN: 5, // > 2 → clamp to 2
      json: true,
      runUtility: async () => {
        calls += 1;
        return {
          timestamp: "2026-04-27T00:00:00Z",
          branch: "test",
          commit: "abc",
          model: "test-model",
          corpus: { domains: 1, tasks: 0, slice: "all", seedsPerArm: 1 },
          aggregateNoakm: { passRate: 0, tokensPerPass: null, wallclockMs: 0 },
          aggregateAkm: { passRate: 0, tokensPerPass: null, wallclockMs: 0 },
          aggregateDelta: { passRate: 0, tokensPerPass: null, wallclockMs: 0 },
          trajectoryAkm: { correctAssetLoaded: null, feedbackRecorded: 0 },
          tasks: [],
          warnings: [],
        };
      },
      fixturesRoot,
    });

    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json.runsPerformed).toBe(2);
    expect(json.maskingStrategy).toBe("leave-one-out");
    expect((json.attributions as unknown[]).length).toBe(2);
    expect(calls).toBe(2);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
