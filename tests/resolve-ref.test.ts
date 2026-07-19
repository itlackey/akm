// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit tests for the F1 ref-resolution layer (ref-grammar decision D-R1/D-R4/
 * D-R5): `resolveRef` and the transient dual-grammar input dispatch/translation.
 *
 * These exercise NEW-grammar behavior only — the old suite never speaks it, so
 * every branch here is net-new coverage per the additive-stage contract.
 */

import { describe, expect, test } from "bun:test";
import { parseAssetRef } from "../src/core/asset/asset-ref";
import {
  classifyRefGrammar,
  conceptIdToLegacy,
  isFullRefInput,
  legacyConceptId,
  legacyRefToBundleRef,
  parseRefInput,
  type RefContext,
  type RefResolutionBundle,
  resolveRef,
} from "../src/core/asset/resolve-ref";
import { NotFoundError, UsageError } from "../src/core/errors";

/** Build a bundle whose membership set is a fixed list of conceptIds. */
function bundle(id: string, concepts: string[]): RefResolutionBundle {
  const set = new Set(concepts);
  return { id, hasConcept: (conceptId) => set.has(conceptId) };
}

// ── resolveRef (D-R4) ───────────────────────────────────────────────────────

describe("resolveRef", () => {
  test("default-bundle hit — short ref resolves to defaultBundle when present there", () => {
    const ctx: RefContext = {
      bundles: [bundle("team", ["skills/review"]), bundle("personal", ["skills/review"])],
      defaultBundle: "personal",
    };
    const resolved = resolveRef("skills/review", ctx);
    expect(resolved.bundle).toBe("personal");
    expect(resolved.conceptId).toBe("skills/review");
  });

  test("default-bundle miss → first bundle in priority order that has the concept", () => {
    const ctx: RefContext = {
      // defaultBundle lacks the concept, so priority order (team first) wins.
      bundles: [bundle("team", ["skills/review"]), bundle("personal", ["skills/other"])],
      defaultBundle: "personal",
    };
    expect(resolveRef("skills/review", ctx).bundle).toBe("team");
  });

  test("priority-order fallback with no defaultBundle — first containing bundle wins", () => {
    const ctx: RefContext = {
      bundles: [bundle("a", ["knowledge/x"]), bundle("b", ["knowledge/y"]), bundle("c", ["knowledge/y"])],
    };
    // Both b and c contain knowledge/y; b is earlier in priority order.
    expect(resolveRef("knowledge/y", ctx).bundle).toBe("b");
  });

  test("only scoping — resolves to the named bundle, ignoring higher-priority ones", () => {
    const ctx: RefContext = {
      bundles: [bundle("first", ["knowledge/x"]), bundle("second", ["knowledge/x"])],
      defaultBundle: "first",
      only: "second",
    };
    expect(resolveRef("knowledge/x", ctx).bundle).toBe("second");
  });

  test("only scoping — no match inside the scoped bundle throws", () => {
    const ctx: RefContext = {
      bundles: [bundle("first", ["knowledge/x"]), bundle("second", ["knowledge/y"])],
      only: "second",
    };
    expect(() => resolveRef("knowledge/x", ctx)).toThrow(NotFoundError);
  });

  test("qualified passthrough — an explicit bundle prefix wins without membership probing", () => {
    const ctx: RefContext = { bundles: [bundle("other", ["skills/review"])] };
    const resolved = resolveRef("explicit//skills/review", ctx);
    expect(resolved.bundle).toBe("explicit");
    expect(resolved.conceptId).toBe("skills/review");
  });

  test("qualified input conflicting with only-scope is a not-found", () => {
    const ctx: RefContext = { bundles: [bundle("a", ["skills/review"])], only: "a" };
    expect(() => resolveRef("b//skills/review", ctx)).toThrow(NotFoundError);
  });

  test("fragment carry — the #fragment survives resolution", () => {
    const ctx: RefContext = { bundles: [bundle("core", ["skills/review"])], defaultBundle: "core" };
    const resolved = resolveRef("skills/review#usage", ctx);
    expect(resolved.bundle).toBe("core");
    expect(resolved.fragment).toBe("usage");
  });

  test("no-match error names the concept and forms tried", () => {
    const ctx: RefContext = { bundles: [bundle("core", ["skills/other"])] };
    let err: unknown;
    try {
      resolveRef("skills/missing", ctx);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as Error).message).toContain("skills/missing");
  });

  test("accepts a pre-parsed BundleRef object as input", () => {
    const ctx: RefContext = { bundles: [bundle("core", ["knowledge/x"])], defaultBundle: "core" };
    const resolved = resolveRef({ conceptId: "knowledge/x" }, ctx);
    expect(resolved.bundle).toBe("core");
  });
});

// ── classifyRefGrammar (D-R5 charset dispatch) ──────────────────────────────

