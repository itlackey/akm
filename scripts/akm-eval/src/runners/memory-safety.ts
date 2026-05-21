/**
 * Memory-safety runner — mandatory sandbox isolation.
 *
 * Copies a fixture stash into a tmpdir-scoped sandbox, runs `akm index`
 * followed by `akm improve --json-to-stdout`, then scores the resulting
 * mutations against per-case expectations.
 *
 * Sandbox isolation is unconditional — even with `--no-sandbox` on the
 * parent run, this runner builds its own sandbox via `createSandbox`. The
 * runner MUST NOT touch the real stash or real data dir under any
 * circumstance (it shells out to akm with AKM_STASH_DIR / AKM_DATA_DIR /
 * HOME carve-outs).
 *
 * Inputs:  { fixture: string; improveArgs?: string[] }
 * Expected:
 *   - preservedRefs        — refs whose files must still exist post-improve
 *   - archivedRefs         — refs that must be archived (file removed + archive entry)
 *   - allowedTransitions   — ref → list of allowed "from->to" strings
 *   - forbiddenTransitions — ref → list of forbidden "from->to" strings
 *   - minContradictionEdges — minimum count of `contradictedBy` edges across
 *                             surviving memory files
 *   - beliefStateAfter     — ref → expected current beliefState frontmatter
 *   - minRelativeDatesResolved — minimum `memoryCleanup.relativeDatesResolved`
 *   - mustNotRetrieve      — { query; topK; forbiddenRefs } — refs that
 *                             must NOT appear in `akm search` results
 */

import fs from "node:fs";
import path from "node:path";
import { AkmCli } from "../sources/akm-cli";
import { createSandbox } from "../sources/sandbox";
import type { EvalCase, EvalCaseResult, EvalContext } from "../types";

interface MemorySafetyExpected {
  preservedRefs?: string[];
  archivedRefs?: string[];
  allowedTransitions?: Record<string, string[]>;
  forbiddenTransitions?: Record<string, string[]>;
  minContradictionEdges?: number;
  beliefStateAfter?: Record<string, string>;
  minRelativeDatesResolved?: number;
  mustNotRetrieve?: { query: string; topK?: number; forbiddenRefs: string[] };
  /** Per-ref body content that must NOT appear post-improve (e.g. unresolved relative dates). */
  bodyMustNotContain?: Record<string, string[]>;
}

interface ImproveJsonShape {
  memoryCleanup?: {
    beliefStateTransitions?: Array<{ ref: string; fromState: string; toState: string }>;
    archived?: Array<{ ref: string; archivedPath?: string }>;
    relativeDatesResolved?: number;
    warnings?: string[];
  };
}

const DEFAULT_WEIGHTS: Record<string, number> = {
  preservedRefs: 0.3,
  archivedRefs: 0.2,
  forbiddenTransitions: 0.2,
  allowedTransitions: 0.1,
  minContradictionEdges: 0.1,
  beliefStateAfter: 0.1,
  minRelativeDatesResolved: 0.1,
  mustNotRetrieve: 0.2,
  bodyMustNotContain: 0.1,
};

/** Resolve a `memory:<name>` ref to its on-disk path under the sandboxed stash. */
function refToPath(stashDir: string, ref: string): string {
  const m = ref.match(/^memory:(.+)$/);
  if (!m) throw new Error(`memory-safety only supports memory:* refs (got ${ref})`);
  return path.join(stashDir, "memories", `${m[1]}.md`);
}

/**
 * Minimal frontmatter key-extractor. Handles the `---\n...\n---\n` block
 * and `key: value` pairs (no nested objects). The fixtures this runner
 * exercises only need scalar lookups; reaching for full YAML would add a
 * dependency for no gain.
 */
function parseFrontmatter(file: string): Record<string, string | string[]> {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string | string[]> = {};
  let currentKey: string | null = null;
  for (const line of m[1].split("\n")) {
    const listItem = line.match(/^\s*-\s*"?([^"]+)"?\s*$/);
    if (listItem && currentKey && Array.isArray(out[currentKey])) {
      (out[currentKey] as string[]).push(listItem[1].trim());
      continue;
    }
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    currentKey = key;
    if (val === "" || val === "[]") {
      out[key] = val === "[]" ? [] : [];
    } else if (val.startsWith("[") && val.endsWith("]")) {
      out[key] = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^"|"$/g, ""))
        .filter((s) => s.length > 0);
    } else {
      out[key] = val.replace(/^"|"$/g, "");
    }
  }
  return out;
}

