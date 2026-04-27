/**
 * Unit tests for the §6.7 search-pipeline bridge.
 *
 * Covers:
 *   • `extractGoldRanks` — pure-function rank extraction from synthetic
 *     verifier-stdout traces, including JSON tool-call form, plain-text
 *     `ref:` lines, multiple searches per run, and gold-not-in-top-10
 *     (the "missing" bucket).
 *   • `computeSearchBridge` — histogram, p50/p90, gold_at_rank_1,
 *     gold_missing, and the keystone `pass_rate_by_rank` slice.
 *   • Empty-corpus path — no records → renderer emits the N/A sentence.
 *
 * No real opencode is invoked; every fixture is a hand-crafted `RunResult`.
 */

import { describe, expect, test } from "bun:test";

import type { RunResult } from "./driver";
import { computeSearchBridge, extractGoldRanks, type GoldRankRunRecord } from "./metrics";
import { renderSearchBridgeTable } from "./report";

function fakeResult(stdout: string, overrides: Partial<RunResult> = {}): RunResult {
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
    verifierStdout: stdout,
    verifierExitCode: 0,
    ...overrides,
  };
}

describe("extractGoldRanks", () => {
  test("returns [] when goldRef is undefined", () => {
    const r = fakeResult('akm search "foo"\nref: skill:foo');
    expect(extractGoldRanks(r, undefined)).toEqual([]);
  });

  test("returns [] when verifierStdout is empty", () => {
    const r = fakeResult("");
    expect(extractGoldRanks(r, "skill:foo")).toEqual([]);
  });

  test("extracts a single search with text-mode ref output, gold at rank 1", () => {
    const stdout = [
      `> akm search "redis healthcheck"`,
      `skill: docker-homelab`,
      `  ref: skill:docker-homelab`,
      `  score: 0.92`,
      `skill: nginx-tls`,
      `  ref: skill:nginx-tls`,
      `  score: 0.81`,
    ].join("\n");

    const events = extractGoldRanks(fakeResult(stdout), "skill:docker-homelab");
    expect(events).toHaveLength(1);
    expect(events[0].query).toBe("redis healthcheck");
    expect(events[0].results).toEqual(["skill:docker-homelab", "skill:nginx-tls"]);
    expect(events[0].rankOfGold).toBe(1);
  });

  test("extracts JSON tool-call form, gold at rank 3", () => {
    const stdout = [
      'tool: akm search "kubernetes pod restart" --output json',
      '{"hits":[{"ref":"skill:k8s-debug"},{"ref":"skill:k8s-monitoring"},{"ref":"skill:k8s-restart"},{"ref":"skill:k8s-deploy"}]}',
    ].join("\n");

    const events = extractGoldRanks(fakeResult(stdout), "skill:k8s-restart");
    expect(events).toHaveLength(1);
    expect(events[0].results.slice(0, 4)).toEqual([
      "skill:k8s-debug",
      "skill:k8s-monitoring",
      "skill:k8s-restart",
      "skill:k8s-deploy",
    ]);
    expect(events[0].rankOfGold).toBe(3);
  });

  test("returns null rank when gold is missing from top 10", () => {
    const refs = Array.from({ length: 12 }, (_, i) => `  ref: skill:other-${i}`).join("\n");
    const stdout = `akm search "missing-target"\n${refs}`;
    const events = extractGoldRanks(fakeResult(stdout), "skill:gold");
    expect(events).toHaveLength(1);
    expect(events[0].rankOfGold).toBeNull();
    // Top-10 cap: only 10 results retained.
    expect(events[0].results.length).toBeLessThanOrEqual(10);
  });

  test("multiple searches per run are each emitted in order", () => {
    const stdout = [
      'akm search "first query"',
      "  ref: skill:a",
      "  ref: skill:b",
      'akm search "second query"',
      "  ref: skill:gold",
      "  ref: skill:c",
    ].join("\n");
    const events = extractGoldRanks(fakeResult(stdout), "skill:gold");
    expect(events).toHaveLength(2);
    expect(events[0].query).toBe("first query");
    expect(events[0].rankOfGold).toBeNull();
    expect(events[1].query).toBe("second query");
    expect(events[1].rankOfGold).toBe(1);
  });

  test("non-search akm invocation closes the active search block", () => {
    const stdout = [
      'akm search "q"',
      "  ref: skill:a",
      "  ref: skill:gold",
      "akm show skill:gold",
      "  ref: skill:gold (this should NOT extend the previous search)",
      "  ref: skill:other",
    ].join("\n");
    const events = extractGoldRanks(fakeResult(stdout), "skill:gold");
    // Only the search block contributes to results; the show block is closed.
    expect(events).toHaveLength(1);
    expect(events[0].results).toEqual(["skill:a", "skill:gold"]);
    expect(events[0].rankOfGold).toBe(2);
  });

  test("origin-prefixed ref counts as gold (team//skill:foo matches skill:foo)", () => {
    const stdout = ['akm search "q"', "  ref: team//skill:foo", "  ref: skill:bar"].join("\n");
    const events = extractGoldRanks(fakeResult(stdout), "skill:foo");
    expect(events[0].rankOfGold).toBe(1);
  });
});

