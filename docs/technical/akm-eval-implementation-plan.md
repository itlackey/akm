# akm-eval — Lightweight Standalone Evaluation Toolkit (Implementation Plan)

> **Historical note (May 2026):** This plan repeatedly cites
> `scripts/improve-stats/` as the precedent toolkit pattern and
> `docs/improve-stats.md` as its operator doc. Both were retired when
> their metrics were first-classed onto `akm health` (see
> [health-command-enhancements.md](health-command-enhancements.md)). The
> design decisions captured here still apply to `scripts/akm-eval/`,
> which remains active; the precedent references are historical only.

> **Status.** All eight phases are implemented and shipping under
> `scripts/akm-eval/`. CI-gated via `.github/workflows/akm-eval-smoke.yml`
> (Phase 8). See `docs/akm-eval.md` for operator usage and
> `scripts/akm-eval/README.md` for the quick-start.
>
> **Original scope.** This document is the implementation plan for a
> lightweight, standalone evaluation toolkit for `akm` 0.8.0. It is based
> on the external "Lightweight AKM Eval Utility Design" proposal,
> re-grounded against the actual `release/0.8.0` codebase, and structured
> per the user's request as a **standalone CLI/scripts toolkit, not an
> `akm` subcommand**. The toolkit complements the roadmap in
> `docs/technical/improve-pipeline-analysis-0.8.0.md` and is the
> implementation vehicle for roadmap items R1 (benchmark suite), R3
> (judge calibration), R5 (graph A/B), R8 (replay), and R10
> (accept-rate-by-source).

## 1. Grounding to 0.8.0 — what the proposal got right, where it drifts

The external proposal is well-shaped and largely lines up with the
0.8.0 reality. Six things need adjustment before implementation.

### 1.1 Directory naming collision (must fix)

The proposal writes eval cases to `.akm/evals/cases/`. `release/0.8.0`
already uses `<stash>/.akm/eval-cases/` for a different purpose: the
improve loop auto-writes a `<slug>.md` file there every time a
`distill_quality_rejected` or `proposal_rejected` event fires
(`src/commands/improve/eval-cases.ts`, called from `src/commands/improve/improve.ts`
lines 2088 and 2104; surfaced in the run envelope as `evalCasesWritten`).
Those files are **automatically captured regression cases**, not
human-authored eval cases. To avoid confusion:

- **`<stash>/.akm/eval-cases/`** — keep as-is, owned by `akm improve`.
  Auto-captured regression triggers.
- **`<stash>/.akm/evals/`** — new, owned by `akm-eval`. Hand-authored
  cases and generated eval outputs.

### 1.2 `state.db` lives in the data dir, not the stash (must know)

The proposal implies `state.db` lives under the stash. It does not. Per
`src/core/state-db.ts:66`, `getStateDbPath()` returns
`<getDataDir()>/state.db`, which respects `AKM_DATA_DIR` and `XDG_DATA_HOME`
(typically `~/.local/share/akm/state.db`). Events and the
state-db copy of proposals live there. `<stash>/.akm/proposals/<UUID>/`
is the *filesystem mirror* of the proposal queue.

The eval toolkit needs to read both:

- **Events**: SQLite from `getStateDbPath()`, table `events` with columns
  `id INTEGER PK AUTOINCREMENT, event_type TEXT, ts TEXT, ref TEXT,
  metadata_json TEXT`.
- **Proposals**: either SQLite `proposals` table OR
  `<stash>/.akm/proposals/<UUID>/proposal.json`. Prefer SQLite for
  performance; fall back to filesystem when isolating against a fixture
  stash.

### 1.3 Run envelope path and shape (verified)

`<stash>/.akm/runs/<run-id>/improve-result.json` is correct. Run-id
format is `<iso-timestamp-with-dashes>-<8hex>`, e.g.
`2026-05-19T17-30-22-123Z-a1b2c3d4`, minted in
`src/commands/improve-result-file.ts:buildImproveRunId`. The envelope
shape is `AkmImproveResult` from `src/commands/improve.ts:201`. The eval
toolkit should treat `schemaVersion: 1` as a stable contract and refuse
to operate on unknown versions.

### 1.4 Existing operator toolkit pattern to mirror (must follow)

`scripts/improve-stats/` is the precedent: shell + `jq`, zero extra
dependencies, reads from `<stash>/.akm/runs/<run-id>/improve-result.json`
and `$AKM_STASH_DIR`, with each script accepting `--stash <path>` for
override. `_lib.sh` holds shared helpers. `README.md` and
`docs/improve-stats.md` document it. **`akm-eval` should mirror this
pattern exactly**, just at a larger scope.

### 1.5 The `akm` CLI surfaces the toolkit needs (verified)

The proposal assumes these surfaces exist. Verified against
`src/cli.ts` and `docs/cli.md`:

| Surface | Verified | Notes |
|---|---|---|
| `akm search <query> --format json` | yes | Returns hits with refs, score, snippet. |
| `akm search <query> --format jsonl` | yes | One hit per line — preferred for streaming. |
| `akm show <ref> --format json` | yes | Asset payload. |
| `akm proposals --format json` | yes | Lists pending; `--status` and `--ref` filters. |
| `akm proposal show <id> --format json` | yes | Single proposal with validation report. |
| `akm diff <id>` | yes | Diff vs. live asset. |
| `akm events list --format jsonl` | yes | Filterable by `--type` and `--ref`. |
| `akm events tail --since '@offset:<id>'` | yes | Durable resume cursor. |
| `akm improve --dry-run --format json` | yes | Returns planned refs without writing. |
| `akm improve --json-to-stdout` | yes | Restores pre-0.8.0 behaviour (full JSON to stdout). |
| `akm health --since 24h --format json` | yes | Operator runtime health. |

The toolkit can shell out to `akm` for everything it needs; it does not
need to import `akm`'s TypeScript modules.

### 1.6 Risk-tiering does not exist yet (forward dependency)

The proposal references risk tiers (Low/Medium/High). Those don't exist
in 0.8.0 — they're roadmap item R2. The toolkit should:

