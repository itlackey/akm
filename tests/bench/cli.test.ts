/**
 * Unit tests for the bench CLI dispatcher.
 *
 * We exercise the binary by spawning it with various argv permutations.
 * Real opencode is never invoked — the corpus tasks each fail at the
 * agent-spawn step (no `opencode` on PATH in CI), and that is exactly the
 * failure mode we want to verify produces a valid §13.3 envelope.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getCacheDir } from "../../src/core/paths";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(REPO_ROOT, "tests", "bench", "cli.ts");

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function envWithoutOpencode(): NodeJS.ProcessEnv {
  const currentPath = process.env.PATH ?? "";
  const opencodePath = Bun.which("opencode");
  if (!opencodePath) return { ...process.env };

  const opencodeDir = path.dirname(opencodePath);
  const filteredPath = currentPath
    .split(path.delimiter)
    .filter((entry) => entry !== opencodeDir)
    .join(path.delimiter);

  return { ...process.env, PATH: filteredPath };
}

function run(args: string[], env: Record<string, string> = {}): SpawnResult {
  const result = Bun.spawnSync({
    cmd: ["bun", "run", CLI, ...args],
    cwd: REPO_ROOT,
    env: { ...envWithoutOpencode(), ...env },
    stdin: null,
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
  test("`help` subcommand exits 0 and lists the five subcommands", () => {
    const r = run(["help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("utility");
    expect(r.stdout).toContain("evolve");
    expect(r.stdout).toContain("compare");
    expect(r.stdout).toContain("attribute");
    expect(r.stdout).toContain("clean");
  });

  test("`clean` subcommand exits 0 and removes bench tmp root", () => {
    const r = run(["clean"]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("bench clean:");
  });

  test("utility without BENCH_OPENCODE_MODEL exits 2 when no providers file supplies defaultModel", () => {
    // When BENCH_OPENCODE_MODEL is unset AND the providers file has no
    // defaultModel, exit 2 fires. We supply a minimal no-defaultModel file
    // via --opencode-config to prevent the committed fixture's defaultModel
    // from satisfying the model requirement.
    const tmpDir = fs.mkdtempSync("/tmp/bench-cli-nomodel-test-");
    const noModelPath = path.join(tmpDir, "no-default.json");
    try {
      fs.writeFileSync(
        noModelPath,
        JSON.stringify({ schemaVersion: 1, providers: { p: { npm: "@ai-sdk/openai-compatible" } } }),
      );
      const r = run(["utility", "--tasks", "train", "--opencode-config", noModelPath], {
        BENCH_OPENCODE_MODEL: "",
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("BENCH_OPENCODE_MODEL");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("evolve without --tasks exits 2 with usage error", () => {
    const r = run(["evolve"], { BENCH_OPENCODE_MODEL: "anthropic/claude-opus-4-7" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--tasks");
  });

  test("evolve without BENCH_OPENCODE_MODEL exits 2 when no providers file supplies defaultModel", () => {
    // Same pattern as utility: supply a no-defaultModel providers file so the
    // model-required check fires.
    const tmpDir = fs.mkdtempSync("/tmp/bench-cli-nomodel-evolve-test-");
    const noModelPath = path.join(tmpDir, "no-default.json");
    try {
      fs.writeFileSync(
        noModelPath,
        JSON.stringify({ schemaVersion: 1, providers: { p: { npm: "@ai-sdk/openai-compatible" } } }),
      );
      const r = run(["evolve", "--tasks", "docker-homelab", "--opencode-config", noModelPath], {
        BENCH_OPENCODE_MODEL: "",
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("BENCH_OPENCODE_MODEL");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
      // --no-noakm to keep run count at 1 arm (faster), since this test is
      // about the stdout/stderr contract, not the noakm arm.
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
        "--no-noakm",
      ],
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

  // ── C2: noakm arm now default-on; --no-noakm opts out ────────────────────

  test("utility help mentions --no-noakm flag", () => {
    const r = run(["help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--no-noakm");
  });

  test("utility default: aggregate includes noakm arm", () => {
    const r = run(
      ["utility", "--tasks", "train", "--seeds", "1", "--budget-tokens", "1000", "--budget-wall-ms", "1000", "--json"],
      { BENCH_OPENCODE_MODEL: "anthropic/claude-opus-4-7" },
    );
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    const aggregate = parsed.aggregate as Record<string, unknown>;
    expect(aggregate.noakm).toBeDefined();
    expect(aggregate.akm).toBeDefined();
    expect(aggregate.delta).toBeDefined();
  }, 60_000);

  test("utility --no-noakm: envelope is valid and contains akm arm", () => {
    // When --no-noakm is passed the noakm arm does not run. The JSON envelope
    // is still valid (aggregate.noakm exists but reflects zero runs); akm
    // is present with real run data. Exit 0.
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
        "--no-noakm",
        "--json",
      ],
      { BENCH_OPENCODE_MODEL: "anthropic/claude-opus-4-7" },
    );
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe(1);
    const aggregate = parsed.aggregate as Record<string, unknown>;
    expect(aggregate.akm).toBeDefined();
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
        "--no-noakm", // isolate: test is about the synthetic arm, not noakm
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
    // flag is absent. Use --no-noakm for speed — this test is about synthetic, not noakm.
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
        "--no-noakm",
        "--json",
      ],
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
      // --no-noakm for speed — this test is about the json/stderr contract, not noakm.
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
        "--no-noakm",
        "--json",
      ],
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

  // ── --opencode-config tests ───────────────────────────────────────────────

  test("utility help mentions --opencode-config and BENCH_OPENCODE_CONFIG", () => {
    const r = run(["help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--opencode-config");
    expect(r.stdout).toContain("BENCH_OPENCODE_CONFIG");
  });

  test("--opencode-config <missing path> exits 2 (usage error — file not found)", () => {
    const r = run(["utility", "--tasks", "train", "--opencode-config", "/nonexistent/providers.json"], {
      BENCH_OPENCODE_MODEL: "test-model",
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("not found");
  });

  test("--opencode-config <invalid JSON file> exits 78 (config error)", () => {
    // Write a temp file with bad JSON then pass its path.
    const tmpDir = fs.mkdtempSync("/tmp/bench-cli-test-");
    const badJsonPath = path.join(tmpDir, "bad.json");
    try {
      fs.writeFileSync(badJsonPath, "{ this is not valid json }");
      const r = run(["utility", "--tasks", "train", "--opencode-config", badJsonPath], {
        BENCH_OPENCODE_MODEL: "test-model",
      });
      expect(r.exitCode).toBe(78);
      expect(r.stderr).toContain("JSON parse error");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("BENCH_OPENCODE_CONFIG env var pointing to missing file exits 2", () => {
    const r = run(["utility", "--tasks", "train"], {
      BENCH_OPENCODE_MODEL: "test-model",
      BENCH_OPENCODE_CONFIG: "/nonexistent/path.json",
    });
    expect(r.exitCode).toBe(2);
  });

  test("auto-discovers committed fixture when no flag or env var is set", () => {
    // The committed fixture exists at tests/fixtures/bench/opencode-providers.json.
    // With no --opencode-config and no BENCH_OPENCODE_CONFIG, the CLI should
    // auto-discover it and NOT fail on provider loading. The model must match
    // the fixture's provider prefix or we'd get a materialise error at runtime;
    // but here we use a tiny budget so it all goes through harness_error anyway.
    // The point is: exit code 0 (not 78) when the default fixture is auto-discovered.
    const r = run(
      ["utility", "--tasks", "train", "--seeds", "1", "--budget-tokens", "100", "--budget-wall-ms", "100", "--json"],
      {
        BENCH_OPENCODE_MODEL: "anthropic/claude-opus-4-7",
        BENCH_OPENCODE_CONFIG: "", // blank — let auto-discovery run
      },
    );
    // Should exit 0 — the auto-discovered fixture is valid.
    expect(r.exitCode).toBe(0);
  }, 60_000);
});

describe("bench CLI — config-file dispatch", () => {
  test("config-file dispatch loads tests/bench/configs/nano-quick.json and runs end-to-end", () => {
    // Same structure as the legacy auto-discovery test above — the in-tree
    // committed fixture supplies providers so this works without
    // BENCH_OPENCODE_CONFIG set. We constrain to one task with the --tasks
    // override and shrink the budget so failures terminate quickly.
    const r = run(
      [
        "tests/bench/configs/nano-quick.json",
        "--tasks",
        "drillbit/backup-policy",
        "--seeds",
        "1",
        "--parallel",
        "1",
        "--json",
      ],
      {
        BENCH_OPENCODE_MODEL: "anthropic/claude-opus-4-7",
      },
    );
    expect(r.exitCode).toBe(0);
    // JSON envelope carries the corpus block and the per-task array.
    const envelope = JSON.parse(r.stdout);
    expect(envelope.corpus).toBeDefined();
    expect(Array.isArray(envelope.tasks)).toBe(true);
    expect(r.stderr).toContain("bench: provider=anthropic model=anthropic/claude-opus-4-7");
    // Stderr trace line confirms the config-mode dispatch ran.
    expect(r.stderr).toContain("config=nano-quick");
    // No obsolete warnings — the new path doesn't trip them.
    expect(r.stderr).not.toContain("[obsolete]");
  }, 60_000);

  test("config-file dispatch writes a persistent report artifact", () => {
    const cacheRoot = path.join(getCacheDir(), "bench-reports");
    const before = new Set(
      fs.existsSync(cacheRoot)
        ? fs.readdirSync(cacheRoot).filter((name) => name.startsWith("bench-report-") && name.endsWith(".json"))
        : [],
    );
    const r = run(
      [
        "tests/bench/configs/nano-quick.json",
        "--tasks",
        "drillbit/backup-policy",
        "--seeds",
        "1",
        "--parallel",
        "1",
        "--json",
      ],
      {
        BENCH_OPENCODE_MODEL: "anthropic/claude-opus-4-7",
      },
    );
    expect(r.exitCode).toBe(0);
    const files = fs
      .readdirSync(cacheRoot)
      .filter((name) => name.startsWith("bench-report-") && name.endsWith(".json"));
    const created = files.filter((name) => !before.has(name));
    expect(created.length).toBeGreaterThan(0);
    const latest = path.join(cacheRoot, created.sort().at(-1) ?? "");
    const artifact = JSON.parse(fs.readFileSync(latest, "utf8"));
    const stdoutJson = JSON.parse(r.stdout);
    expect(artifact.track).toBe(stdoutJson.track);
    expect(artifact.agent.model).toBe(stdoutJson.agent.model);
  }, 60_000);

  test("config-file dispatch surfaces baseline_by_task_id when the config carries `baseline`", () => {
    const r = run(
      [
        "tests/bench/configs/failing-tasks.json",
        "--tasks",
        "drillbit/backup-policy",
        "--seeds",
        "1",
        "--parallel",
        "1",
        "--json",
      ],
      {
        BENCH_OPENCODE_MODEL: "anthropic/claude-opus-4-7",
      },
    );
    expect(r.exitCode).toBe(0);
    const envelope = JSON.parse(r.stdout);
    expect(envelope.baseline_by_task_id).toBeDefined();
    expect(typeof envelope.baseline_by_task_id["drillbit/backup-policy"]).toBe("number");
  }, 60_000);

  test("config-file dispatch with bogus --tasks override exits 2", () => {
    const r = run(
      ["tests/bench/configs/nano-quick.json", "--tasks", "drillbit/no-such-task", "--seeds", "1", "--json"],
      {
        BENCH_OPENCODE_MODEL: "anthropic/claude-opus-4-7",
      },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--tasks");
  });

  test("nonexistent config file falls through to subcommand parser", () => {
    // A path that doesn't exist isn't routed to config mode — the subcommand
    // parser sees an unknown name and exits 2.
    const r = run(["does-not-exist.json"], {
      BENCH_OPENCODE_MODEL: "anthropic/claude-opus-4-7",
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown subcommand");
  });
});

describe("bench CLI — obsolete flag warnings", () => {
  test("--no-noakm in subcommand mode emits exactly one [obsolete] line for that flag", () => {
    const r = run(
      [
        "utility",
        "--tasks",
        "train",
        "--seeds",
        "1",
        "--budget-tokens",
        "100",
        "--budget-wall-ms",
        "100",
        "--no-noakm",
        "--json",
      ],
      { BENCH_OPENCODE_MODEL: "anthropic/claude-opus-4-7" },
    );
    expect(r.exitCode).toBe(0);
    // The invocation also uses --budget-tokens / --budget-wall-ms which fire
    // their own obsolete warnings; this test only asserts that --no-noakm
    // emits exactly one line and is deduped.
    const noNoakmLines = r.stderr.split("\n").filter((l) => l.includes("[obsolete] --no-noakm"));
    expect(noNoakmLines.length).toBe(1);
  }, 60_000);

  test("--budget-tokens emits an [obsolete] warning that points at budgetTokens", () => {
    const r = run(
      ["utility", "--tasks", "train", "--seeds", "1", "--budget-tokens", "100", "--budget-wall-ms", "100", "--json"],
      { BENCH_OPENCODE_MODEL: "anthropic/claude-opus-4-7" },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("[obsolete] --budget-tokens");
    expect(r.stderr).toContain("budgetTokens");
  }, 60_000);

  test("config-file dispatch never emits obsolete warnings", () => {
    const r = run(
      [
        "tests/bench/configs/nano-quick.json",
        "--tasks",
        "drillbit/backup-policy",
        "--seeds",
        "1",
        "--parallel",
        "1",
        "--json",
      ],
      { BENCH_OPENCODE_MODEL: "anthropic/claude-opus-4-7" },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain("[obsolete]");
  }, 60_000);
});
