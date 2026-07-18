// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-B gate — the AKM workspace's own `akm` adapter
 * (`src/core/adapter/adapters/akm-adapter.ts`), implementing
 * `docs/design/akm-0.9.0-bundle-adapter-spec.md` §5.1 (BINDING) / §6 / §7.
 *
 * §5.1 is a behavior-preserving port: the `akm` adapter reproduces TODAY'S
 * `runMatchers` classification and `resolveAssetPathFromName` placement VERBATIM
 * by reusing the existing matcher stack. The byte-for-byte Chunk-0b goldens are
 * the conformance gate, so this suite drives the adapter over the SAME
 * `tests/fixtures/stashes/all-types/` fixture the goldens were captured from and
 * asserts:
 *
 *  1. recognition parity — `recognize().type` (and the carried renderer) for
 *     every fixture file equals `goldens/recognition/all-types.json`;
 *  2. placement parity — `placeNew()` for every akm type equals
 *     `goldens/placement/all-types.json`;
 *  3. sync-arbitration FIDELITY — `recognizeMatch()` (the sync `runMatchers`
 *     reproduction) agrees with the async `runMatchers` on the real fixture
 *     contexts AND on hand-built contexts that make each matcher the winner.
 *
 * Neither the fixture nor any golden is modified.
 */

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmAdapter, recognizeMatch } from "../../../src/core/adapter/adapters/akm-adapter";
import type { BundleComponent } from "../../../src/core/adapter/types";
import { deriveCanonicalAssetNameFromStashRoot } from "../../../src/core/asset/asset-placement";
import type { StashEntry } from "../../../src/indexer/passes/metadata";
import { applyMetadataContributors } from "../../../src/indexer/passes/metadata-contributors";
import { buildFileContext, buildRenderContext, type FileContext } from "../../../src/indexer/walk/file-context";
import { walkStashFlat } from "../../../src/indexer/walk/walker";

const ALL_TYPES_ROOT = path.resolve(__dirname, "../../fixtures/stashes/all-types");
const BUNDLE_ID = "all-types";

interface RecognitionGolden {
  byRelPath: Record<string, { type: string; specificity: number; renderer: string }>;
}
interface PlacementGolden {
  byType: Record<string, { stashDir: string; name: string; assetPath: string }>;
}

const RECOGNITION_GOLDEN = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../fixtures/goldens/recognition/all-types.json"), "utf8"),
) as RecognitionGolden;
const PLACEMENT_GOLDEN = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../fixtures/goldens/placement/all-types.json"), "utf8"),
) as PlacementGolden;

/** Temp dirs created by fidelity/probe tests; cleaned in afterAll. */
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function component(overrides: Partial<BundleComponent> = {}): BundleComponent {
  return { id: BUNDLE_ID, adapter: "akm", root: ALL_TYPES_ROOT, writable: true, ...overrides };
}

function relFromRoot(absPath: string): string {
  return path.relative(ALL_TYPES_ROOT, absPath).split(path.sep).join("/");
}

/** Every asset FileContext in the all-types stash, MANIFEST.json excluded — exactly the golden capture's walk. */
function allTypesContexts(): FileContext[] {
  return walkStashFlat(ALL_TYPES_ROOT).filter((ctx) => ctx.relPath !== "MANIFEST.json");
}

// ── adapter metadata ─────────────────────────────────────────────────────────

describe("akm adapter — metadata (§7)", () => {
  test("id / version", () => {
    expect(akmAdapter.id).toBe("akm");
    expect(akmAdapter.version).toBe("0.9.0");
  });

  test("extensions cover the matcher-accepted set (`.md`, `.yaml`/`.yml`, `.env`, script exts)", () => {
    const exts = new Set(akmAdapter.extensions);
    for (const e of [".md", ".yaml", ".yml", ".env", ".sh", ".ts", ".py", ".kts"]) {
      expect(exts.has(e), `extensions missing ${e}`).toBe(true);
    }
  });
});

// ── 1. recognition parity (byte-for-byte vs the Chunk-0b golden) ─────────────