- accept a `riskTier` field in eval cases when the user authors one,
- compute a *heuristic* tier from `proposal.source` until R2 lands
  (`schema-repair` / mechanical `consolidate` → Tier 0; `distill` low
  confidence → Tier 1; `reflect` lessons → Tier 2; `reflect` on skill/
  agent/command/workflow → Tier 3),
- replace the heuristic with the real field when R2 ships.

## 2. Design decision: standalone, not `akm` subcommand

The user asked for standalone if it doesn't add complexity. It doesn't —
it **reduces** complexity. Standalone wins on six axes:

| Axis | Standalone | `akm eval` subcommand |
|---|---|---|
| CLI wiring | None — direct script entry | Update `src/cli.ts`, `src/cli/parse-args.ts` |
| Output shapes | Own JSON/JSONL/MD | Register in `src/output/shapes.ts` + `src/output/text.ts` |
| Test isolation | None — runs in its own dir | Must respect `TEST_ISOLATION_MISSING` guards |
| Release coupling | Independent | Locked to akm release cycle |
| Distribution | Folder or separate npm package | Bundled into `akm-cli` (bloats install) |
| Existing precedent | `scripts/improve-stats/` | None for this scope |

The akm ecosystem already has the `itlackey/akm-eval` repository (per
README "Ecosystem" table). The standalone toolkit can live in two places
without contradiction:

1. **Initial home: `scripts/akm-eval/`** in this repo, mirroring
   `scripts/improve-stats/`. Easy to ship in lock-step with 0.8.0,
   no separate publish pipeline.
2. **Graduation target: `itlackey/akm-eval` standalone repo** once the
   surface stabilizes — pull the same scripts/TS unchanged.

This plan targets the initial home. Graduation is a follow-up when
the toolkit has been used for one release cycle.

## 3. Toolkit shape

### 3.1 Layout

```text
scripts/akm-eval/
  README.md                    operator guide (mirrors improve-stats/README.md)
  _lib.sh                      shared shell helpers (paths, JSON, run-id resolve)
  _lib.ts                      shared TypeScript helpers (case loader, scorer, db reader)
  cases/                       starter case suites (versioned in git)
    improve-smoke/
      retrieval-basic.json
      proposal-validation.json
      memory-safety-hot.json
      workflow-search-before-write.json
      regression-frozen.json
    memory-regression/
    workflow-compliance/
    proposal-quality/
  bin/
    akm-eval-run               shell entry: dispatches to run.ts
    akm-eval-compare           shell entry: dispatches to compare.ts
    akm-eval-trend             shell entry: dispatches to trend.ts
    akm-eval-collect           shell entry: dispatches to collect.ts (reads improve-result.json into eval inputs)
    akm-eval-report            shell entry: dispatches to report.ts (MD from JSON)
  src/
    run.ts                     orchestrator
    runners/
      retrieval.ts             deterministic, shells out to `akm search`
      proposal-quality.ts      reads proposals table or .akm/proposals/<UUID>/
      memory-safety.ts         reads memory belief states via filesystem fixtures
      workflow-compliance.ts   reads events table for command traces
      lesson-application.ts    paired check: was lesson retrieved + cited?
      regression.ts            diffs current case-results.jsonl vs previous
    scoring.ts                 weighted scorer; deterministic vs LLM-judged kept separate
    compare.ts                 two-run diff
    trend.ts                   N-run trend over $AKM_STASH_DIR/.akm/evals/runs/
    collect.ts                 ingest an existing improve-result.json into eval inputs
    report.ts                  Markdown renderer
    types.ts                   EvalCase, EvalCaseResult, EvalRunResult (matches external proposal types)
    sources/
      akm-cli.ts               shell helper that wraps `akm <subcommand> --format json`
      state-db.ts              read-only SQLite reader for events + proposals tables
      stash-fs.ts              read-only filesystem reader for .akm/proposals/, .akm/runs/, eval-cases/
      improve-result.ts        loader for <stash>/.akm/runs/<id>/improve-result.json
```

### 3.2 Output layout

```text
<stash>/.akm/evals/                  NEW — owned by akm-eval
  runs/
    <eval-run-id>/                   ISO timestamp + 8hex, mirrors improve runs
      eval-result.json               summary envelope (schemaVersion: 1)
      case-results.jsonl             one line per case
      report.md                      human-readable rollup
      artifacts/
        baseline-search.jsonl
        akm-search.jsonl
        proposal-snapshot.json
        improve-result.json          symlinked or copied from <stash>/.akm/runs/
        events-window.jsonl          events emitted during the paired window
    latest                           symlink to most recent eval run
```

This sits alongside but does not collide with the existing
`<stash>/.akm/eval-cases/` directory.

### 3.3 Invocation

The user runs scripts directly, no `akm` integration required:

```bash
# From the akm repo root, or from any clone of it
scripts/akm-eval/bin/akm-eval-run --suite improve-smoke --mode baseline
scripts/akm-eval/bin/akm-eval-run --suite improve-smoke --mode paired \
    --improve-args "--limit 20 --timeout-ms 600000"
scripts/akm-eval/bin/akm-eval-compare <baseline-id> <akm-id>
scripts/akm-eval/bin/akm-eval-trend --suite improve-smoke --limit 20
scripts/akm-eval/bin/akm-eval-collect --from-improve-run <run-id>
scripts/akm-eval/bin/akm-eval-report latest --format md
```

Each entry script is a thin shell wrapper that resolves
`$AKM_STASH_DIR` (with `--stash <path>` override) and `$AKM_DATA_DIR`
and shells into `bun run src/<entry>.ts`. This matches the
`scripts/improve-stats/` pattern exactly — those scripts are also shell
wrappers, just with `jq` instead of `bun`.

## 4. Eval case schema (refined from the proposal)

Two changes from the external proposal:

1. Add `riskTier` (optional, populated from a future R2 or heuristic
   today).
2. Add `requires` so cases can declare feature dependencies (e.g.
   "needs graph extraction enabled", "needs distill judge enabled") and
   the runner can `skip` them with a recorded reason rather than fail.

