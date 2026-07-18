// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Import-cycle ratchet for `src/**` (plan §10.7 / §11 Chunk 9, armed early —
 * 0.9.0 gate hardening).
 *
 * Builds the static module graph (top-level `import` / `export … from`
 * declarations, INCLUDING type-only imports — dependency direction is an
 * architecture property, not a runtime one; dynamic `import()` is excluded
 * because it is the repo's sanctioned lazy-loading escape hatch), finds
 * strongly-connected components via Tarjan, and treats every file inside an
 * SCC of size > 1 (or with a self-import) as a CYCLE PARTICIPANT.
 *
 * Ratchet semantics (shrink-tolerant, like `lint-src-fn-size.ts`):
 *   - a file NOT in {@link CYCLE_PARTICIPANT_BASELINE} that participates in a
 *     cycle fails (no NEW files may join the knot);
 *   - files leaving the knot pass silently — no baseline edit required;
 *   - kill ownership (plan DoD 11): Chunk 9 takes the named + unowned local
 *     knots, Chunk 3 the taxonomy set, Chunk 5 the indexer-db trio, Chunk 8
 *     the workflows-runtime trio — the baseline is EMPTY after Chunk 8 and
 *     this becomes an absolute no-cycles gate.
 *
 * Known limitation, accepted: a brand-new edge between two files ALREADY in
 * the baseline (deepening the existing knot) is not detected — participant
 * granularity trades that for zero churn while the knot is being dismantled.
 *
 * COMPANION RATCHET (adversarial-audit hardening, 2026-07-16): because
 * dynamic `import()` is excluded from the graph, converting a static import
 * to `await import()` would silence a cycle red while merely deferring the
 * cycle — a one-line, house-style dodge. So dynamic-import call sites are
 * ratcheted too: {@link DYNAMIC_IMPORT_BASELINE} pins today's per-file
 * counts, and no file may GROW its count (new lazy-loads need a loud,
 * reviewable baseline edit; shrinking is silent). Cycle-laundering via
 * import() is therefore a visible red, not an escape hatch.
 *
 * Enforced by `tests/architecture/import-cycle-ratchet.test.ts` (unit suite →
 * every chunk Finalize carries it).
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

function* walkTsFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkTsFiles(full);
    else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) yield full;
  }
}

function toRel(abs: string): string {
  return path.relative(REPO_ROOT, abs).replace(/\\/g, "/");
}

/** Resolve a relative import specifier to a repo file, mirroring bundler resolution. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // external package — not part of the graph
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    base.replace(/\.js$/, ".ts"), // ESM-style ".js" specifiers authored against ".ts" sources
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile() && (c.endsWith(".ts") || c.endsWith(".tsx"))) return c;
  }
  return null; // .md/.xml text imports, assets, or unresolved — not graph edges
}

/** Static import graph over src/**: repo-relative file → repo-relative imports. */
export function buildImportGraph(): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const file of walkTsFiles(SRC_ROOT)) {
    const rel = toRel(file);
    const edges = new Set<string>();
    const src = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const stmt of sf.statements) {
      let spec: string | null = null;
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) spec = stmt.moduleSpecifier.text;
      else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier))
        spec = stmt.moduleSpecifier.text;
      if (spec === null) continue;
      const resolved = resolveSpecifier(file, spec);
      if (resolved !== null) edges.add(toRel(resolved));
    }
    graph.set(rel, edges);
  }
  return graph;
}

