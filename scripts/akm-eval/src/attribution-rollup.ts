#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDbPath } from "./sources/paths";

const READ_BACK_WINDOW_MS = 60_000;
const SNAPSHOT_ATTEMPTS = 3;
const SQLITE_SNAPSHOT_SUFFIXES = ["", "-wal", "-journal"] as const;

export interface AttributionUsageRow {
  id: number;
  eventType: string;
  entryRef: string | null;
  metadata: string | null;
  source: string | null;
  createdAt: string;
}

type ExposureKind = "direct" | "surface";

interface ParsedAttribution {
  memoryInference?: { exposure: ExposureKind; childRef: string };
  graphExtraction?: { boost: number };
}

type ParsedMetadata =
  | { kind: "attribution"; attribution: ParsedAttribution }
  | { kind: "control" }
  | { kind: "historical" };

interface RefRollup {
  ref: string;
  memoryInference: {
    childRefs: string[];
    directExposure: number;
    surfaceExposure: number;
    directShow: number;
    surfaceShow: number;
    directCurate: number;
    surfaceCurate: number;
  };
  graphExtraction: {
    exposures: number;
    selected: number;
    shownReadBack: number;
  };
}

export interface AttributionRollupReport {
  tool: "akm-eval-attribution-rollup";
  mode: "read-only";
  source: "user";
  readBackWindowSeconds: number;
  memoryInference: {
    exposure: Record<ExposureKind, number>;
    consumption: {
      show: Record<ExposureKind, number>;
      curate: Record<ExposureKind, number>;
    };
  };
  graphExtraction: {
    exposures: number;
    selected: number;
    shownReadBack: number;
    interpretation: string;
  };
  currentControl: {
    search: number;
    show: number;
    curate: number;
    total: number;
  };
  historicalUnattributed: {
    search: number;
    show: number;
    curate: number;
    total: number;
  };
  excludedUnqualifiedRows: number;
  refs: RefRollup[];
}