```json
{
  "schemaVersion": 1,
  "id": "retrieval-basic-001",
  "suite": "improve-smoke",
  "type": "retrieval",
  "description": "AKM should retrieve the proposal-queue safety lesson for changes to mutation workflow.",
  "input": {
    "query": "How should generated improvements be applied safely?",
    "topK": 5
  },
  "expected": {
    "mustIncludeRefs": ["lesson:proposal-queue-safety"],
    "mustNotIncludeRefs": [],
    "keywords": ["proposal", "validate", "accept", "promote"]
  },
  "scoring": {
    "deterministic": true,
    "weights": {
      "mustIncludeRefs": 0.6,
      "keywordCoverage": 0.3,
      "noForbiddenRefs": 0.1
    }
  },
  "requires": {
    "features": [],
    "minAkmVersion": "0.8.0"
  },
  "tags": ["retrieval", "proposal-safety", "smoke"]
}
```

Memory-safety cases need a fixture seed because the eval must not run
against the live stash. The runner will copy a fixture set into a
sandbox stash, run `akm improve` against it with `AKM_STASH_DIR` and
`AKM_DATA_DIR` redirected, then read the resulting belief-state
transitions:

```json
{
  "schemaVersion": 1,
  "id": "memory-safety-hot-001",
  "suite": "improve-smoke",
  "type": "memory-safety",
  "description": "captureMode: hot memories must never be auto-deleted by consolidation.",
  "input": {
    "fixture": "fixtures/hot-memory-mixed-with-derived/",
    "improveArgs": ["--limit", "10"]
  },
  "expected": {
    "preservedRefs": ["memory:incident-2026-05-10"],
    "allowedTransitions": {
      "memory:duplicate-derived-001": ["active->archived"],
      "memory:hot-fact-001": []
    },
    "forbiddenTransitions": {
      "memory:hot-fact-001": ["active->archived", "active->superseded"]
    }
  },
  "scoring": {
    "deterministic": true,
    "weights": {
      "preservedRefs": 0.5,
      "allowedTransitions": 0.3,
      "forbiddenTransitions": 0.2
    }
  },
  "requires": {
    "features": [],
    "minAkmVersion": "0.8.0"
  },
  "tags": ["memory", "hot-preservation"]
}
```

This case maps directly to the `fb72ada` fix
("refuse to auto-delete or auto-merge captureMode:hot memories") — the
toolkit can verify that fix has not regressed.

## 5. Runners — code sketches grounded in 0.8.0

### 5.1 Retrieval runner

Shells out to `akm search --format jsonl`:

```ts
import { spawnSync } from "node:child_process";
import type { EvalCase, EvalCaseResult, EvalContext } from "../types";

export async function runRetrievalCase(c: EvalCase, ctx: EvalContext): Promise<EvalCaseResult> {
  const query = String(c.input.query ?? "");
  const topK = Number(c.input.topK ?? 5);
  const expected = c.expected as {
    mustIncludeRefs?: string[];
    mustNotIncludeRefs?: string[];
    keywords?: string[];
  };

  // Shell out to akm — never import akm internals.
  const proc = spawnSync(ctx.akmBin, [
    "search", query,
    "--format", "jsonl",
    "--limit", String(topK),
    "--detail", "agent",
  ], { encoding: "utf8", env: ctx.env });

  if (proc.status !== 0) {
    return failed(c, `akm search failed: ${proc.stderr}`);
  }

  const hits = proc.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { ref: string; description?: string; snippet?: string });

  const refs = hits.map((h) => h.ref);
  const text = hits.map((h) => `${h.ref} ${h.description ?? ""} ${h.snippet ?? ""}`).join("\n").toLowerCase();

  const mustInclude = expected.mustIncludeRefs ?? [];
  const mustNotInclude = expected.mustNotIncludeRefs ?? [];
  const keywords = expected.keywords ?? [];

  const includeScore = mustInclude.length === 0 ? 1 :
    mustInclude.filter((r) => refs.includes(r)).length / mustInclude.length;

  const forbiddenHits = mustNotInclude.filter((r) => refs.includes(r));
  const forbiddenScore = forbiddenHits.length === 0 ? 1 : 0;

  const keywordScore = keywords.length === 0 ? 1 :
    keywords.filter((k) => text.includes(k.toLowerCase())).length / keywords.length;

  const w = c.scoring?.weights ?? { mustIncludeRefs: 0.6, keywordCoverage: 0.3, noForbiddenRefs: 0.1 };
  const score =
    includeScore * (w.mustIncludeRefs ?? 0) +
    keywordScore * (w.keywordCoverage ?? 0) +
    forbiddenScore * (w.noForbiddenRefs ?? 0);

  return {
    caseId: c.id, type: "retrieval",
    score, passed: score >= 0.8,
    metrics: {
      includeScore, keywordScore, forbiddenScore,
      hitAt1: refs[0] !== undefined && mustInclude.includes(refs[0]),
      hitAtK: includeScore > 0,
      forbiddenHits,
    },
    evidence: { query, refs, topK },
  };
}
```

Why this shape: shelling out is fully deterministic relative to the
stash + index state, costs nothing extra at runtime, and survives
arbitrary akm internal refactors as long as the `akm search --format
jsonl` contract holds.

### 5.2 Proposal-quality runner

Reads the proposal queue via `state.db` for performance; falls back to
filesystem when running against a sandbox fixture without a populated
state-db.

