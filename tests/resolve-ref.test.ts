// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Unit tests for the current bundle-ref resolution layer. */

import { describe, expect, test } from "bun:test";
import {
  conceptIdFromTypeName,
  displayRef,
  isFullRefInput,
  parsePlacementRef,
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

// ── parsePlacementRef (F1b input-boundary parser) ───────────────────────────────

describe("parsePlacementRef", () => {
  test("bare concept ids project to type/name values", () => {
    expect(parsePlacementRef("skills/code-review")).toEqual({ type: "skill", name: "code-review" });
    expect(parsePlacementRef("knowledge/guide")).toEqual({ type: "knowledge", name: "guide" });
    expect(parsePlacementRef("scripts/db/migrate/run.sh")).toEqual({ type: "script", name: "db/migrate/run.sh" });
    expect(parsePlacementRef("workflows/release")).toEqual({ type: "workflow", name: "release" });
  });

  test("new-grammar bundle-qualified → bundle becomes the AssetRef origin", () => {
    expect(parsePlacementRef("mycatalog//skills/review")).toEqual({
      type: "skill",
      name: "review",
      origin: "mycatalog",
    });
  });

  // Q-07/D11 — the ref-parser seam accepts opaque adapter conceptIds. Prior to
  // this, ANY conceptId whose leading segment was not an AKM placement stashDir
  // threw here — rejecting perfectly valid adapter-emitted conceptIds (OKF
  // items, website pages, wiki pageKinds, adapter `instruction` docs) in every
  // ref-consuming command except `show` (which bypasses this parser). This
  // test used to pin the OLD (defect) behavior — a NotFoundError for
  // "notatype/thing" — and is UPDATED here to pin the corrected D11 behavior:
  // a well-formed `<segment>/<rest>` conceptId is accepted as opaque data.
  test("new-grammar conceptId with an unknown-but-well-formed prefix → accepted as opaque data (D11)", () => {
    expect(parsePlacementRef("notatype/thing")).toEqual({
      type: "notatype",
      name: "notatype/thing",
      origin: undefined,
    });
    expect(parsePlacementRef("tables/customers")).toEqual({
      type: "tables",
      name: "tables/customers",
      origin: undefined,
    });
    expect(parsePlacementRef("adversarial//tables/customers")).toEqual({
      type: "tables",
      name: "tables/customers",
      origin: "adversarial",
    });
  });

  test("D11 opaque acceptance round-trips through the UNCHANGED conceptIdFromTypeName", () => {
    // This is the property the proposals-repository canonical-ref check and the
    // index-utility-repository event matcher both depend on: reconstructing
    // `type`/`name` via conceptIdFromTypeName must reproduce the exact input
    // conceptId, not just its tail.
    for (const conceptId of ["notatype/thing", "tables/customers", "sub/duplicate-b", "a/b/c/d"]) {
      const parsed = parsePlacementRef(conceptId);
      expect(conceptIdFromTypeName(parsed.type, parsed.name)).toBe(conceptId);
    }
  });

  test("D11 collision guard: a leading segment that coincidentally spells a real type KEY (not its stashDir) still round-trips", () => {
    // "skill" (singular) is a real PLACEMENT_SPECS type key, but ITS stashDir is
    // "skills" (plural) — so "skill/foo" is not a known placement dir and falls
    // into the opaque branch. Naively using "skill" as the opaque `type` would
    // make `conceptIdFromTypeName("skill", …)` resolve via the REAL placement
    // mapping (`stashDirFor("skill") === "skills"`) and corrupt the round-trip.
    for (const key of [
      "skill",
      "command",
      "agent",
      "workflow",
      "script",
      "memory",
      "secret",
      "lesson",
      "session",
      "fact",
    ]) {
      const conceptId = `${key}/foo`;
      const parsed = parsePlacementRef(conceptId);
      expect(conceptIdFromTypeName(parsed.type, parsed.name)).toBe(conceptId);
    }
  });

  test("D11 does NOT loosen acceptance of a bare (no-slash) name — still the caller's bare-name-to-qualify job", () => {
    expect(() => parsePlacementRef("notatype")).toThrow(NotFoundError);
    expect(() => parsePlacementRef("prod")).toThrow(NotFoundError);
  });

  test("a qualified root-level opaque conceptId is a complete parseable ref", () => {
    expect(parsePlacementRef("catalog//readme")).toEqual({ type: "readme", name: "readme", origin: "catalog" });
    expect(isFullRefInput("catalog//readme")).toBe(true);
  });

  test("D11 does NOT re-accept the retired colon `type:name` grammar (Q-02)", () => {
    // No slash at all after the colon — already rejected pre-D11 too.
    expect(() => parsePlacementRef("skill:code-review")).toThrow(NotFoundError);
    expect(() => parsePlacementRef("knowledge:guide.md")).toThrow(NotFoundError);
    // A slash appears in the NAME after the colon — this is exactly the shape
    // the naive "accept any well-formed <segment>/<rest>" fallback would have
    // wrongly re-admitted (the leading segment "script:db" / "workflow:release"
    // would fail the AKM-placement lookup and fall into the opaque branch).
    // The colon-in-leading-segment guard must still refuse these.
    expect(() => parsePlacementRef("script:db/migrate/run.sh")).toThrow(NotFoundError);
    expect(() => parsePlacementRef("workflow:release/train")).toThrow(NotFoundError);
  });

  test("an export #fragment is rejected at the input boundary", () => {
    expect(() => parsePlacementRef("skills/review#usage")).toThrow(UsageError);
  });
});

// ── isFullRefInput (bare-name-vs-typed-ref disambiguation) ──────────────────

describe("isFullRefInput", () => {
  test("new-grammar typed conceptId → full ref", () => {
    expect(isFullRefInput("env/prod")).toBe(true);
    expect(isFullRefInput("mycatalog//env/prod")).toBe(true);
    expect(isFullRefInput("secrets/api-token")).toBe(true);
  });

  test("bare names (no type prefix) → not a full ref", () => {
    expect(isFullRefInput("prod")).toBe(false);
    expect(isFullRefInput("projectA/new-note")).toBe(false); // leading segment maps to no type
    expect(isFullRefInput("")).toBe(false);
  });

  test("qualified opaque conceptIds are syntactically complete", () => {
    expect(isFullRefInput("catalog//tables/customers")).toBe(true);
    expect(isFullRefInput("tables/customers")).toBe(false);
  });
});

describe("displayRef (F4b output-spelling rule)", () => {
  test("default/primary bundle (no bundleId) → the SHORT conceptId", () => {
    expect(displayRef({ conceptId: "knowledge/http-caching" })).toBe("knowledge/http-caching");
    expect(displayRef({ conceptId: "reports/q3" })).toBe("reports/q3");
  });

  test("bundleId equal to defaultBundleId → SHORT conceptId", () => {
    expect(displayRef({ conceptId: "knowledge/guide", bundleId: "core" }, "core")).toBe("knowledge/guide");
  });

  test("non-default bundles named local or stash remain qualified", () => {
    expect(displayRef({ conceptId: "knowledge/guide", bundleId: "local" }, "primary")).toBe("local//knowledge/guide");
    expect(displayRef({ conceptId: "knowledge/guide", bundleId: "stash" }, "primary")).toBe("stash//knowledge/guide");
  });

  test("non-default bundle → bundle//conceptId, a non-slug bundle id emitted verbatim", () => {
    expect(displayRef({ conceptId: "team/notes/auth", bundleId: "team-catalog" })).toBe(
      "team-catalog//team/notes/auth",
    );
    expect(displayRef({ conceptId: "agents/helper", bundleId: "github:evil/pack" })).toBe(
      "github:evil/pack//agents/helper",
    );
  });
});

describe("conceptIdFromTypeName (placement of a new asset)", () => {
  test("prefixes the type's stash folder; a type with no folder keeps the bare name", () => {
    expect(conceptIdFromTypeName("skill", "code-review")).toBe("skills/code-review");
    expect(conceptIdFromTypeName("memory", "claude-prefs.derived")).toBe("memories/claude-prefs.derived");
    expect(conceptIdFromTypeName("tables", "customers")).toBe("customers");
  });
});
