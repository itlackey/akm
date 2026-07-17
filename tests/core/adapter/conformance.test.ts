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
 * conformance is VACUOUSLY satisfied — the core `scanComponent` walk ×
 * `recognize` IS the index for these adapters. We first assert every registered
 * adapter leaves `index` undefined (documenting the vacuous-true §12.3 shape),
 * then exercise the equality CONCRETELY: `scanComponent(inst, c, adapter)` over
 * a golden root yields exactly the same `IndexDocument` stream (compared by
 * `ref`/`type`, order-preserving) as mapping `recognize` over the same
 * `walkStashFlat(root)` files directly — proving `scanComponent == fold(recognize)`
 * for the non-`index()` adapter.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { akmAdapter, okfAdapter, registerBuiltinAdapters } from "../../../src/core/adapter/adapters";
import type { BundleAdapter } from "../../../src/core/adapter/bundle-adapter";
import { getAdapters, resetAdapterRegistryForTests } from "../../../src/core/adapter/registry";
import { scanComponent } from "../../../src/core/adapter/scan-component";
import type { BundleComponent, BundleInstallation, IndexDocument } from "../../../src/core/adapter/types";
import { walkStashFlat } from "../../../src/indexer/walk/walker";

/** The `okf` reference bundle's own root (root `index.md`, no `TYPE_DIRS` subdir). */
const OKF_ROOT = path.resolve(__dirname, "../../fixtures/bundles/okf-sample");
/** The `akm` workspace stash's own root (`TYPE_DIRS` subdirs, no root `index.md`). */
const AKM_ROOT = path.resolve(__dirname, "../../fixtures/stashes/all-types");

/** adapter id → its OWN golden root. Every registered adapter's `looksLikeRoot` must fire on its own root and no sibling's. */
const OWN_ROOT_BY_ID: Record<string, string> = {
  okf: OKF_ROOT,
  akm: AKM_ROOT,
};

beforeAll(() => {
  // Deterministic registry snapshot: reset the module-level singleton, then
  // register only the built-ins (mirrors registry.test.ts's isolation).
  resetAdapterRegistryForTests();
  registerBuiltinAdapters();
});

function component(id: string, adapterId: string, root: string): BundleComponent {
  return { id, adapter: adapterId, root, writable: true };
}

function installation(c: BundleComponent): BundleInstallation {
  return { id: c.id, components: [c], trusted: true };
}

async function drain(iterable: AsyncIterable<IndexDocument>): Promise<IndexDocument[]> {
  const out: IndexDocument[] = [];
  for await (const doc of iterable) out.push(doc);
  return out;
}

/** `{ref, type}` projection of a doc stream — the comparison key for scan == fold. */
function refType(docs: IndexDocument[]): Array<{ ref: string; type: string | undefined }> {
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
  test("the built-in registry is exactly [okf, akm] — the roots this matrix covers", () => {
    // Pins the fixture set: every registered adapter has a golden root in
    // OWN_ROOT_BY_ID, so the own-root-only matrix below is complete.
    const ids = getAdapters().map((a) => a.id);
    expect(ids.sort()).toEqual(["akm", "okf"]);
    for (const id of ids) expect(OWN_ROOT_BY_ID[id]).toBeDefined();
  });

  test("for each registered adapter, looksLikeRoot fires on its OWN golden root and NO sibling's", () => {
    const adapters = getAdapters();
    const allRoots = Object.entries(OWN_ROOT_BY_ID); // [ownerId, root][]
    for (const adapter of adapters) {
      expect(typeof adapter.looksLikeRoot).toBe("function");
      const ownRoot = OWN_ROOT_BY_ID[adapter.id];
      for (const [ownerId, root] of allRoots) {
        // Exactly the owning adapter fires: true iff this root is the adapter's own.
        expect(adapter.looksLikeRoot?.(root)).toBe(root === ownRoot);
        // Redundant, explicit framing for readability.
        if (ownerId === adapter.id) {
          expect(adapter.looksLikeRoot?.(root)).toBe(true);
        } else {
          expect(adapter.looksLikeRoot?.(root)).toBe(false);
        }
      }
    }
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
  test("neither okf nor akm overrides index() — the conformance is vacuously satisfied", () => {
    // §12.3: an adapter overriding index() MUST keep it == fold(recognize).
    // These two adapters do NOT override it, so the core scanComponent walk ×
    // recognize IS the index; the equality holds vacuously.
    expect(okfAdapter.index).toBeUndefined();
    expect(akmAdapter.index).toBeUndefined();
    // Documented over the whole registry, not just the two named handles.
    for (const adapter of getAdapters()) expect(adapter.index).toBeUndefined();
  });

  test("akm: scanComponent(all-types) == fold(recognize) over the same walk (by ref/type)", async () => {
    const c = component("all-types", "akm", AKM_ROOT);
    const scanned = await drain(scanComponent(installation(c), c, akmAdapter));
    const folded = foldRecognize(akmAdapter, c);

    expect(scanned.length).toBeGreaterThan(0); // the fixture actually exercises the walk
    expect(refType(scanned)).toEqual(refType(folded));
  });

  test("okf: scanComponent(okf-sample) == fold(recognize) over the same walk (by ref/type)", async () => {
    const c = component("okf-sample", "okf", OKF_ROOT);
    const scanned = await drain(scanComponent(installation(c), c, okfAdapter));
    const folded = foldRecognize(okfAdapter, c);

    expect(scanned.length).toBeGreaterThan(0);
    expect(refType(scanned)).toEqual(refType(folded));
  });
});