```ts
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

export async function runProposalQualityCase(c: EvalCase, ctx: EvalContext): Promise<EvalCaseResult> {
  const expected = c.expected as {
    minValidationPassRate?: number;
    minAcceptRate?: number;
    maxRejectRate?: number;
    maxDuplicateRate?: number;
  };

  // Reads proposals + acceptance events from state.db.
  // Falls back to scanning <stash>/.akm/proposals/ + .akm/proposals/archive/ when state.db missing.
  const proposals = await ctx.sources.readProposals({ since: c.input.since as string | undefined });
  const events = await ctx.sources.readEvents({
    types: ["promoted", "rejected", "proposal_creation_rejected"],
    since: c.input.since as string | undefined,
  });

  const counts = {
    total: proposals.length,
    pending: proposals.filter((p) => p.status === "pending").length,
    accepted: proposals.filter((p) => p.status === "accepted").length,
    rejected: proposals.filter((p) => p.status === "rejected").length,
    creationRejected: events.filter((e) => e.eventType === "proposal_creation_rejected").length,
  };

  const decided = counts.accepted + counts.rejected;
  const acceptRate = decided === 0 ? 0 : counts.accepted / decided;
  const rejectRate = decided === 0 ? 0 : counts.rejected / decided;
  const validationPassRate = counts.total === 0 ? 1 :
    1 - (counts.creationRejected / (counts.total + counts.creationRejected));

  // Accept-rate-by-source — the canonical PROV-DM metric from src/core/proposals.ts.
  const bySource: Record<string, { accepted: number; rejected: number; total: number }> = {};
  for (const p of proposals) {
    const s = p.source;
    bySource[s] ??= { accepted: 0, rejected: 0, total: 0 };
    bySource[s].total += 1;
    if (p.status === "accepted") bySource[s].accepted += 1;
    if (p.status === "rejected") bySource[s].rejected += 1;
  }

  const passes = [
    expected.minValidationPassRate === undefined || validationPassRate >= expected.minValidationPassRate,
    expected.minAcceptRate === undefined || acceptRate >= expected.minAcceptRate,
    expected.maxRejectRate === undefined || rejectRate <= expected.maxRejectRate,
  ];

  const score = passes.filter(Boolean).length / passes.length;
  return {
    caseId: c.id, type: "proposal-quality",
    score, passed: score >= 0.8,
    metrics: { counts, acceptRate, rejectRate, validationPassRate, bySource },
    evidence: { sampleProposalIds: proposals.slice(0, 5).map((p) => p.id) },
  };
}
```

This runner is the implementation vehicle for **roadmap R10**
(accept-rate-by-source). The metric falls out of the eval data for free.

### 5.3 Memory-safety runner (sandbox-mandatory)

The only runner that requires a sandbox stash, because it actually
mutates state:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export async function runMemorySafetyCase(c: EvalCase, ctx: EvalContext): Promise<EvalCaseResult> {
  const fixture = String(c.input.fixture ?? "");
  const improveArgs = (c.input.improveArgs as string[]) ?? [];
  const expected = c.expected as {
    preservedRefs?: string[];
    allowedTransitions?: Record<string, string[]>;
    forbiddenTransitions?: Record<string, string[]>;
  };

  // Build a sandbox: copy fixture stash + fresh data dir.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akm-eval-mem-"));
  const sandboxStash = path.join(sandbox, "stash");
  const sandboxData = path.join(sandbox, "data");
  fs.cpSync(path.join(ctx.casesRoot, fixture), sandboxStash, { recursive: true });
  fs.mkdirSync(sandboxData, { recursive: true });

  const env = {
    ...ctx.env,
    AKM_STASH_DIR: sandboxStash,
    AKM_DATA_DIR: sandboxData,
    HOME: sandbox, // belt-and-braces isolation
  };

  // Index + improve inside the sandbox.
  const idx = spawnSync(ctx.akmBin, ["index"], { encoding: "utf8", env });
  if (idx.status !== 0) return failed(c, `index failed: ${idx.stderr}`);

  const imp = spawnSync(ctx.akmBin,
    ["improve", "--format", "json", "--json-to-stdout", ...improveArgs],
    { encoding: "utf8", env });
  if (imp.status !== 0) return failed(c, `improve failed: ${imp.stderr}`);

  const improveResult = JSON.parse(imp.stdout) as { memoryCleanup?: any; actions?: any[] };

  // Read the belief-state transition log written by applyMemoryCleanup.
  const transitions = (improveResult.memoryCleanup?.beliefStateTransitions ?? []) as Array<{
    ref: string; fromState: string; toState: string;
  }>;

  // Score against expected.
  const transitionsByRef: Record<string, string[]> = {};
  for (const t of transitions) {
    transitionsByRef[t.ref] ??= [];
    transitionsByRef[t.ref].push(`${t.fromState}->${t.toState}`);
  }

  const preservedRefs = expected.preservedRefs ?? [];
  const preserved = preservedRefs.every((ref) => fs.existsSync(refToPath(sandboxStash, ref)));
  const preservedScore = preservedRefs.length === 0 ? 1 :
    preservedRefs.filter((r) => fs.existsSync(refToPath(sandboxStash, r))).length / preservedRefs.length;

  const forbiddenHits: string[] = [];
  for (const [ref, forbidden] of Object.entries(expected.forbiddenTransitions ?? {})) {
    const got = transitionsByRef[ref] ?? [];
    for (const f of forbidden) {
      if (got.includes(f)) forbiddenHits.push(`${ref}: ${f}`);
    }
  }
  const forbiddenScore = forbiddenHits.length === 0 ? 1 : 0;

  const w = c.scoring?.weights ?? { preservedRefs: 0.5, allowedTransitions: 0.3, forbiddenTransitions: 0.2 };
  const score = preservedScore * (w.preservedRefs ?? 0)
              + forbiddenScore * (w.forbiddenTransitions ?? 0)
              + 1 * (w.allowedTransitions ?? 0); // allowed: any transition present in the allow-list is fine

  // Clean up sandbox unless --keep-sandbox.
  if (!ctx.keepSandbox) fs.rmSync(sandbox, { recursive: true, force: true });

  return {
    caseId: c.id, type: "memory-safety",
    score, passed: score >= 0.8,
    metrics: { preserved, preservedScore, forbiddenScore, forbiddenHits },
    evidence: { sandbox: ctx.keepSandbox ? sandbox : undefined, transitions },
  };
}
```

Sandbox isolation is the only way to evaluate destructive operations
safely. The sandbox respects the same `AKM_DATA_DIR` / `AKM_STASH_DIR` /
`HOME` carve-outs that the test suite uses
(see `release/0.8.0`'s `7d8b28a`, `23373b5`, `cc95085`, `35ec047`
isolation hardening commits).

### 5.4 Workflow-compliance runner

Reads command traces from the events table. The eval declares which
events should have occurred in the window:

```json
{
  "schemaVersion": 1,
  "id": "workflow-search-before-write-001",
  "suite": "workflow-compliance",
  "type": "workflow-compliance",
  "input": {
    "windowSince": "2026-05-21T16:30:00.000Z",
    "windowUntil": "2026-05-21T16:35:00.000Z"
  },
  "expected": {
    "requiredEventTypes": ["search", "show", "feedback"],
    "requiredOrder": ["search", "show"],
    "forbiddenEventTypes": [],
    "minEventsOfType": { "search": 1, "show": 1 }
  },
  "scoring": { "deterministic": true }
}
```

This consumes the `EventType` union defined in `src/core/events.ts:43`
and uses the existing `--since` cursor semantics.

## 6. Sources layer

A thin sources layer hides the storage details from the runners:

```ts
// scripts/akm-eval/src/sources/index.ts
export interface Sources {
  readEvents(opts: { types?: string[]; refs?: string[]; since?: string; until?: string }): Promise<EventRow[]>;
  readProposals(opts: { since?: string; status?: ProposalStatus; ref?: string }): Promise<ProposalRow[]>;
  readImproveResult(runId: string): Promise<AkmImproveResult>;
  listImproveRuns(opts?: { limit?: number; since?: string }): Promise<string[]>;
}
```

Two implementations:

1. **`StateDbSources`** — opens `state.db` read-only
   (`new Database(getStateDbPath(), { readonly: true })`), queries the
   events and proposals tables directly. Default.
2. **`CliSources`** — shells out to `akm events list --format jsonl`,
   `akm proposals --format json`, etc. Used when `--no-direct-db` is
   passed, or in CI environments where the SQLite driver isn't
   guaranteed available.

The default is `StateDbSources` because it is 10–100× faster on large
event windows. The fallback exists so the toolkit can graduate to the
`itlackey/akm-eval` repo without taking `bun:sqlite` as a hard
dependency.

## 7. Phase plan

Each phase is independently shippable and adds operator value.

### Phase 1 — Read-only deterministic runner (S, ~3 days)

Goal: ship something useful with zero risk to existing data.

**Deliverables:**

- `scripts/akm-eval/` directory created, mirroring
  `scripts/improve-stats/`.
- `_lib.sh` + `_lib.ts` shared helpers.
- `bin/akm-eval-run` shell entry.
- `src/run.ts` orchestrator.
- `src/runners/retrieval.ts` (shells `akm search`).
- `src/runners/proposal-quality.ts` (reads state.db proposals, events).
- `src/scoring.ts`, `src/types.ts`, `src/report.ts`.
- `src/sources/akm-cli.ts`, `src/sources/state-db.ts`,
  `src/sources/improve-result.ts`.
- `cases/improve-smoke/` with 5 retrieval + 3 proposal-quality cases.
- `README.md` + `docs/akm-eval.md` operator guides.

**Acceptance:** `scripts/akm-eval/bin/akm-eval-run --suite improve-smoke
--mode baseline` runs end-to-end against any populated stash and writes
`<stash>/.akm/evals/runs/<id>/{eval-result.json, case-results.jsonl,
report.md}`.

**No LLM calls. No mutation. No sandbox required.**

### Phase 2 — Paired mode + compare/trend (M, ~5 days)

**Deliverables:**

- `src/runners/regression.ts` — diffs current vs previous case-results.
- `src/compare.ts` — two-run diff command.
- `src/trend.ts` — N-run trend, prints TSV like `runs-trend`.
- `src/collect.ts` — ingest an existing `improve-result.json` into
  paired-mode inputs (lets users run `akm improve` and `akm-eval`
  separately).
- `--mode paired` in `bin/akm-eval-run` that orchestrates the snapshot →
  improve → re-eval flow.
- `--improve-args "<...>"` passthrough to `akm improve`.
- Default to `--sandbox` for paired mode (copies stash to a tmpdir).

**Acceptance:** `akm-eval-run --suite improve-smoke --mode paired
--improve-args "--limit 10"` reports baseline + AKM-mode scores and a
delta block.

### Phase 3 — Memory-safety + workflow-compliance runners (M, ~5 days)

**Deliverables:**

- `src/runners/memory-safety.ts` with mandatory sandbox isolation.
- `src/runners/workflow-compliance.ts` reading from events table.
- `cases/memory-regression/` suite with at least:
  - hot-memory preservation (verifies `fb72ada`),
  - relative-date resolution (verifies `M-5 / #396`),
  - contradiction edge detection (verifies `M-1 / #367`),
  - superseded memory behaviour,
  - stale memory exclusion.
