// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Golden capture: renderer output parity across all 14 `ASSET_SPECS_INTERNAL`
 * asset types PLUS the workflow type's second renderer form (WI-0b.4a,
 * chunk-0b brief, `docs/design/execution/chunk-0b/anchors.md` Section B.1 —
 * the per-format producer table's Renderer column — and
 * `tests/fixtures/stashes/all-types/`, WI-0b.2's 14-type parity substrate).
 *
 * FROZEN behavior-parity oracle: Chunk 2's format adapters must reproduce
 * every `AssetRenderer.buildShowResponse(ctx)`'s output byte-for-byte. This
 * suite is capture-only (no `src/` changes) — it snapshots PRODUCTION
 * rendering logic against the greenfield `all-types` fixture stash (sibling
 * of WI-0b.3's recognition/placement/minting captures; no pre-existing
 * renderer golden to re-baseline, per anchors.md B.3).
 *
 * ## Call shape (mirrors `src/commands/read/show.ts`'s `showLocal`)
 *
 * For every file: `buildFileContext(STASH_ROOT, absPath)` ->
 * `runMatchers(ctx)` -> `match.meta = { ...match.meta, name: <canonical
 * name> }` (mirroring `show.ts:439`'s `match.meta = { ...match.meta, name:
 * parsed.name, view: input.view }`; `view` is left `undefined` so every
 * markdown-view-capable renderer exercises its "full" default branch) ->
 * `getRenderer(match.renderer)` -> `buildRenderContext(ctx, match,
 * [STASH_ROOT], undefined)` -> `renderer.buildShowResponse(renderCtx)`. The
 * capture stops at the renderer's own output — it does NOT go through
 * `showLocal`'s post-processing (`related`, `editable`, `editHint`,
 * `activeRun`, the primary-stash `toolPolicy` ceiling), which is CLI-layer
 * composition, not renderer behavior, and depends on index/db state this
 * suite deliberately does not stand up. `origin` is `undefined` (primary
 * local stash, no registry id) for every case, matching how the fixture
 * stash is consumed.
 *
 * The canonical `name` passed via `match.meta.name` for each type is the
 * SAME name `tests/fixtures/goldens/placement/all-types.json` (WI-0b.3b)
 * already uses for its `byType` round-trip, so the two goldens agree on
 * asset identity.
 *
 * ## Normalization (the one non-determinism point)
 *
 * Every `AssetRenderer.buildShowResponse` implementation returns `path:
 * ctx.absPath` — an ABSOLUTE filesystem path that varies by checkout
 * location and is therefore not byte-stable across machines. This is the
 * ONLY non-deterministic field any of the 14 renderers emit (verified by
 * reading every implementation in `src/output/renderers.ts` and
 * `src/workflows/renderer.ts`: no renderer reads a timestamp, random id, or
 * any other absolute-path-bearing field). `expectGolden`'s `roots: { stash:
 * STASH_ROOT }` substitutes the literal `STASH_ROOT` prefix with `<STASH>`
 * (see `tests/_helpers/golden.ts`), turning e.g.
 * `/…/tests/fixtures/stashes/all-types/agents/all-types-agent.md` into
 * `<STASH>/agents/all-types-agent.md`. No other normalization is needed —
 * every other field (content/description/action/steps/keys/run/etc.) is
 * derived purely from the fixture's committed bytes plus the injected
 * canonical name, both of which are fixed.
 *
 * Keyed by stash-relative POSIX relPath (never an absolute path), matching
 * `tests/fixtures/goldens/recognition/all-types.json`'s `byRelPath` shape —
 * the same 15-key set (14 types + the workflow-program-yaml renderer form).
 *
 * Designation: `frozen-migration-input` (`DESIGNATIONS.json`) for
 * `tests/fixtures/goldens/renderer/all-types.json`.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { recognizeMatch } from "../../src/core/adapter/adapters/akm-adapter";
import { buildFileContext, buildRenderContext, getRenderer } from "../../src/indexer/walk/file-context";
import type { ShowResponse } from "../../src/sources/types";
import { expectGolden } from "../_helpers/golden";

const STASH_ROOT = path.resolve(__dirname, "../fixtures/stashes/all-types");
const RENDERER_GOLDEN_PATH = "tests/fixtures/goldens/renderer/all-types.json";
const HEAD_SHA = "25df0a859ebb0094c1b2f4e5e0c3071864d20e85";

/**
 * relPath -> canonical name, identical to
 * `tests/fixtures/goldens/placement/all-types.json`'s `byType` name set
 * (WI-0b.3b), so `match.meta.name` mirrors what `show.ts` would inject for
 * `akm show <canonical-ref>` against this fixture.
 */
const CANONICAL_NAME_BY_REL_PATH: Record<string, string> = {
  "agents/all-types-agent.md": "all-types-agent",
  "commands/all-types-command.md": "all-types-command",
  "env/all-types-env.env": "all-types-env",
  "facts/all-types-fact.md": "all-types-fact",
  "knowledge/all-types-knowledge.md": "all-types-knowledge",
  "lessons/all-types-lesson.md": "all-types-lesson",
  "memories/all-types-memory.md": "all-types-memory",
  "scripts/all-types-script.sh": "all-types-script.sh",
  "secrets/all-types-secret": "all-types-secret",
  "sessions/all-types-harness/all-types-session.md": "all-types-harness/all-types-session",
  "skills/all-types-skill/SKILL.md": "all-types-skill",
  "tasks/all-types-task.yml": "all-types-task",
  "workflows/all-types-workflow-program.yaml": "all-types-workflow-program",
  "workflows/all-types-workflow.md": "all-types-workflow",
};

/** Expected `type` field per relPath (same set the recognition golden pins). */
const EXPECTED_TYPE_BY_REL_PATH: Record<string, string> = {
  "agents/all-types-agent.md": "agent",
  "commands/all-types-command.md": "command",
  "env/all-types-env.env": "env",
  "facts/all-types-fact.md": "fact",
  "knowledge/all-types-knowledge.md": "knowledge",
  "lessons/all-types-lesson.md": "lesson",
  "memories/all-types-memory.md": "memory",
  "scripts/all-types-script.sh": "script",
  "secrets/all-types-secret": "secret",
  "sessions/all-types-harness/all-types-session.md": "session",
  "skills/all-types-skill/SKILL.md": "skill",
  "tasks/all-types-task.yml": "task",
  "workflows/all-types-workflow-program.yaml": "workflow",
  "workflows/all-types-workflow.md": "workflow",
};

/**
 * Render one fixture asset the same way `showLocal` does (see the module
 * docstring for the exact call shape), returning the raw (un-normalized)
 * `ShowResponse`.
 */
async function renderFixture(relPath: string): Promise<ShowResponse> {
  const name = CANONICAL_NAME_BY_REL_PATH[relPath];
  if (!name) throw new Error(`no canonical name registered for ${relPath}`);
  const absPath = path.join(STASH_ROOT, relPath);
  const fileCtx = buildFileContext(STASH_ROOT, absPath);
  const match = recognizeMatch(fileCtx);
  if (!match) throw new Error(`runMatchers returned null for ${relPath}`);
  match.meta = { ...match.meta, name };
  const renderer = await getRenderer(match.renderer);
  if (!renderer) throw new Error(`no renderer registered for name "${match.renderer}" (${relPath})`);
  const renderCtx = buildRenderContext(fileCtx, match, [STASH_ROOT], undefined);
  return renderer.buildShowResponse(renderCtx);
}

// ── 1. Renderer assertions (pre-capture sanity) ─────────────────────────────

describe("renderer parity: all 14 all-types fixture assets render via their documented renderer (WI-0b.4a)", () => {
  test("every fixture file's buildShowResponse carries the expected type/name and an absolute path under the fixture stash", async () => {
    for (const [relPath, expectedType] of Object.entries(EXPECTED_TYPE_BY_REL_PATH)) {
      const response = await renderFixture(relPath);
      expect(response.type, `type for ${relPath}`).toBe(expectedType);
      expect(response.name, `name for ${relPath}`).toBe(CANONICAL_NAME_BY_REL_PATH[relPath]);
      expect(response.path.startsWith(STASH_ROOT), `path for ${relPath} should be absolute under STASH_ROOT`).toBe(
        true,
      );
    }
  });

  test("the two workflow renderer forms produce distinct step shapes from the same fixture semantics", async () => {
    const mdResponse = await renderFixture("workflows/all-types-workflow.md");
    const yamlResponse = await renderFixture("workflows/all-types-workflow-program.yaml");
    expect(mdResponse.steps?.[0]?.id).toBe("announce");
    expect(yamlResponse.steps?.[0]?.id).toBe("announce");
    // workflow-md derives its step title from the "### Step: <title>" heading;
    // workflow-program-yaml falls back to the step id when no title is set —
    // the two renderers disagree on title derivation for equivalent content.
    expect(mdResponse.workflowTitle).toBe("All Types Fixture");
    expect(yamlResponse.workflowTitle).toBe("all-types-workflow-program");
  });

  test("env-file renderer surfaces key NAMES only, never values or comment text", async () => {
    const response = await renderFixture("env/all-types-env.env");
    expect(response.keys).toEqual(["FIXTURE_GREETING", "FIXTURE_LOG_LEVEL"]);
    expect(JSON.stringify(response)).not.toContain("hello-from-all-types");
  });
});

// ── 2. Golden fixture capture ────────────────────────────────────────────────
//
// Re-derives every response independently of the assertion block above so
// capture never depends on bun:test's within-file execution order (mirrors
// tests/integration/goldens-recognition-placement.test.ts).

describe("golden fixture: renderer output parity (WI-0b.4a)", () => {
  test("golden fixture: renderer/all-types.json", async () => {
    const byRelPath: Record<string, unknown> = {};
    for (const relPath of Object.keys(CANONICAL_NAME_BY_REL_PATH)) {
      byRelPath[relPath] = await renderFixture(relPath);
    }

    expectGolden(
      RENDERER_GOLDEN_PATH,
      {
        scenario:
          "AssetRenderer.buildShowResponse(renderCtx) output for every asset in tests/fixtures/stashes/all-types/ (WI-0b.4a, all 14 ASSET_SPECS_INTERNAL types + the workflow-program-yaml renderer form), invoked via the same buildFileContext -> runMatchers -> getRenderer -> buildRenderContext call shape src/commands/read/show.ts's showLocal uses",
        capturedAtHead: HEAD_SHA,
        notes: [
          "Keyed by stash-relative POSIX relPath (never an absolute path) -- the same 15-key set as " +
            "tests/fixtures/goldens/recognition/all-types.json. match.meta.name is injected per-file using the SAME " +
            "canonical name tests/fixtures/goldens/placement/all-types.json's byType round-trip uses, mirroring " +
            "show.ts:439's `match.meta = { ...match.meta, name: parsed.name, view: input.view }` (view left " +
            'undefined, so knowledge/wiki exercise their default "full" view branch). The capture stops at the ' +
            "renderer's own buildShowResponse output -- it does not include showLocal's post-processing " +
            "(related/editable/editHint/activeRun/toolPolicy ceiling), which is CLI composition, not renderer " +
            "behavior, and depends on index/db state this suite does not stand up.",
          "NORMALIZATION: every renderer's `path` field is `ctx.absPath` -- an absolute filesystem path, the ONLY " +
            "non-deterministic value any of the 14 renderers emit (verified by reading every implementation in " +
            "src/output/renderers.ts and src/workflows/renderer.ts). expectGolden's roots:{stash:STASH_ROOT} " +
            'substitutes the literal fixture-stash absolute prefix with the placeholder "<STASH>" (see ' +
            "tests/_helpers/golden.ts) so the golden is byte-stable across checkouts. No other field required " +
            "normalization: content/description/action/steps/keys/run/workflowTitle are all derived purely from " +
            "the fixture's committed bytes plus the injected canonical name.",
          "Two documented asymmetries this golden PINS byte-for-byte (not fixed, per capture-only scope): (1) " +
            "skill/command/agent/lesson/fact/session renderers return frontmatter-STRIPPED content (via " +
            'parseFrontmatter(ctx.content()).content), while memory-md AND knowledge-md/wiki-md\'s default "full" ' +
            "view return the RAW content INCLUDING the frontmatter fence (memory-md's buildShowResponse returns " +
            "ctx.content() directly; buildMarkdownViewResponse's default branch does the same for knowledge/wiki) " +
            '-- Chunk 2\'s memory/knowledge/wiki adapters must reproduce this, not silently "fix" it. (2) ' +
            "workflow-md derives a step's displayed title from its parsed heading " +
            '("Announce"), while workflow-program-yaml falls back to the step id when no `title` key is set ' +
            '("announce") -- same fixture semantics, different renderer, different title casing.',
          "FROZEN behavior-parity oracle (D0b-1/D0b-3): Chunk 2's format adapters must reproduce every renderer's " +
            "output byte-for-byte. anchors.md Section B.3 confirms zero prior renderer golden coverage existed " +
            "before this capture -- greenfield, not a re-baseline. Sibling of WI-0b.3's recognition/placement/" +
            "minting goldens; this is WI-0b.4a.",
        ],
        byRelPath,
      },
      { stash: STASH_ROOT },
    );
  });
});
