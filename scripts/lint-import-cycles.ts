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
 *   - Chunk 9 kills the non-taxonomy cycles and Chunk 3 drives the count to 0
 *     (manifest gates), at which point the baseline empties and this becomes
 *     an absolute no-cycles gate.
 *
 * Known limitation, accepted: a brand-new edge between two files ALREADY in
 * the baseline (deepening the existing knot) is not detected — participant
 * granularity trades that for zero churn while the knot is being dismantled.
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
 * completion HEAD (43d6f10). Files may only ever LEAVE this list (Chunk 9
 * kills the non-taxonomy cycles; Chunk 3 empties it). Never add an entry.
 */
export const CYCLE_PARTICIPANT_BASELINE: readonly string[] = [
  "src/commands/env/env.ts",
  "src/commands/improve/consolidate.ts",
  "src/commands/improve/consolidate/eligibility.ts",
  "src/commands/improve/distill.ts",
  "src/commands/improve/distill/content-repair.ts",
  "src/commands/improve/distill/promote-memory.ts",
  "src/commands/improve/distill/quality-gate.ts",
  "src/commands/improve/eligibility.ts",
  "src/commands/improve/extract.ts",
  "src/commands/improve/improve.ts",
  "src/commands/improve/loop-stages.ts",
  "src/commands/improve/preparation.ts",
  "src/commands/improve/proposal-envelope.ts",
  "src/commands/improve/reflect.ts",
  "src/commands/proposal/legacy-import.ts",
  "src/commands/proposal/repository.ts",
  "src/commands/proposal/validators/proposal-quality-validators.ts",
  "src/commands/proposal/validators/proposal-validators.ts",
  "src/commands/proposal/validators/proposals.ts",
  "src/core/asset/asset-ref.ts",
  "src/core/asset/asset-registry.ts",
  "src/core/asset/asset-spec.ts",
  "src/core/common.ts",
  "src/core/config/config-io.ts",
  "src/core/config/config-schema.ts",
  "src/core/config/config-sources.ts",
  "src/core/config/config-types.ts",
  "src/core/config/config.ts",
  "src/core/events.ts",
  "src/core/file-lock.ts",
  "src/core/improve-types.ts",
  "src/core/migration-operation.ts",
  "src/core/paths.ts",
  "src/core/write-source.ts",
  "src/indexer/db/db.ts",
  "src/indexer/db/entry-mapper.ts",
  "src/indexer/db/graph-db.ts",
  "src/indexer/db/schema.ts",
  "src/indexer/graph/graph-dedup.ts",
  "src/indexer/graph/graph-extraction.ts",
  "src/indexer/passes/metadata-contributors.ts",
  "src/indexer/passes/metadata.ts",
  "src/indexer/search/ranking-contributors.ts",
  "src/indexer/search/ranking.ts",
  "src/indexer/walk/file-context.ts",
  "src/integrations/agent/builder-shared.ts",
  "src/integrations/agent/builders.ts",
  "src/integrations/agent/engine-resolution.ts",
  "src/integrations/agent/runner.ts",
  "src/integrations/agent/spawn.ts",
  "src/integrations/harnesses/aider/agent-builder.ts",
  "src/integrations/harnesses/aider/index.ts",
  "src/integrations/harnesses/aider/result-extractor.ts",
  "src/integrations/harnesses/amazonq/agent-builder.ts",
  "src/integrations/harnesses/amazonq/index.ts",
  "src/integrations/harnesses/amazonq/result-extractor.ts",
  "src/integrations/harnesses/claude/agent-builder.ts",
  "src/integrations/harnesses/claude/config-import.ts",
  "src/integrations/harnesses/claude/index.ts",
  "src/integrations/harnesses/claude/result-extractor.ts",
  "src/integrations/harnesses/codex/agent-builder.ts",
  "src/integrations/harnesses/codex/index.ts",
  "src/integrations/harnesses/codex/result-extractor.ts",
  "src/integrations/harnesses/copilot/agent-builder.ts",
  "src/integrations/harnesses/copilot/index.ts",
  "src/integrations/harnesses/copilot/result-extractor.ts",
  "src/integrations/harnesses/gemini/agent-builder.ts",
  "src/integrations/harnesses/gemini/index.ts",
  "src/integrations/harnesses/gemini/result-extractor.ts",
  "src/integrations/harnesses/index.ts",
  "src/integrations/harnesses/opencode-sdk/harness.ts",
  "src/integrations/harnesses/opencode/agent-builder.ts",
  "src/integrations/harnesses/opencode/config-import.ts",
  "src/integrations/harnesses/opencode/index.ts",
  "src/integrations/harnesses/openhands/agent-builder.ts",
  "src/integrations/harnesses/openhands/index.ts",
  "src/integrations/harnesses/openhands/result-extractor.ts",
  "src/integrations/harnesses/pi/agent-builder.ts",
  "src/integrations/harnesses/pi/index.ts",
  "src/integrations/harnesses/pi/result-extractor.ts",
  "src/integrations/harnesses/types.ts",
  "src/llm/feature-gate.ts",
  "src/llm/graph-extract.ts",
  "src/output/renderers.ts",
  "src/registry/types.ts",
  "src/setup/harness-config-import.ts",
  "src/sources/providers/git-stash.ts",
  "src/sources/providers/git.ts",
  "src/sources/types.ts",
  "src/sources/wiki-fetchers/registry.ts",
  "src/sources/wiki-fetchers/youtube.ts",
  "src/storage/repositories/events-repository.ts",
  "src/storage/repositories/proposals-repository.ts",
  "src/tasks/backends/cron.ts",
  "src/tasks/backends/index.ts",
  "src/tasks/backends/launchd.ts",
  "src/tasks/backends/schtasks.ts",
  "src/workflows/exec/step-work.ts",
  "src/workflows/parser.ts",
  "src/workflows/program/parser.ts",
  "src/workflows/program/project.ts",
  "src/workflows/program/schema.ts",
  "src/workflows/renderer.ts",
  "src/workflows/runtime/document-cache.ts",
  "src/workflows/runtime/runs.ts",
  "src/workflows/runtime/unit-checkin.ts",
  "src/workflows/validator.ts",
];

/** Files in a cycle now that are not in the baseline (empty = green). */
export function checkImportCycleRatchet(participants: readonly string[] = measureCycleParticipants()): string[] {
  const allowed = new Set(CYCLE_PARTICIPANT_BASELINE);
  return participants.filter((p) => !allowed.has(p));
}

if (import.meta.main) {
  const participants = measureCycleParticipants();
  const violations = checkImportCycleRatchet(participants);
  if (violations.length > 0) {
    console.error(
      `lint-import-cycles: ${violations.length} file(s) joined an import cycle (baseline is shrink-only):`,
    );
    for (const v of violations) console.error(`  NEW cycle participant: ${v}`);
    process.exit(1);
  }
  console.log(
    `lint-import-cycles: OK — ${participants.length} cycle participant(s), all within the shrink-only baseline (${CYCLE_PARTICIPANT_BASELINE.length}).`,
  );
}
