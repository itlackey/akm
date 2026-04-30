/**
 * Graph-extraction pass for `akm index` (#207).
 *
 * Walks the primary stash for `memory:` and `knowledge:` assets, asks the
 * configured LLM to extract entities and relations from each one, and
 * persists the result to a single stash-local artifact at
 * `<stashRoot>/.akm/graph.json`. The artifact is consumed by the search
 * pipeline (see `src/indexer/graph-boost.ts`) as a single boost component
 * inside the existing FTS5+boosts loop — there is NO second SearchHit
 * scorer and no parallel ranking track.
 *
 * Disabling — three preconditions must ALL hold for the pass to run:
 *   1. `akm.llm` must be configured (no provider = no extraction). When
 *      absent, `resolveIndexPassLLM("graph", config)` returns `undefined`
 *      and the pass short-circuits.
 *   2. `llm.features.graph_extraction !== false` — the locked v1 spec §14
 *      feature-flag layer. Set to `false` to block the pass at the
 *      feature-gate layer (no network call may ever issue).
 *   3. `index.graph.llm !== false` — the per-pass opt-out layer (#208).
 *      Set to `false` to skip just this pass while leaving other passes
 *      that share the same `llm` block enabled.
 *   Toggling any one off does NOT delete the existing `graph.json` — the
 *   user keeps the boost component they already have, it just stops
 *   refreshing.
 *
 * Locked v1 contract:
 *   - LLM access is exclusively via `resolveIndexPassLLM("graph", config)`.
 *   - The `graph.json` file is an indexer artifact, NOT a user-visible
 *     asset. It does not have an asset ref, does not appear in search
 *     hits, and is not addressable via `akm show`. Direct `fs.writeFile`
 *     is therefore the correct primitive — `writeAssetToSource` is
 *     reserved for asset writes (CLAUDE.md / spec §10 step 5).
 */

import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../core/config";
import { parseFrontmatter } from "../core/frontmatter";
import { warn } from "../core/warn";
import { extractGraphFromBody, type GraphRelation } from "../llm/graph-extract";
import { resolveIndexPassLLM } from "../llm/index-passes";
import type { SearchSource } from "./search-source";

/** Schema version for the persisted artifact — bumps trigger a full rebuild. */
export const GRAPH_FILE_SCHEMA_VERSION = 1;

/** Path scheme — kept stable so consumers (search-time boost) can find it. */
export const GRAPH_FILE_RELATIVE_PATH = path.join(".akm", "graph.json");

/** Public path resolver — exported so the search-side reader and tests share the rule. */
export function getGraphFilePath(stashRoot: string): string {
  return path.join(stashRoot, GRAPH_FILE_RELATIVE_PATH);
}

/** One node in the graph — corresponds to a single asset file. */
export interface GraphFileNode {
  /** Absolute path on disk. */
  path: string;
  /** Asset type (`memory` or `knowledge`). */
  type: string;
  /** Entities surfaced by the LLM for this file. Lower-cased before matching. */
  entities: string[];
  /** Relations the LLM surfaced from this file's body. */
  relations: GraphRelation[];
}

/** On-disk shape of `graph.json`. */
export interface GraphFile {
  schemaVersion: number;
  /** ISO-8601 timestamp of the last refresh. */
  generatedAt: string;
  /** Stash root the file was extracted from (canonicalised). */
  stashRoot: string;
  /** Per-file extraction results. */
  files: GraphFileNode[];
}

/** Telemetry — useful for tests and progress events. */
export interface GraphExtractionResult {
  /** Eligible files considered (all `memory:` / `knowledge:` markdown files). */
  considered: number;
  /** Files for which the LLM returned at least one entity. */
  extracted: number;
  /** Total entities across all extracted files. */
  totalEntities: number;
  /** Total relations across all extracted files. */
  totalRelations: number;
  /** Whether `graph.json` was written this run. False when the pass is a no-op. */
  written: boolean;
}

const EMPTY_RESULT: GraphExtractionResult = {
  considered: 0,
  extracted: 0,
  totalEntities: 0,
  totalRelations: 0,
  written: false,
};

/**
 * Top-level entry point. Returns a no-op result when the pass is disabled.
 *
 * Three preconditions — ALL must hold for the pass to run:
 *
 *   1. **Provider configured** — `akm.llm` must be present. Without a
 *      configured provider, `resolveIndexPassLLM("graph", config)` returns
 *      `undefined` (the pass cannot run because there is no model to call).
 *   2. **Feature gate** — `llm.features.graph_extraction` (defaults to
 *      `true`). When `false`, no network call may issue regardless of
 *      per-pass settings. This is the locked spec-§14 gate.
 *   3. **Per-pass gate** — `index.graph.llm` (defaults to `true`). When
 *      `false`, the indexer simply skips this pass for the current run.
 *
 * If any of the three is missing or `false`, this function short-circuits
 * to an empty no-op result, leaving any existing `graph.json` untouched on
 * disk.
 */
