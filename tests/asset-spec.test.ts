import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import {
  ASSET_SPECS,
  ASSET_TYPES,
  deriveCanonicalAssetName,
  isRelevantAssetFile,
  registerAssetType,
  resolveAssetPathFromName,
  SCRIPT_EXTENSIONS,
  TYPE_DIRS,
} from "../src/asset-spec";
// Import local-search to wire the deferred hooks (_setAssetTypeHooks) so that
// registerAssetType automatically populates TYPE_TO_RENDERER and ACTION_BUILDERS.
import { ACTION_BUILDERS, TYPE_TO_RENDERER } from "../src/local-search";

// ── Constants ───────────────────────────────────────────────────────────────

describe("SCRIPT_EXTENSIONS", () => {
  test("contains all expected extensions", () => {
    for (const ext of [".sh", ".ts", ".js", ".ps1", ".cmd", ".bat", ".py", ".rb", ".go"]) {
      expect(SCRIPT_EXTENSIONS.has(ext)).toBe(true);
    }
  });

  test("does not contain non-script extensions", () => {
    for (const ext of [".md", ".json", ".txt"]) {
      expect(SCRIPT_EXTENSIONS.has(ext)).toBe(false);
    }
  });
});

describe("ASSET_TYPES", () => {
  test("contains all built-in types", () => {
    expect(ASSET_TYPES).toContain("skill");
    expect(ASSET_TYPES).toContain("command");
    expect(ASSET_TYPES).toContain("agent");
    expect(ASSET_TYPES).toContain("knowledge");
    expect(ASSET_TYPES).toContain("script");
    expect(ASSET_TYPES).toContain("memory");
    expect(ASSET_TYPES).toHaveLength(6);
  });
});

describe("TYPE_DIRS", () => {
  test("maps types to directory names", () => {
    expect(TYPE_DIRS.skill).toBe("skills");
    expect(TYPE_DIRS.command).toBe("commands");
    expect(TYPE_DIRS.agent).toBe("agents");
    expect(TYPE_DIRS.knowledge).toBe("knowledge");
    expect(TYPE_DIRS.script).toBe("scripts");
    expect(TYPE_DIRS.memory).toBe("memories");
  });
});

// ── isRelevantAssetFile ─────────────────────────────────────────────────────

describe("isRelevantAssetFile", () => {
  test("script: accepts all script extensions", () => {
    expect(isRelevantAssetFile("script", "deploy.sh")).toBe(true);
    expect(isRelevantAssetFile("script", "run.ts")).toBe(true);
    expect(isRelevantAssetFile("script", "script.js")).toBe(true);
    expect(isRelevantAssetFile("script", "run.ps1")).toBe(true);
    expect(isRelevantAssetFile("script", "run.cmd")).toBe(true);
    expect(isRelevantAssetFile("script", "run.bat")).toBe(true);
    expect(isRelevantAssetFile("script", "run.py")).toBe(true);
    expect(isRelevantAssetFile("script", "main.go")).toBe(true);
    expect(isRelevantAssetFile("script", "run.lua")).toBe(true);
  });

  test("script: rejects non-script files", () => {
    expect(isRelevantAssetFile("script", "README.md")).toBe(false);
    expect(isRelevantAssetFile("script", "package.json")).toBe(false);
    expect(isRelevantAssetFile("script", "data.txt")).toBe(false);
  });

  test("skill: only accepts SKILL.md", () => {
    expect(isRelevantAssetFile("skill", "SKILL.md")).toBe(true);
    expect(isRelevantAssetFile("skill", "skill.md")).toBe(false);
    expect(isRelevantAssetFile("skill", "README.md")).toBe(false);
    expect(isRelevantAssetFile("skill", "deploy.sh")).toBe(false);
  });

  test("command: accepts .md files", () => {
    expect(isRelevantAssetFile("command", "release.md")).toBe(true);
    expect(isRelevantAssetFile("command", "SETUP.MD")).toBe(true);
    expect(isRelevantAssetFile("command", "script.sh")).toBe(false);
  });

  test("agent: accepts .md files", () => {
    expect(isRelevantAssetFile("agent", "architect.md")).toBe(true);
    expect(isRelevantAssetFile("agent", "coach.MD")).toBe(true);
    expect(isRelevantAssetFile("agent", "script.ts")).toBe(false);
  });

  test("knowledge: accepts .md files", () => {
    expect(isRelevantAssetFile("knowledge", "guide.md")).toBe(true);
    expect(isRelevantAssetFile("knowledge", "data.json")).toBe(false);
  });
});

// ── deriveCanonicalAssetName ────────────────────────────────────────────────

describe("deriveCanonicalAssetName", () => {
  test("script: returns relative path from type root", () => {
    const root = "/stash/scripts";
    const file = path.join(root, "docker", "build.sh");
    expect(deriveCanonicalAssetName("script", root, file)).toBe("docker/build.sh");
  });

  test("script: returns file name for flat structure", () => {
    const root = "/stash/scripts";
    const file = path.join(root, "deploy.sh");
    expect(deriveCanonicalAssetName("script", root, file)).toBe("deploy.sh");
  });

  test("skill: returns directory name for SKILL.md", () => {
    const root = "/stash/skills";
    const file = path.join(root, "code-review", "SKILL.md");
    expect(deriveCanonicalAssetName("skill", root, file)).toBe("code-review");
  });

  test("skill: returns undefined for SKILL.md at root", () => {
    const root = "/stash/skills";
    const file = path.join(root, "SKILL.md");
    expect(deriveCanonicalAssetName("skill", root, file)).toBeUndefined();
  });

  test("command: returns relative path without .md extension", () => {
    const root = "/stash/commands";
    const file = path.join(root, "release.md");
    expect(deriveCanonicalAssetName("command", root, file)).toBe("release");
  });

  test("agent: returns relative path without .md extension", () => {
    const root = "/stash/agents";
    const file = path.join(root, "architect.md");
    expect(deriveCanonicalAssetName("agent", root, file)).toBe("architect");
  });

  test("knowledge: returns relative path without .md extension", () => {
    const root = "/stash/knowledge";
    const file = path.join(root, "guide.md");
    expect(deriveCanonicalAssetName("knowledge", root, file)).toBe("guide");
  });

  test("script: returns relative path including subdirectory", () => {
    const root = "/stash/scripts";
    const file = path.join(root, "utils", "cleanup.py");
    expect(deriveCanonicalAssetName("script", root, file)).toBe("utils/cleanup.py");
  });
});

