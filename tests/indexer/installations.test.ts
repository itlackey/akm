// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Chunk 5 M-a — `deriveInstallations` (`src/indexer/installations.ts`):
 * SearchSource[] → BundleInstallation[] derivation (spec §1.1/§1.2).
 *
 * Exercised against the frozen fixture roots the conformance suite uses so the
 * ordered `looksLikeRoot` probe is checked over real bundle layouts:
 *   - `all-types` stash  → akm  (type dirs, no root index.md)
 *   - `okf-sample`       → okf  (root index.md, no schema.md+pages/)
 *   - `llm-wiki`         → llm-wiki (schema.md + pages/)
 */

import { beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { registerBuiltinAdapters } from "../../src/core/adapter/adapters";
import { resetAdapterRegistryForTests } from "../../src/core/adapter/registry";
import { deriveBundleId, deriveInstallations, slugForPath } from "../../src/indexer/installations";
import type { SearchSource } from "../../src/indexer/search/search-source";

const AKM_ROOT = path.resolve(__dirname, "../fixtures/stashes/all-types");
const OKF_ROOT = path.resolve(__dirname, "../fixtures/bundles/okf-sample");
const LLM_WIKI_ROOT = path.resolve(__dirname, "../fixtures/bundles/llm-wiki");

beforeAll(() => {
  resetAdapterRegistryForTests();
  registerBuiltinAdapters();
});

describe("slugForPath", () => {
  test("sanitizes the basename to the ref bundle-slug charset", () => {
    expect(slugForPath("/home/user/My Knowledge.Stash")).toBe("my-knowledge-stash");
    expect(slugForPath("/a/b/team-catalog")).toBe("team-catalog");
  });

  test("is a pure function of the resolved path", () => {
    expect(slugForPath("/x/y/../y/stash")).toBe(slugForPath("/x/y/stash"));
  });

  test("falls back to a stable hash for a basename-less root", () => {
    const s = slugForPath("/");
    expect(s).toMatch(/^bundle-[0-9a-f]{8}$/);
    expect(s).toBe(slugForPath("/"));
  });
});

describe("deriveInstallations — adapter selection (ordered §1.2 probe)", () => {
  test("akm workspace stash → akm adapter", () => {
    const [inst] = deriveInstallations([{ path: AKM_ROOT, writable: true }]);
    expect(inst!.components[0]!.adapter).toBe("akm");
  });

  test("okf reference bundle → okf adapter", () => {
    const [inst] = deriveInstallations([{ path: OKF_ROOT }]);
    expect(inst!.components[0]!.adapter).toBe("okf");
  });

  test("llm-wiki bundle → llm-wiki adapter (more-specific probe wins over okf)", () => {
    const [inst] = deriveInstallations([{ path: LLM_WIKI_ROOT }]);
    expect(inst!.components[0]!.adapter).toBe("llm-wiki");
  });

  test("a root no probe claims falls back to akm", () => {
    const [inst] = deriveInstallations([{ path: "/nonexistent/empty/root" }]);
    expect(inst!.components[0]!.adapter).toBe("akm");
  });
});

describe("deriveInstallations — id / trust / component shape", () => {
  test("registryId is the bundle id when present; otherwise a path slug", () => {
    const sources: SearchSource[] = [
      { path: AKM_ROOT, writable: true },
      { path: OKF_ROOT, registryId: "team-catalog" },
    ];
    const [primary, installed] = deriveInstallations(sources);
    expect(primary!.id).toBe("all-types");
    expect(installed!.id).toBe("team-catalog");
  });

  test("trusted mirrors writable; component carries root/writable and id == bundle id", () => {
    const [writable, readonly] = deriveInstallations([
      { path: AKM_ROOT, writable: true },
      { path: OKF_ROOT, registryId: "ro", writable: false },
    ]);
    expect(writable!.trusted).toBe(true);
    expect(writable!.components).toHaveLength(1);
    expect(writable!.components[0]).toMatchObject({ id: "all-types", root: AKM_ROOT, writable: true });
    expect(readonly!.trusted).toBe(false);
    expect(readonly!.components[0]!.writable).toBe(false);
  });

  test("source order is preserved as installation priority", () => {
    const ids = deriveInstallations([
      { path: OKF_ROOT, registryId: "a" },
      { path: LLM_WIKI_ROOT, registryId: "b" },
      { path: AKM_ROOT, registryId: "c" },
    ]).map((i) => i.id);
    expect(ids).toEqual(["a", "b", "c"]);
  });
});

describe("deriveBundleId — D-R5 slug-gated derivation (shared with the config migrator)", () => {
  test("a slug-legal registryId IS the bundle id (D-R5 rule 1)", () => {
    const used = new Set<string>();
    expect(deriveBundleId("team-catalog", "/a/b/whatever", used)).toBe("team-catalog");
  });

  test("a non-slug-legal registryId slugs from the path (bundle keys must be slug-legal, §11.1)", () => {
    const used = new Set<string>();
    // `github:owner/repo` carries ':' and '/', so it cannot be a bundle prefix.
    expect(deriveBundleId("github:owner/repo", "/x/y/repo", used)).toBe("repo");
    expect(deriveBundleId("npm:@scope/pkg", "/x/y/pkg", new Set())).toBe("pkg");
  });

  test("an empty registryId falls back to the path slug", () => {
    expect(deriveBundleId(undefined, "/x/y/team-catalog", new Set())).toBe("team-catalog");
    expect(deriveBundleId("", "/x/y/team-catalog", new Set())).toBe("team-catalog");
  });

  test("deriveInstallations ids equal a direct deriveBundleId pass over the same sources (no re-derive)", () => {
    const sources: SearchSource[] = [
      { path: AKM_ROOT, writable: true },
      { path: OKF_ROOT, registryId: "team-catalog" },
      { path: LLM_WIKI_ROOT, registryId: "github:owner/repo" }, // non-slug-legal
    ];
    const used = new Set<string>();
    const expected = sources.map((s) => deriveBundleId(s.registryId, s.path, used));
    expect(deriveInstallations(sources).map((i) => i.id)).toEqual(expected);
  });
});

describe("deriveInstallations — bundle id uniqueness within a batch", () => {
  test("two distinct paths sharing a basename get distinct bundle ids", () => {
    const ids = deriveInstallations([{ path: "/one/knowledge" }, { path: "/two/knowledge" }]).map((i) => i.id);
    expect(ids[0]).toBe("knowledge");
    expect(ids[1]).toMatch(/^knowledge-[0-9a-f]{8}$/);
    expect(new Set(ids).size).toBe(2);
  });

  test("a duplicate registryId is disambiguated deterministically", () => {
    const first = deriveInstallations([
      { path: "/p/one", registryId: "dup" },
      { path: "/p/two", registryId: "dup" },
    ]).map((i) => i.id);
    const second = deriveInstallations([
      { path: "/p/one", registryId: "dup" },
      { path: "/p/two", registryId: "dup" },
    ]).map((i) => i.id);
    expect(first[0]).toBe("dup");
    expect(new Set(first).size).toBe(2);
    expect(first).toEqual(second); // deterministic
  });
});