interface SourceFileFingerprint {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface StateDbSnapshot {
  databasePath: string;
  cleanup(): void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseMetadata(raw: string | null): ParsedMetadata {
  if (!raw) return { kind: "historical" };
  let metadata: Record<string, unknown> | undefined;
  try {
    metadata = asRecord(JSON.parse(raw));
  } catch {
    return { kind: "historical" };
  }
  const attribution = asRecord(metadata?.downstreamAttribution);
  if (!attribution || attribution.version !== 1) return { kind: "historical" };
  if (attribution.control === true) return { kind: "control" };
  if (attribution.control !== false) return { kind: "historical" };
  const out: ParsedAttribution = {};
  const memory = asRecord(attribution.memoryInference);
  if (
    (memory?.exposure === "direct" || memory?.exposure === "surface") &&
    typeof memory.childRef === "string" &&
    memory.childRef.includes("//")
  ) {
    out.memoryInference = { exposure: memory.exposure, childRef: memory.childRef };
  }
  const graph = asRecord(attribution.graphExtraction);
  if (typeof graph?.boost === "number" && Number.isFinite(graph.boost) && graph.boost > 0) {
    out.graphExtraction = { boost: graph.boost };
  }
  return out.memoryInference || out.graphExtraction
    ? { kind: "attribution", attribution: out }
    : { kind: "historical" };
}

function timestampMs(value: string): number {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  return new Date(normalized).getTime();
}

function emptyRefRollup(ref: string): RefRollup {
  return {
    ref,
    memoryInference: {
      childRefs: [],
      directExposure: 0,
      surfaceExposure: 0,
      directShow: 0,
      surfaceShow: 0,
      directCurate: 0,
      surfaceCurate: 0,
    },
    graphExtraction: { exposures: 0, selected: 0, shownReadBack: 0 },
  };
}

function sourceFileFingerprint(filePath: string): SourceFileFingerprint | null {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    return {
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameFingerprint(a: SourceFileFingerprint | null, b: SourceFileFingerprint | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

function createStateDbSnapshot(stateDb: string): StateDbSnapshot {
  if (!fs.existsSync(stateDb)) throw new Error(`state.db not found: ${stateDb}`);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-attribution-rollup-"));
  try {
    for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
      const attemptDir = path.join(tempRoot, String(attempt));
      fs.mkdirSync(attemptDir);
      const sourcePaths = SQLITE_SNAPSHOT_SUFFIXES.map((suffix) => `${stateDb}${suffix}`);
      const before = sourcePaths.map(sourceFileFingerprint);
      if (!before[0]) throw new Error(`state.db not found: ${stateDb}`);

      try {
        for (const [index, sourcePath] of sourcePaths.entries()) {
          if (!before[index]) continue;
          const destination = path.join(attemptDir, `state.db${SQLITE_SNAPSHOT_SUFFIXES[index]}`);
          fs.copyFileSync(sourcePath, destination);
          fs.chmodSync(destination, 0o600);
        }
      } catch {
        fs.rmSync(attemptDir, { recursive: true, force: true });
        continue;
      }

      const after = sourcePaths.map(sourceFileFingerprint);
      if (before.every((fingerprint, index) => sameFingerprint(fingerprint, after[index] ?? null))) {
        let cleaned = false;
        return {
          databasePath: path.join(attemptDir, "state.db"),
          cleanup() {
            if (cleaned) return;
            cleaned = true;
            fs.rmSync(tempRoot, { recursive: true, force: true });
          },
        };
      }
      fs.rmSync(attemptDir, { recursive: true, force: true });
    }
    throw new Error("state.db changed while creating a consistent read snapshot; retry the report");
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

export function rollupAttributionRows(rows: AttributionUsageRow[]): AttributionRollupReport {
  const report: AttributionRollupReport = {
    tool: "akm-eval-attribution-rollup",
    mode: "read-only",
    source: "user",
    readBackWindowSeconds: READ_BACK_WINDOW_MS / 1000,
    memoryInference: {
      exposure: { direct: 0, surface: 0 },
      consumption: {
        show: { direct: 0, surface: 0 },
        curate: { direct: 0, surface: 0 },
      },
    },
    graphExtraction: {
      exposures: 0,
      selected: 0,
      shownReadBack: 0,
      interpretation: "Applied capped ranking contribution; not proof that graph changed rank or selection.",
    },
    currentControl: { search: 0, show: 0, curate: 0, total: 0 },
    historicalUnattributed: { search: 0, show: 0, curate: 0, total: 0 },
    excludedUnqualifiedRows: 0,
    refs: [],
  };
  const byRef = new Map<string, RefRollup>();
  const latestExposure = new Map<string, { attribution: ParsedAttribution; at: number }>();

  for (const row of [...rows].sort((a, b) => a.id - b.id)) {
    if (row.source !== "user" || !row.entryRef) continue;
    if (row.eventType !== "search" && row.eventType !== "show" && row.eventType !== "curate") continue;
    if (!row.entryRef.includes("//")) {
      report.excludedUnqualifiedRows += 1;
      continue;
    }
    const parsedMetadata = parseMetadata(row.metadata);
    const own = parsedMetadata.kind === "attribution" ? parsedMetadata.attribution : undefined;
    const prior = latestExposure.get(row.entryRef);
    const at = timestampMs(row.createdAt);
    const recentPrior =
      row.eventType === "show" &&
      prior &&
      Number.isFinite(at) &&
      Number.isFinite(prior.at) &&
      at >= prior.at &&
      at - prior.at <= READ_BACK_WINDOW_MS
        ? prior.attribution
        : undefined;
    const effective: ParsedAttribution | undefined =
      own || recentPrior
        ? {
            memoryInference: own?.memoryInference ?? recentPrior?.memoryInference,
            graphExtraction: own?.graphExtraction ?? recentPrior?.graphExtraction,
          }
        : undefined;

    if (row.eventType === "search" || row.eventType === "curate") {
      if (own) latestExposure.set(row.entryRef, { attribution: own, at });
      else latestExposure.delete(row.entryRef);
    }

    if (!effective) {
      if (parsedMetadata.kind === "control") {
        report.currentControl[row.eventType] += 1;
        report.currentControl.total += 1;
      } else {
        report.historicalUnattributed[row.eventType] += 1;
        report.historicalUnattributed.total += 1;
      }
      continue;
    }

    let refRollup = byRef.get(row.entryRef);
    if (!refRollup) {
      refRollup = emptyRefRollup(row.entryRef);
      byRef.set(row.entryRef, refRollup);
    }
    if (
      effective.memoryInference &&
      !refRollup.memoryInference.childRefs.includes(effective.memoryInference.childRef)
    ) {
      refRollup.memoryInference.childRefs.push(effective.memoryInference.childRef);
    }

    if (row.eventType === "search") {
      if (effective.memoryInference) {
        const kind = effective.memoryInference.exposure;
        report.memoryInference.exposure[kind] += 1;
        refRollup.memoryInference[kind === "direct" ? "directExposure" : "surfaceExposure"] += 1;
      }
      if (effective.graphExtraction) {
        report.graphExtraction.exposures += 1;
        refRollup.graphExtraction.exposures += 1;
      }
      continue;
    }

    if (effective.memoryInference) {
      const kind = effective.memoryInference.exposure;
      report.memoryInference.consumption[row.eventType][kind] += 1;
      const key = `${kind}${row.eventType === "show" ? "Show" : "Curate"}` as
        | "directShow"
        | "surfaceShow"
        | "directCurate"
        | "surfaceCurate";
      refRollup.memoryInference[key] += 1;
    }
    if (effective.graphExtraction) {
      if (row.eventType === "show") {
        report.graphExtraction.shownReadBack += 1;
        refRollup.graphExtraction.shownReadBack += 1;
      } else {
        report.graphExtraction.selected += 1;
        refRollup.graphExtraction.selected += 1;
      }
    }
  }

  report.refs = [...byRef.values()]
    .filter((entry) => {
      const memoryTotal =
        entry.memoryInference.directExposure +
        entry.memoryInference.surfaceExposure +
        entry.memoryInference.directShow +
        entry.memoryInference.surfaceShow +
        entry.memoryInference.directCurate +
        entry.memoryInference.surfaceCurate;
      const graphTotal = Object.values(entry.graphExtraction).reduce((sum, count) => sum + count, 0);
      return memoryTotal + graphTotal > 0;
    })
    .sort((a, b) => a.ref.localeCompare(b.ref));
  return report;
}

export function readAttributionRows(stateDb: string): AttributionUsageRow[] {
  const snapshot = createStateDbSnapshot(stateDb);
  try {
    // The disposable copy may create/recover SQLite sidecars; the source files
    // are never opened by SQLite and remain filesystem-read-only.
    const db = new Database(snapshot.databasePath);
    try {
      db.exec("PRAGMA query_only = ON");
      const rows = db
        .query(
          `SELECT id, event_type, entry_ref, metadata, source, created_at
           FROM usage_events
          WHERE source = 'user'
            AND entry_ref IS NOT NULL
            AND event_type IN ('search', 'show', 'curate')
          ORDER BY id`,
        )
        .all() as Array<{
        id: number;
        event_type: string;
        entry_ref: string | null;
        metadata: string | null;
        source: string | null;
        created_at: string;
      }>;
      return rows.map((row) => ({
        id: row.id,
        eventType: row.event_type,
        entryRef: row.entry_ref,
        metadata: row.metadata,
        source: row.source,
        createdAt: row.created_at,
      }));
    } finally {
      db.close();
    }
  } finally {
    snapshot.cleanup();
  }
}

function renderMarkdown(report: AttributionRollupReport): string {
  const lines = [
    "# Downstream value attribution",
    "",
    "Read-only: yes",
    "Source: user",
    `Memory inference exposure: ${report.memoryInference.exposure.direct} direct, ${report.memoryInference.exposure.surface} surface`,
    `Memory inference show consumption: ${report.memoryInference.consumption.show.direct} direct, ${report.memoryInference.consumption.show.surface} surface`,
    `Memory inference curate consumption: ${report.memoryInference.consumption.curate.direct} direct, ${report.memoryInference.consumption.curate.surface} surface`,
    `Graph extraction: ${report.graphExtraction.exposures} exposures, ${report.graphExtraction.selected} selected, ${report.graphExtraction.shownReadBack} shown read-back`,
    `Graph interpretation: ${report.graphExtraction.interpretation}`,
    `Current control rows: ${report.currentControl.total}`,
    `Historical unattributed rows: ${report.historicalUnattributed.total}`,
    `Excluded unqualified rows: ${report.excludedUnqualifiedRows}`,
    "",
    "## Fully Qualified Refs",
    "",
    ...report.refs.map((entry) => `- \`${entry.ref}\``),
    "",
  ];
  return lines.join("\n");
}

function pathExistsIncludingSymlink(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function sameExistingFile(a: string, b: string): boolean {
  try {
    const aStat = fs.statSync(a);
    const bStat = fs.statSync(b);
    return aStat.dev === bStat.dev && aStat.ino === bStat.ino;
  } catch {
    return false;
  }
}

function printHelp(): void {
  process.stdout.write(`akm-eval-attribution-rollup - read-only downstream value report

Usage:
  akm-eval-attribution-rollup [options]

Options:
  --state-db <path>   state.db containing usage_events.
  --format <format>   json | md (default: md).
  --out <path>        Also create this report; existing/input files are refused.
  -h, --help          Show help.
`);
}

interface CliOptions {
  stateDb: string;
  format: "json" | "md";
  out?: string;
}

function parseArgs(argv: string[]): CliOptions | undefined {
  const options: CliOptions = { stateDb: resolveStateDbPath(), format: "md" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--state-db":
        options.stateDb = path.resolve(next());
        break;
      case "--format": {
        const value = next();
        if (value !== "json" && value !== "md") throw new Error(`--format must be json|md (got ${value})`);
        options.format = value;
        break;
      }
      case "--out":
        options.out = path.resolve(next());
        break;
      case "-h":
      case "--help":
        printHelp();
        return undefined;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

export function runAttributionRollupCli(argv: string[]): number {
  const options = parseArgs(argv);
  if (!options) return 0;
  if (options.out) {
    if (path.resolve(options.out) === path.resolve(options.stateDb) || sameExistingFile(options.out, options.stateDb)) {
      throw new Error(`--out collides with the input database: ${options.stateDb}`);
    }
    if (pathExistsIncludingSymlink(options.out)) throw new Error(`--out already exists: ${options.out}`);
  }
  const report = rollupAttributionRows(readAttributionRows(options.stateDb));
  const rendered = options.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report);
  if (options.out) {
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, rendered, { encoding: "utf8", flag: "wx" });
  }
  process.stdout.write(rendered);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = runAttributionRollupCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[akm-eval-attribution-rollup] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
