// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Golden capture: recognition + placement parity across all 14
 * `ASSET_SPECS_INTERNAL` asset types (WI-0b.3a / WI-0b.3b, chunk-0b brief,
 * `docs/design/execution/chunk-0b/anchors.md` Section B — the per-format
 * producer table — and `tests/fixtures/stashes/all-types/` (WI-0b.2's
 * 14-type parity substrate, MANIFEST.json).
 *
 * FROZEN behavior-parity oracle: Chunk 2's format adapters must reproduce
 * `runMatchers`'s classification (type/specificity/renderer/meta) and
 * `ASSET_SPECS[type].toAssetPath`'s placement byte-for-byte. This suite is
 * capture-only (no `src/` changes) — it snapshots PRODUCTION classification
 * and placement logic against the greenfield `all-types` fixture stash (no
 * pre-existing golden to re-baseline; anchors.md B.3 confirms zero prior
 * recognition/placement coverage).
 *
 * ## Recognition (WI-0b.3a)
 *
 * For every file under `tests/fixtures/stashes/all-types/` (excluding the
 * fixture's own `MANIFEST.json`, which is not an asset), captures
 * `runMatchers(buildFileContext(stashRoot, absPath))`'s winning `MatchResult`
 * keyed by the file's stash-relative path. Uses `walkStashFlat` — the same
 * git-ls-files-based walker the real indexer uses — rather than a bespoke
 * directory walk, so the capture exercises the exact production entry point.
 *
 * ## Placement (WI-0b.3b)
 *
 * For every type, captures `ASSET_SPECS[type].toAssetPath(typeRoot, name)`
 * for the SAME canonical name the `all-types` fixture already uses on disk
 * (a placement round-trip against real, committed fixture bytes) plus a set
 * of documented edge-case branches: the `env` `"default"` alias, the
 * `workflow` multi-extension probe-fallback (when no candidate file exists)
 * and probe-hit (`all-types-workflow-program`, whose only on-disk form is
 * `.yaml` — pins the priority-ordered `fs.existsSync` probe actually finding
 * a non-`.md` candidate), the `task`/`command`/`env` already-suffixed-name
 * idempotent aliases, and a nested `secret` name. `typeRoot` is always
 * computed under the real `all-types` stash root so the `workflow` spec's
 * `fs.existsSync` probes observe real (committed, stable) files rather than
 * depending on `process.cwd()` — this keeps the capture deterministic
 * regardless of the invoking shell's working directory.
 *
 * Byte-for-byte pure-path goldens: no timestamps/ids/durations appear in
 * either fixture, so `expectGolden`'s placeholder normalization is a no-op
 * here (mirrors `tests/commands/consolidate/goldens-merge-plans.test.ts`).
 * Every path stored is stash-relative POSIX (never absolute — hard
 * constraint per the WI-0b.3 brief).
 *
 * Designation: `frozen-migration-input` (`DESIGNATIONS.json`) for both
 * `tests/fixtures/goldens/recognition/all-types.json` and
 * `tests/fixtures/goldens/placement/all-types.json`.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { recognizeMatch } from "../../src/core/adapter/adapters/akm-adapter";
import { type AssetSpec, placementSpecFor, placementTypes } from "../../src/core/asset/asset-placement";
import { walkStashFlat } from "../../src/indexer/walk/walker";
import { expectGolden } from "../_helpers/golden";

/**
 * The live per-type placement specs, keyed by type — reconstructed from the
 * `asset-placement` leaf (chunk-3 removed the old ambient `ASSET_SPECS` map).
 * `spec.toAssetPath`/`spec.stashDir` are the exact placement primitives this
 * golden pins, identical to the prior global.
 */
const ASSET_SPECS: Record<string, AssetSpec> = {};
for (const t of placementTypes()) {
  const s = placementSpecFor(t);
  if (s) ASSET_SPECS[t] = s;
}

const STASH_ROOT = path.resolve(__dirname, "../fixtures/stashes/all-types");
const RECOGNITION_GOLDEN_PATH = "tests/fixtures/goldens/recognition/all-types.json";
const PLACEMENT_GOLDEN_PATH = "tests/fixtures/goldens/placement/all-types.json";
const HEAD_SHA = "ff7ee5975e915c11d3799cdf5454c8bc494a304b";

/** Expected `{relPath: type}` per the chunk-0b anchors.md B.1 producer table. */
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

/** Recursively list every asset FileContext in the all-types stash, MANIFEST.json excluded. */
function allTypesFileContexts() {
  return walkStashFlat(STASH_ROOT).filter((ctx) => ctx.relPath !== "MANIFEST.json");
}

function relFromStash(absPath: string): string {
  return path.relative(STASH_ROOT, absPath).split(path.sep).join("/");
}

// ── 1. Recognition assertions (WI-0b.3a, pre-capture sanity) ───────────────

describe("recognition parity: all 14 all-types fixture assets classify as documented (WI-0b.3a)", () => {
  test("every fixture file (except MANIFEST.json) recognizes as its documented type", async () => {
    const contexts = allTypesFileContexts();
    // 14 assets: 13 types (wiki retired in chunk 4) + the extra workflow-program-yaml renderer form.
    expect(contexts.length).toBe(14);

    for (const ctx of contexts) {
      const expectedType = EXPECTED_TYPE_BY_REL_PATH[ctx.relPath];
      expect(expectedType, `no expected type registered for ${ctx.relPath}`).toBeDefined();
      const result = recognizeMatch(ctx);
      expect(result, `runMatchers returned null for ${ctx.relPath}`).not.toBeNull();
      expect(result?.type).toBe(expectedType);
    }
  });

  test("the two workflow renderer forms resolve to distinct renderers", async () => {
    const contexts = allTypesFileContexts();
    const md = contexts.find((c) => c.relPath === "workflows/all-types-workflow.md");
    const yaml = contexts.find((c) => c.relPath === "workflows/all-types-workflow-program.yaml");
    expect(md).toBeDefined();
    expect(yaml).toBeDefined();
    if (!md || !yaml) throw new Error("unreachable: asserted defined above");
    const mdResult = recognizeMatch(md);
    const yamlResult = recognizeMatch(yaml);
    expect(mdResult?.renderer).toBe("workflow-md");
    expect(yamlResult?.renderer).toBe("workflow-program-yaml");
  });
});

// ── 2. Placement assertions (WI-0b.3b, pre-capture sanity) ─────────────────

describe("placement parity: toAssetPath round-trips onto the real all-types fixture layout (WI-0b.3b)", () => {
  test("every type's canonical name places at exactly the fixture's real on-disk path", () => {
    const roundTrips: Array<[type: string, name: string, expectedRelPath: string]> = [
      ["skill", "all-types-skill", "skills/all-types-skill/SKILL.md"],
      ["command", "all-types-command", "commands/all-types-command.md"],
      ["agent", "all-types-agent", "agents/all-types-agent.md"],
      ["knowledge", "all-types-knowledge", "knowledge/all-types-knowledge.md"],
      ["workflow", "all-types-workflow", "workflows/all-types-workflow.md"],
      ["script", "all-types-script.sh", "scripts/all-types-script.sh"],
      ["memory", "all-types-memory", "memories/all-types-memory.md"],
      ["env", "all-types-env", "env/all-types-env.env"],
      ["secret", "all-types-secret", "secrets/all-types-secret"],
      ["lesson", "all-types-lesson", "lessons/all-types-lesson.md"],
      ["task", "all-types-task", "tasks/all-types-task.yml"],
      ["session", "all-types-harness/all-types-session", "sessions/all-types-harness/all-types-session.md"],
      ["fact", "all-types-fact", "facts/all-types-fact.md"],
    ];
    for (const [type, name, expectedRelPath] of roundTrips) {
      const spec = ASSET_SPECS[type];
      const typeRoot = path.join(STASH_ROOT, spec.stashDir);
      const assetPath = spec.toAssetPath(typeRoot, name);
      expect(relFromStash(assetPath), `type ${type}`).toBe(expectedRelPath);
    }
  });

  test("workflow toAssetPath probes candidates in .md/.yaml/.yml priority order and finds the real .yaml-only fixture", () => {
    const spec = ASSET_SPECS.workflow;
    const typeRoot = path.join(STASH_ROOT, spec.stashDir);
    // all-types-workflow-program.yaml has no .md sibling with the same stem —
    // the probe must skip the (non-existent) .md candidate and hit .yaml.
    const assetPath = spec.toAssetPath(typeRoot, "all-types-workflow-program");
    expect(relFromStash(assetPath)).toBe("workflows/all-types-workflow-program.yaml");
  });

  test("workflow toAssetPath falls back to the default .md path when no candidate exists", () => {
    const spec = ASSET_SPECS.workflow;
    const typeRoot = path.join(STASH_ROOT, spec.stashDir);
    const assetPath = spec.toAssetPath(typeRoot, "totally-nonexistent-workflow");
    expect(relFromStash(assetPath)).toBe("workflows/totally-nonexistent-workflow.md");
  });

  test('env toAssetPath maps the "default" name to the bare .env file', () => {
    const spec = ASSET_SPECS.env;
    const typeRoot = path.join(STASH_ROOT, spec.stashDir);
    const assetPath = spec.toAssetPath(typeRoot, "default");
    expect(relFromStash(assetPath)).toBe("env/.env");
  });
});

// ── 3. Golden fixture capture ────────────────────────────────────────────────
//
// Re-derives both goldens independently of the assertion blocks above so
// capture never depends on bun:test's within-file execution order (mirrors
// tests/commands/goldens-mv-txn.test.ts / goldens-merge-plans.test.ts).

describe("golden fixture: recognition + placement parity (WI-0b.3a/b)", () => {
  test("golden fixture: recognition/all-types.json", async () => {
    const contexts = allTypesFileContexts();
    const byRelPath: Record<string, unknown> = {};
    for (const ctx of contexts) {
      byRelPath[ctx.relPath] = recognizeMatch(ctx);
    }

    expectGolden(RECOGNITION_GOLDEN_PATH, {
      scenario:
        "runMatchers(buildFileContext(...)) recognition result for every asset in tests/fixtures/stashes/all-types/ (WI-0b.3a, all 14 ASSET_SPECS_INTERNAL types + the workflow-program-yaml renderer form)",
      capturedAtHead: HEAD_SHA,
      notes: [
        "Keyed by stash-relative POSIX relPath (never an absolute path). Walked via walkStashFlat, the same " +
          "git-ls-files-based walker the real indexer uses; MANIFEST.json (fixture metadata, not an asset) is " +
          "excluded. Values are the raw MatchResult ({type, specificity, renderer, meta?}) runMatchers returns, or " +
          "null if no matcher claims the file (does not occur for any file in this fixture).",
        "FROZEN behavior-parity oracle (D0b-1/D0b-3): Chunk 2's format adapters must reproduce this classification " +
          "byte-for-byte. anchors.md Section B.3 confirms zero prior recognition golden coverage existed before " +
          "this capture -- greenfield, not a re-baseline.",
      ],
      byRelPath,
    });
  });

  test("golden fixture: placement/all-types.json", () => {
    const byType: Record<string, unknown> = {};
    // Per-type canonical name -> path, using the SAME name the all-types
    // fixture places on disk (a placement round-trip against real bytes).
    const namesByType: Record<string, string> = {
      skill: "all-types-skill",
      command: "all-types-command",
      agent: "all-types-agent",
      knowledge: "all-types-knowledge",
      workflow: "all-types-workflow",
      script: "all-types-script.sh",
      memory: "all-types-memory",
      env: "all-types-env",
      secret: "all-types-secret",
      lesson: "all-types-lesson",
      task: "all-types-task",
      session: "all-types-harness/all-types-session",
      fact: "all-types-fact",
    };
    for (const [type, name] of Object.entries(namesByType)) {
      const spec = ASSET_SPECS[type];
      const typeRoot = path.join(STASH_ROOT, spec.stashDir);
      byType[type] = {
        stashDir: spec.stashDir,
        name,
        assetPath: relFromStash(spec.toAssetPath(typeRoot, name)),
      };
    }

    const workflowSpec = ASSET_SPECS.workflow;
    const workflowTypeRoot = path.join(STASH_ROOT, workflowSpec.stashDir);
    const envSpec = ASSET_SPECS.env;
    const envTypeRoot = path.join(STASH_ROOT, envSpec.stashDir);
    const taskSpec = ASSET_SPECS.task;
    const taskTypeRoot = path.join(STASH_ROOT, taskSpec.stashDir);
    const commandSpec = ASSET_SPECS.command;
    const commandTypeRoot = path.join(STASH_ROOT, commandSpec.stashDir);
    const secretSpec = ASSET_SPECS.secret;
    const secretTypeRoot = path.join(STASH_ROOT, secretSpec.stashDir);

    const edgeCases = {
      envDefaultAlias: {
        type: "env",
        name: "default",
        assetPath: relFromStash(envSpec.toAssetPath(envTypeRoot, "default")),
      },
      envAlreadySuffixedNameIsIdempotent: {
        type: "env",
        name: "all-types-env.env",
        assetPath: relFromStash(envSpec.toAssetPath(envTypeRoot, "all-types-env.env")),
      },
      workflowExplicitExtensionSkipsProbe: {
        type: "workflow",
        name: "totally-nonexistent.yaml",
        assetPath: relFromStash(workflowSpec.toAssetPath(workflowTypeRoot, "totally-nonexistent.yaml")),
      },
      workflowProbeFallbackToMdWhenNoCandidateExists: {
        type: "workflow",
        name: "totally-nonexistent-workflow",
        assetPath: relFromStash(workflowSpec.toAssetPath(workflowTypeRoot, "totally-nonexistent-workflow")),
      },
      workflowProbeFindsYamlOnlyCandidateBeforeDefaultingToMd: {
        type: "workflow",
        name: "all-types-workflow-program",
        assetPath: relFromStash(workflowSpec.toAssetPath(workflowTypeRoot, "all-types-workflow-program")),
      },
      taskAlreadySuffixedNameIsIdempotent: {
        type: "task",
        name: "all-types-task.yml",
        assetPath: relFromStash(taskSpec.toAssetPath(taskTypeRoot, "all-types-task.yml")),
      },
      markdownSpecAlreadySuffixedNameIsIdempotent: {
        type: "command",
        name: "all-types-command.md",
        assetPath: relFromStash(commandSpec.toAssetPath(commandTypeRoot, "all-types-command.md")),
      },
      secretNestedNameIsIdentityJoin: {
        type: "secret",
        name: "team/deploy.key",
        assetPath: relFromStash(secretSpec.toAssetPath(secretTypeRoot, "team/deploy.key")),
      },
    };

    expectGolden(PLACEMENT_GOLDEN_PATH, {
      scenario:
        "ASSET_SPECS[type].toAssetPath(typeRoot, name) placement for every ASSET_SPECS_INTERNAL type (WI-0b.3b), round-tripped against the real tests/fixtures/stashes/all-types/ fixture layout plus documented edge-case branches",
      capturedAtHead: HEAD_SHA,
      notes: [
        "byType uses the SAME canonical name the all-types fixture already places on disk, so assetPath is a " +
          "placement round-trip against real committed fixture bytes, not a synthetic path. typeRoot is always " +
          "computed under the real all-types stash root (never a fabricated/nonexistent absolute path) so the " +
          "workflow spec's fs.existsSync probe observes real files instead of depending on process.cwd().",
        "edgeCases pins branches that byType's round-trip names don't exercise: the env \"default\" alias (bare " +
          ".env), the already-suffixed-name idempotent alias shared by env/task/markdownSpec-family toAssetPath " +
          "implementations, the workflow multi-extension fs.existsSync probe's explicit-extension short-circuit " +
          "(skips the probe entirely), its no-candidate-exists fallback to .md, and its probe finding a real " +
          "YAML-only candidate (all-types-workflow-program.yaml has no .md sibling) before ever reaching the .md " +
          "default -- and a nested secret name (identity join, no extension logic).",
        "All paths are stash-relative POSIX strings (never absolute) -- hard constraint per the WI-0b.3 brief.",
        "FROZEN behavior-parity oracle (D0b-1/D0b-3): Chunk 2's format adapters must reproduce this placement " +
          "mapping byte-for-byte.",
      ],
      byType,
      edgeCases,
    });
  });
});