- `cases/workflow-compliance/` suite with search-before-write,
  show-before-use, feedback-after-task, proposal-queue-respect.
- Fixture stashes under `cases/<suite>/fixtures/`.

**Acceptance:** memory-safety suite passes against `release/0.8.0` and
fails when run against a synthetic regression that removes the
`captureMode: hot` guard.

### Phase 4 — Judge-calibration probe (R3) (M, ~3 days)

This is the implementation of **roadmap R3** (LLM judge calibration).

**Deliverables:**

- `cases/judge-calibration/` with N hand-graded proposal probes
  (10–30 to start), each with `{ proposal: {...}, humanGrade: {...} }`.
- `src/runners/judge-calibration.ts` that runs the distill judge against
  each probe via `akm` (using a `--judge-only` test seam, or by calling
  out to a small wrapper), records the model score + uncertainty band,
  and computes agreement-with-human + re-sample variance.
- `metrics.judgeCalibration` block added to `eval-result.json`.

**Acceptance:** judge calibration report shows pass-rate, human
agreement, MT-Bench-style variance, and per-band counts
(`queued` / `review_needed` / `quality_rejected` / `validation_failed`).

### Phase 5 — Graph A/B harness (R5) (M, ~3 days)

This is the implementation of **roadmap R5**.

**Deliverables:**

- `bin/akm-eval-graph-ablation` — driver script.
- Runs the smoke suite twice in a sandbox: once with `index.graph.llm:
  true`, once with `index.graph.llm: false` (config seam exists today).
- Reports per-metric delta: retrieval hit@K, contradiction-detection
  precision/recall, false-positive contradictions, staleness delta,
  latency delta, token-cost delta.

**Acceptance:** running the ablation produces a single JSON envelope
comparing the two runs, with one row per metric, suitable for inclusion
in release notes.

### Phase 6 — Replay mode (R8) (M, ~5 days)

