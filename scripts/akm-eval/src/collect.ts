#!/usr/bin/env bun
/**
 * akm-eval-collect — ingest an existing `improve-result.json` into a
 * paired-mode-ready summary.
 *
 * Reads `<stash>/.akm/runs/<run-id>/improve-result.json` and surfaces the
 * metrics that paired-mode comparison cares about (proposal counts
 * emitted that run, validation failures, consolidation, memory cleanup).
 * Writes the summary to `<stash>/.akm/evals/collected/<improve-run-id>.json`.
 */

import fs from "node:fs";
import path from "node:path";
import { loadImproveResult, type ImproveResultEnvelope } from "./sources/improve-result";
import { resolveEvalsRoot, resolveStashDir } from "./sources/paths";

interface CliOptions {
  fromImproveRun: string;
  stash?: string;
  out?: string;
  format: "json" | "md";
}

export interface CollectedSummary {
  schemaVersion: 1;
  improveRunId: string;
  improveRunDir: string;
  stashRoot: string;
  scope?: ImproveResultEnvelope["scope"];
  dryRun?: boolean;
  collectedAt: string;
  counts: {
    plannedRefs: number;
    actions: number;
    proposalsEmitted: number;
    validationFailures: number;
    schemaRepairs: number;
    evalCasesWritten: number;
    orphansPurged: number;
    proposalsExpired: number;
    reflectCooldownActions: number;
    reflectsWithErrorContext: number;
  };
  actionsByMode: Record<string, number>;
  actionsByOutcome: Record<string, number>;
  proposalsByMode: Record<string, number>;
  memoryCleanup: {
    deletedDerived: number;
    archivedSuperseded: number;
    archivedStale: number;
    transitions: number;
    warnings: number;
  };
  memorySummary?: { eligible?: number; derived?: number };
  consolidationKeys: string[];
  lintSummary?: { fixed?: number; flagged?: number };
  memoryIndexHealth?: { lineCount?: number; overBudget?: boolean };
  validationFailures: Array<{ ref: string; reason: string }>;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { fromImproveRun: "", format: "json" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case "--from-improve-run":
        opts.fromImproveRun = next();
        break;
      case "--stash":
        opts.stash = next();
        break;
      case "--out":
        opts.out = next();
        break;
      case "--format": {
        const v = next();
        if (v !== "json" && v !== "md") throw new Error(`--format must be json|md`);
        opts.format = v;
        break;
      }
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!opts.fromImproveRun) {
    throw new Error(`--from-improve-run <id|latest> is required`);
  }
  return opts;
}

function printHelp(): void {
  process.stdout.write(`akm-eval-collect — ingest an improve-result.json

Usage:
  akm-eval-collect --from-improve-run <id|latest> [options]

Options:
  --stash <path>       Stash root (default: $AKM_STASH_DIR or ~/akm).
  --out <path>         Write collected.json to this path (overrides default).
  --format json|md     Output format (default: json).
`);
}

