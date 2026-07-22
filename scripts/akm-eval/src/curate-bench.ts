#!/usr/bin/env bun
/**
 * curate-bench — reproducible, rank-aware curate effectiveness benchmark.
 *
 * Seeds the frozen `curate-golden` corpus into a throwaway sandbox, indexes it
 * with the DETERMINISTIC embedder (AKM_EMBED_DETERMINISTIC=1 — no model, no
 * download, byte-stable across machines and source versions), runs `akm curate`
 * for each hand-labeled query through the REAL CLI, and scores the RANK of the
 * results against the judgments (nDCG / recall / MRR / leapfrog gate).
 *
 * Because the embedding axis is held constant, any score delta between two akm
 * binaries is attributable to source changes, not model drift — so this is the
 * "is curate better or worse between versions?" scorecard.
 *
 * Usage:
 *   akm-eval-curate-bench [--akm "<cmd>"] [--compare "<cmd>"]
 *                         [--fixture <dir>] [--format md|json]
 *                         [--fail-on-regression] [--threshold <n>]
 *
 *   --akm "<cmd>"      Command for the (baseline) akm binary. Tokenized on
 *                      spaces, so `--akm "bun /path/to/src/cli.ts"` works for
 *                      comparing source checkouts. Default: "akm".
 *   --compare "<cmd>"  Second akm binary; prints a per-case A→B delta table.
 *   --fixture <dir>    Golden corpus dir (default: the in-repo curate-golden).
 *   --format md|json   Output format (default: md).
 *   --fail-on-regression  Exit 1 if any case's score drops by > threshold (compare mode).
 *   --threshold <n>    Regression threshold for --fail-on-regression (default: 0.05).
 *
 * READ-ONLY against the repo; all writes go to an OS tmp sandbox that is removed.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type CurateCaseMetrics,
  type CurateJudgment,
  scoreCurateCase,
  summarizeCurateMetrics,
} from "./curate-metrics";

interface CliOptions {
  akm: string;
  compare?: string;
  fixture: string;
  format: "md" | "json";
  failOnRegression: boolean;
  threshold: number;
}

const DEFAULT_FIXTURE = path.resolve(
  path.join(import.meta.dir, "..", "..", "..", "tests", "fixtures", "stashes", "curate-golden"),
);

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    akm: "akm",
    fixture: DEFAULT_FIXTURE,
    format: "md",
    failOnRegression: false,
    threshold: 0.05,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case "--akm": opts.akm = next(); break;
      case "--compare": opts.compare = next(); break;
      case "--fixture": opts.fixture = path.resolve(next()); break;
      case "--format": {
        const v = next();
        if (v !== "md" && v !== "json") throw new Error("--format must be md|json");
        opts.format = v;
        break;
      }
      case "--fail-on-regression": opts.failOnRegression = true; break;
      case "--threshold": opts.threshold = Number(next()); break;
      case "-h":
      case "--help":
        process.stdout.write(helpText());
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function helpText(): string {
  return `curate-bench — reproducible rank-aware curate benchmark

Usage:
  akm-eval-curate-bench [--akm "<cmd>"] [--compare "<cmd>"] [--fixture <dir>]
                        [--format md|json] [--fail-on-regression] [--threshold <n>]
`;
}

interface JudgmentsFile {
  schemaVersion: number;
  corpus: string;
  queries: CurateJudgment[];
}

function loadJudgments(fixture: string): JudgmentsFile {
  return JSON.parse(fs.readFileSync(path.join(fixture, "judgments.json"), "utf8")) as JudgmentsFile;
}

/** Run one curate query through a (possibly multi-token) akm command. */
function runCurate(cmd: string[], env: Record<string, string>, query: string, limit: number): string[] {
  const args = [...cmd.slice(1), "curate", query, "--format", "jsonl", "--shape", "agent", "--limit", String(limit)];
  const res = spawnSync(cmd[0], args, { encoding: "utf8", env });
  if (res.status !== 0) {
    throw new Error(`akm curate failed (exit ${res.status}): ${(res.stderr ?? "").trim()}`);
  }
  // curate --format jsonl emits ONE envelope object with an `items[]` array.
  const out = (res.stdout ?? "").trim();
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const obj = JSON.parse(t) as { items?: Array<{ ref?: string; id?: string }> };
      if (Array.isArray(obj.items)) {
        return obj.items.map((it) => it.ref ?? (it.id ? `registry:${it.id}` : "")).filter(Boolean);
      }
    } catch {
      // tolerate stray non-JSON lines (progress warnings)
    }
  }
  return [];
}

