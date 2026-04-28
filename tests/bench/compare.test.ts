/**
 * Unit tests for the `bench compare` subcommand (#239).
 *
 * Covers:
 *   • happy-path comparison: deltas + sign markers correct.
 *   • model-mismatch refusal: both models named in the message.
 *   • missing fixture-content hash on either side: proceeds with a warning.
 *   • markdown output is byte-stable across two calls with identical input.
 *   • CLI driver: invalid input file (missing path / malformed JSON) → exit 2.
 *   • CLI driver: refusal → exit 1; success → exit 0.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCompareCli } from "./cli";
import { compareReports, type ParsedReportJson } from "./metrics";
import { renderCompareMarkdown } from "./report";

const MODEL = "anthropic/claude-opus-4-7";

function makeReport(overrides: Partial<ParsedReportJson> = {}): ParsedReportJson {
  return {
    schemaVersion: 1,
    track: "utility",
    branch: "release/1.0.0",
    commit: "deadbee",
    timestamp: "2026-04-27T12:00:00Z",
    agent: { harness: "opencode", model: MODEL },
    corpus: { domains: 2, tasks: 2, slice: "all", seedsPerArm: 5 },
    aggregate: {
      noakm: { pass_rate: 0.4, tokens_per_pass: 18000, wallclock_ms: 41000 },
      akm: { pass_rate: 0.6, tokens_per_pass: 14000, wallclock_ms: 36000 },
      delta: { pass_rate: 0.2, tokens_per_pass: -4000, wallclock_ms: -5000 },
    },
    tasks: [
      {
        id: "domain-a/task-1",
        akm: {
          pass_rate: 0.6,
          pass_at_1: 1,
          tokens_per_pass: 13000,
          wallclock_ms: 35000,
          pass_rate_stdev: 0.1,
          budget_exceeded_count: 0,
          harness_error_count: 0,
          count: 5,
        },
      },
      {
        id: "domain-b/task-2",
        akm: {
          pass_rate: 0.6,
          pass_at_1: 1,
          tokens_per_pass: 15000,
          wallclock_ms: 37000,
          pass_rate_stdev: 0.2,
          budget_exceeded_count: 0,
          harness_error_count: 0,
          count: 5,
        },
      },
    ],
    warnings: [],
    ...overrides,
  } as ParsedReportJson;
}

describe("compareReports — happy path", () => {
  test("computes aggregate delta with correct sign markers", () => {
    const base = makeReport();
    // Current improves pass_rate by +0.2, reduces tokens by 1000, slower by 1000ms.
    const current = makeReport({
      aggregate: {
        noakm: { pass_rate: 0.4, tokens_per_pass: 18000, wallclock_ms: 41000 },
        akm: { pass_rate: 0.8, tokens_per_pass: 13000, wallclock_ms: 37000 },
        delta: { pass_rate: 0.4, tokens_per_pass: -5000, wallclock_ms: -4000 },
      },
    });
    const result = compareReports(base, current);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.aggregate.passRateDelta).toBeCloseTo(0.2);
    expect(result.aggregate.passRateSign).toBe("improve");
    expect(result.aggregate.tokensPerPassDelta).toBeCloseTo(-1000);
    expect(result.aggregate.tokensPerPassSign).toBe("improve"); // lower tokens = better
    expect(result.aggregate.wallclockMsDelta).toBeCloseTo(1000);
    expect(result.aggregate.wallclockMsSign).toBe("regress"); // higher wallclock = worse
    expect(result.perTask.length).toBe(2);
  });

  test("flat sign for tiny pass-rate jitter", () => {
    const base = makeReport();
    const current = makeReport({
      aggregate: {
        noakm: { pass_rate: 0.4, tokens_per_pass: 18000, wallclock_ms: 41000 },
        akm: { pass_rate: 0.602, tokens_per_pass: 14000, wallclock_ms: 36000 },
        delta: { pass_rate: 0.202, tokens_per_pass: -4000, wallclock_ms: -5000 },
      },
    });
    const result = compareReports(base, current);
    if (!result.ok) throw new Error("expected ok=true");
    // 0.602 − 0.6 = 0.002 < 0.005 tolerance
    expect(result.aggregate.passRateSign).toBe("flat");
  });

  test("per-task row carries baseMetrics + currentMetrics + signMarker", () => {
    const base = makeReport();
    const current = makeReport({
      tasks: [
        {
          id: "domain-a/task-1",
          akm: {
            pass_rate: 0.8,
            pass_at_1: 1,
            tokens_per_pass: 12000,
            wallclock_ms: 33000,
            pass_rate_stdev: 0.05,
            budget_exceeded_count: 0,
            harness_error_count: 0,
            count: 5,
          },
        },
        {
          id: "domain-b/task-2",
          akm: {
            pass_rate: 0.4,
            pass_at_1: 0,
            tokens_per_pass: 16000,
            wallclock_ms: 38000,
            pass_rate_stdev: 0.3,
            budget_exceeded_count: 1,
            harness_error_count: 0,
            count: 5,
          },
        },
      ],
    });
    const result = compareReports(base, current);
    if (!result.ok) throw new Error("expected ok=true");
    const row1 = result.perTask.find((r) => r.id === "domain-a/task-1");
    const row2 = result.perTask.find((r) => r.id === "domain-b/task-2");
    expect(row1?.signMarker).toBe("improve");
    expect(row1?.delta.passRate).toBeCloseTo(0.2);
    expect(row1?.baseMetrics?.pass_rate_stdev).toBeCloseTo(0.1);
    expect(row1?.currentMetrics?.pass_rate_stdev).toBeCloseTo(0.05);
    expect(row2?.signMarker).toBe("regress");
    expect(row2?.delta.passRate).toBeCloseTo(-0.2);
  });
});

describe("compareReports — refusal cases", () => {
  test("model mismatch: ok=false with both models named", () => {
    const base = makeReport();
    const current = makeReport({ agent: { harness: "opencode", model: "anthropic/claude-sonnet-4-5" } });
    const result = compareReports(base, current);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("model_mismatch");
    expect(result.baseModel).toBe(MODEL);
    expect(result.currentModel).toBe("anthropic/claude-sonnet-4-5");
    expect(result.message).toContain(MODEL);
    expect(result.message).toContain("anthropic/claude-sonnet-4-5");
  });

  test("schema mismatch: refuses non-v1 envelopes", () => {
    const base = makeReport({ schemaVersion: 2 });
    const current = makeReport();
    const result = compareReports(base, current);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("schema_mismatch");
  });

  test("track mismatch: refuses non-utility tracks", () => {
    const base = makeReport({ track: "evolve" });
    const current = makeReport();
    const result = compareReports(base, current);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("track_mismatch");
  });

  test("hash mismatch: refuses with both hashes named", () => {
    const base = makeReport({
      corpus: { domains: 2, tasks: 2, slice: "all", seedsPerArm: 5, fixtureContentHash: "abc123" },
    });
    const current = makeReport({
      corpus: { domains: 2, tasks: 2, slice: "all", seedsPerArm: 5, fixtureContentHash: "def456" },
    });
    const result = compareReports(base, current);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("hash_mismatch");
    expect(result.message).toContain("abc123");
    expect(result.message).toContain("def456");
  });
});

describe("compareReports — fixture-hash warnings", () => {
  test("missing hash on base: proceeds with warning", () => {
    const base = makeReport(); // no fixtureContentHash
    const current = makeReport({
      corpus: { domains: 2, tasks: 2, slice: "all", seedsPerArm: 5, fixtureContentHash: "abc123" },
    });
    const result = compareReports(base, current);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.some((w) => w.includes("base") && w.includes("fixtureContentHash"))).toBe(true);
  });

  test("missing hash on current: proceeds with warning", () => {
    const base = makeReport({
      corpus: { domains: 2, tasks: 2, slice: "all", seedsPerArm: 5, fixtureContentHash: "abc123" },
    });
    const current = makeReport(); // no fixtureContentHash
    const result = compareReports(base, current);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.some((w) => w.includes("current") && w.includes("fixtureContentHash"))).toBe(true);
  });

  test("missing on both: two warnings, still ok", () => {
    const base = makeReport();
    const current = makeReport();
    const result = compareReports(base, current);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.length).toBe(2);
  });

  test("matching hash: no warnings", () => {
    const base = makeReport({
      corpus: { domains: 2, tasks: 2, slice: "all", seedsPerArm: 5, fixtureContentHash: "abc123" },
    });
    const current = makeReport({
      corpus: { domains: 2, tasks: 2, slice: "all", seedsPerArm: 5, fixtureContentHash: "abc123" },
    });
    const result = compareReports(base, current);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.length).toBe(0);
  });
});

describe("renderCompareMarkdown determinism", () => {
  test("byte-stable across two calls with identical input", () => {
    const base = makeReport();
    const current = makeReport();
    const r1 = compareReports(base, current);
    const r2 = compareReports(base, current);
    expect(renderCompareMarkdown(r1)).toBe(renderCompareMarkdown(r2));
  });

  test("contains aggregate header and per-task table", () => {
    const base = makeReport();
    const current = makeReport({
      aggregate: {
        noakm: { pass_rate: 0.4, tokens_per_pass: 18000, wallclock_ms: 41000 },
        akm: { pass_rate: 0.8, tokens_per_pass: 13000, wallclock_ms: 36000 },
        delta: { pass_rate: 0.4, tokens_per_pass: -5000, wallclock_ms: -5000 },
      },
    });
    const md = renderCompareMarkdown(compareReports(base, current));
    expect(md).toContain("# akm-bench compare");
    expect(md).toContain("## Aggregate");
    expect(md).toContain("## Per-task");
    expect(md).toContain("pass_rate");
    expect(md).toContain("+0.20"); // pass_rate delta
    expect(md).toContain("▲"); // improve glyph
  });

  test("refusal renders as a single error block, not a diff table", () => {
    const base = makeReport();
    const current = makeReport({ agent: { harness: "opencode", model: "anthropic/claude-sonnet-4-5" } });
    const md = renderCompareMarkdown(compareReports(base, current));
    expect(md).toContain("refused");
    expect(md).toContain("model_mismatch");
    expect(md).toContain(MODEL);
    expect(md).toContain("anthropic/claude-sonnet-4-5");
    expect(md).not.toContain("## Aggregate"); // no diff body
  });
});

// ── CLI driver ────────────────────────────────────────────────────────────

describe("runCompareCli", () => {
  function withTmpFiles(
    cb: (paths: { basePath: string; currentPath: string; tmp: string }) => void,
    base?: object,
    current?: object,
  ): void {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-compare-"));
    try {
      const basePath = path.join(tmp, "base.json");
      const currentPath = path.join(tmp, "current.json");
      fs.writeFileSync(basePath, JSON.stringify(base ?? makeReport()));
      fs.writeFileSync(currentPath, JSON.stringify(current ?? makeReport()));
      cb({ basePath, currentPath, tmp });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  test("happy path: exit 0, markdown to stdout", () => {
    withTmpFiles(({ basePath, currentPath }) => {
      const result = runCompareCli({ basePath, currentPath, json: false });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("# akm-bench compare");
      expect(result.stderr).toContain("pass_rate");
    });
  });

  test("happy path with --json: exit 0, structured JSON to stdout", () => {
    withTmpFiles(({ basePath, currentPath }) => {
      const result = runCompareCli({ basePath, currentPath, json: true });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { ok: boolean };
      expect(parsed.ok).toBe(true);
    });
  });

  test("model mismatch: exit 1 + clear stderr", () => {
    withTmpFiles(
      ({ basePath, currentPath }) => {
        const result = runCompareCli({ basePath, currentPath, json: false });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("different models");
      },
      makeReport(),
      makeReport({ agent: { harness: "opencode", model: "anthropic/claude-sonnet-4-5" } }),
    );
  });

  test("hash mismatch: exit 1", () => {
    withTmpFiles(
      ({ basePath, currentPath }) => {
        const result = runCompareCli({ basePath, currentPath, json: false });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("fixture-content");
      },
      makeReport({ corpus: { domains: 2, tasks: 2, slice: "all", seedsPerArm: 5, fixtureContentHash: "h1" } }),
      makeReport({ corpus: { domains: 2, tasks: 2, slice: "all", seedsPerArm: 5, fixtureContentHash: "h2" } }),
    );
  });

  test("malformed JSON in --base: exit 2", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-compare-bad-"));
    try {
      const basePath = path.join(tmp, "base.json");
      const currentPath = path.join(tmp, "current.json");
      fs.writeFileSync(basePath, "{ not valid json");
      fs.writeFileSync(currentPath, JSON.stringify(makeReport()));
      const result = runCompareCli({ basePath, currentPath, json: false });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("malformed JSON");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("round-trip: reports with persisted runs[] (#249) compare cleanly", () => {
    // The runs[] field is additive — compare ignores it but must NOT reject
    // reports that carry it. Confirms the new key is forward-compatible with
    // the existing aggregate-based diff path.
    const baseWithRuns = {
      ...(makeReport() as unknown as Record<string, unknown>),
      runs: [
        {
          task_id: "domain-a/task-1",
          arm: "akm",
          seed: 0,
          model: MODEL,
          outcome: "pass",
          tokens: { input: 1, output: 2 },
          wallclock_ms: 100,
          verifier_exit_code: 0,
          trajectory: { correct_asset_loaded: true, feedback_recorded: false },
          assets_loaded: ["skill:foo"],
          failure_mode: null,
        },
      ],
    };
    withTmpFiles(
      ({ basePath, currentPath }) => {
        const result = runCompareCli({ basePath, currentPath, json: true });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout) as { ok: boolean };
        expect(parsed.ok).toBe(true);
      },
      baseWithRuns,
      baseWithRuns,
    );
  });

  test("missing --base file: exit 2", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-compare-missing-"));
    try {
      const currentPath = path.join(tmp, "current.json");
      fs.writeFileSync(currentPath, JSON.stringify(makeReport()));
      const result = runCompareCli({
        basePath: path.join(tmp, "nope.json"),
        currentPath,
        json: false,
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("cannot read --base");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