describe("classifyRefGrammar", () => {
  test("bare conceptId (no // no :) → bundle grammar", () => {
    expect(classifyRefGrammar("skills/code-review")).toBe("bundle");
    expect(classifyRefGrammar("knowledge/http-caching")).toBe("bundle");
  });

  test("legal-slug prefix + colon-free tail → bundle grammar", () => {
    expect(classifyRefGrammar("personal//skills/code-review")).toBe("bundle");
    expect(classifyRefGrammar("team-catalog//workflows/release")).toBe("bundle");
  });

  test("bare type:name → legacy grammar", () => {
    expect(classifyRefGrammar("skill:code-review")).toBe("legacy");
    expect(classifyRefGrammar("knowledge:guide.md")).toBe("legacy");
  });

  test("tricky both-// -and-: shapes classify as LEGACY", () => {
    // Illegal slug prefixes (contain / : .) → legacy.
    expect(classifyRefGrammar("owner/repo//skill:code-review")).toBe("legacy");
    expect(classifyRefGrammar("npm:@scope/pkg//skill:x")).toBe("legacy");
    expect(classifyRefGrammar("github:owner/repo#v1//script:lint.sh")).toBe("legacy");
    // Legal slug prefix but a colon in the tail → legacy.
    expect(classifyRefGrammar("local//skill:code-review")).toBe("legacy");
  });
});

// ── D-R2 static-table translation ───────────────────────────────────────────

describe("legacyConceptId / conceptIdToLegacy", () => {
  test("type:name → <stash-subdir>/name via the static placement table", () => {
    expect(legacyConceptId("skill", "code-review")).toBe("skills/code-review");
    expect(legacyConceptId("knowledge", "guide")).toBe("knowledge/guide");
    expect(legacyConceptId("script", "db/migrate/run.sh")).toBe("scripts/db/migrate/run.sh");
    expect(legacyConceptId("workflow", "release")).toBe("workflows/release");
  });

  test("foreign type with no placement subdir keeps the bare name", () => {
    expect(legacyConceptId("madeuptype", "thing")).toBe("thing");
  });

  test("conceptIdToLegacy is the inverse for known stash subdirs", () => {
    expect(conceptIdToLegacy("skills/code-review")).toEqual({ type: "skill", name: "code-review" });
    expect(conceptIdToLegacy("scripts/db/migrate/run.sh")).toEqual({ type: "script", name: "db/migrate/run.sh" });
    expect(conceptIdToLegacy("workflows/release")).toEqual({ type: "workflow", name: "release" });
  });

  test("conceptIdToLegacy → undefined for a bare/unknown leading segment", () => {
    expect(conceptIdToLegacy("no-slash-here")).toBeUndefined();
    expect(conceptIdToLegacy("notatype/thing")).toBeUndefined();
  });

  test("legacyRefToBundleRef maps a registryId origin to the bundle slug", () => {
    // A registry origin is a legal slug → becomes the bundle id (D-R5 rule 2).
    expect(legacyRefToBundleRef("mycatalog//skill:review")).toEqual({
      bundle: "mycatalog",
      conceptId: "skills/review",
    });
    // local/stash origins are not stored bundle ids → stays short.
    expect(legacyRefToBundleRef("local//skill:review")).toEqual({ bundle: undefined, conceptId: "skills/review" });
    expect(legacyRefToBundleRef("skill:review")).toEqual({ bundle: undefined, conceptId: "skills/review" });
  });
});

// ── parseRefInput (F1b input-boundary parser) ───────────────────────────────

describe("parseRefInput", () => {
  test("legacy grammar → byte-identical to parseAssetRef", () => {
    for (const raw of [
      "skill:code-review",
      "knowledge:guide.md",
      "script:db/migrate/run.sh",
      "mycatalog//skill:review",
      "local//knowledge:auth-flow",
      "environment:prod", // the `environment` alias of `env`
    ]) {
      expect(parseRefInput(raw)).toEqual(parseAssetRef(raw));
    }
  });

  test("new-grammar bare conceptId → same AssetRef an origin-less type:name yields", () => {
    // The whole point: a re-keyed literal resolves to the SAME value-object the
    // old spelling did, so every downstream consumer is unaffected.
    expect(parseRefInput("skills/code-review")).toEqual(parseAssetRef("skill:code-review"));
    expect(parseRefInput("knowledge/guide")).toEqual(parseAssetRef("knowledge:guide"));
    expect(parseRefInput("scripts/db/migrate/run.sh")).toEqual(parseAssetRef("script:db/migrate/run.sh"));
    expect(parseRefInput("workflows/release")).toEqual(parseAssetRef("workflow:release"));
  });

  test("new-grammar bundle-qualified → bundle becomes the AssetRef origin", () => {
    expect(parseRefInput("mycatalog//skills/review")).toEqual({
      type: "skill",
      name: "review",
      origin: "mycatalog",
    });
  });

  test("new-grammar conceptId with an unknown type prefix → NotFoundError naming the ref", () => {
    let err: unknown;
    try {
      parseRefInput("notatype/thing");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as Error).message).toContain("notatype/thing");
  });

  test("an export #fragment is rejected at the input boundary", () => {
    expect(() => parseRefInput("skills/review#usage")).toThrow(UsageError);
  });
});

// ── isFullRefInput (bare-name-vs-typed-ref disambiguation) ──────────────────

describe("isFullRefInput", () => {
  test("legacy type:name and new-grammar typed conceptId → full ref", () => {
    expect(isFullRefInput("env:prod")).toBe(true);
    expect(isFullRefInput("mycatalog//env:prod")).toBe(true);
    expect(isFullRefInput("env/prod")).toBe(true);
    expect(isFullRefInput("mycatalog//env/prod")).toBe(true);
    expect(isFullRefInput("secrets/api-token")).toBe(true);
  });

  test("bare names (no type prefix) → not a full ref", () => {
    expect(isFullRefInput("prod")).toBe(false);
    expect(isFullRefInput("projectA/new-note")).toBe(false); // leading segment maps to no type
    expect(isFullRefInput("")).toBe(false);
  });
});
