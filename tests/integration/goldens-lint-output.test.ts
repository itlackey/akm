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
 * ## RE-BASELINED at chunk-3 (plan §12 linter consolidation)
 *
 * The original capture pinned `getLinterForType(subdir).lint(ctx)` dispatch and
 * a `linterUsed` field naming the dispatched `BaseLinter` subclass. Task #45
 * item 1 collapsed the 9 per-type linter classes + `LINTER_MAP`/
 * `getLinterForType` into (a) the shared `runBaseChecks` (`base-linter.ts`) and
 * (b) the `akm` adapter's per-`type` `validate` rules
 * (`core/adapter/adapters/akm-lint.ts`), reached by the live CLI through the
 * one `lintAssetFile(ctx, subdir)` dispatcher (`commands/lint/index.ts`). The
 * class-name `linterUsed` field can no longer be produced, so this golden was
 * re-designated `re-baseline @ 3` (surface-owner rule) and re-captured WITHOUT
 * it — every FINDING is byte-identical (all fixtures still lint clean; the
 * `akmLint({dir})` full-sweep result is unchanged).
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
 *   2. `perType` — a DIRECT `lintAssetFile(ctx, subdir)` call per type, built
 *      with the SAME `LintContext` construction `akmLint()`'s per-file loop
 *      uses (`lint/index.ts`: read raw, `parseFrontmatter` for non-task subdirs
 *      / `parseYaml` for `tasks`, then dispatch). This is "run its lint path"
 *      literally, independent of whether `akmLint()`'s directory walk happens to
 *      reach that type. `skill` additionally exercises `lintSkillDirectory`, the
 *      directory-level `missing-skill-md` check `akmLint()` runs once per
 *      subdirectory before the per-file loop.
 *
 * ## The workflow two-form split (WI-0b.2 finding, cited by the WI-0b.4
 * brief)
 *
 * `collectMarkdownFiles(workflows/)` only picks up `.md` — the
 * `workflow-program-yaml` form (`.yaml`) is INVISIBLE to the workflow lint
 * path both in the real `akmLint()` sweep and in this suite's direct-dispatch
 * loop (dispatching `lintAssetFile(ctx, "workflows")` against YAML content
 * would misuse the markdown-shaped workflow checks on non-markdown bytes — not
 * a real production code path). The `.yaml` form's ONLY correctness check in
 * production is `parseWorkflowProgram` itself (invoked by
 * `workflowProgramRenderer`/its metadata contributor — see
 * `src/workflows/renderer.ts`'s `loadProgram`) — a parse succeeds or throws,
 * there is no separate `LintIssue[]` surface. This suite therefore captures
 * TWO SEPARATE entries, not one:
 *
 *   - `perType.workflowMd` — `lintAssetFile(ctx, "workflows")` against
 *     `workflows/all-types-workflow.md` (a real lint path, issues: []).
 *   - `perType.workflowProgramYaml` — `parseWorkflowProgram(raw, { path:
 *     relPath })`'s result against
 *     `workflows/all-types-workflow-program.yaml` (a correctness check, not
 *     a lint path: `{ ok, program | errors }`).
 *
 * ## Determinism
 *
 * `LintIssue.file` is always `ctx.relPath` (never `ctx.filePath`/absPath), and
 * `parseWorkflowProgram` is invoked with `{ path: relPath }` (mirroring
 * `src/workflows/renderer.ts`'s `loadProgram`, never `ctx.absPath`) so its
 * `source.path` fields are stash-relative too. No absolute path appears
 * anywhere in this golden's captured values — normalization is a no-op. Every
 * fixture is lint-clean by construction (WI-0b.2's `all-types` stash notes), so
 * every `issues`/`flagged`/`fixed` array below is expected to be empty — this
 * golden still pins the actual structured shape (dispatch reachability,
 * full-sweep reachability), not just "zero issues".
 *
 * Designation: `re-baseline @ 3` (`DESIGNATIONS.json`) for
 * `tests/fixtures/goldens/lint/all-types.json`.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { type AkmLintResult, akmLint, lintAssetFile, lintSkillDirectory } from "../../src/commands/lint/index";
import type { LintContext, LintIssue } from "../../src/commands/lint/types";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";
import { parseWorkflowProgram } from "../../src/workflows/program/parser";
import { expectGolden } from "../_helpers/golden";

const STASH_ROOT = path.resolve(__dirname, "../fixtures/stashes/all-types");
const LINT_GOLDEN_PATH = "tests/fixtures/goldens/lint/all-types.json";
const HEAD_SHA = "cd94d26c6de251fa5dcadd9e9e40f6991bf87eb5";

/** [type key, stash subdir, relPath] for the 12 non-workflow types (workflow is split, see below). */
const NON_WORKFLOW_CASES: Array<[type: string, subdir: string, relPath: string]> = [
  ["skill", "skills", "skills/all-types-skill/SKILL.md"],
  ["command", "commands", "commands/all-types-command.md"],
  ["agent", "agents", "agents/all-types-agent.md"],
  ["knowledge", "knowledge", "knowledge/all-types-knowledge.md"],
  ["script", "scripts", "scripts/all-types-script.sh"],
  ["memory", "memories", "memories/all-types-memory.md"],
  ["env", "env", "env/all-types-env.env"],
  ["secret", "secrets", "secrets/all-types-secret"],
  ["lesson", "lessons", "lessons/all-types-lesson.md"],
  ["task", "tasks", "tasks/all-types-task.yml"],
  ["session", "sessions", "sessions/all-types-harness/all-types-session.md"],
  ["fact", "facts", "facts/all-types-fact.md"],
];

const WORKFLOW_MD_REL_PATH = "workflows/all-types-workflow.md";
const WORKFLOW_YAML_REL_PATH = "workflows/all-types-workflow-program.yaml";

/**
 * Build a `LintContext` for `relPath`, using the EXACT construction
 * `src/commands/lint/index.ts`'s `akmLint()` per-file loop uses: tasks are
 * parsed as plain YAML (no frontmatter fence), everything else via
 * `parseFrontmatter`. `fix` is always `false` — this suite never mutates the
 * fixture stash.
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

/** Direct per-type lint dispatch: `lintAssetFile(ctx, subdir)`. */
function lintOneType(subdir: string, relPath: string): { issues: LintIssue[] } {
  return { issues: lintAssetFile(buildLintContext(subdir, relPath), subdir) };
}

// ── 1. Lint dispatch assertions (pre-capture sanity) ────────────────────────

describe("lint parity: all 14 all-types fixture assets lint clean via the consolidated dispatch (WI-0b.4b)", () => {
  test("every non-workflow type lints clean via lintAssetFile", () => {
    for (const [, subdir, relPath] of NON_WORKFLOW_CASES) {
      const { issues } = lintOneType(subdir, relPath);
      expect(issues, `issues for ${relPath}`).toEqual([]);
    }
  });

  test("types with no per-type rules (script/env/secret/session/lesson/knowledge) run base checks only", () => {
    // Post-consolidation there is no dispatch table: these subdirs simply add
    // no per-type findings on top of runBaseChecks, so a clean fixture is [].
    for (const subdir of ["scripts", "env", "secrets", "sessions", "lessons", "knowledge"]) {
      const [, , relPath] = NON_WORKFLOW_CASES.find(([, s]) => s === subdir) ?? [];
      if (!relPath) continue;
      expect(lintAssetFile(buildLintContext(subdir, relPath), subdir), subdir).toEqual([]);
    }
  });

  test("skill directory-level check (missing-skill-md) passes for the fixture's SKILL.md-bearing directory", () => {
    const issues = lintSkillDirectory(path.join(STASH_ROOT, "skills/all-types-skill"), STASH_ROOT);
    expect(issues).toEqual([]);
  });

  test("workflow-md lints clean; workflow-program-yaml is invisible to the markdown lint path", () => {
    const { issues } = lintOneType("workflows", WORKFLOW_MD_REL_PATH);
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
// capture never depends on bun:test's within-file execution order.

describe("golden fixture: lint output parity (WI-0b.4b)", () => {
  test("golden fixture: lint/all-types.json", () => {
    const perType: Record<string, unknown> = {};

    for (const [type, subdir, relPath] of NON_WORKFLOW_CASES) {
      const { issues } = lintOneType(subdir, relPath);
      perType[type] = { subdir, relPath, issues };
    }

    const workflowMd = lintOneType("workflows", WORKFLOW_MD_REL_PATH);
    perType.workflowMd = {
      subdir: "workflows",
      relPath: WORKFLOW_MD_REL_PATH,
      issues: workflowMd.issues,
    };

    const skillDirIssues = lintSkillDirectory(path.join(STASH_ROOT, "skills/all-types-skill"), STASH_ROOT);
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
        "Lint dispatch parity for every asset in tests/fixtures/stashes/all-types/ (WI-0b.4b, all 14 ASSET_SPECS_INTERNAL types), capturing BOTH the direct lintAssetFile(ctx, subdir) dispatch per type AND the real akmLint({dir: STASH_ROOT}) CLI-entry-point full sweep",
      capturedAtHead: HEAD_SHA,
      notes: [
        "RE-BASELINED @ chunk-3 (plan §12): the 9 per-type linter classes + LINTER_MAP/getLinterForType were " +
          "collapsed into runBaseChecks (base-linter.ts) + the akm adapter's per-type validate rules " +
          "(core/adapter/adapters/akm-lint.ts), reached by the CLI through lintAssetFile(ctx, subdir). The former " +
          "`linterUsed` (dispatched class name) field is GONE — no classes remain. Every finding is byte-identical " +
          "(all fixtures still lint clean; akmLintFullSweep unchanged).",
        "perType: one entry per type (workflow split into workflowMd + workflowProgramYaml, so 14 keys mapping to " +
          "15 fixture files' worth of coverage -- see module docstring for the split rationale). Each non-workflow " +
          "entry is {subdir, relPath, issues (LintIssue[] from a direct lintAssetFile(ctx, subdir) call, ctx built " +
          "via the exact LintContext construction lint/index.ts's per-file loop uses)}. `skill` additionally " +
          "carries `lintDirectoryIssues` (the directory-level missing-skill-md check, lintSkillDirectory). " +
          "`workflowMd` is a real lint path. `workflowProgramYaml` is NOT a lint path -- the markdown workflow " +
          "checks never see .yaml files in production (collectMarkdownFiles filters .md only), so its only " +
          "correctness surface is parseWorkflowProgram's own {ok, program|errors} result, captured under `result` " +
          'with `correctnessCheck: "parseWorkflowProgram"`.',
        "akmLintFullSweep: the real akmLint({dir: STASH_ROOT}) result ({ok, fixed, flagged, summary}), pinning " +
          "the CLI entry point's ACTUAL reachable surface for this fixture stash. akmLint()'s STASH_SUBDIRS walk " +
          'list (lint/index.ts) is ["agents","commands","memories","skills","workflows","lessons",' +
          '"tasks","knowledge","facts"] -- 9 of the 14 type dirs; script/secret/wiki/session are never ' +
          "visited by the per-file loop for ANY file. A separate env-dangerous-key pass additionally scans " +
          "env/ and secrets/, but only .env-suffixed filenames (collectEnvFiles) -- it reaches " +
          "env/all-types-env.env (matches) but NOT secrets/all-types-secret (bare filename, no .env suffix). Net " +
          "result for this fixture stash: script, secret, wiki, and session are 100% unreached by akmLint() in " +
          "production; workflows/all-types-workflow-program.yaml is unreached (its .md sibling is reached).",
        "Determinism: LintIssue.file is always ctx.relPath (never absPath), and parseWorkflowProgram is invoked " +
          "with {path: relPath} (mirroring src/workflows/renderer.ts's loadProgram). No absolute path appears " +
          "anywhere in this golden -- normalization is a no-op.",
        "Behavior-parity oracle: the format adapters + the CLI lint sweep must reproduce this lint dispatch " +
          "byte-for-byte. Sibling of WI-0b.4a's renderer/all-types.json.",
      ],
      perType,
      akmLintFullSweep,
    });
  });
});
