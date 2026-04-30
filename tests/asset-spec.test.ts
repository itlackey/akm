import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { ACTION_BUILDERS, TYPE_TO_RENDERER } from "../src/core/asset-registry";
import {
  ASSET_SPECS,
  deregisterAssetType,
  deriveCanonicalAssetName,
  getAssetTypes,
  isRelevantAssetFile,
  registerAssetType,
  resolveAssetPathFromName,
  SCRIPT_EXTENSIONS,
  TYPE_DIRS,
} from "../src/core/asset-spec";

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

describe("getAssetTypes", () => {
  test("contains all built-in types", () => {
    const types = getAssetTypes();
    expect(types).toContain("skill");
    expect(types).toContain("command");
    expect(types).toContain("agent");
    expect(types).toContain("knowledge");
    expect(types).toContain("workflow");
    expect(types).toContain("script");
    expect(types).toContain("memory");
    expect(types).toContain("vault");
    expect(types).toContain("wiki");
    expect(types).toContain("lesson");
    expect(types).toHaveLength(10);
  });
});

describe("TYPE_DIRS", () => {
  test("maps types to directory names", () => {
    expect(TYPE_DIRS.skill).toBe("skills");
    expect(TYPE_DIRS.command).toBe("commands");
    expect(TYPE_DIRS.agent).toBe("agents");
    expect(TYPE_DIRS.knowledge).toBe("knowledge");
    expect(TYPE_DIRS.workflow).toBe("workflows");
    expect(TYPE_DIRS.script).toBe("scripts");
    expect(TYPE_DIRS.memory).toBe("memories");
    expect(TYPE_DIRS.vault).toBe("vaults");
    expect(TYPE_DIRS.lesson).toBe("lessons");
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

  test("workflow: accepts .md files", () => {
    expect(isRelevantAssetFile("workflow", "release.md")).toBe(true);
    expect(isRelevantAssetFile("workflow", "release.txt")).toBe(false);
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

  test("workflow: returns relative path without .md extension", () => {
    const root = "/stash/workflows";
    const file = path.join(root, "release", "ship.md");
    expect(deriveCanonicalAssetName("workflow", root, file)).toBe("release/ship");
  });

  test("script: returns relative path including subdirectory", () => {
    const root = "/stash/scripts";
    const file = path.join(root, "utils", "cleanup.py");
    expect(deriveCanonicalAssetName("script", root, file)).toBe("utils/cleanup.py");
  });

  test("vault: top-level <name>.env → <name>", () => {
    const root = "/stash/vaults";
    expect(deriveCanonicalAssetName("vault", root, path.join(root, "prod.env"))).toBe("prod");
  });

  test("vault: top-level `.env` → `default`", () => {
    const root = "/stash/vaults";
    expect(deriveCanonicalAssetName("vault", root, path.join(root, ".env"))).toBe("default");
  });

  test("vault: nested <dir>/<name>.env → <dir>/<name>", () => {
    const root = "/stash/vaults";
    expect(deriveCanonicalAssetName("vault", root, path.join(root, "team", "prod.env"))).toBe("team/prod");
  });

  test("vault: nested <dir>/.env → <dir>/default", () => {
    const root = "/stash/vaults";
    expect(deriveCanonicalAssetName("vault", root, path.join(root, "team", ".env"))).toBe("team/default");
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

  test("workflow: joins type root with name", () => {
    expect(resolveAssetPathFromName("workflow", "/stash/workflows", "release/ship")).toBe(
      path.join("/stash/workflows", "release/ship.md"),
    );
  });
});

// ── R3.17: registerAssetType — single-call full registration ────────────────
//
// When `registerAssetType` is called with `rendererName` and `actionBuilder`
// in the spec, it should automatically populate TYPE_TO_RENDERER and
// ACTION_BUILDERS via the asset-registry singleton.
// This means callers need only one `registerAssetType` call to fully integrate
// a new asset type with the search and renderer systems.

describe("registerAssetType", () => {
  const TEST_TYPE = "widget-test-r317";

  afterEach(() => {
    // Clean up the test type to avoid polluting other tests
    deregisterAssetType(TEST_TYPE);
    delete TYPE_TO_RENDERER[TEST_TYPE];
    delete ACTION_BUILDERS[TEST_TYPE];
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
    expect(getAssetTypes()).toContain(TEST_TYPE);
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