// ── resolveAssetPathFromName ────────────────────────────────────────────────

describe("resolveAssetPathFromName", () => {
  test("script: joins type root with name", () => {
    expect(resolveAssetPathFromName("script", "/stash/scripts", "deploy.sh")).toBe(
      path.join("/stash/scripts", "deploy.sh"),
    );
  });

  test("skill: appends SKILL.md to name directory", () => {
    expect(resolveAssetPathFromName("skill", "/stash/skills", "code-review")).toBe(
      path.join("/stash/skills", "code-review", "SKILL.md"),
    );
  });

  test("command: joins type root with name", () => {
    expect(resolveAssetPathFromName("command", "/stash/commands", "release.md")).toBe(
      path.join("/stash/commands", "release.md"),
    );
  });
});

// ── R3.17: registerAssetType — single-call full registration ────────────────
//
// When `registerAssetType` is called with `rendererName` and `actionBuilder`
// in the spec, it should automatically wire those into TYPE_TO_RENDERER and
// ACTION_BUILDERS (via the deferred hooks set by local-search.ts).
// This means callers need only one `registerAssetType` call to fully integrate
// a new asset type with the search and renderer systems.

describe("registerAssetType", () => {
  const TEST_TYPE = "widget-test-r317";

  afterEach(() => {
    // Clean up the test type to avoid polluting other tests
    delete ASSET_SPECS[TEST_TYPE];
    delete TYPE_DIRS[TEST_TYPE];
    delete TYPE_TO_RENDERER[TEST_TYPE];
    delete ACTION_BUILDERS[TEST_TYPE];
    const idx = ASSET_TYPES.indexOf(TEST_TYPE);
    if (idx !== -1) ASSET_TYPES.splice(idx, 1);
  });

  test("adds the new type to ASSET_SPECS and TYPE_DIRS", () => {
    registerAssetType(TEST_TYPE, {
      stashDir: "widgets",
      isRelevantFile: (f) => f.endsWith(".widget"),
      toCanonicalName: (_root, fp) => path.basename(fp, ".widget"),
      toAssetPath: (root, name) => path.join(root, `${name}.widget`),
    });

    expect(ASSET_SPECS[TEST_TYPE]).toBeDefined();
    expect(TYPE_DIRS[TEST_TYPE]).toBe("widgets");
    expect(ASSET_TYPES).toContain(TEST_TYPE);
  });

  test("automatically registers rendererName into TYPE_TO_RENDERER", () => {
    registerAssetType(TEST_TYPE, {
      stashDir: "widgets",
      isRelevantFile: (f) => f.endsWith(".widget"),
      toCanonicalName: (_root, fp) => path.basename(fp, ".widget"),
      toAssetPath: (root, name) => path.join(root, `${name}.widget`),
      rendererName: "widget-md",
    });

    expect(TYPE_TO_RENDERER[TEST_TYPE]).toBe("widget-md");
  });

  test("automatically registers actionBuilder into ACTION_BUILDERS", () => {
    const builder = (ref: string) => `akm show ${ref} -> use widget`;
    registerAssetType(TEST_TYPE, {
      stashDir: "widgets",
      isRelevantFile: (f) => f.endsWith(".widget"),
      toCanonicalName: (_root, fp) => path.basename(fp, ".widget"),
      toAssetPath: (root, name) => path.join(root, `${name}.widget`),
      actionBuilder: builder,
    });

    expect(ACTION_BUILDERS[TEST_TYPE]).toBe(builder);
    expect(ACTION_BUILDERS[TEST_TYPE]?.("widget:my-widget")).toBe("akm show widget:my-widget -> use widget");
  });

  test("registers both rendererName and actionBuilder in a single call", () => {
    const builder = (ref: string) => `akm show ${ref} -> render widget`;
    registerAssetType(TEST_TYPE, {
      stashDir: "widgets",
      isRelevantFile: (f) => f.endsWith(".widget"),
      toCanonicalName: (_root, fp) => path.basename(fp, ".widget"),
      toAssetPath: (root, name) => path.join(root, `${name}.widget`),
      rendererName: "widget-md",
      actionBuilder: builder,
    });

    // Both search-system hooks should be populated after the single call
    expect(TYPE_TO_RENDERER[TEST_TYPE]).toBe("widget-md");
    expect(ACTION_BUILDERS[TEST_TYPE]).toBe(builder);
  });

  test("spec without rendererName leaves TYPE_TO_RENDERER unchanged for that type", () => {
    registerAssetType(TEST_TYPE, {
      stashDir: "widgets",
      isRelevantFile: (f) => f.endsWith(".widget"),
      toCanonicalName: (_root, fp) => path.basename(fp, ".widget"),
      toAssetPath: (root, name) => path.join(root, `${name}.widget`),
      // intentionally no rendererName
    });

    expect(TYPE_TO_RENDERER[TEST_TYPE]).toBeUndefined();
  });
});
