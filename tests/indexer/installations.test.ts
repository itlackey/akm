// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Exercised against the frozen fixture roots the conformance suite uses so the
 * ordered `looksLikeRoot` probe is checked over real bundle layouts:
 *   - `all-types` stash  → akm  (type dirs, no root index.md)
 *   - `okf-sample`       → okf  (root index.md, no schema.md+pages/)
 *   - `llm-wiki`         → llm-wiki (schema.md + pages/)
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { bundleAdapterId } from "../../src/core/adapter/detect-adapter";
import { detectBundleAdapter } from "../../src/core/assets/gate";
import { deriveBundleId, deriveBundleIds, slugForPath, slugForRegistryId } from "../../src/core/bundle-id";
import { deriveWritableBundleIds } from "../../src/indexer/installations";
import type { SearchSource } from "../../src/indexer/search/search-source";

// NO registry setup: the registry is a static frozen map (normative §12.6)
// populated at module load, so the ordered `looksLikeRoot`
// probe runs in production with the full built-in set WITHOUT any registration
// call. These tests assert exactly that production path.

const AKM_ROOT = path.resolve(__dirname, "../fixtures/stashes/all-types");
const OKF_ROOT = path.resolve(__dirname, "../fixtures/bundles/okf-sample");
const LLM_WIKI_ROOT = path.resolve(__dirname, "../fixtures/bundles/llm-wiki");

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

describe("slugForRegistryId", () => {
  test("slugs the package or repo name every registry install id kind names", () => {
    expect(slugForRegistryId("npm:akm-upgrade-rehearsal-fixture")).toBe("akm-upgrade-rehearsal-fixture");
    expect(slugForRegistryId("npm:@scope/pkg")).toBe("pkg");
    expect(slugForRegistryId("github:owner/repo")).toBe("repo");
    expect(slugForRegistryId("git:https://gitlab.com/owner/repo")).toBe("repo");
    expect(slugForRegistryId("git:git@github.com:owner/repo")).toBe("repo");
  });

  test("sanitizes the name to the ref bundle-slug charset", () => {
    expect(slugForRegistryId("github:owner/Dotfiles.NVIM")).toBe("dotfiles-nvim");
  });

  test("is empty when the id names nothing slug-legal, leaving deriveBundleId its path fallback", () => {
    expect(slugForRegistryId("github:owner/---")).toBe("");
  });
});

describe("detectBundleAdapter — adapter selection (ordered §1.2 probe)", () => {
  test("akm workspace stash → akm adapter", () => {
    expect(detectBundleAdapter(AKM_ROOT)).toBe("akm");
  });

  test("okf reference bundle → okf adapter", () => {
    expect(detectBundleAdapter(OKF_ROOT)).toBe("okf");
  });

  test("llm-wiki bundle → llm-wiki adapter (more-specific probe wins over okf)", () => {
    expect(detectBundleAdapter(LLM_WIKI_ROOT)).toBe("llm-wiki");
  });

  test("a root no probe claims falls back to akm (recorded deviation from spec §1.2(3)'s okf)", () => {
    // FALLBACK_ADAPTER_ID is `akm`, not the spec §1.2(3) `okf`, as the
    // status-quo-preserving / workspace-root-discipline choice in this
    // pre-config-adapter transitional model (see installations.ts). Pins that
    // decision so a future 0.9.1 flip to `okf` is a deliberate, visible change.
    expect(detectBundleAdapter("/nonexistent/empty/root")).toBe("akm");
  });

  test("the ordered probe is genuinely consulted in production — non-akm roots no longer all collapse to akm", () => {
    // The pre-wiring bug: an empty registry made EVERY source fall back to
    // `akm`. Now distinct bundle shapes resolve to distinct adapters through
    // the same detection function production uses.
    const adapters = [AKM_ROOT, OKF_ROOT, LLM_WIKI_ROOT].map((root) => detectBundleAdapter(root));
    expect(adapters).toEqual(["akm", "okf", "llm-wiki"]);
  });

  test("a configured adapter is the bundle's adapter", () => {
    expect(bundleAdapterId({ adapterId: "okf" })).toBe("okf");
  });
});

describe("deriveWritableBundleIds", () => {
  test("writability is the source's, by bundle id", () => {
    const sources: SearchSource[] = [
      { bundleId: "all-types", path: AKM_ROOT, writable: true },
      { bundleId: "ro", path: OKF_ROOT, writable: false },
    ];
    expect([...deriveWritableBundleIds(sources)]).toEqual(["all-types"]);
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
});

describe("deriveBundleIds — bundle id uniqueness within a batch", () => {
  test("two distinct paths sharing a basename get distinct bundle ids", () => {
    const ids = deriveBundleIds([{ path: "/one/knowledge" }, { path: "/two/knowledge" }]);
    expect(ids[0]).toBe("knowledge");
    expect(ids[1]).toMatch(/^knowledge-[0-9a-f]{8}$/);
    expect(new Set(ids).size).toBe(2);
  });

  test("a duplicate registryId is disambiguated deterministically", () => {
    const first = deriveBundleIds([
      { path: "/p/one", registryId: "dup" },
      { path: "/p/two", registryId: "dup" },
    ]);
    const second = deriveBundleIds([
      { path: "/p/one", registryId: "dup" },
      { path: "/p/two", registryId: "dup" },
    ]);
    expect(first[0]).toBe("dup");
    expect(new Set(first).size).toBe(2);
    expect(first).toEqual(second); // deterministic
  });
});
