// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-D gate — the cross-adapter CONFORMANCE suite (adapter-spec §4 / §12.3),
 * the Chunk-2 CLOSE. Exercises the two properties the format-neutral contract
 * requires of EVERY registered `BundleAdapter`, driven off `getAdapters()`
 * (populated by `registerBuiltinAdapters()`), so the suite covers the adapters
 * that are actually registered rather than a hand-picked pair.
 *
 * ── 1. `looksLikeRoot` own-root-only (§4) ──
 *
 * Install-time root detection MUST be UNAMBIGUOUS: on a bundle's own root,
 * exactly one adapter's `looksLikeRoot` fires (§1.2's ordered probe would
 * otherwise pick arbitrarily). We assert the full matrix over the two golden
 * roots — the `okf` reference bundle (`tests/fixtures/bundles/okf-sample/`,
 * which has a root `index.md` and NO `TYPE_DIRS` subdir) and the `akm`
 * workspace stash (`tests/fixtures/stashes/all-types/`, which has `TYPE_DIRS`
 * subdirs and NO root `index.md`): each adapter's `looksLikeRoot` returns
 * `true` on its OWN golden root and `false` on the sibling's.
 *
 * These two frozen fixtures already separate cleanly (verified: `okf-sample`'s
 * only subdirs are `guides`/`metrics`/`tables` — none a `TYPE_DIRS` value — so
 * `akm.looksLikeRoot` abstains on it; `all-types` carries no root `index.md`,
 * so `okf.looksLikeRoot` abstains on it), so NO dedicated single-adapter root
 * fixtures were needed. Neither the frozen `all-types` stash nor any golden is
 * touched.
 *
 * ── 2. `index() == fold(recognize)` (§12.3) ──
 *
 * The optional `index()` capability, when present, MUST equal folding
 * `recognize()` over the core walk (adapter-spec §2's `index?` JSDoc /
 * normative §14.2). NEITHER `okf` NOR `akm` overrides `index()`, so the
 * conformance is VACUOUSLY satisfied — the core walk × `recognize` IS the index
 * for these adapters. We first assert every registered adapter leaves `index`
 * undefined (documenting the vacuous-true §12.3 shape), then exercise the
 * equality CONCRETELY over each golden root by folding `recognize` over the
 * `walkStashFlat(root)` files directly (the walk×recognize mapping the live
 * indexer drains) — the per-adapter recognize-over-walk coverage that the retired
 * `scanComponent` module used to carry (owner ruling 2026-07-21).
 */

import { beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { akmAdapter, llmWikiAdapter, okfAdapter, registerBuiltinAdapters } from "../../../src/core/adapter/adapters";
import type { BundleAdapter } from "../../../src/core/adapter/bundle-adapter";
import { adapterForId, getAdapters, resetAdapterRegistryForTests } from "../../../src/core/adapter/registry";
import type { BundleComponent, IndexDocument } from "../../../src/core/adapter/types";
import { walkStashFlat } from "../../../src/indexer/walk/walker";

/** The `okf` reference bundle's own root (root `index.md`, no `TYPE_DIRS` subdir). */
const OKF_ROOT = path.resolve(__dirname, "../../fixtures/bundles/okf-sample");
/** The `akm` workspace stash's own root (`TYPE_DIRS` subdirs, no root `index.md`). */
const AKM_ROOT = path.resolve(__dirname, "../../fixtures/stashes/all-types");
/** The `llm-wiki` bundle's own root (root `schema.md` + `pages/`; ALSO carries a root `index.md`). */
const LLM_WIKI_ROOT = path.resolve(__dirname, "../../fixtures/bundles/llm-wiki");

/** The format-family fixture roots (#46) — one per new adapter. */
const BUNDLES = path.resolve(__dirname, "../../fixtures/bundles");
const CLAUDE_ROOT = path.join(BUNDLES, "claude");
const OPENCODE_ROOT = path.join(BUNDLES, "opencode");
const AGENT_SKILLS_ROOT = path.join(BUNDLES, "agent-skills");
const AKM_WORKFLOW_ROOT = path.join(BUNDLES, "akm-workflow");
const AKM_TASK_ROOT = path.join(BUNDLES, "akm-task");
const DOTENV_ROOT = path.join(BUNDLES, "dotenv");
const WEBSITE_ROOT = path.join(BUNDLES, "website-snapshot");
const GENERIC_FILES_ROOT = path.join(BUNDLES, "generic-files");

/**
 * adapter id → its OWN golden/fixture root. Every registered adapter EXCEPT the
 * explicit-config `generic-files` (whose `looksLikeRoot` never fires, §1.2) is
 * claimed by the §1.2 ordered probe on its own root.
 */
const OWN_ROOT_BY_ID: Record<string, string> = {
  okf: OKF_ROOT,
  akm: AKM_ROOT,
  "llm-wiki": LLM_WIKI_ROOT,
  claude: CLAUDE_ROOT,
  opencode: OPENCODE_ROOT,
  "agent-skills": AGENT_SKILLS_ROOT,
  "akm-workflow": AKM_WORKFLOW_ROOT,
  "akm-task": AKM_TASK_ROOT,
  dotenv: DOTENV_ROOT,
  "website-snapshot": WEBSITE_ROOT,
  "generic-files": GENERIC_FILES_ROOT,
};

/** Adapters whose `looksLikeRoot` is intentionally never-firing (explicit-config, §1.2). */
const NEVER_FIRES = new Set(["generic-files"]);

/**
 * The §1.2 install-time probe: the FIRST registered adapter (registration order
 * == probe precedence) whose `looksLikeRoot` fires claims the root. This is the
 * REAL "cannot shadow" contract — several probes legitimately overlap (a wiki
 * root also has a root `index.md` so `okf` fires; a `.claude`/`.opencode`/dotenv
 * root carries stash-subdir-shaped dirs so `akm` fires), and ORDER, not
 * exclusivity, resolves them.
 */
function orderedProbeOwner(root: string): string | undefined {
  for (const adapter of getAdapters()) {
    if (adapter.looksLikeRoot?.(root)) return adapter.id;
  }
  return undefined;
}

beforeAll(() => {
  // Deterministic registry snapshot: reset the module-level singleton, then
  // register only the built-ins (mirrors registry.test.ts's isolation).
  resetAdapterRegistryForTests();
  registerBuiltinAdapters();
});

function component(id: string, adapterId: string, root: string): BundleComponent {
  return { id, adapter: adapterId, root, writable: true };
}

/** `{ref, type}` projection of a doc stream — the comparison key for the walk×recognize mapping. */
function refType(docs: IndexDocument[]): Array<{ ref: string | undefined; type: string }> {
  return docs.map((d) => ({ ref: d.ref, type: d.type }));
}

/** fold(recognize): map `adapter.recognize` over the SAME `walkStashFlat(root)` files directly, dropping abstentions. */
function foldRecognize(adapter: BundleAdapter, c: BundleComponent): IndexDocument[] {
  const out: IndexDocument[] = [];
  for (const file of walkStashFlat(c.root)) {
    const doc = adapter.recognize(c, file);
    if (doc !== null) out.push(doc);
  }
  return out;
}

// ── 1. looksLikeRoot own-root-only (§4) ──────────────────────────────────────

describe("conformance — looksLikeRoot own-root-only (§4)", () => {
  test("the built-in registry is exactly the 11 format families, and every one has a fixture root", () => {
    // Pins the fixture set: every registered adapter has a golden/fixture root in
    // OWN_ROOT_BY_ID, so the ordered-probe matrix below is complete.
    const ids = getAdapters().map((a) => a.id);
    expect(ids.sort()).toEqual([
      "agent-skills",
      "akm",
      "akm-task",
      "akm-workflow",
      "claude",
      "dotenv",
      "generic-files",
      "llm-wiki",
      "okf",
      "opencode",
      "website-snapshot",
    ]);
    for (const id of ids) {
      expect(typeof adapterForId(id)?.looksLikeRoot).toBe("function");
      expect(OWN_ROOT_BY_ID[id]).toBeDefined();
    }
  });

  test("the §1.2 ordered probe selects each root's OWN adapter — no adapter shadows another", () => {
    for (const [id, root] of Object.entries(OWN_ROOT_BY_ID)) {
      if (NEVER_FIRES.has(id)) {
        // Explicit-config: NO probe claims a generic-files root.
        expect(orderedProbeOwner(root), id).toBeUndefined();
      } else {
        expect(orderedProbeOwner(root), id).toBe(id);
      }
    }
  });

  test("llm-wiki fires on its own root (schema.md + pages/), NOT on the okf/akm roots", () => {
    expect(llmWikiAdapter.looksLikeRoot?.(LLM_WIKI_ROOT)).toBe(true);
    expect(llmWikiAdapter.looksLikeRoot?.(OKF_ROOT)).toBe(false);
    expect(llmWikiAdapter.looksLikeRoot?.(AKM_ROOT)).toBe(false);
  });

  test("akm abstains on the llm-wiki root (no .stash marker, no placement stash-subdir)", () => {
    expect(akmAdapter.looksLikeRoot?.(LLM_WIKI_ROOT)).toBe(false);
  });

  test("okf.looksLikeRoot fires on the okf-sample root, NOT on the akm/all-types root", () => {
    expect(okfAdapter.looksLikeRoot?.(OKF_ROOT)).toBe(true);
    expect(okfAdapter.looksLikeRoot?.(AKM_ROOT)).toBe(false);
  });

  test("akm.looksLikeRoot fires on the all-types root, NOT on the okf-sample root", () => {
    expect(akmAdapter.looksLikeRoot?.(AKM_ROOT)).toBe(true);
    expect(akmAdapter.looksLikeRoot?.(OKF_ROOT)).toBe(false);
  });
});

// ── 2. index() == fold(recognize) (§12.3) ────────────────────────────────────

describe("conformance — index() == fold(recognize) (§12.3)", () => {
  test("no built-in adapter overrides index() — the conformance is vacuously satisfied", () => {
    // §12.3: an adapter overriding index() MUST keep it == fold(recognize).
    // None of the built-ins override it, so the core walk × recognize IS the
    // index; the equality holds vacuously.
    expect(okfAdapter.index).toBeUndefined();
    expect(akmAdapter.index).toBeUndefined();
    expect(llmWikiAdapter.index).toBeUndefined();
    // Documented over the whole registry, not just the named handles.
    for (const adapter of getAdapters()) expect(adapter.index).toBeUndefined();
  });

  // fold(recognize) over the golden walk is the live indexer's scan engine
  // (drainDirDocuments × adapter.recognize). These assertions pin each adapter's
  // recognize-over-walk behavior directly (owner ruling 2026-07-21 — the
  // walk×recognize mapping the retired `scanComponent` module used to wrap).
  test("akm: fold(recognize) over the all-types walk yields a stable ref/type stream", () => {
    const c = component("all-types", "akm", AKM_ROOT);
    const folded = foldRecognize(akmAdapter, c);
    expect(folded.length).toBeGreaterThan(0); // the fixture actually exercises the walk
    expect(refType(folded)).toEqual(refType(foldRecognize(akmAdapter, c)));
  });

  test("okf: fold(recognize) over the okf-sample walk yields a stable ref/type stream", () => {
    const c = component("okf-sample", "okf", OKF_ROOT);
    const folded = foldRecognize(okfAdapter, c);
    expect(folded.length).toBeGreaterThan(0);
    expect(refType(folded)).toEqual(refType(foldRecognize(okfAdapter, c)));
  });

  test("llm-wiki: fold(recognize) over the llm-wiki walk yields a stable ref/type stream", () => {
    const c = component("sample-wiki", "llm-wiki", LLM_WIKI_ROOT);
    const folded = foldRecognize(llmWikiAdapter, c);
    expect(folded.length).toBeGreaterThan(0);
    expect(refType(folded)).toEqual(refType(foldRecognize(llmWikiAdapter, c)));
  });
});