export async function runGraphExtractionPass(
  config: AkmConfig,
  sources: SearchSource[],
): Promise<GraphExtractionResult> {
  // Gate 1 — locked feature flag (§14). Defaults to enabled; only an
  // explicit `false` disables the pass entirely.
  if (config.llm?.features?.graph_extraction === false) return { ...EMPTY_RESULT };

  // Gate 2 — per-pass opt-out (#208). Returns the resolved llm config or
  // `undefined` when the pass should not run.
  const llmConfig = resolveIndexPassLLM("graph", config);
  if (!llmConfig) return { ...EMPTY_RESULT };

  // The pass only writes to the primary (working) stash. Read-only caches
  // (git, npm, website) are deliberately untouched — the graph artifact for
  // those sources would be clobbered by the next sync().
  const primary = sources[0];
  if (!primary) return { ...EMPTY_RESULT };

  const eligible = collectEligibleFiles(primary.path);
  const considered = eligible.length;
  if (considered === 0) return { ...EMPTY_RESULT };

  const nodes: GraphFileNode[] = [];
  let totalEntities = 0;
  let totalRelations = 0;

  for (const candidate of eligible) {
    const extraction = await extractGraphFromBody(llmConfig, candidate.body);
    if (extraction.entities.length === 0) continue;
    nodes.push({
      path: candidate.absPath,
      type: candidate.type,
      // Lower-case once at write time so the search-time boost can do a
      // single case-folded comparison without re-canonicalising on every
      // query.
      entities: extraction.entities.map((e) => e.toLowerCase()),
      relations: extraction.relations.map((r) => ({
        from: r.from.toLowerCase(),
        to: r.to.toLowerCase(),
        ...(r.type ? { type: r.type.toLowerCase() } : {}),
      })),
    });
    totalEntities += extraction.entities.length;
    totalRelations += extraction.relations.length;
  }

  const graph: GraphFile = {
    schemaVersion: GRAPH_FILE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    stashRoot: primary.path,
    files: nodes,
  };

  const written = writeGraphFile(primary.path, graph);

  return {
    considered,
    extracted: nodes.length,
    totalEntities,
    totalRelations,
    written,
  };
}

// ── Eligible-file detection ─────────────────────────────────────────────────

interface EligibleFile {
  absPath: string;
  type: "memory" | "knowledge";
  body: string;
}

/**
 * Scan the primary stash for `memory:` and `knowledge:` markdown files
 * suitable for graph extraction. The directory layout convention is the
 * same one the rest of the indexer uses: `<stashRoot>/<type>/...`.
 *
 * Inferred-child memories (frontmatter `inferred: true`) are skipped — they
 * are atomic facts already, with no internal graph structure worth
 * extracting.
 *
 * Exported for direct unit testing.
 */
export function collectEligibleFiles(stashRoot: string): EligibleFile[] {
  const out: EligibleFile[] = [];
  for (const type of ["memory", "knowledge"] as const) {
    const dir = path.join(stashRoot, `${type === "memory" ? "memories" : "knowledge"}`);
    if (!fs.existsSync(dir)) continue;
    for (const filePath of walkMarkdownFiles(dir)) {
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      const parsed = parseFrontmatter(raw);
      // Skip inferred memory children — they are atomic and there's no
      // graph to extract from a single-fact body.
      if (type === "memory" && parsed.data.inferred === true) continue;
      const body = parsed.content.trim();
      if (!body) continue;
      out.push({ absPath: filePath, type, body });
    }
  }
  return out;
}

function* walkMarkdownFiles(root: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdownFiles(full);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      yield full;
    }
  }
}

// ── Persistence ─────────────────────────────────────────────────────────────

/**
 * Write `graph.json` atomically to `<stashRoot>/.akm/graph.json`.
 *
 * Direct `fs.writeFile` is intentional. The graph artifact is an indexer
 * cache — not a user-visible asset — so it does not have an asset ref and
 * `writeAssetToSource` (which routes through the asset-spec rendering
 * layer) is the wrong primitive here. See CLAUDE.md / spec §10 step 5 for
 * the carve-out: kind-branching writes for asset content live in
 * `src/core/write-source.ts`; opaque indexer artifacts may write directly.
 */
function writeGraphFile(stashRoot: string, graph: GraphFile): boolean {
  const target = getGraphFilePath(stashRoot);
  const dir = path.dirname(target);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmp, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, target);
    return true;
  } catch (err) {
    warn(`graph extraction: failed to write ${target}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