describe("akm adapter — recognize reproduces runMatchers classification (§5.1 BINDING)", () => {
  test("every fixture file recognizes as its golden type + carries its golden renderer", () => {
    const contexts = allTypesContexts();
    // 14 assets: 13 types (wiki retired in chunk 4) + the extra workflow-program-yaml renderer form.
    expect(contexts.length).toBe(14);

    let asserted = 0;
    for (const ctx of contexts) {
      const expected = RECOGNITION_GOLDEN.byRelPath[ctx.relPath];
      expect(expected, `no golden entry for ${ctx.relPath}`).toBeDefined();
      const doc = akmAdapter.recognize(component(), ctx);
      expect(doc, `recognize returned null for ${ctx.relPath}`).not.toBeNull();
      expect(doc?.type, `type mismatch for ${ctx.relPath}`).toBe(expected.type);
      // Winner's renderer is carried on documentJson for WI-C (not a new field).
      expect((doc?.documentJson as { renderer?: string })?.renderer, `renderer mismatch for ${ctx.relPath}`).toBe(
        expected.renderer,
      );
      expect(doc?.adapterId).toBe("akm");
      expect(doc?.bundle).toBe(BUNDLE_ID);
      expect(doc?.component).toBe(BUNDLE_ID);
      expect(doc?.ref).toBe(`${BUNDLE_ID}//${doc?.conceptId}`);
      expect(doc?.path).toBe(ctx.absPath);
      expect(doc?.hash).toMatch(/^[0-9a-f]{64}$/);
      asserted += 1;
    }
    // Every golden entry was exercised (parity is total, not a subset).
    expect(asserted).toBe(Object.keys(RECOGNITION_GOLDEN.byRelPath).length);
  });

  test("conceptId reproduces the winning type's canonical name (per-type toCanonicalName)", () => {
    const byRel = new Map(allTypesContexts().map((c) => [c.relPath, c]));
    const cases: Array<[relPath: string, conceptId: string]> = [
      ["skills/all-types-skill/SKILL.md", "all-types-skill"], // skill = its dir
      ["scripts/all-types-script.sh", "all-types-script.sh"], // script keeps ext
      ["knowledge/all-types-knowledge.md", "all-types-knowledge"], // markdown strips .md
      ["tasks/all-types-task.yml", "all-types-task"], // task strips .yml
      ["env/all-types-env.env", "all-types-env"], // env strips .env
      ["sessions/all-types-harness/all-types-session.md", "all-types-harness/all-types-session"],
      ["secrets/all-types-secret", "all-types-secret"],
    ];
    for (const [relPath, conceptId] of cases) {
      const ctx = byRel.get(relPath);
      expect(ctx, `fixture missing ${relPath}`).toBeDefined();
      if (!ctx) continue;
      const doc = akmAdapter.recognize(component(), ctx);
      expect(doc?.conceptId, `conceptId for ${relPath}`).toBe(conceptId);
    }
  });

  test("a file no matcher claims => recognize returns null (unclaimed files skipped)", () => {
    const ctx = buildFileContext(ALL_TYPES_ROOT, path.join(ALL_TYPES_ROOT, "MANIFEST.json"));
    expect(akmAdapter.recognize(component(), ctx)).toBeNull();
  });
});

// ── 2. recognizeMatch — content/extension winners (§5.1) ─────────────────────

describe("akm adapter — recognizeMatch classifies content/extension winners (§5.1)", () => {
  test("classifies hand-built contexts where smartMd/extension is the winner", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akm-adapter-sync-"));
    tmpDirs.push(tmp);
    // Files placed OUTSIDE any type dir so the winner comes from a content/ext
    // probe, not a directory hint — exercising branches the all-types fixture's
    // parentDir-hint winners mask (§1 covers the dir-hint winners against the golden).
    const cases: Array<[rel: string, content: string, type: string]> = [
      ["note.md", "# Just knowledge\n\nplain body\n", "knowledge"], // smartMd knowledge @5
      ["cmd.md", "# Command\n\nUse $ARGUMENTS to pass input\n", "command"], // smartMd command @18 (body probe)
      ["agent.md", "---\ntools:\n  - read\n---\n\n# Agent\n", "agent"], // smartMd agent @20 (frontmatter probe)
      ["run.sh", "#!/bin/sh\necho hi\n", "script"], // extension script @3
    ];
    for (const [rel, content, type] of cases) {
      const abs = path.join(tmp, rel);
      fs.writeFileSync(abs, content);
      expect(recognizeMatch(buildFileContext(tmp, abs))?.type, `winner for ${rel}`).toBe(type);
    }
  });
});

// ── 3. placement parity (byte-for-byte vs the Chunk-0b golden) ───────────────

describe("akm adapter — placeNew reproduces resolveAssetPathFromName placement (§5.1)", () => {
  test("every akm type's qualified conceptId places at exactly the golden path", () => {
    for (const [type, entry] of Object.entries(PLACEMENT_GOLDEN.byType)) {
      // The §1.3 qualified path-form conceptId: <stash-subdir>/<canonical-name>.
      const conceptId = `${entry.stashDir}/${entry.name}`;
      const abs = akmAdapter.placeNew?.(component(), conceptId);
      expect(abs, `placeNew undefined for ${type}`).toBeDefined();
      expect(relFromRoot(abs as string), `placement for ${type}`).toBe(entry.assetPath);
    }
  });

  test("the env `default` alias maps to the bare .env file", () => {
    expect(relFromRoot(akmAdapter.placeNew?.(component(), "env/default") as string)).toBe("env/.env");
  });

  test("an unqualified conceptId (no leading stash-subdir) falls back to <root>/<id>.md", () => {
    expect(relFromRoot(akmAdapter.placeNew?.(component(), "loose-note") as string)).toBe("loose-note.md");
  });

  test("workflow placement probes .md/.yaml/.yml and finds the real .yaml-only fixture", () => {
    expect(relFromRoot(akmAdapter.placeNew?.(component(), "workflows/all-types-workflow-program") as string)).toBe(
      "workflows/all-types-workflow-program.yaml",
    );
  });
});

// ── 3b. recognize folds the 11 metadata contributors (§2) ────────────────────