This is the implementation of **roadmap R8**.

**Deliverables:**

- `bin/akm-eval-replay <eval-run-id>` — replays the seam outputs from a
  recorded run.
- Capture step: each eval-run records every `akm` invocation it made and
  the response (for `akm search`, `akm proposals`, `akm events list`,
  etc.) under `artifacts/replay/`.
- Replay step: substitutes captured responses for live calls and asserts
  determinism (same case results within a configurable tolerance).

**Acceptance:** running the same eval twice deterministically (once
live, once `--replay`) produces identical `case-results.jsonl` modulo
timestamps.

### Phase 7 — Optional LLM judge (S, ~2 days)

**Deliverables:**

- `--llm-judge` opt-in flag.
- Judge results recorded separately as `metrics.llmJudged` in the run
  envelope — never folded into deterministic scores.
- Each judge call records prompt hash, model, provider, temperature,
  judged artifact hash (matches the proposal's guardrail).

### Phase 8 — CI integration (S, ~1 day)

**Deliverables:**

- `.github/workflows/akm-eval-smoke.yml` runs the smoke suite on every
  PR.
- Gates fail only on deterministic criteria: schema invalid, runner
  error, smoke score < 0.75, regression count > 0, forbidden action
  detected, incorrect archive detected.
- LLM-judged scores never block merges.

## 8. Risk-tier handling pre-R2

Until roadmap R2 lands, `akm-eval` derives a risk tier heuristically
from the proposal's `source` field. The heuristic mapping (subject to
change when R2 ships and proposals carry an explicit `riskTier`):

| Source | Heuristic tier | Rationale |
|---|---|---|
| `schema-repair` | Tier 0 | Mechanical fixes only. |
| `consolidate` (op = merge with content-preservation lint passing) | Tier 1 | Low semantic risk. |
| `consolidate` (op = delete or contradict) | Tier 2 | Belief-state change. |
| `consolidate` (op = promote to knowledge) | Tier 2 | Semantic promotion. |
| `distill` (lesson, score < 4) | Tier 2 | Borderline semantic. |
| `distill` (lesson, score ≥ 4) | Tier 1 | High-confidence semantic. |
| `distill_quality_rejected` | n/a — already rejected | Captured as regression case. |
| `reflect` (lesson asset) | Tier 2 | Lesson edit. |
| `reflect` (skill/agent/command/workflow asset) | Tier 3 | Behavioral change. |
| `propose` | Tier matches asset type per reflect | User-initiated; same risk. |
| `improve` (umbrella) | Tier from underlying op | Delegate. |
| `feedback` / `remember` / `import` | n/a (no proposal payload mutation) | — |

When R2 ships, this table is replaced by a single read of
`proposal.riskTier`.

## 9. Mapping to the roadmap

| Eval phase | Roadmap item | What ships |
|---|---|---|
| Phase 1 | R10 (accept-rate-by-source) | The metric is computed by the proposal-quality runner. |
| Phase 1 | R6 (schemas) | Documents the existing schemas by consuming them. |
| Phase 2 | R1 (benchmark suite) | Foundation. Five paired-mode suites land in Phase 3. |
| Phase 3 | R1 (benchmark suite) | Memory + workflow suites are the bulk of R1. |
| Phase 4 | R3 (judge calibration) | Direct implementation. |
| Phase 5 | R5 (graph A/B) | Direct implementation. |
| Phase 6 | R8 (replay mode) | Direct implementation. |
| Phase 7 | R3 / R1 | Optional LLM judging with calibration guardrails. |
| Phase 8 | R1 | Reproducible CI gate. |

Phases 1, 2, 3, 5, 6 ship the meat of R1 (benchmark suite).

## 10. CI usage

Smoke run on every PR:

```yaml
- name: akm-eval smoke
  run: |
    scripts/akm-eval/bin/akm-eval-run \
      --suite improve-smoke \
      --mode baseline \
      --format json \
      --fail-on-regression \
      --fail-below-score 0.75
```

Paired-run on tuning experiments:

```yaml
- name: akm-eval paired
  run: |
    scripts/akm-eval/bin/akm-eval-run \
      --suite improve-smoke \
      --mode paired \
      --sandbox \
      --improve-args "--limit 10 --timeout-ms 600000" \
      --fail-on-regression
```

## 11. Agent experimentation loop

The toolkit is shaped so an agent can run a tuning loop without
touching production data:

```bash
scripts/akm-eval/bin/akm-eval-run --suite improve-smoke --mode baseline --label before
akm improve --limit 20 --auto-accept=false
scripts/akm-eval/bin/akm-eval-run --suite improve-smoke --mode akm --label after
scripts/akm-eval/bin/akm-eval-compare before after
```

The agent should optimize for: fewer regressions, higher retrieval
hit@K, higher proposal-validation pass rate, higher accept-rate per
source, lower stale-memory injection, lower runtime and LLM-call count.
It should explicitly not optimize for total proposal count or overall
score in isolation — the runner records both deterministic and LLM-judged
scores separately so the agent cannot game one by inflating the other.

## 12. MVP checklist

The smallest useful version, deliverable in Phase 1 alone:

- [ ] `scripts/akm-eval/bin/akm-eval-run` shell entry.
- [ ] `_lib.sh` shared shell helpers (path resolution, `--stash` override).
- [ ] `src/run.ts` orchestrator with `--suite`, `--mode baseline`,
      `--out`, `--format`.
- [ ] `src/sources/state-db.ts` read-only events + proposals reader.
- [ ] `src/sources/akm-cli.ts` shell wrapper for `akm search`,
      `akm proposals`, `akm events list`.
- [ ] `src/runners/retrieval.ts`.
- [ ] `src/runners/proposal-quality.ts` (computes accept-rate-by-source).
- [ ] `src/scoring.ts` weighted scorer; deterministic vs LLM-judged
      kept separate.
- [ ] `src/report.ts` Markdown renderer.
- [ ] `cases/improve-smoke/` with 5 retrieval + 3 proposal-quality
      hand-authored cases.
- [ ] Writes `eval-result.json`, `case-results.jsonl`, `report.md` to
      `<stash>/.akm/evals/runs/<id>/`.