/** Tarjan strongly-connected components; returns components of size > 1 plus self-loop singletons. */
function cyclicComponents(graph: Map<string, Set<string>>): string[][] {
  let index = 0;
  const nodeIndex = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  // Iterative Tarjan (explicit frames) — src/ is ~500 modules deep enough to
  // overflow a recursive walk on long import chains.
  interface Frame {
    node: string;
    iter: Iterator<string>;
    child: string | null;
  }

  const visit = (root: string): void => {
    const frames: Frame[] = [{ node: root, iter: (graph.get(root) ?? new Set()).values(), child: null }];
    nodeIndex.set(root, index);
    lowLink.set(root, index);
    index += 1;
    stack.push(root);
    onStack.add(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame.child !== null) {
        // Returning from a child visit: fold its lowlink into ours.
        lowLink.set(frame.node, Math.min(lowLink.get(frame.node) ?? 0, lowLink.get(frame.child) ?? 0));
        frame.child = null;
      }
      const next = frame.iter.next();
      if (!next.done) {
        const target = next.value;
        if (!graph.has(target)) continue;
        if (!nodeIndex.has(target)) {
          nodeIndex.set(target, index);
          lowLink.set(target, index);
          index += 1;
          stack.push(target);
          onStack.add(target);
          frame.child = target;
          frames.push({ node: target, iter: (graph.get(target) ?? new Set()).values(), child: null });
        } else if (onStack.has(target)) {
          lowLink.set(frame.node, Math.min(lowLink.get(frame.node) ?? 0, nodeIndex.get(target) ?? 0));
        }
        continue;
      }
      // Node exhausted: close its component if it is a root.
      if (lowLink.get(frame.node) === nodeIndex.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const popped = stack.pop();
          if (popped === undefined) break;
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.node) break;
        }
        const selfLoop = component.length === 1 && (graph.get(component[0])?.has(component[0]) ?? false);
        if (component.length > 1 || selfLoop) components.push(component.sort());
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) parent.child = frame.node;
    }
  };

  for (const node of graph.keys()) {
    if (!nodeIndex.has(node)) visit(node);
  }
  return components;
}

/** Sorted repo-relative list of every file participating in an import cycle. */
export function measureCycleParticipants(): string[] {
  const components = cyclicComponents(buildImportGraph());
  const participants = new Set<string>();
  for (const component of components) for (const file of component) participants.add(file);
  return [...participants].sort();
}

/**
 * SHRINK-ONLY baseline: the cycle participants measured at the chunk-7
 * completion HEAD (43d6f10). Files may only ever LEAVE this list (kill
 * ownership per plan DoD 11: Chunk 9 → named + unowned knots, Chunk 3 →
 * taxonomy, Chunk 5 → indexer-db trio, Chunk 8 → workflows-runtime trio,
 * emptying it). Never add an entry.
 *
 * Trimmed 28 → 18 by chunk 1.5 (WI-1.5.1, D1.5-7): deleting `common.ts`'s
 * closed asset-type union severed its `import { getAssetTypes, TYPE_DIRS
 * } from "./asset/asset-spec"` edge (the union's only reason to import
 * asset-spec.ts) and `asset-ref.ts`'s now-fully-dead `common.ts` import,
 * clearing 10 participants as a pure side effect: `commands/env/env.ts`,
 * `core/asset/asset-ref.ts`, `core/config/config-io.ts`, `core/file-lock.ts`,
 * `core/migration-operation.ts`, `indexer/walk/file-context.ts`,
 * `sources/types.ts`, `workflows/parser.ts`, `workflows/program/project.ts`,
 * `workflows/validator.ts`. `common.ts` itself stays a participant via a
 * separate `common.ts <-> paths.ts` round trip. Empirically re-verified
 * against the live tree (`bun scripts/lint-import-cycles.ts` → 18), not just
 * reasoned about — see `docs/design/execution/chunk-1.5/anchors.md` §E.1.
 */
export const CYCLE_PARTICIPANT_BASELINE: readonly string[] = [
  // chunk-3 (taxonomy cutover) drove the count 18 → 13: the taxonomy trio
  // (asset-registry.ts, asset-spec.ts — both deleted — and output/renderers.ts)
  // left the knot, and with them workflows/renderer.ts +
  // workflows/runtime/document-cache.ts. Baseline tightened to lock in the drop.
  "src/core/common.ts",
  "src/core/config/config-schema.ts",
  "src/core/config/config.ts",
  "src/core/paths.ts",
  "src/indexer/db/db.ts",
  "src/indexer/db/entry-mapper.ts",
  "src/indexer/db/schema.ts",
  "src/indexer/passes/metadata-contributors.ts",
  "src/indexer/passes/metadata.ts",
  "src/registry/types.ts",
  "src/workflows/exec/step-work.ts",
  "src/workflows/runtime/runs.ts",
  "src/workflows/runtime/unit-checkin.ts",
];

/** Files in a cycle now that are not in the baseline (empty = green). */
export function checkImportCycleRatchet(participants: readonly string[] = measureCycleParticipants()): string[] {
  const allowed = new Set(CYCLE_PARTICIPANT_BASELINE);
  return participants.filter((p) => !allowed.has(p));
}