describe("computeSearchBridge — histogram + percentiles", () => {
  function fakeRecord(
    seed: number,
    outcome: RunResult["outcome"],
    rankOrNullPerSearch: Array<number | null>,
  ): GoldRankRunRecord {
    return {
      taskId: `t${seed}`,
      arm: "akm",
      seed,
      outcome,
      goldRef: "skill:gold",
      searches: rankOrNullPerSearch.map((rank, i) => ({
        query: `q${i}`,
        // Reconstruct a plausible result list: gold at the requested rank,
        // others as fillers. The aggregator only looks at rankOfGold.
        results: rank === null ? Array.from({ length: 10 }, (_, j) => `skill:other-${j}`) : [],
        rankOfGold: rank,
      })),
    };
  }

  test("empty corpus produces zero envelope", () => {
    const m = computeSearchBridge({ goldRankRecords: [] });
    expect(m.runsObserved).toBe(0);
    expect(m.searchesObserved).toBe(0);
    expect(m.goldRankP50).toBeNull();
    expect(m.goldRankP90).toBeNull();
    expect(m.goldAtRank1).toBe(0);
    expect(m.goldMissing).toBe(0);
    expect(m.passRateByRank).toEqual([]);
    // Histogram is fully zeroed for every key.
    for (const k of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "missing"]) {
      expect(m.goldRankDistribution[k]).toBe(0);
    }
  });

  test("histogram counts ranks across all searches", () => {
    const records: GoldRankRunRecord[] = [
      fakeRecord(0, "pass", [1, 2]),
      fakeRecord(1, "fail", [1, null]),
      fakeRecord(2, "pass", [3]),
    ];
    const m = computeSearchBridge({ goldRankRecords: records });
    expect(m.searchesObserved).toBe(5);
    expect(m.runsObserved).toBe(3);
    expect(m.goldRankDistribution["1"]).toBe(2);
    expect(m.goldRankDistribution["2"]).toBe(1);
    expect(m.goldRankDistribution["3"]).toBe(1);
    expect(m.goldRankDistribution.missing).toBe(1);
    expect(m.goldAtRank1).toBeCloseTo(2 / 5);
    expect(m.goldMissing).toBeCloseTo(1 / 5);
  });

  test("p50/p90 use nearest-rank with missing treated as Infinity", () => {
    // Ranks: [1,1,2,3,5,5,7,9,null,null] across one record.
    const records = [fakeRecord(0, "pass", [1, 1, 2, 3, 5, 5, 7, 9, null, null])];
    const m = computeSearchBridge({ goldRankRecords: records });
    // Sorted: [1,1,2,3,5,5,7,9,Inf,Inf]
    // p50 = idx ceil(0.5*10)-1 = 4 → 5
    expect(m.goldRankP50).toBe(5);
    // p90 = idx ceil(0.9*10)-1 = 8 → Infinity
    expect(m.goldRankP90).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("computeSearchBridge — pass_rate_by_rank uses the agent's chosen search", () => {
  test("attributes pass/fail to the rank in the LAST search, not the highest-ranked", () => {
    // Run A passed; first search had gold at rank 1 (great rank!), but the
    // *chosen* (last) search had gold at rank 5. The bridge must attribute
    // run A to rank 5, not rank 1, otherwise it overstates the value of
    // having gold at rank 1.
    const records: GoldRankRunRecord[] = [
      {
        taskId: "ta",
        arm: "akm",
        seed: 0,
        outcome: "pass",
        goldRef: "skill:gold",
        searches: [
          { query: "first", results: [], rankOfGold: 1 },
          { query: "last", results: [], rankOfGold: 5 },
        ],
      },
      {
        taskId: "tb",
        arm: "akm",
        seed: 0,
        outcome: "fail",
        goldRef: "skill:gold",
        searches: [{ query: "only", results: [], rankOfGold: 5 }],
      },
      {
        taskId: "tc",
        arm: "akm",
        seed: 0,
        outcome: "pass",
        goldRef: "skill:gold",
        searches: [{ query: "only", results: [], rankOfGold: 1 }],
      },
    ];
    const m = computeSearchBridge({ goldRankRecords: records });
    // Buckets: rank 1 → {1 pass / 1 total}, rank 5 → {1 pass / 2 total}.
    const rank1 = m.passRateByRank.find((e) => e.rank === "1");
    const rank5 = m.passRateByRank.find((e) => e.rank === "5");
    expect(rank1).toBeDefined();
    expect(rank1?.passRate).toBe(1);
    expect(rank1?.runCount).toBe(1);
    expect(rank5).toBeDefined();
    expect(rank5?.passRate).toBe(0.5);
    expect(rank5?.runCount).toBe(2);
  });

  test("missing bucket gets its own pass-rate row instead of being dropped", () => {
    const records: GoldRankRunRecord[] = [
      {
        taskId: "tm1",
        arm: "akm",
        seed: 0,
        outcome: "pass",
        goldRef: "skill:gold",
        searches: [{ query: "q", results: [], rankOfGold: null }],
      },
      {
        taskId: "tm2",
        arm: "akm",
        seed: 0,
        outcome: "fail",
        goldRef: "skill:gold",
        searches: [{ query: "q", results: [], rankOfGold: null }],
      },
    ];
    const m = computeSearchBridge({ goldRankRecords: records });
    const missing = m.passRateByRank.find((e) => e.rank === "missing");
    expect(missing).toBeDefined();
    expect(missing?.runCount).toBe(2);
    expect(missing?.passRate).toBe(0.5);
  });

  test("runs without any akm search invocation are excluded from pass_rate_by_rank", () => {
    const records: GoldRankRunRecord[] = [
      {
        taskId: "no-search",
        arm: "akm",
        seed: 0,
        outcome: "fail",
        goldRef: "skill:gold",
        searches: [],
      },
    ];
    const m = computeSearchBridge({ goldRankRecords: records });
    expect(m.runsObserved).toBe(1);
    expect(m.searchesObserved).toBe(0);
    expect(m.passRateByRank).toEqual([]);
  });
});

describe("renderSearchBridgeTable", () => {
  test("empty corpus renders the N/A sentence", () => {
    const md = renderSearchBridgeTable({
      goldRankDistribution: {
        "1": 0,
        "2": 0,
        "3": 0,
        "4": 0,
        "5": 0,
        "6": 0,
        "7": 0,
        "8": 0,
        "9": 0,
        "10": 0,
        missing: 0,
      },
      goldRankP50: null,
      goldRankP90: null,
      goldAtRank1: 0,
      goldMissing: 0,
      passRateByRank: [],
      runsObserved: 0,
      searchesObserved: 0,
    });
    expect(md).toContain("Search → outcome bridge");
    expect(md).toContain("(no gold-ref tasks in corpus; bridge metrics N/A)");
  });

  test("populated corpus surfaces histogram, p50/p90, and pass-rate-by-rank table", () => {
    const md = renderSearchBridgeTable({
      goldRankDistribution: {
        "1": 3,
        "2": 1,
        "3": 0,
        "4": 0,
        "5": 1,
        "6": 0,
        "7": 0,
        "8": 0,
        "9": 0,
        "10": 0,
        missing: 1,
      },
      goldRankP50: 1,
      goldRankP90: 5,
      goldAtRank1: 0.5,
      goldMissing: 1 / 6,
      passRateByRank: [
        { rank: "1", passRate: 0.67, runCount: 3 },
        { rank: "5", passRate: 0, runCount: 1 },
        { rank: "missing", passRate: 0, runCount: 1 },
      ],
      runsObserved: 5,
      searchesObserved: 6,
    });
    expect(md).toContain("| 1 | 3 |");
    expect(md).toContain("| missing | 1 |");
    expect(md).toContain("p50=1.0");
    expect(md).toContain("p90=5.0");
    expect(md).toContain("gold_at_rank_1=50.0%");
    expect(md).toContain("| rank | pass_rate | run_count |");
    expect(md).toContain("| 1 | 0.67 | 3 |");
    expect(md).toContain("| missing | 0.00 | 1 |");
  });
});