- [ ] `scripts/akm-eval/README.md`.
- [ ] `docs/akm-eval.md` operator guide (mirrors `docs/improve-stats.md`).
- [ ] Symlink `<stash>/.akm/evals/runs/latest` to most recent run.

Explicit non-goals for MVP: no dashboard, no DB migration, no
`bun:sqlite` write paths, no LLM judges, no mutation paths, no `akm`
subcommand integration.

## 13. Open questions and decisions to make

These should be resolved before Phase 1 starts. None blocks the plan;
each has a reasonable default.

- **Bun runtime requirement.** Recommend yes — `scripts/improve-stats/`
  is shell + jq, but the runners need TS-level logic. Default: require
  Bun (consistent with the rest of the repo's `engines.bun >= 1.0.0`).
- **Sandbox temp-dir cleanup default.** Recommend cleanup on success,
  retain on failure. Add `--keep-sandbox` to keep on success for
  debugging.
- **Eval cases vs improve auto-captured `eval-cases/`.** Keep separate
  directories. Phase 1 may add a one-way ingestion command that converts
  auto-captured `eval-cases/<slug>.md` into a Phase-3-style memory
  regression case skeleton, but the directories never share contents.
- **`bun:sqlite` direct read vs CLI shell-out.** Direct read default for
  performance. Add `--no-direct-db` to force CLI for portability.
- **Graduation to `itlackey/akm-eval`.** Plan: ship in
  `scripts/akm-eval/` for 1–2 release cycles; graduate when the surface
  is stable. Keep the directory layout identical to `improve-stats/` so
  graduation is just a `git mv`.

## 13a. Update — what shipped against this plan

All eight phases described above are now implemented on
`claude/akm-improve-pipeline-analysis-CyTz8` in PR #438. Each phase shipped
as its own commit (Phases 1–3 sequentially, Phases 4–7 in parallel
worktrees that were merged in, Phase 8 inline). The decisions and
deviations recorded below override the corresponding plan text where
they conflict; the plan above is preserved as the intent.

### Phase-by-phase outcome

| Phase | Commit | Shipped | Deviations |
|---|---|---|---|
| 1 — Read-only deterministic runner | `cccb907` | `bin/akm-eval-run`, `_lib.sh`, `src/{run,types,scoring,report}.ts`, `src/runners/{retrieval,proposal-quality}.ts`, `src/sources/{paths,state-db,stash-fs,akm-cli}.ts`, 8 smoke cases (5 retrieval + 3 proposal-quality). 7/8 pass on a minimal synthetic fixture; 8/8 against `docs/example-stash`. | None. |
| 2 — Paired mode + compare/trend/collect/regression | `7d582a2` | `bin/akm-eval-{compare,trend,collect}`, `src/{compare,trend,collect}.ts`, `src/runners/regression.ts`, `src/sources/{eval-runs,improve-result}.ts`, `--mode paired` in run.ts with default `--sandbox`. | `akm improve --format json` rejected by akm's CLI; toolkit reads the run envelope from disk instead. Sandbox cleanup is automatic unless `--keep-sandbox`. |
| 3 — Memory-safety + workflow-compliance + sandbox helper | `6a2478a` | `src/sources/sandbox.ts` (`createSandbox()` with XDG carve-outs reused by Phase 5), `src/runners/{memory-safety,workflow-compliance}.ts`, 5 memory-regression fixtures + cases (`hot-memory-preservation`, `relative-date-resolution`, `contradiction-edge-detection`, `superseded-memory-behaviour`, `stale-memory-exclusion`), 4 workflow-compliance cases. 5/5 memory + 4/4 workflow (skip on empty `state.db`). | `improveResult.memoryCleanup.relativeDatesResolved` is not surfaced by akm 0.8.0; the relative-date case uses a new `bodyMustNotContain` expectation instead of `minRelativeDatesResolved`. Anti-regression check synthetic-fixture style rather than dist-cli-patching. |
| 4 — Judge calibration probe (R3) | `bba654c` | `src/runners/judge-calibration.ts`, 8 hand-graded probes spread across all four bands (queued / review_needed / quality_rejected / validation_failed), `metrics.judgeCalibration` block hoisted into the run envelope. | Added `feedback()` method to `AkmCli` to materialize probe feedback events. `DEFAULT_TYPE_WEIGHTS.retrieval` reduced 0.25→0.15 to make room for `judge-calibration: 0.10`; all other weights kept verbatim. In this env LLM features are off, so the probe results are uniformly `skipped` — the runner machinery is fully exercised; agreement/variance metrics will be meaningful once a provider is configured. |
| 5 — Graph A/B ablation (R5) | `537f048` | `bin/akm-eval-graph-ablation`, `src/graph-ablation.ts` (862 LOC). Standalone driver; does NOT touch `run.ts`/`types.ts`/`scoring.ts`. Reuses Phase 3's `createSandbox()`. Reports retrieval / precision / contradiction / latency / token-proxy deltas with a verdict heuristic. Outputs land at `<stash>/.akm/evals/ablations/<run-id>/` (separate namespace from `runs/`). | Optional `cases/graph-ablation/` suite deliberately omitted — the smoke suite's retrieval cases are sufficient, per the plan's "if existing suite has retrieval cases, those are sufficient" carve-out. |
| 6 — Deterministic replay (R8) | `7ab0836` | `bin/akm-eval-replay`, `src/replay.ts`, `src/sources/replay-log.ts` (`ReplayRecorder`, `ReplayPlayer`, singleton accessors, `deepEqual`, `scoresClose`). `RecordingAkmCli` / `PlaybackAkmCli` / `RecordingStateDbSources` / `PlaybackStateDbSources` factories; `loadImproveResult` accepts recorder/player. Runners switched to factory calls. New `--record` flag in `run.ts`. Three captured JSONL streams: `akm-invocations`, `state-db-queries`, `improve-results`. | Recorder/player held as process-level singletons in `replay-log.ts` rather than threaded through `EvalContext` (the spec said add only `recording?: boolean` to `EvalContext`). Added a `state-db-available` record kind so playback picks the same branch (state-db vs stash-fs fallback). Replay engine normalizes JSON round-trip to avoid `undefined` evidence-field phantom divergences. |
| 7 — Optional LLM judge (R3 guardrail) | `ec4d6e8` | `src/sources/llm-judge.ts` (OpenAI-compatible HTTP client with provider defaults for openai/openrouter/ollama/llamacpp/lmstudio; SHA-256 prompt+artifact hashing; JSON-repair pass; rubric cap 4 KB, artifact cap 16 KB). `--llm-judge` / `--judge-model` / `--judge-provider` / `--judge-temperature` flags in `run.ts`. `EvalCase.scoring.llmJudge` + `EvalCaseResult.llmJudgement`. `metrics.llmJudged` aggregation that is **never folded into deterministic scores** (verified via mock-server test: `overall=1.0`, `deterministic=1.0`, `llmJudged=0.82`). | `retrieval` runner emits a pre-formatted `evidence.topHitArtifact` so judge cases can target it without runner changes. |
| 8 — CI integration | `3624304` | `.github/workflows/akm-eval-smoke.yml` runs typecheck → baseline smoke (`--fail-below-score 0.75`) → record-then-replay (`jq -e '.deterministic == true'`) → memory-regression (`--fail-below-score 0.5`) on every PR touching the toolkit, `src/`, or `docs/example-stash/`. Uploads eval/replay/memory summaries + `runs/` tree as a 7-day artifact. | None. |

### Cross-cutting integration

After all worktrees merged, an end-to-end sweep against
`docs/example-stash` confirmed every surface still works:

```
Smoke baseline (improve-smoke)            → exit 0, 8/8 pass
Smoke with --record                       → exit 0, all three replay JSONL streams written
akm-eval-replay latest                    → exit 0, deterministic: true
Memory regression (5 cases)               → exit 0, 5/5 pass
Graph ablation (--seeds 1, --dry-run)     → exit 0, envelope + verdict written
bunx tsc -p scripts/akm-eval/tsconfig.json → exit 0
bunx tsc --noEmit  (whole repo)           → exit 0   (after merging release/0.8.0 tsc fix)
bun run lint                              → exit 0   (2 pre-existing template-string warnings, no errors)
```

### Files added by the plan (final tally)

Six bin scripts, sixteen TypeScript modules (run, types, scoring, report,
compare, trend, collect, graph-ablation, replay, four runners + regression,
six sources), one shared shell helper, one tsconfig, plus the case
suites: `improve-smoke/` (8 cases), `memory-regression/` (5 cases +
fixtures), `workflow-compliance/` (4 cases), `judge-calibration/` (8
probes + entry case). Total `scripts/akm-eval/` footprint: ≈ 5 800 LOC
TypeScript + JSON cases + Markdown docs.

### Mapping back to the analysis-doc roadmap

The five eval-side roadmap items from
`docs/technical/improve-pipeline-analysis-0.8.0.md` §8 are all shipped:

- **R10** (accept-rate-by-source) — Phase 1 proposal-quality runner.
- **R1** (versioned benchmark suite) — Phases 1–5 cases + replay.
- **R3** (judge calibration) — Phase 4 probe set + metrics block.
- **R5** (graph A/B) — Phase 5 ablation driver.
- **R8** (replay mode) — Phase 6 record/replay.

The seven remaining items (R2 risk-tier proposals, R4 weighted
Self-Consistency, R6 public schemas, R7 ambition ladder, R9
review-needed filter, R11 memory-classes doc, R12 release-notes
expansion) require akm-core changes outside this toolkit. The toolkit
will measure their impact when they ship via paired-mode runs.

## 14. Bottom line

A standalone toolkit at `scripts/akm-eval/` is the right vehicle. It
mirrors the existing `scripts/improve-stats/` precedent, avoids
bloating the `akm` CLI, requires no test-isolation guards, ships
independently of akm release cycles, and graduates cleanly to the
`itlackey/akm-eval` repo when ready.

The eight phases above ship in order, each adding measurable value:
Phase 1 alone is the MVP and already implements R10. Phases 2–3 ship
the bulk of R1. Phases 4, 5, 6 implement R3, R5, R8 directly. Phase 7
adds optional LLM judging with proper guardrails. Phase 8 gates the
whole thing in CI.

The toolkit's character matches `akm`'s character: file-based, JSON-first,
deterministic by default, inspectable end-to-end, with optional richer
modes for operators who want them. It is the missing piece that turns
the existing observability substrate
(`<stash>/.akm/runs/<run-id>/improve-result.json`, the events table,
the proposal queue) into measured evidence — which is the gap both
external reviews independently identified as the highest-priority work
remaining on `akm` 0.8.0.

## Reviewed against

- `src/commands/eval-cases.ts` (the existing `<stash>/.akm/eval-cases/`
  surface — verified naming collision and resolved).
- `src/commands/improve-result-file.ts` (`buildImproveRunId`,
  `relativeImproveResultPath`, `writeImproveResultFile`).
- `src/core/state-db.ts` (events + proposals table schemas;
  `getStateDbPath` returns `<getDataDir()>/state.db`, not stash-local).
- `src/core/events.ts` (`EventType` union; `--since '@offset:<id>'`
  cursor semantics).
- `src/core/proposals.ts` (`PROPOSAL_SOURCES`,
  `AUTOMATED_PROPOSAL_SOURCES`, status lifecycle, accept-rate-per-source
  rationale).
- `src/commands/improve.ts` (`AkmImproveResult` shape;
  `memoryCleanup.beliefStateTransitions`; `evalCasesWritten` field).
- `src/cli.ts` (CLI shell-out contract: `--format json|jsonl|text`,
  `--detail`, `--json-to-stdout`).
- `scripts/improve-stats/` (toolkit precedent: shell + jq, `_lib.sh`,
  `--stash` flag, `latest` symlink resolution).
- `docs/technical/improve-workflow.md` (pipeline structure).
- `docs/improve-stats.md` and `scripts/improve-stats/README.md`
  (operator-guide tone and layout).
- README "Ecosystem" table (`itlackey/akm-eval` already exists as a
  separate repo — graduation target).
- `docs/technical/improve-pipeline-analysis-0.8.0.md` (roadmap items
  R1, R3, R5, R8, R10 mapped to eval phases).