/** Per-file count of dynamic `import(...)` call sites across src/**. */
export function measureDynamicImports(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of walkTsFiles(SRC_ROOT)) {
    const rel = toRel(file);
    const src = fs.readFileSync(file, "utf8");
    if (!src.includes("import(")) continue;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let n = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) n += 1;
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (n > 0) counts.set(rel, n);
  }
  return counts;
}

/**
 * SHRINK-ONLY per-file dynamic-import baseline at the chunk-7 completion HEAD.
 * A genuinely new lazy-load lowers no gate — it edits this map, loudly, in its
 * own reviewable diff line. Converting a static import to import() to dodge
 * the cycle ratchet trips this instead.
 */
export const DYNAMIC_IMPORT_BASELINE: Readonly<Record<string, number>> = {
  "src/cli.ts": 8,
  "src/commands/agent/agent-dispatch.ts": 1,
  "src/commands/agent/contribute-cli.ts": 1,
  "src/commands/config-cli.ts": 2,
  "src/commands/env/env-cli.ts": 10,
  "src/commands/env/secret-cli.ts": 5,
  "src/commands/migrate-cli.ts": 2,
  "src/commands/proposal/proposal-cli.ts": 7,
  "src/commands/proposal/propose.ts": 4,
  "src/commands/read/show.ts": 2,
  "src/commands/registry-cli.ts": 1,
  "src/commands/remember.ts": 2,
  "src/commands/sources/add-cli.ts": 2,
  "src/commands/sources/sources-cli.ts": 1,
  "src/commands/wiki-cli.ts": 13,
  "src/commands/workflow-cli.ts": 7,
  "src/indexer/ensure-index.ts": 1,
  "src/indexer/indexer.ts": 10,
  "src/indexer/init.ts": 3,
  "src/indexer/passes/metadata-contributors.ts": 1,
  "src/indexer/search/db-search.ts": 1,
  "src/indexer/walk/file-context.ts": 1,
  "src/integrations/harnesses/opencode-sdk/sdk-runner.ts": 2,
  "src/llm/embedders/local.ts": 1,
  "src/setup/detect.ts": 1,
  "src/setup/setup.ts": 1,
  "src/sources/providers/sync-from-ref.ts": 2,
  "src/sources/snapshot-fetchers/registry.ts": 1,
  "src/storage/repositories/events-repository.ts": 1,
  "src/workflows/exec/frozen-judge.ts": 1,
  "src/workflows/exec/native-executor.ts": 4,
  "src/workflows/exec/report.ts": 1,
};

export interface DynamicImportViolation {
  file: string;
  count: number;
  kind: "new" | "grew";
  baseline?: number;
}

/** Dynamic-import ratchet check (empty = green). */
export function checkDynamicImportRatchet(
  counts: ReadonlyMap<string, number> = measureDynamicImports(),
): DynamicImportViolation[] {
  const violations: DynamicImportViolation[] = [];
  for (const [file, count] of counts) {
    const base = DYNAMIC_IMPORT_BASELINE[file];
    if (base === undefined) violations.push({ file, count, kind: "new" });
    else if (count > base) violations.push({ file, count, kind: "grew", baseline: base });
  }
  return violations;
}

if (import.meta.main) {
  const participants = measureCycleParticipants();
  const violations = checkImportCycleRatchet(participants);
  const dynamicViolations = checkDynamicImportRatchet();
  if (violations.length > 0 || dynamicViolations.length > 0) {
    console.error(
      `lint-import-cycles: ${violations.length + dynamicViolations.length} ratchet violation(s) (baselines are shrink-only):`,
    );
    for (const v of violations) console.error(`  NEW cycle participant: ${v}`);
    for (const v of dynamicViolations)
      console.error(
        v.kind === "new"
          ? `  NEW dynamic-import file: ${v.file} (${v.count} site(s)) — if this is a genuine lazy-load, add it to DYNAMIC_IMPORT_BASELINE in its own diff line; if it dodges a cycle, break the cycle`
          : `  dynamic-import count GREW: ${v.file} ${v.baseline} → ${v.count}`,
      );
    process.exit(1);
  }
  console.log(
    `lint-import-cycles: OK — ${participants.length} cycle participant(s) within baseline (${CYCLE_PARTICIPANT_BASELINE.length}); dynamic-import counts within baseline.`,
  );
}