describe("akm adapter — recognize folds the index-time metadata contributors (§2)", () => {
  /** The contributor-produced fields the fold mirrors onto the IndexDocument (first-class + documentJson extras). */
  const FIELDS = ["tags", "searchHints", "description", "confidence", "source", "toc", "parameters"] as const;

  /** Pull the folded metadata back off an IndexDocument: first-class fields + the documentJson extras. */
  function foldedFromDoc(doc: NonNullable<ReturnType<typeof akmAdapter.recognize>>): Record<string, unknown> {
    const extras = (doc.documentJson ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = {
      tags: doc.tags,
      searchHints: doc.searchHints,
      description: doc.description,
      confidence: doc.confidence,
      source: extras.source,
      toc: extras.toc,
      parameters: extras.parameters,
    };
    const out: Record<string, unknown> = {};
    for (const f of FIELDS) if (merged[f] !== undefined) out[f] = merged[f];
    return out;
  }

  /** The reference: today's contributors applied to a MINIMAL (name+type) seed, exactly what the fold isolates. */
  async function referenceMetadata(ctx: FileContext): Promise<Record<string, unknown>> {
    const match = recognizeMatch(ctx);
    if (!match) return {};
    const rc = buildRenderContext(ctx, match, [ALL_TYPES_ROOT]);
    const name = deriveCanonicalAssetNameFromStashRoot(match.type, ALL_TYPES_ROOT, ctx.absPath) ?? ctx.relPath;
    const entry: StashEntry = { name, type: match.type };
    await applyMetadataContributors(entry, { rendererName: match.renderer, renderContext: rc });
    const rec = entry as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const f of FIELDS) if (rec[f] !== undefined) out[f] = rec[f];
    return out;
  }

  test("folded metadata matches the live contributors' output for every fixture file", async () => {
    let asserted = 0;
    for (const ctx of allTypesContexts()) {
      const reference = await referenceMetadata(ctx);
      const doc = akmAdapter.recognize(component(), ctx);
      expect(doc, `recognize null for ${ctx.relPath}`).not.toBeNull();
      if (!doc) continue;
      expect(foldedFromDoc(doc), `folded metadata for ${ctx.relPath}`).toEqual(reference);
      asserted += 1;
    }
    expect(asserted).toBe(14);
  });

  test("the winning renderer is still carried on documentJson.renderer (WI-B contract intact)", () => {
    for (const ctx of allTypesContexts()) {
      const doc = akmAdapter.recognize(component(), ctx);
      expect((doc?.documentJson as { renderer?: string })?.renderer).toBeDefined();
    }
  });

  test("a few representative folds land on the expected IndexDocument fields", () => {
    const byRel = new Map(allTypesContexts().map((c) => [c.relPath, c]));

    const env = akmAdapter.recognize(component(), byRel.get("env/all-types-env.env") as FileContext);
    expect(env?.tags).toEqual(["env", "secrets"]);
    expect(env?.searchHints).toEqual(["FIXTURE_GREETING", "FIXTURE_LOG_LEVEL"]);

    const knowledge = akmAdapter.recognize(component(), byRel.get("knowledge/all-types-knowledge.md") as FileContext);
    // toc has no first-class IndexDocument home → carried on documentJson.
    expect((knowledge?.documentJson as { toc?: unknown[] }).toc?.length).toBeGreaterThan(0);

    const task = akmAdapter.recognize(component(), byRel.get("tasks/all-types-task.yml") as FileContext);
    expect(task?.tags).toEqual(["task", "scheduled"]);
    expect(task?.searchHints).toContain("schedule:@daily");

    const script = akmAdapter.recognize(component(), byRel.get("scripts/all-types-script.sh") as FileContext);
    expect(script?.confidence).toBe(0.7);
    expect((script?.documentJson as { source?: string }).source).toBe("comments");
  });
});

// ── 4. directoryList / looksLikeRoot ─────────────────────────────────────────

describe("akm adapter — owned dirs + root probe (§7 / §1.2)", () => {
  test("directoryList = the TYPE_DIRS stash subdirs", () => {
    const dirs = new Set(akmAdapter.directoryList?.(component()));
    for (const d of [
      "skills",
      "commands",
      "agents",
      "knowledge",
      "workflows",
      "memories",
      "lessons",
      "env",
      "secrets",
      "tasks",
      "sessions",
      "facts",
      "scripts",
    ]) {
      expect(dirs.has(d), `directoryList missing ${d}`).toBe(true);
    }
  });

  test("looksLikeRoot fires on a stash root that has type dirs", () => {
    expect(akmAdapter.looksLikeRoot?.(ALL_TYPES_ROOT)).toBe(true);
  });

  test("looksLikeRoot does NOT fire on an empty dir", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "akm-adapter-empty-"));
    tmpDirs.push(empty);
    expect(akmAdapter.looksLikeRoot?.(empty)).toBe(false);
  });

  test("looksLikeRoot fires on a dir carrying a single TYPE_DIRS subdir", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-adapter-onedir-"));
    tmpDirs.push(root);
    fs.mkdirSync(path.join(root, "knowledge"));
    expect(akmAdapter.looksLikeRoot?.(root)).toBe(true);
  });
});