export function summarizeImproveResult(
  improveRunId: string,
  improveRunDir: string,
  stashRoot: string,
  envelope: ImproveResultEnvelope,
): CollectedSummary {
  const actions = envelope.actions ?? [];
  const actionsByMode: Record<string, number> = {};
  const actionsByOutcome: Record<string, number> = {};
  const proposalsByMode: Record<string, number> = {};
  let proposalsEmitted = 0;
  for (const a of actions) {
    const mode = a.mode ?? "unknown";
    const outcome = a.outcome ?? "unknown";
    actionsByMode[mode] = (actionsByMode[mode] ?? 0) + 1;
    actionsByOutcome[outcome] = (actionsByOutcome[outcome] ?? 0) + 1;
    if (a.proposalId) {
      proposalsEmitted += 1;
      proposalsByMode[mode] = (proposalsByMode[mode] ?? 0) + 1;
    }
  }

  const cleanup = envelope.memoryCleanup ?? {};
  const transitions = Array.isArray(cleanup.beliefStateTransitions) ? cleanup.beliefStateTransitions.length : 0;
  const warnings = Array.isArray(cleanup.warnings) ? cleanup.warnings.length : 0;

  return {
    schemaVersion: 1,
    improveRunId,
    improveRunDir,
    stashRoot,
    scope: envelope.scope,
    dryRun: envelope.dryRun,
    collectedAt: new Date().toISOString(),
    counts: {
      plannedRefs: (envelope.plannedRefs ?? []).length,
      actions: actions.length,
      proposalsEmitted,
      validationFailures: (envelope.validationFailures ?? []).length,
      schemaRepairs: (envelope.schemaRepairs ?? []).length,
      evalCasesWritten: envelope.evalCasesWritten ?? 0,
      orphansPurged: envelope.orphansPurged ?? 0,
      proposalsExpired: envelope.proposalsExpired ?? 0,
      reflectCooldownActions: envelope.reflectCooldownActions ?? 0,
      reflectsWithErrorContext: envelope.reflectsWithErrorContext ?? 0,
    },
    actionsByMode,
    actionsByOutcome,
    proposalsByMode,
    memoryCleanup: {
      deletedDerived: cleanup.deletedDerived ?? 0,
      archivedSuperseded: cleanup.archivedSuperseded ?? 0,
      archivedStale: cleanup.archivedStale ?? 0,
      transitions,
      warnings,
    },
    memorySummary: envelope.memorySummary,
    consolidationKeys: envelope.consolidation ? Object.keys(envelope.consolidation) : [],
    lintSummary: envelope.lintSummary,
    memoryIndexHealth: envelope.memoryIndexHealth,
    validationFailures: envelope.validationFailures ?? [],
  };
}

function renderCollectedMarkdown(s: CollectedSummary): string {
  const lines: string[] = [];
  lines.push(`# akm-eval-collect — improve run \`${s.improveRunId}\``);
  lines.push("");
  lines.push(`**Stash:** \`${s.stashRoot}\``);
  if (s.scope) lines.push(`**Scope:** \`${s.scope.mode}${s.scope.value ? ` ${s.scope.value}` : ""}\``);
  if (s.dryRun) lines.push(`**Dry run:** yes`);
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  for (const [k, v] of Object.entries(s.counts)) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push("");
  if (Object.keys(s.actionsByMode).length > 0) {
    lines.push("## Actions by mode");
    lines.push("");
    lines.push("| Mode | Count | Proposals |");
    lines.push("| --- | ---: | ---: |");
    for (const mode of Object.keys(s.actionsByMode).sort()) {
      lines.push(`| ${mode} | ${s.actionsByMode[mode]} | ${s.proposalsByMode[mode] ?? 0} |`);
    }
    lines.push("");
  }
  lines.push("## Memory cleanup");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  for (const [k, v] of Object.entries(s.memoryCleanup)) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push("");
  if (s.validationFailures.length > 0) {
    lines.push("## Validation failures");
    lines.push("");
    for (const f of s.validationFailures) {
      lines.push(`- \`${f.ref}\`: ${f.reason}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const stashRoot = resolveStashDir(opts.stash);
  const loaded = loadImproveResult(stashRoot, opts.fromImproveRun);
  const summary = summarizeImproveResult(loaded.runId, loaded.dir, stashRoot, loaded.envelope);

  const outPath = opts.out
    ? path.resolve(opts.out)
    : path.join(resolveEvalsRoot(stashRoot), "collected", `${loaded.runId}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);

  if (opts.format === "md") {
    process.stdout.write(renderCollectedMarkdown(summary));
  } else {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
  process.stderr.write(`[akm-eval-collect] wrote ${outPath}\n`);
  return 0;
}

if (import.meta.main) {
  try {
    const code = await main();
    process.exit(code);
  } catch (err) {
    process.stderr.write(`[akm-eval-collect] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
