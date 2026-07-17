// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Golden capture: lint output parity across all 14 `ASSET_SPECS_INTERNAL`
 * asset types (WI-0b.4b, chunk-0b brief,
 * `docs/design/execution/chunk-0b/anchors.md` Section B.1 — the per-format
 * producer table's Lint column — and `tests/fixtures/stashes/all-types/`,
 * WI-0b.2's 14-type parity substrate). Sibling of
 * `tests/integration/goldens-renderer-output.test.ts` (WI-0b.4a).
 *
 * ## Two lint dispatch surfaces, captured separately
 *
 * `src/commands/lint/index.ts`'s `akmLint()` is the CLI entry point, but its
 * `STASH_SUBDIRS` walk list is `["agents","commands","memories","skills",
 * "workflows","lessons","tasks","knowledge","facts"]` — 9 of the 14 type
 * dirs. `script`/`env`/`secret`/`wiki`/`session` are not in that list at
 * all, so `akmLint()` never visits their files via the per-file loop; a
 * SEPARATE env-dangerous-key pass additionally scans `env/`/`secrets/` but
 * only for `.env`-suffixed filenames (`collectEnvFiles`), which the
 * `secret` fixture (a bare, extension-less filename) does not match. This
 * suite captures BOTH surfaces:
 *
 *   1. `akmLintFullSweep` — one real `akmLint({ dir: STASH_ROOT })` call
 *      over the whole fixture stash, the genuine CLI-facing behavior,
 *      pinning exactly which files it does and does not reach.
 *   2. `perType` — a DIRECT `getLinterForType(subdir).lint(ctx)` call per
 *      type, built with the SAME `LintContext` construction
 *      `akmLint()`'s per-file loop uses (`lint/index.ts:142-172`: read raw,
 *      `parseFrontmatter` for non-task subdirs / `parseYaml` for `tasks`,
 *      then dispatch). This is "run its lint path" literally, independent
 *      of whether `akmLint()`'s directory walk happens to reach that type —
 *      the mechanism this pins is `getLinterForType`'s dispatch table
 *      itself (`src/commands/lint/registry.ts`), which routes
 *      `script`/`env`/`secret`/`wiki`/`session` (no dedicated linter) AND
 *      `lessons` (explicitly keyed) to the shared `DefaultLinter` instance.
 *      `skill` additionally exercises `SkillLinter.lintDirectory`, the
 *      directory-level `missing-skill-md` check `akmLint()` runs once per
 *      subdirectory before the per-file loop.
 *
 * ## The workflow two-form split (WI-0b.2 finding, cited by the WI-0b.4
 * brief)
 *
 * `collectMarkdownFiles(workflows/)` only picks up `.md` — the
 * `workflow-program-yaml` form (`.yaml`) is INVISIBLE to `WorkflowLinter`
 * both in the real `akmLint()` sweep and in this suite's direct-dispatch
 * loop (calling `getLinterForType("workflows").lint()` against YAML content
 * would misuse a markdown-shaped linter on non-markdown bytes — not a real
 * production code path). The `.yaml` form's ONLY correctness check in
 * production is `parseWorkflowProgram` itself (invoked by
 * `workflowProgramRenderer`/its metadata contributor — see
 * `src/workflows/renderer.ts`'s `loadProgram`) — a parse succeeds or throws,
 * there is no separate `LintIssue[]` surface. This suite therefore captures
 * TWO SEPARATE entries, not one:
 *
 *   - `perType.workflowMd` — `WorkflowLinter.lint(ctx)` against
 *     `workflows/all-types-workflow.md` (a real lint path, issues: []).
 *   - `perType.workflowProgramYaml` — `parseWorkflowProgram(raw, { path:
 *     relPath })`'s result against
 *     `workflows/all-types-workflow-program.yaml` (a correctness check, not
 *     a lint path: `{ ok, program | errors }`).
 *
 * ## Determinism
 *
 * `LintIssue.file` is always `ctx.relPath` (verified by reading every
 * linter in `src/commands/lint/*.ts` — never `ctx.filePath`/absPath), and
 * `parseWorkflowProgram` is invoked with `{ path: relPath }` (mirroring
 * `src/workflows/renderer.ts`'s `loadProgram`, never `ctx.absPath`) so its
 * `source.path` fields are stash-relative too. No absolute path appears
 * anywhere in this golden's captured values — normalization is a no-op
 * (mirrors `tests/integration/goldens-recognition-placement.test.ts`, which
 * documents the same no-op case for its pure-path data). Every fixture is
 * lint-clean by construction (WI-0b.2's `all-types` stash notes), so every
 * `issues`/`flagged`/`fixed` array below is expected to be empty — this
 * golden still pins the actual structured shape (dispatch table identity,
 * full-sweep reachability), not just "zero issues".
 *
 * Designation: `frozen-migration-input` (`DESIGNATIONS.json`) for
 * `tests/fixtures/goldens/lint/all-types.json`.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { type AkmLintResult, akmLint } from "../../src/commands/lint/index";
import { getLinterForType } from "../../src/commands/lint/registry";
import type { LintContext, LintIssue } from "../../src/commands/lint/types";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";
import { parseWorkflowProgram } from "../../src/workflows/program/parser";
import { expectGolden } from "../_helpers/golden";

const STASH_ROOT = path.resolve(__dirname, "../fixtures/stashes/all-types");
const LINT_GOLDEN_PATH = "tests/fixtures/goldens/lint/all-types.json";
const HEAD_SHA = "25df0a859ebb0094c1b2f4e5e0c3071864d20e85";

/** [type key, stash subdir, relPath] for the 13 non-workflow types (workflow is split, see below). */
const NON_WORKFLOW_CASES: Array<[type: string, subdir: string, relPath: string]> = [
  ["skill", "skills", "skills/all-types-skill/SKILL.md"],
  ["command", "commands", "commands/all-types-command.md"],
  ["agent", "agents", "agents/all-types-agent.md"],
  ["knowledge", "knowledge", "knowledge/all-types-knowledge.md"],
  ["script", "scripts", "scripts/all-types-script.sh"],
  ["memory", "memories", "memories/all-types-memory.md"],
  ["env", "env", "env/all-types-env.env"],
  ["secret", "secrets", "secrets/all-types-secret"],
  ["wiki", "wikis", "wikis/all-types-space/all-types-wiki.md"],
  ["lesson", "lessons", "lessons/all-types-lesson.md"],
  ["task", "tasks", "tasks/all-types-task.yml"],
  ["session", "sessions", "sessions/all-types-harness/all-types-session.md"],
  ["fact", "facts", "facts/all-types-fact.md"],
];

const WORKFLOW_MD_REL_PATH = "workflows/all-types-workflow.md";
const WORKFLOW_YAML_REL_PATH = "workflows/all-types-workflow-program.yaml";

/**
 * Build a `LintContext` for `relPath`, using the EXACT construction
 * `src/commands/lint/index.ts`'s `akmLint()` per-file loop uses
 * (`lint/index.ts:142-172`): tasks are parsed as plain YAML (no frontmatter
 * fence), everything else via `parseFrontmatter`. `fix` is always `false` —
 * this suite never mutates the fixture stash.
 */
function buildLintContext(subdir: string, relPath: string): LintContext {
  const filePath = path.join(STASH_ROOT, relPath);
  const raw = fs.readFileSync(filePath, "utf8");
  let data: Record<string, unknown>;
  let body: string;
  let frontmatter: string | null;
  if (subdir === "tasks") {
    try {
      const parsed: unknown = parseYaml(raw);
      data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      data = {};
    }
    body = raw;
    frontmatter = null;
  } else {
    ({ data, content: body, frontmatter } = parseFrontmatter(raw));
  }
  return { filePath, relPath, raw, data, body, frontmatter, fix: false, stashRoot: STASH_ROOT };
}

/** Direct per-type lint dispatch: `getLinterForType(subdir).lint(ctx)`. */
function lintOneType(subdir: string, relPath: string): { linterUsed: string; issues: LintIssue[] } {
  const linter = getLinterForType(subdir);
  const ctx = buildLintContext(subdir, relPath);
  const issues = linter.lint(ctx);
  return { linterUsed: linter.constructor.name, issues };
}

// ── 1. Lint dispatch assertions (pre-capture sanity) ────────────────────────

describe("lint parity: all 14 all-types fixture assets lint clean via their dispatched linter (WI-0b.4b)", () => {
  test("every non-workflow type dispatches to the documented linter and reports zero issues", () => {
    for (const [, subdir, relPath] of NON_WORKFLOW_CASES) {
      const { issues } = lintOneType(subdir, relPath);
      expect(issues, `issues for ${relPath}`).toEqual([]);
    }
  });

  test("script/env/secret/wiki/session (no dedicated linter) AND lesson (explicitly keyed) all dispatch to DefaultLinter", () => {
    for (const subdir of ["scripts", "env", "secrets", "wikis", "sessions", "lessons"]) {
      expect(getLinterForType(subdir).constructor.name, subdir).toBe("DefaultLinter");
    }
  });

  test("skill directory-level check (missing-skill-md) passes for the fixture's SKILL.md-bearing directory", () => {
    const linter = getLinterForType("skills");
    expect(typeof linter.lintDirectory).toBe("function");
    const issues = linter.lintDirectory?.(path.join(STASH_ROOT, "skills/all-types-skill"), STASH_ROOT) ?? [];
    expect(issues).toEqual([]);
  });

  test("workflow-md dispatches to WorkflowLinter with zero issues; workflow-program-yaml is invisible to it", () => {
    const { linterUsed, issues } = lintOneType("workflows", WORKFLOW_MD_REL_PATH);
    expect(linterUsed).toBe("WorkflowLinter");
    expect(issues).toEqual([]);
  });

  test("workflow-program-yaml's only correctness check is parseWorkflowProgram, which succeeds for the fixture", () => {
    const raw = fs.readFileSync(path.join(STASH_ROOT, WORKFLOW_YAML_REL_PATH), "utf8");
    const result = parseWorkflowProgram(raw, { path: WORKFLOW_YAML_REL_PATH });
    expect(result.ok).toBe(true);
  });

  test("akmLint({dir: STASH_ROOT}) full sweep is clean and does not error", () => {
    const result = akmLint({ dir: STASH_ROOT });
    expect(result.ok).toBe(true);
    expect(result.flagged).toEqual([]);
    expect(result.fixed).toEqual([]);
  });
});

// ── 2. Golden fixture capture ────────────────────────────────────────────────
//
// Re-derives every result independently of the assertion block above so
// capture never depends on bun:test's within-file execution order (mirrors
// tests/integration/goldens-recognition-placement.test.ts).

describe("golden fixture: lint output parity (WI-0b.4b)", () => {
  test("golden fixture: lint/all-types.json", () => {
    const perType: Record<string, unknown> = {};

    for (const [type, subdir, relPath] of NON_WORKFLOW_CASES) {
      const { linterUsed, issues } = lintOneType(subdir, relPath);
      perType[type] = { subdir, relPath, linterUsed, issues };
    }

    const workflowMd = lintOneType("workflows", WORKFLOW_MD_REL_PATH);
    perType.workflowMd = {
      subdir: "workflows",
      relPath: WORKFLOW_MD_REL_PATH,
      linterUsed: workflowMd.linterUsed,
      issues: workflowMd.issues,
    };

    const skillDirIssues =
      getLinterForType("skills").lintDirectory?.(path.join(STASH_ROOT, "skills/all-types-skill"), STASH_ROOT) ?? [];
    (perType.skill as { lintDirectoryIssues?: LintIssue[] }).lintDirectoryIssues = skillDirIssues;

    const yamlRaw = fs.readFileSync(path.join(STASH_ROOT, WORKFLOW_YAML_REL_PATH), "utf8");
    const programResult = parseWorkflowProgram(yamlRaw, { path: WORKFLOW_YAML_REL_PATH });
    perType.workflowProgramYaml = {
      subdir: "workflows",
      relPath: WORKFLOW_YAML_REL_PATH,
      correctnessCheck: "parseWorkflowProgram",
      result: programResult,
    };

    const akmLintFullSweep: AkmLintResult = akmLint({ dir: STASH_ROOT });

    expectGolden(LINT_GOLDEN_PATH, {
      scenario:
        "Lint dispatch parity for every asset in tests/fixtures/stashes/all-types/ (WI-0b.4b, all 14 ASSET_SPECS_INTERNAL types), capturing BOTH the direct getLinterForType(subdir).lint(ctx) dispatch per type AND the real akmLint({dir: STASH_ROOT}) CLI-entry-point full sweep",
      capturedAtHead: HEAD_SHA,
      notes: [
        "perType: one entry per type (workflow split into workflowMd + workflowProgramYaml, so 14 keys mapping to " +
          "15 fixture files' worth of coverage -- see module docstring for the split rationale). Each non-workflow " +
          "entry is {subdir, relPath, linterUsed (the dispatched linter's constructor name), issues (LintIssue[] " +
          "from a direct getLinterForType(subdir).lint(ctx) call, ctx built via the exact LintContext construction " +
          "lint/index.ts's per-file loop uses)}. `skill` additionally carries `lintDirectoryIssues` (SkillLinter's " +
          "directory-level missing-skill-md check). `workflowMd` is a real lint path (WorkflowLinter). " +
          "`workflowProgramYaml` is NOT a lint path -- WorkflowLinter never sees .yaml files in production " +
          "(collectMarkdownFiles filters .md only), so its only correctness surface is parseWorkflowProgram's own " +
          '{ok, program|errors} result, captured under `result` with `correctnessCheck: "parseWorkflowProgram"` ' +
          "to make the distinction explicit rather than silently reusing the `issues` shape for a different kind " +
          "of check.",
        "script/env/secret/wiki/session have no dedicated linter and dispatch to the shared DefaultLinter via " +
          "getLinterForType's fallback (`?? DEFAULT_LINTER`); lesson dispatches to the SAME DefaultLinter instance " +
          'via an explicit registry.ts entry (`LINTER_MAP.set("lessons", DEFAULT_LINTER)`) rather than the ' +
          "fallback -- both paths land on `DefaultLinter`, which this golden's `linterUsed` field pins for all six.",
        "akmLintFullSweep: the real akmLint({dir: STASH_ROOT}) result ({ok, fixed, flagged, summary}), pinning " +
          "the CLI entry point's ACTUAL reachable surface for this fixture stash. akmLint()'s STASH_SUBDIRS walk " +
          'list (lint/index.ts) is ["agents","commands","memories","skills","workflows","lessons",' +
          '"tasks","knowledge","facts"] -- 9 of the 14 type dirs; script/secret/wiki/session are never ' +
          "visited by the per-file loop for ANY file. A separate env-dangerous-key pass additionally scans " +
          "env/ and secrets/, but only .env-suffixed filenames (collectEnvFiles) -- it reaches " +
          "env/all-types-env.env (matches) but NOT secrets/all-types-secret (bare filename, no .env suffix). Net " +
          "result for this fixture stash: script, secret, wiki, and session are 100% unreached by akmLint() in " +
          "production; workflows/all-types-workflow-program.yaml is unreached (its .md sibling is reached). This " +
          "is the lint-surface analogue of the WI-0b.2-documented tasks/*.yml recognition gap (fixed by WI-0b.1) " +
          "-- here it is a CAPTURED FINDING, not a fix (capture-only scope; no src/ changes).",
        "Determinism: LintIssue.file is always ctx.relPath (never absPath) in every linter under src/commands/" +
          "lint/*.ts, and parseWorkflowProgram is invoked with {path: relPath} (mirroring src/workflows/renderer." +
          "ts's loadProgram). No absolute path appears anywhere in this golden -- normalization is a no-op, same " +
          "as tests/fixtures/goldens/recognition/all-types.json's pure-path data.",
        "FROZEN behavior-parity oracle (D0b-1/D0b-3): Chunk 2's format adapters must reproduce this lint dispatch " +
          "byte-for-byte. anchors.md Section B.3 confirms zero prior lint golden coverage existed before this " +
          "capture -- greenfield, not a re-baseline. Sibling of WI-0b.4a's renderer/all-types.json.",
      ],
      perType,
      akmLintFullSweep,
    });
  });
});
