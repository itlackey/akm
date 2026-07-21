// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-1.4 gate mechanization (decision D1-6; chunk-1 anchors.md §E.2) — the
 * frozen `src/migrate/legacy/legacy-layout.ts` copy.
 *
 * Three groups:
 *
 *   1. **Self-containment** (the #1 trap, D1-6/anchors.md §D.3) — reads the
 *      file's raw source text and asserts NO `import ... from "..."` line
 *      references any of the 9 forbidden live modules, and (stronger) that
 *      it has NO relative (`./`/`../`) import at all — the file's only
 *      dependencies are Node builtins.
 *   2. **Shape/existence** (gate 2's mechanization, anchors.md §E.2's own
 *      recommendation) — all 14 type keys, the 3 extension constants, the
 *      ref-grammar functions, and origin resolution are present.
 *   3. **Faithfulness** — the frozen copy reproduces the SAME
 *      recognition/placement/canonical-name/ref-parse/origin-resolution
 *      results as the LIVE modules at this HEAD, cross-checked against (a)
 *      the live modules directly (imported here, in the TEST — self-
 *      containment is a constraint on `legacy-layout.ts` itself, not on
 *      code that verifies it) and (b) the WI-0b.3 frozen goldens
 *      (`tests/fixtures/goldens/minting/oracle.json`,
 *      `tests/fixtures/goldens/placement/all-types.json`).
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { isDerivedMemory, resolveParentRef } from "../../../src/commands/improve/memory/derived-ref";
// ── Live modules — imported ONLY here, to prove faithfulness by direct
// comparison. legacy-layout.ts itself must never import these. ────────────
import {
  type AssetSpec,
  deriveCanonicalAssetNameFromStashRoot,
  placementSpecFor,
  placementTypes,
} from "../../../src/core/asset/asset-placement";
import { makeAssetRef, parseAssetRef } from "../../../src/migrate/legacy-ref-grammar";

/** The live per-type placement specs, keyed by type (chunk-3 replaced the ambient `ASSET_SPECS` map). */
const ASSET_SPECS: Record<string, AssetSpec> = {};
for (const t of placementTypes()) {
  const s = placementSpecFor(t);
  if (s) ASSET_SPECS[t] = s;
}

// ── Frozen copy under test ──────────────────────────────────────────────────
import {
  ASSET_SPECS_INTERNAL as FROZEN_ASSET_SPECS_INTERNAL,
  DERIVED_SUFFIX as FROZEN_DERIVED_SUFFIX,
  SCRIPT_EXTENSIONS as FROZEN_SCRIPT_EXTENSIONS,
  TYPE_DIRS as FROZEN_TYPE_DIRS,
  WORKFLOW_EXTENSIONS as FROZEN_WORKFLOW_EXTENSIONS,
  canonicalizeWorkflowName as frozenCanonicalizeWorkflowName,
  deriveCanonicalAssetNameFromStashRoot as frozenDeriveCanonicalAssetNameFromStashRoot,
  isDerivedMemory as frozenIsDerivedMemory,
  isRemoteOrigin as frozenIsRemoteOrigin,
  makeAssetRef as frozenMakeAssetRef,
  parseAssetRef as frozenParseAssetRef,
  parseRegistryRef as frozenParseRegistryRef,
  resolveAssetPathFromName as frozenResolveAssetPathFromName,
  resolveParentRef as frozenResolveParentRef,
  resolveSourcesForOrigin as frozenResolveSourcesForOrigin,
  LEGACY_TYPE_KEYS,
  type LegacySource,
} from "../../../src/migrate/legacy/legacy-layout";
import { isRemoteOrigin, resolveSourcesForOrigin } from "../../../src/registry/origin-resolve";
import { parseRegistryRef } from "../../../src/registry/resolve";
import { loadGolden } from "../../_helpers/golden";

const LEGACY_LAYOUT_PATH = path.join(import.meta.dir, "../../../src/migrate/legacy/legacy-layout.ts");
const STASH_ROOT = path.resolve(import.meta.dir, "../../fixtures/stashes/all-types");

// ═══════════════════════════════════════════════════════════════════════════
// 1. Self-containment (D1-6, the #1 trap)
// ═══════════════════════════════════════════════════════════════════════════

describe("legacy-layout.ts — self-containment (D1-6)", () => {
  const source = fs.readFileSync(LEGACY_LAYOUT_PATH, "utf8");
  const importLines = source.split("\n").filter((line) => /^\s*import\b.*\bfrom\s+["']/.test(line));

  test("the file exists at the expected migrate/legacy path", () => {
    expect(fs.existsSync(LEGACY_LAYOUT_PATH)).toBe(true);
  });

  test("has at least one import line (sanity: the regex below isn't vacuously true)", () => {
    expect(importLines.length).toBeGreaterThan(0);
  });

  // The 9 forbidden modules named in the WI-1.4 brief, verbatim.
  const FORBIDDEN_SPECIFIERS = [
    "../../core/common",
    "../../core/asset/asset-spec",
    "../../core/asset/asset-ref",
    "../../core/asset/asset-registry",
    "../../output/renderers",
    "../../core/recognition-util",
    "../../commands/improve/memory/derived-ref",
    "../../registry/origin-resolve",
    "../../registry/resolve",
  ];

  for (const forbidden of FORBIDDEN_SPECIFIERS) {
    test(`does not import from the forbidden module "${forbidden}"`, () => {
      const hit = importLines.find((line) => line.includes(`"${forbidden}"`) || line.includes(`'${forbidden}'`));
      expect(hit, `found forbidden import: ${hit}`).toBeUndefined();
    });
  }

  test("no import line references ANY relative (./ or ../) specifier — stronger than the 9-item list", () => {
    const relativeImports = importLines.filter((line) => /from\s+["']\.\.?\//.test(line));
    expect(relativeImports).toEqual([]);
  });

  test("every import is a bare node: builtin specifier (fs/os/path/url) — no bare package imports either", () => {
    const specifiers = importLines.map((line) => {
      const m = line.match(/from\s+["']([^"']+)["']/);
      return m?.[1];
    });
    for (const spec of specifiers) {
      expect(spec, `unexpected import specifier: ${spec}`).toMatch(/^node:/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Shape / existence (gate 2 mechanization, anchors.md §E.2)
// ═══════════════════════════════════════════════════════════════════════════

describe("legacy-layout.ts — shape/existence (gate 2 mechanization)", () => {
  test("LEGACY_TYPE_KEYS is the closed 14-type snapshot", () => {
    expect(LEGACY_TYPE_KEYS.length).toBe(14);
    expect(new Set(LEGACY_TYPE_KEYS).size).toBe(14);
  });

  test("ASSET_SPECS_INTERNAL carries all 14 type keys, each with the narrowed recognition/placement surface", () => {
    const keys = Object.keys(FROZEN_ASSET_SPECS_INTERNAL);
    expect(keys.sort()).toEqual([...LEGACY_TYPE_KEYS].sort());
    for (const key of keys) {
      const spec = FROZEN_ASSET_SPECS_INTERNAL[key];
      expect(typeof spec.stashDir, `${key}.stashDir`).toBe("string");
      expect(typeof spec.isRelevantFile, `${key}.isRelevantFile`).toBe("function");
      expect(typeof spec.toCanonicalName, `${key}.toCanonicalName`).toBe("function");
      expect(typeof spec.toAssetPath, `${key}.toAssetPath`).toBe("function");
      // D1-6b: rendererName/actionBuilder are DROPPED — the migrator never renders.
      expect(Object.hasOwn(spec, "rendererName"), `${key}.rendererName should be absent`).toBe(false);
      expect(Object.hasOwn(spec, "actionBuilder"), `${key}.actionBuilder should be absent`).toBe(false);
    }
  });

  test("TYPE_DIRS mirrors ASSET_SPECS_INTERNAL's stashDir per type", () => {
    for (const key of LEGACY_TYPE_KEYS) {
      expect(FROZEN_TYPE_DIRS[key]).toBe(FROZEN_ASSET_SPECS_INTERNAL[key].stashDir);
    }
  });

  test("the 3 own extension constants (D1-6c) are present with the expected shapes", () => {
    expect(FROZEN_SCRIPT_EXTENSIONS).toBeInstanceOf(Set);
    expect(FROZEN_SCRIPT_EXTENSIONS.size).toBe(16);
    expect(FROZEN_WORKFLOW_EXTENSIONS).toEqual([".md", ".yaml", ".yml"]);
    expect(typeof frozenCanonicalizeWorkflowName).toBe("function");
    expect(frozenCanonicalizeWorkflowName("foo.yaml")).toBe("foo");
    expect(FROZEN_DERIVED_SUFFIX).toBe(".derived");
  });

  test("the ref-grammar functions are present and callable", () => {
    expect(typeof frozenMakeAssetRef).toBe("function");
    expect(typeof frozenParseAssetRef).toBe("function");
    expect(typeof frozenIsDerivedMemory).toBe("function");
    expect(typeof frozenResolveParentRef).toBe("function");
    expect(frozenParseAssetRef("skill:example")).toEqual({ type: "skill", name: "example", origin: undefined });
  });

  test("origin -> source resolution is present and callable", () => {
    expect(typeof frozenResolveSourcesForOrigin).toBe("function");
    expect(typeof frozenIsRemoteOrigin).toBe("function");
    expect(typeof frozenParseRegistryRef).toBe("function");
    expect(frozenResolveSourcesForOrigin(undefined, [])).toEqual([]);
  });

  test("deriveCanonicalAssetNameFromStashRoot and resolveAssetPathFromName are present and callable", () => {
    expect(typeof frozenDeriveCanonicalAssetNameFromStashRoot).toBe("function");
    expect(typeof frozenResolveAssetPathFromName).toBe("function");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Faithfulness — frozen copy vs. LIVE modules, at this HEAD
// ═══════════════════════════════════════════════════════════════════════════

describe("legacy-layout.ts — faithfulness: toCanonicalName/toAssetPath/isRelevantFile match ASSET_SPECS live, per type", () => {
  const SAMPLE_BY_TYPE: Record<string, { fileName: string; relFile: string }> = {
    skill: { fileName: "SKILL.md", relFile: "example-skill/SKILL.md" },
    command: { fileName: "example-command.md", relFile: "example-command.md" },
    agent: { fileName: "example-agent.md", relFile: "example-agent.md" },
    knowledge: { fileName: "example-knowledge.md", relFile: "example-knowledge.md" },
    workflow: { fileName: "example-workflow.md", relFile: "example-workflow.md" },
    script: { fileName: "example-script.sh", relFile: "example-script.sh" },
    memory: { fileName: "example-memory.derived.md", relFile: "example-memory.derived.md" },
    env: { fileName: ".env", relFile: ".env" },
    secret: { fileName: "deploy.key", relFile: "team/deploy.key" },
    wiki: { fileName: "example-wiki.md", relFile: "space/example-wiki.md" },
    lesson: { fileName: "example-lesson.md", relFile: "example-lesson.md" },
    task: { fileName: "example-task.yml", relFile: "example-task.yml" },
    session: { fileName: "example-session.md", relFile: "harness-a/example-session.md" },
    fact: { fileName: "example-fact.md", relFile: "meta/example-fact.md" },
  };

  for (const type of LEGACY_TYPE_KEYS) {
    test(`${type}: isRelevantFile/toCanonicalName agree with the live ASSET_SPECS`, () => {
      // `wiki` was retired from the LIVE placement specs in chunk 4 (the wiki
      // asset-type dies), but the FROZEN legacy copy retains it by design. There
      // is no live spec to cross-check against, so assert the retirement instead.
      if (type === "wiki") {
        expect(ASSET_SPECS.wiki).toBeUndefined();
        return;
      }
      const sample = SAMPLE_BY_TYPE[type];
      const liveSpec = ASSET_SPECS[type];
      const frozenSpec = FROZEN_ASSET_SPECS_INTERNAL[type];
      expect(frozenSpec.stashDir).toBe(liveSpec.stashDir);
      expect(frozenSpec.isRelevantFile(sample.fileName)).toBe(liveSpec.isRelevantFile(sample.fileName));

      const typeRoot = "/synthetic-root";
      const filePath = `${typeRoot}/${sample.relFile}`;
      expect(frozenSpec.toCanonicalName(typeRoot, filePath)).toBe(liveSpec.toCanonicalName(typeRoot, filePath));
    });
  }

  test("toAssetPath agrees with the live ASSET_SPECS against the real all-types fixture (workflow fs probe included)", () => {
    for (const [type, name] of [
      ["skill", "all-types-skill"],
      ["command", "all-types-command"],
      ["workflow", "all-types-workflow"],
      ["workflow", "all-types-workflow-program"], // .yaml-only fixture — exercises the fs.existsSync probe
      ["workflow", "totally-nonexistent-workflow"], // no candidate — falls back to .md
      ["env", "default"],
      ["env", "all-types-env.env"], // already-suffixed idempotent alias
      ["task", "all-types-task.yml"],
      ["secret", "team/deploy.key"],
    ] as const) {
      const liveSpec = ASSET_SPECS[type];
      const frozenSpec = FROZEN_ASSET_SPECS_INTERNAL[type];
      const typeRoot = path.join(STASH_ROOT, liveSpec.stashDir);
      expect(frozenSpec.toAssetPath(typeRoot, name), `type ${type} name ${name}`).toBe(
        liveSpec.toAssetPath(typeRoot, name),
      );
    }
  });
});

describe("legacy-layout.ts — faithfulness: deriveCanonicalAssetNameFromStashRoot matches ASSET_SPECS live", () => {
  const SYNTHETIC_STASH_ROOT = "/stash";
  const CASES: Array<[type: string, relFilePath: string]> = [
    ["skill", "skills/example-skill/SKILL.md"],
    ["skill", "tools/agents/svelte-file-editor/SKILL.md"],
    ["command", "commands/example-command.md"],
    ["command", "tools/commands/example-command.md"],
    ["workflow", "workflows/example-workflow.yaml"],
    ["workflow", "installed/workflows/example-workflow.yaml"],
    ["env", "env/.env"],
    ["env", "env/staging.env"],
    ["env", "tools/env/.env"],
    ["memory", "memories/example-memory.derived.md"],
    ["secret", "secrets/team/deploy.key"],
    ["task", "tasks/example-task.yml"],
    ["session", "sessions/harness-a/example-session.md"],
    ["fact", "facts/meta/example-fact.md"],
  ];

  for (const [type, relFilePath] of CASES) {
    test(`${type}: ${relFilePath}`, () => {
      const filePath = `${SYNTHETIC_STASH_ROOT}/${relFilePath}`;
      expect(frozenDeriveCanonicalAssetNameFromStashRoot(type, SYNTHETIC_STASH_ROOT, filePath)).toBe(
        deriveCanonicalAssetNameFromStashRoot(type, SYNTHETIC_STASH_ROOT, filePath),
      );
    });
  }

  test("cross-checked against the frozen WI-0b.3 minting-oracle golden (tests/fixtures/goldens/minting/oracle.json)", () => {
    const golden = loadGolden<{
      pureFunction: Record<string, Record<string, { relFilePath: string; name: string | undefined }>>;
    }>("tests/fixtures/goldens/minting/oracle.json");

    let checked = 0;
    for (const [type, byLabel] of Object.entries(golden.pureFunction)) {
      for (const [label, { relFilePath, name }] of Object.entries(byLabel)) {
        const filePath = `${SYNTHETIC_STASH_ROOT}/${relFilePath}`;
        const got = frozenDeriveCanonicalAssetNameFromStashRoot(type, SYNTHETIC_STASH_ROOT, filePath);
        expect(got, `golden ${type}/${label}: ${relFilePath}`).toBe(name);
        checked++;
      }
    }
    // 14 types x >=2 branches (canonical + fallback) each = at least 28 cases.
    expect(checked).toBeGreaterThanOrEqual(28);
  });

  test("cross-checked against the frozen WI-0b.3 placement golden (tests/fixtures/goldens/placement/all-types.json)", () => {
    const golden = loadGolden<{
      byType: Record<string, { assetPath: string; name: string; stashDir: string }>;
    }>("tests/fixtures/goldens/placement/all-types.json");

    let checked = 0;
    for (const [type, entry] of Object.entries(golden.byType)) {
      const typeRoot = path.join(STASH_ROOT, entry.stashDir);
      const gotPath = frozenResolveAssetPathFromName(type, typeRoot, entry.name);
      const relGot = path.relative(STASH_ROOT, gotPath).split(path.sep).join("/");
      expect(relGot, `golden byType.${type}`).toBe(entry.assetPath);
      checked++;
    }
    // 13 golden byType entries (wiki retired from the live placement in chunk 4;
    // the frozen legacy copy still carries its wiki spec by design, so it is
    // simply no longer cross-checked here).
    expect(checked).toBe(13);
  });
});

describe("legacy-layout.ts — faithfulness: parseAssetRef/makeAssetRef match asset-ref.ts live", () => {
  const REF_CASES = [
    "skill:example",
    "script:deploy.sh",
    "npm:@scope/pkg//script:deploy.sh",
    "local//skill:code-review",
    "owner/repo//script:db/migrate/run.sh",
    "environment:staging", // TYPE_ALIASES spelling
    "memory:example-memory.derived",
    "  memory:padded  ", // whitespace trim
  ];

  for (const ref of REF_CASES) {
    test(`parseAssetRef("${ref}") agrees with the live parser`, () => {
      // Compared as (live, frozen) rather than (frozen, live): chunk 1.5
      // widened the live `AssetRef.type` to a plain `string` (open token),
      // while the frozen snapshot keeps its own closed `LegacyAssetType`
      // literal union — a value typed to the closed union is assignable to
      // the open `string` field, not the other way around, so `expected`
      // must be the frozen (narrower-typed) side for this to type-check.
      expect(parseAssetRef(ref)).toEqual(frozenParseAssetRef(ref));
    });
  }

  test("makeAssetRef round-trips identically to the live serializer", () => {
    expect(frozenMakeAssetRef("script", "deploy.sh")).toBe(makeAssetRef("script", "deploy.sh"));
    expect(frozenMakeAssetRef("script", "deploy.sh", "npm:@scope/pkg")).toBe(
      makeAssetRef("script", "deploy.sh", "npm:@scope/pkg"),
    );
    expect(frozenMakeAssetRef("skill", "code-review", "local")).toBe(makeAssetRef("skill", "code-review", "local"));
  });

  // "notatype:example" deliberately excluded from this list since chunk 1.5
  // (below): the live parser now accepts unknown types as an open token,
  // while the frozen snapshot keeps rejecting them (it is a permanent
  // pre-1.5 closed-union snapshot, by design — see the file header). `vault`
  // stays in both lists: it is a deny-listed deprecated type in the LIVE
  // parser too (D1.5-6), not merely an unknown one, so both still throw with
  // the same migration-hint message.
  const INVALID_REF_CASES = ["", "vault:credentials", "skill:../escape", "skill:/absolute", "skill:"];

  for (const ref of INVALID_REF_CASES) {
    test(`parseAssetRef("${ref}") throws in BOTH the frozen copy and the live parser`, () => {
      let liveThrew = false;
      let liveMessage = "";
      try {
        parseAssetRef(ref);
      } catch (error) {
        liveThrew = true;
        liveMessage = error instanceof Error ? error.message : String(error);
      }
      expect(liveThrew, `live parseAssetRef("${ref}") did not throw`).toBe(true);

      let frozenThrew = false;
      let frozenMessage = "";
      try {
        frozenParseAssetRef(ref);
      } catch (error) {
        frozenThrew = true;
        frozenMessage = error instanceof Error ? error.message : String(error);
      }
      expect(frozenThrew, `frozen parseAssetRef("${ref}") did not throw`).toBe(true);
      expect(frozenMessage).toBe(liveMessage);
    });
  }

  test('parseAssetRef("notatype:example") deliberately DIVERGES post-chunk-1.5: frozen (closed) still throws, live (open token) now accepts it', () => {
    expect(() => frozenParseAssetRef("notatype:example")).toThrow("Invalid asset type");
    expect(parseAssetRef("notatype:example")).toEqual({ type: "notatype", name: "example", origin: undefined });
  });
});

describe("legacy-layout.ts — faithfulness: isDerivedMemory/resolveParentRef match derived-ref.ts live", () => {
  const CASES: Array<{ name: string; frontmatter: Record<string, unknown> }> = [
    { name: "example-memory.derived", frontmatter: {} },
    { name: "example-memory", frontmatter: { inferred: true } },
    { name: "example-memory", frontmatter: {} },
    { name: "example-memory.derived", frontmatter: { source: "memory:parent" } },
    { name: "example-memory.derived", frontmatter: { source: " team//memory:parent " } },
    { name: "example-memory.derived", frontmatter: { derivedFrom: "parent-name" } },
    { name: "plain-memory", frontmatter: { source: "not-a-memory-ref" } },
  ];

  for (const { name, frontmatter } of CASES) {
    test(`name=${JSON.stringify(name)} frontmatter=${JSON.stringify(frontmatter)}`, () => {
      expect(frozenIsDerivedMemory(name, frontmatter)).toBe(isDerivedMemory(name, frontmatter));
      // DELIBERATE POST-FLIP DIVERGENCE (Group-C item 2, 2026-07-21): the live
      // reader's normalized OUTPUT moved to the 0.9.0 `memories/<name>`
      // conceptId; the frozen copy keeps the pre-0.9.0 `memory:<name>`
      // spelling the migrator-era content actually carries. Parent-name
      // EXTRACTION must stay identical; only the output grammar differs.
      const frozen = frozenResolveParentRef(name, frontmatter);
      const live = resolveParentRef(name, frontmatter);
      if (frozen === undefined || live === undefined) {
        expect(live).toBe(frozen as undefined);
      } else {
        expect(frozen.startsWith("memory:")).toBe(true);
        expect(live).toBe(`memories/${frozen.slice("memory:".length)}`);
      }
    });
  }
});

describe("legacy-layout.ts — faithfulness: resolveSourcesForOrigin/isRemoteOrigin match origin-resolve.ts live", () => {
  // Structurally satisfies both the live SearchSource[] and the frozen
  // LegacySource[] — only .path/.registryId are read by either.
  const sources: Array<{ path: string; registryId?: string; writable?: boolean }> = [
    { path: "/stash/primary", writable: true },
    { path: "/stash/installed/foo", registryId: "npm:@scope/pkg" },
    { path: "/stash/installed/bar", registryId: "github:owner/repo" },
  ];

  const ORIGIN_CASES = [
    undefined,
    "local",
    "npm:@scope/pkg",
    "@scope/pkg",
    "owner/repo",
    "/stash/installed/bar",
    "npm:totally-unknown-pkg",
  ];

  for (const origin of ORIGIN_CASES) {
    test(`origin=${JSON.stringify(origin)}`, () => {
      const liveResult = resolveSourcesForOrigin(origin, sources);
      const frozenResult = frozenResolveSourcesForOrigin(origin, sources as LegacySource[]);
      expect(frozenResult.map((s) => s.path)).toEqual(liveResult.map((s) => s.path));
    });
  }

  for (const origin of ["local", "npm:@scope/pkg", "npm:totally-unknown-pkg", "/stash/installed/bar"]) {
    test(`isRemoteOrigin("${origin}") agrees with the live check`, () => {
      expect(frozenIsRemoteOrigin(origin, sources as LegacySource[])).toBe(isRemoteOrigin(origin, sources));
    });
  }
});

describe("legacy-layout.ts — faithfulness: parseRegistryRef's pure ID-deriving core matches resolve.ts live", () => {
  // Only the PURE, non-network branches — the frozen copy documents dropping
  // the live module's network-fetching artifact resolvers (see the file's
  // "Origin -> source resolution" header comment).
  const REF_CASES = ["npm:@scope/pkg", "npm:left-pad@1.3.0", "github:owner/repo", "github:owner/repo#v1"];

  for (const ref of REF_CASES) {
    test(`parseRegistryRef("${ref}").{source,id} agrees with the live parser`, () => {
      const live = parseRegistryRef(ref);
      const frozen = frozenParseRegistryRef(ref);
      expect(frozen.source).toBe(live.source);
      expect(frozen.id).toBe(live.id);
      expect(frozen.ref).toBe(live.ref);
    });
  }

  test(
    'a bare "owner/repo" shorthand is path-LIKE (contains "/") and throws identically in both, ' +
      "since it is resolved as an explicit local path relative to cwd before ever reaching github-shorthand parsing",
    () => {
      const ref = "owner/repo";
      expect(() => parseRegistryRef(ref)).toThrow();
      expect(() => frozenParseRegistryRef(ref)).toThrow();
    },
  );

  test("an existing local directory ref parses to the same {source,id} in both", () => {
    const dir = STASH_ROOT; // a real, committed directory — safe to statSync
    const live = parseRegistryRef(dir);
    const frozen = frozenParseRegistryRef(dir);
    expect(frozen.source).toBe(live.source);
    expect(frozen.id).toBe(live.id);
  });

  test("a search-result-ID-shaped ref throws in both", () => {
    const ref = "skills-sh:org/skills/name";
    expect(() => parseRegistryRef(ref)).toThrow();
    expect(() => frozenParseRegistryRef(ref)).toThrow();
  });

  test("a nonexistent explicit local path throws in both", () => {
    const ref = path.join(STASH_ROOT, "definitely-does-not-exist-xyz");
    expect(() => parseRegistryRef(ref)).toThrow();
    expect(() => frozenParseRegistryRef(ref)).toThrow();
  });
});