/** Seed a sandbox, index with the deterministic embedder, score every query. */
function benchOne(cmdStr: string, fixture: string, judgments: JudgmentsFile): {
  perCase: Map<string, CurateCaseMetrics>;
  summary: ReturnType<typeof summarizeCurateMetrics>;
} {
  const cmd = cmdStr.split(/\s+/).filter(Boolean);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-curate-bench-"));
  const stash = path.join(root, "stash");
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const config = path.join(root, "config");
  try {
    fs.cpSync(fixture, stash, { recursive: true });
    fs.rmSync(path.join(stash, "judgments.json"), { force: true });
    for (const d of [home, data, path.join(config, "akm")]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(config, "akm", "config.json"),
      JSON.stringify({ semanticSearchMode: "auto", sources: [{ type: "filesystem", path: stash }], registries: [] }, null, 2),
    );
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      AKM_EMBED_DETERMINISTIC: "1",
      AKM_EVENT_SOURCE: "audit",
      HOME: home,
      AKM_STASH_DIR: stash,
      AKM_DATA_DIR: data,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
    };
    const idx = spawnSync(cmd[0], [...cmd.slice(1), "index", "--dir", stash], { encoding: "utf8", env });
    if (idx.status !== 0) {
      throw new Error(`akm index failed (exit ${idx.status}): ${(idx.stderr ?? "").trim()}`);
    }
    const perCase = new Map<string, CurateCaseMetrics>();
    const metrics: CurateCaseMetrics[] = [];
    for (const j of judgments.queries) {
      const refs = runCurate(cmd, env, j.query, j.limit);
      const m = scoreCurateCase(refs, j);
      perCase.set(j.id, m);
      metrics.push(m);
    }
    return { perCase, summary: summarizeCurateMetrics(metrics) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function fmt(n: number): string {
  return n.toFixed(3);
}

function main(): number {
  const opts = parseArgs(process.argv.slice(2));
  const judgments = loadJudgments(opts.fixture);

  const a = benchOne(opts.akm, opts.fixture, judgments);

  if (!opts.compare) {
    if (opts.format === "json") {
      process.stdout.write(
        `${JSON.stringify(
          {
            akm: opts.akm,
            summary: a.summary,
            perCase: Object.fromEntries(a.perCase),
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }
    const lines: string[] = [];
    lines.push(`# curate-bench — \`${opts.akm}\``);
    lines.push("");
    lines.push(
      `mean score **${fmt(a.summary.meanScore)}** · ndcg ${fmt(a.summary.meanNdcg)} · recall ${fmt(a.summary.meanRecall)} · mrr ${fmt(a.summary.meanMrr)} · no-leapfrog ${fmt(a.summary.meanNoBannedAboveRequired)} · leapfrogs ${a.summary.totalBannedLeapfrog}`,
    );
    lines.push("");
    lines.push("| case | score | ndcg | recall | mrr | leapfrog |");
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
    for (const j of judgments.queries) {
      const m = a.perCase.get(j.id)!;
      lines.push(`| ${j.id} | ${fmt(m.score)} | ${fmt(m.ndcg)} | ${fmt(m.recall)} | ${fmt(m.mrr)} | ${m.bannedLeapfrogCount} |`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  }

  // Compare mode: A (baseline) vs B.
  const b = benchOne(opts.compare, opts.fixture, judgments);
  const regressions: Array<{ id: string; delta: number }> = [];
  for (const j of judgments.queries) {
    const delta = (b.perCase.get(j.id)!.score - a.perCase.get(j.id)!.score);
    if (delta < -opts.threshold) regressions.push({ id: j.id, delta });
  }

  if (opts.format === "json") {
    process.stdout.write(
      `${JSON.stringify(
        {
          baseline: { akm: opts.akm, summary: a.summary },
          candidate: { akm: opts.compare, summary: b.summary },
          meanScoreDelta: b.summary.meanScore - a.summary.meanScore,
          regressions,
          perCase: judgments.queries.map((j) => ({
            id: j.id,
            baseline: a.perCase.get(j.id),
            candidate: b.perCase.get(j.id),
            delta: b.perCase.get(j.id)!.score - a.perCase.get(j.id)!.score,
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const lines: string[] = [];
    lines.push(`# curate-bench compare`);
    lines.push("");
    lines.push(`- baseline:  \`${opts.akm}\` → mean ${fmt(a.summary.meanScore)}`);
    lines.push(`- candidate: \`${opts.compare}\` → mean ${fmt(b.summary.meanScore)}`);
    lines.push(`- **Δ mean score: ${(b.summary.meanScore - a.summary.meanScore >= 0 ? "+" : "")}${fmt(b.summary.meanScore - a.summary.meanScore)}**`);
    lines.push(`- Δ leapfrogs: ${b.summary.totalBannedLeapfrog - a.summary.totalBannedLeapfrog}`);
    lines.push("");
    lines.push("| case | base | cand | Δ |");
    lines.push("| --- | ---: | ---: | ---: |");
    for (const j of judgments.queries) {
      const av = a.perCase.get(j.id)!.score;
      const bv = b.perCase.get(j.id)!.score;
      const d = bv - av;
      const mark = d < -opts.threshold ? " ⚠️" : d > opts.threshold ? " ✅" : "";
      lines.push(`| ${j.id} | ${fmt(av)} | ${fmt(bv)} | ${(d >= 0 ? "+" : "")}${fmt(d)}${mark} |`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
  }

  if (opts.failOnRegression && regressions.length > 0) {
    process.stderr.write(`[curate-bench] ${regressions.length} case(s) regressed beyond ${opts.threshold}\n`);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`[curate-bench] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
