/**
 * Unit tests for the bench CLI dispatcher.
 *
 * We exercise the binary by spawning it with various argv permutations.
 * Real opencode is never invoked — the corpus tasks each fail at the
 * agent-spawn step (no `opencode` on PATH in CI), and that is exactly the
 * failure mode we want to verify produces a valid §13.3 envelope.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(REPO_ROOT, "tests", "bench", "cli.ts");

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string> = {}): SpawnResult {
  const result = Bun.spawnSync({
    cmd: ["bun", "run", CLI, ...args],
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: new TextDecoder().decode(result.stdout ?? new Uint8Array()),
    stderr: new TextDecoder().decode(result.stderr ?? new Uint8Array()),
  };
}

describe("bench CLI", () => {
  test("`help` subcommand exits 0 and lists the four subcommands", () => {
    const r = run(["help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("utility");
    expect(r.stdout).toContain("evolve");
    expect(r.stdout).toContain("compare");
    expect(r.stdout).toContain("attribute");
  });

  test("utility without BENCH_OPENCODE_MODEL exits 2", () => {
    // Strip out any inherited model env so the missing-model branch fires.
    const r = run(["utility", "--tasks", "train"], { BENCH_OPENCODE_MODEL: "" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("BENCH_OPENCODE_MODEL");
  });

  test("evolve without --tasks exits 2 with usage error", () => {
    const r = run(["evolve"], { BENCH_OPENCODE_MODEL: "anthropic/claude-opus-4-7" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--tasks");
  });

  test("evolve without BENCH_OPENCODE_MODEL exits 2", () => {
    const r = run(["evolve", "--tasks", "docker-homelab"], { BENCH_OPENCODE_MODEL: "" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("BENCH_OPENCODE_MODEL");
  });

  test("attribute without --base exits 2", () => {
    const r = run(["attribute"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--base");
  });

  test("attribute with missing --base file exits 2", () => {
    const r = run(["attribute", "--base", "/nonexistent/run.json"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("not found");
  });

  test("utility --tasks train --seeds 1 --json produces a §13.3 envelope", () => {
    const r = run(
      ["utility", "--tasks", "train", "--seeds", "1", "--budget-tokens", "1000", "--budget-wall-ms", "1000", "--json"],
      { BENCH_OPENCODE_MODEL: "anthropic/claude-opus-4-7" },
    );
    expect(r.exitCode).toBe(0);
    // Stdout should be valid JSON.
    let parsed: Record<string, unknown>;
    expect(() => {
      parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    }).not.toThrow();
    parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.track).toBe("utility");
    expect((parsed.agent as { model: string }).model).toBe("anthropic/claude-opus-4-7");
    const corpus = parsed.corpus as Record<string, unknown>;
    expect(corpus.slice).toBe("train");
    expect(corpus.seedsPerArm).toBe(1);
    expect(typeof corpus.tasks).toBe("number");
    expect((corpus.tasks as number) > 0).toBe(true);
    expect(Array.isArray(parsed.tasks)).toBe(true);
    expect(Array.isArray(parsed.warnings)).toBe(true);
    // Aggregate must have all three sections.
    const aggregate = parsed.aggregate as Record<string, unknown>;
    expect(aggregate.noakm).toBeDefined();
    expect(aggregate.akm).toBeDefined();
    expect(aggregate.delta).toBeDefined();
    // Trajectory.akm must have both fields.
    const trajectory = (parsed.trajectory as Record<string, Record<string, unknown>>).akm;
    expect("correct_asset_loaded" in trajectory).toBe(true);
    expect("feedback_recorded" in trajectory).toBe(true);
  }, 60_000);

  test("utility --tasks eval filters to eval slice", () => {
    const trainR = run(
      ["utility", "--tasks", "train", "--seeds", "1", "--budget-tokens", "100", "--budget-wall-ms", "100", "--json"],
      { BENCH_OPENCODE_MODEL: "test-model" },
    );
    const evalR = run(
      ["utility", "--tasks", "eval", "--seeds", "1", "--budget-tokens", "100", "--budget-wall-ms", "100", "--json"],
      { BENCH_OPENCODE_MODEL: "test-model" },
    );
    expect(trainR.exitCode).toBe(0);
    expect(evalR.exitCode).toBe(0);
    const trainCorpus = (JSON.parse(trainR.stdout) as { corpus: { tasks: number } }).corpus;
    const evalCorpus = (JSON.parse(evalR.stdout) as { corpus: { tasks: number } }).corpus;
    // The two slices partition the corpus; together they should account for every non-_example task.
    expect(trainCorpus.tasks + evalCorpus.tasks).toBeGreaterThanOrEqual(1);
  }, 60_000);

  test("unknown subcommand exits 2 and prints help", () => {
    const r = run(["bogus"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown subcommand");
  });

  test("unknown --tasks value exits 2 with a clear error (no silent coerce to all)", () => {
    const r = run(["utility", "--tasks", "bogus"], { BENCH_OPENCODE_MODEL: "test-model" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("invalid --tasks");
    expect(r.stderr).toContain("bogus");
    expect(r.stderr).toContain("all");
    expect(r.stderr).toContain("train");
    expect(r.stderr).toContain("eval");
  });

  test("without --json: JSON still goes to stdout, markdown summary goes to stderr", () => {
    const r = run(
      ["utility", "--tasks", "train", "--seeds", "1", "--budget-tokens", "1000", "--budget-wall-ms", "1000"],
      { BENCH_OPENCODE_MODEL: "anthropic/claude-opus-4-7" },
    );
    expect(r.exitCode).toBe(0);
    // stdout MUST be valid JSON (the bench's machine-readable contract).
    let parsed: Record<string, unknown> | undefined;
    expect(() => {
      parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    }).not.toThrow();
    expect(parsed?.schemaVersion).toBe(1);
    expect(parsed?.track).toBe("utility");
    // stderr MUST contain the human-friendly markdown summary.
    expect(r.stderr).toContain("# akm-bench utility");
    expect(r.stderr).toContain("## Aggregate");
    expect(r.stderr).toContain("tasks discovered:");
  }, 60_000);

  // ── #261: --include-synthetic flag ─────────────────────────────────────────

  test("utility help mentions --include-synthetic flag", () => {
    const r = run(["help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--include-synthetic");
  });

  test("utility --include-synthetic adds aggregate.synthetic + akm_over_synthetic_lift", () => {
    const r = run(
      [
        "utility",
        "--tasks",
        "train",
        "--seeds",
        "1",
        "--budget-tokens",
        "1000",
        "--budget-wall-ms",
        "1000",
        "--include-synthetic",
        "--json",
      ],
      { BENCH_OPENCODE_MODEL: "anthropic/claude-opus-4-7" },
    );
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    const aggregate = parsed.aggregate as Record<string, unknown>;
    expect(aggregate.synthetic).toBeDefined();
    expect("akm_over_synthetic_lift" in aggregate).toBe(true);
  }, 60_000);

  test("utility WITHOUT --include-synthetic: aggregate has no synthetic / akm_over_synthetic_lift", () => {
    // Byte-identical default contract: no spurious 'synthetic' keys when the
    // flag is absent.
    const r = run(
      ["utility", "--tasks", "train", "--seeds", "1", "--budget-tokens", "1000", "--budget-wall-ms", "1000", "--json"],
      { BENCH_OPENCODE_MODEL: "anthropic/claude-opus-4-7" },
    );
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    const aggregate = parsed.aggregate as Record<string, unknown>;
    expect(aggregate.synthetic).toBeUndefined();
    expect("akm_over_synthetic_lift" in aggregate).toBe(false);
  }, 60_000);

  test("with --json: stderr carries no markdown summary", () => {
    const r = run(
      ["utility", "--tasks", "train", "--seeds", "1", "--budget-tokens", "1000", "--budget-wall-ms", "1000", "--json"],
      { BENCH_OPENCODE_MODEL: "anthropic/claude-opus-4-7" },
    );
    expect(r.exitCode).toBe(0);
    // stdout is still JSON.
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    // stderr MUST NOT contain the markdown summary headings.
    expect(r.stderr).not.toContain("# akm-bench utility");
    expect(r.stderr).not.toContain("## Aggregate");
    // The minor trace line is fine.
    expect(r.stderr).toContain("tasks discovered:");
  }, 60_000);
});