/** Count `contradictedBy` edges across all surviving memory files. */
function countContradictionEdges(stashDir: string): number {
  const memoriesDir = path.join(stashDir, "memories");
  if (!fs.existsSync(memoriesDir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(memoriesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const fm = parseFrontmatter(path.join(memoriesDir, entry.name));
    const cb = fm.contradictedBy;
    if (Array.isArray(cb)) count += cb.length;
  }
  return count;
}

export async function runMemorySafetyCase(c: EvalCase, ctx: EvalContext): Promise<EvalCaseResult> {
  const start = Date.now();
  const fixtureRel = String(c.input.fixture ?? "");
  const improveArgs = Array.isArray(c.input.improveArgs) ? (c.input.improveArgs as string[]) : [];
  const expected = c.expected as MemorySafetyExpected;

  if (!fixtureRel) return errorResult(c, "case is missing `input.fixture`", start);

  // Resolve fixture relative to the suite's cases dir (the case file lives in
  // <casesRoot>/<suite>/, fixtures live alongside it under fixtures/).
  const suiteDir = path.join(ctx.casesRoot, c.suite);
  const fixtureAbs = path.isAbsolute(fixtureRel) ? fixtureRel : path.join(suiteDir, fixtureRel);
  if (!fs.existsSync(fixtureAbs)) {
    return errorResult(c, `fixture not found: ${fixtureAbs}`, start);
  }

  // Sandbox is MANDATORY — never touch the real stash/data dir.
  const sandbox = createSandbox({ fixture: fixtureAbs, prefix: "akm-eval-mem-", inheritEnv: true });
  try {
    const cli = new AkmCli(ctx.akmBin, sandbox.env);
    const idx = cli.index();
    if (idx.status !== 0) {
      return errorResult(c, `akm index failed (exit ${idx.status}): ${idx.stderr.trim()}`, start);
    }
    const imp = cli.improve(["--json-to-stdout", ...improveArgs]);
    if (imp.status !== 0) {
      return errorResult(c, `akm improve failed (exit ${imp.status}): ${imp.stderr.trim()}`, start);
    }

    let improveResult: ImproveJsonShape;
    try {
      improveResult = JSON.parse(imp.stdout) as ImproveJsonShape;
    } catch (err) {
      return errorResult(c, `improve stdout was not JSON: ${err instanceof Error ? err.message : String(err)}`, start);
    }

    const transitions = improveResult.memoryCleanup?.beliefStateTransitions ?? [];
    const archivedFromCleanup = new Set((improveResult.memoryCleanup?.archived ?? []).map((a) => a.ref));
    const relativeDatesResolved = improveResult.memoryCleanup?.relativeDatesResolved ?? 0;

    const transitionsByRef: Record<string, string[]> = {};
    for (const t of transitions) {
      const key = `${t.fromState}->${t.toState}`;
      transitionsByRef[t.ref] ??= [];
      transitionsByRef[t.ref].push(key);
    }

    // ── Score each declared expectation ────────────────────────────────────
    const scores: Record<string, { score: number; detail: unknown }> = {};

    if (expected.preservedRefs && expected.preservedRefs.length > 0) {
      const hits = expected.preservedRefs.map((r) => ({ ref: r, present: fs.existsSync(refToPath(sandbox.stashDir, r)) }));
      const ok = hits.filter((h) => h.present).length;
      scores.preservedRefs = { score: ok / expected.preservedRefs.length, detail: hits };
    }
    if (expected.archivedRefs && expected.archivedRefs.length > 0) {
      const hits = expected.archivedRefs.map((r) => {
        const fileGone = !fs.existsSync(refToPath(sandbox.stashDir, r));
        const archived = archivedFromCleanup.has(r);
        return { ref: r, archived: fileGone && archived };
      });
      const ok = hits.filter((h) => h.archived).length;
      scores.archivedRefs = { score: ok / expected.archivedRefs.length, detail: hits };
    }
    if (expected.forbiddenTransitions && Object.keys(expected.forbiddenTransitions).length > 0) {
      const violations: Array<{ ref: string; observed: string }> = [];
      for (const [ref, forbidden] of Object.entries(expected.forbiddenTransitions)) {
        const got = transitionsByRef[ref] ?? [];
        for (const f of forbidden) {
          if (got.includes(f)) violations.push({ ref, observed: f });
        }
      }
      scores.forbiddenTransitions = { score: violations.length === 0 ? 1 : 0, detail: violations };
    }
    if (expected.allowedTransitions && Object.keys(expected.allowedTransitions).length > 0) {
      const violations: Array<{ ref: string; observed: string }> = [];
      for (const [ref, allowed] of Object.entries(expected.allowedTransitions)) {
        const got = transitionsByRef[ref] ?? [];
        for (const g of got) {
          if (!allowed.includes(g)) violations.push({ ref, observed: g });
        }
      }
      scores.allowedTransitions = { score: violations.length === 0 ? 1 : 0, detail: violations };
    }
    if (expected.minContradictionEdges !== undefined) {
      const observed = countContradictionEdges(sandbox.stashDir);
      scores.minContradictionEdges = {
        score: observed >= expected.minContradictionEdges ? 1 : observed / Math.max(1, expected.minContradictionEdges),
        detail: { observed, required: expected.minContradictionEdges },
      };
    }
    if (expected.beliefStateAfter && Object.keys(expected.beliefStateAfter).length > 0) {
      const hits = Object.entries(expected.beliefStateAfter).map(([ref, want]) => {
        const fm = parseFrontmatter(refToPath(sandbox.stashDir, ref));
        const got = typeof fm.beliefState === "string" ? fm.beliefState : null;
        return { ref, expected: want, observed: got, ok: got === want };
      });
      const ok = hits.filter((h) => h.ok).length;
      scores.beliefStateAfter = { score: ok / hits.length, detail: hits };
    }
    if (expected.minRelativeDatesResolved !== undefined) {
      scores.minRelativeDatesResolved = {
        score: relativeDatesResolved >= expected.minRelativeDatesResolved ? 1 : relativeDatesResolved / Math.max(1, expected.minRelativeDatesResolved),
        detail: { observed: relativeDatesResolved, required: expected.minRelativeDatesResolved },
      };
    }
    if (expected.bodyMustNotContain && Object.keys(expected.bodyMustNotContain).length > 0) {
      const violations: Array<{ ref: string; substring: string }> = [];
      for (const [ref, substrings] of Object.entries(expected.bodyMustNotContain)) {
        const file = refToPath(sandbox.stashDir, ref);
        if (!fs.existsSync(file)) continue; // archived/missing — covered by other expectations
        const raw = fs.readFileSync(file, "utf8");
        const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
        for (const s of substrings) {
          if (body.toLowerCase().includes(s.toLowerCase())) violations.push({ ref, substring: s });
        }
      }
      scores.bodyMustNotContain = { score: violations.length === 0 ? 1 : 0, detail: violations };
    }
    if (expected.mustNotRetrieve) {
      const { query, topK = 5, forbiddenRefs } = expected.mustNotRetrieve;
      let observedRefs: string[] = [];
      let leaked: string[] = [];
      try {
        const hits = cli.search(query, { limit: topK });
        observedRefs = hits.map((h) => h.ref);
        leaked = forbiddenRefs.filter((r) => observedRefs.includes(r));
      } catch (err) {
        return errorResult(c, `mustNotRetrieve search failed: ${err instanceof Error ? err.message : String(err)}`, start);
      }
      scores.mustNotRetrieve = { score: leaked.length === 0 ? 1 : 0, detail: { query, observedRefs, leaked } };
    }

    // ── Aggregate via renormalised weights over declared expectations ──────
    const weights = c.scoring?.weights ?? DEFAULT_WEIGHTS;
    let weightTotal = 0;
    let weighted = 0;
    for (const key of Object.keys(scores)) {
      const w = weights[key] ?? DEFAULT_WEIGHTS[key] ?? 0;
      weightTotal += w;
      weighted += scores[key].score * w;
    }
    const score = weightTotal === 0 ? (Object.keys(scores).length === 0 ? 1 : 0) : weighted / weightTotal;
    const passThreshold = c.scoring?.passThreshold ?? 0.8;

    return {
      caseId: c.id,
      type: "memory-safety",
      score,
      passed: score >= passThreshold,
      metrics: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v.score])),
      evidence: {
        fixture: fixtureAbs,
        sandbox: ctx.keepSandbox ? sandbox.root : undefined,
        transitions,
        archived: [...archivedFromCleanup],
        relativeDatesResolved,
        details: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v.detail])),
      },
      durationMs: Date.now() - start,
    };
  } finally {
    if (!ctx.keepSandbox) sandbox.cleanup();
  }
}

function errorResult(c: EvalCase, message: string, start: number): EvalCaseResult {
  return {
    caseId: c.id,
    type: "memory-safety",
    score: 0,
    passed: false,
    metrics: {},
    evidence: {},
    errors: [message],
    durationMs: Date.now() - start,
  };
}
