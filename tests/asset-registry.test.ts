import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { ACTION_BUILDERS, TYPE_TO_RENDERER } from "../src/asset-registry";
import type { AssetSpec } from "../src/asset-spec";
import { ASSET_SPECS, ASSET_TYPES, registerAssetType, TYPE_DIRS } from "../src/asset-spec";

// ── Test helpers ────────────────────────────────────────────────────────────

const TEST_TYPE = "registry-test-widget";

function makeWidgetSpec(overrides: Partial<AssetSpec> = {}) {
  return {
    stashDir: "widgets",
    isRelevantFile: (f: string) => f.endsWith(".widget"),
    toCanonicalName: (_root: string, fp: string) => path.basename(fp, ".widget"),
    toAssetPath: (root: string, name: string) => path.join(root, `${name}.widget`),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("asset-registry singleton", () => {
  afterEach(() => {
    // Clean up the test type to avoid polluting other tests
    delete ASSET_SPECS[TEST_TYPE];
    delete TYPE_DIRS[TEST_TYPE];
    delete TYPE_TO_RENDERER[TEST_TYPE];
    delete ACTION_BUILDERS[TEST_TYPE];
    const idx = ASSET_TYPES.indexOf(TEST_TYPE);
    if (idx !== -1) ASSET_TYPES.splice(idx, 1);
  });

  test("registerAssetType populates TYPE_TO_RENDERER when rendererName is set", () => {
    registerAssetType(TEST_TYPE, makeWidgetSpec({ rendererName: "widget-md" }));
    expect(TYPE_TO_RENDERER[TEST_TYPE]).toBe("widget-md");
  });

  test("registerAssetType populates ACTION_BUILDERS when actionBuilder is set", () => {
    const builder = (ref: string) => `akm show ${ref} -> use widget`;
    registerAssetType(TEST_TYPE, makeWidgetSpec({ actionBuilder: builder }));
    expect(ACTION_BUILDERS[TEST_TYPE]).toBe(builder);
    expect(ACTION_BUILDERS[TEST_TYPE]("widget:foo")).toBe("akm show widget:foo -> use widget");
  });

  test("registration works regardless of import order (no deferred hooks needed)", () => {
    // The key property: TYPE_TO_RENDERER and ACTION_BUILDERS are populated
    // directly, not through deferred hooks. Importing asset-registry.ts
    // before or after asset-spec.ts doesn't matter because they share the
    // same singleton maps.
    const builder = (ref: string) => `akm show ${ref} -> render widget`;
    registerAssetType(
      TEST_TYPE,
      makeWidgetSpec({
        rendererName: "widget-md",
        actionBuilder: builder,
      }),
    );

    // Both maps should be populated after a single registerAssetType call
    expect(TYPE_TO_RENDERER[TEST_TYPE]).toBe("widget-md");
    expect(ACTION_BUILDERS[TEST_TYPE]).toBe(builder);
  });

  test("multiple registrations don't clobber each other", () => {
    const type1 = `${TEST_TYPE}-1`;
    const type2 = `${TEST_TYPE}-2`;

    try {
      registerAssetType(
        type1,
        makeWidgetSpec({
          stashDir: "widgets1",
          rendererName: "widget1-md",
          actionBuilder: (ref: string) => `action1 ${ref}`,
        }),
      );

      registerAssetType(
        type2,
        makeWidgetSpec({
          stashDir: "widgets2",
          rendererName: "widget2-md",
          actionBuilder: (ref: string) => `action2 ${ref}`,
        }),
      );

      expect(TYPE_TO_RENDERER[type1]).toBe("widget1-md");
      expect(TYPE_TO_RENDERER[type2]).toBe("widget2-md");
      expect(ACTION_BUILDERS[type1]("r")).toBe("action1 r");
      expect(ACTION_BUILDERS[type2]("r")).toBe("action2 r");
    } finally {
      delete ASSET_SPECS[type1];
      delete ASSET_SPECS[type2];
      delete TYPE_DIRS[type1];
      delete TYPE_DIRS[type2];
      delete TYPE_TO_RENDERER[type1];
      delete TYPE_TO_RENDERER[type2];
      delete ACTION_BUILDERS[type1];
      delete ACTION_BUILDERS[type2];
      for (const t of [type1, type2]) {
        const idx = ASSET_TYPES.indexOf(t);
        if (idx !== -1) ASSET_TYPES.splice(idx, 1);
      }
    }
  });

  test("_setAssetTypeHooks no longer exists in asset-spec", async () => {
    const assetSpec = await import("../src/asset-spec");
    expect("_setAssetTypeHooks" in assetSpec).toBe(false);
  });

  test("TYPE_TO_RENDERER contains built-in types", () => {
    expect(TYPE_TO_RENDERER.script).toBe("script-source");
    expect(TYPE_TO_RENDERER.skill).toBe("skill-md");
    expect(TYPE_TO_RENDERER.command).toBe("command-md");
    expect(TYPE_TO_RENDERER.agent).toBe("agent-md");
    expect(TYPE_TO_RENDERER.knowledge).toBe("knowledge-md");
    expect(TYPE_TO_RENDERER.memory).toBe("memory-md");
  });

  test("ACTION_BUILDERS contains built-in types", () => {
    expect(typeof ACTION_BUILDERS.script).toBe("function");
    expect(typeof ACTION_BUILDERS.skill).toBe("function");
    expect(typeof ACTION_BUILDERS.command).toBe("function");
    expect(typeof ACTION_BUILDERS.agent).toBe("function");
    expect(typeof ACTION_BUILDERS.knowledge).toBe("function");
    expect(typeof ACTION_BUILDERS.memory).toBe("function");
  });

  test("spec without rendererName leaves TYPE_TO_RENDERER unchanged for that type", () => {
    registerAssetType(TEST_TYPE, makeWidgetSpec());
    expect(TYPE_TO_RENDERER[TEST_TYPE]).toBeUndefined();
  });

  test("spec without actionBuilder leaves ACTION_BUILDERS unchanged for that type", () => {
    registerAssetType(TEST_TYPE, makeWidgetSpec());
    expect(ACTION_BUILDERS[TEST_TYPE]).toBeUndefined();
  });
});
