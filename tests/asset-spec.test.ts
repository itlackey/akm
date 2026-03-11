import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  ASSET_TYPES,
  deriveCanonicalAssetName,
  isRelevantAssetFile,
  resolveAssetPathFromName,
  SCRIPT_EXTENSIONS,
  TYPE_DIRS,
} from "../src/asset-spec";

// ── Constants ───────────────────────────────────────────────────────────────

describe("SCRIPT_EXTENSIONS", () => {
  test("contains all expected extensions", () => {
    for (const ext of [".sh", ".ts", ".js", ".ps1", ".cmd", ".bat"]) {
      expect(SCRIPT_EXTENSIONS.has(ext)).toBe(true);
    }
  });

  test("does not contain non-script extensions", () => {
    for (const ext of [".md", ".json", ".txt", ".py"]) {
      expect(SCRIPT_EXTENSIONS.has(ext)).toBe(false);
    }
  });
});

describe("ASSET_TYPES", () => {
  test("contains all six types", () => {
    expect(ASSET_TYPES).toContain("tool");
    expect(ASSET_TYPES).toContain("skill");
    expect(ASSET_TYPES).toContain("command");
    expect(ASSET_TYPES).toContain("agent");
    expect(ASSET_TYPES).toContain("knowledge");
    expect(ASSET_TYPES).toContain("script");
    expect(ASSET_TYPES).toHaveLength(6);
  });
});

describe("TYPE_DIRS", () => {
  test("maps types to directory names", () => {
    expect(TYPE_DIRS.tool).toBe("tools");
    expect(TYPE_DIRS.skill).toBe("skills");
    expect(TYPE_DIRS.command).toBe("commands");
    expect(TYPE_DIRS.agent).toBe("agents");
    expect(TYPE_DIRS.knowledge).toBe("knowledge");
    expect(TYPE_DIRS.script).toBe("scripts");
  });
});

// ── isRelevantAssetFile ─────────────────────────────────────────────────────

describe("isRelevantAssetFile", () => {
  test("tool: accepts script extensions", () => {
    expect(isRelevantAssetFile("tool", "deploy.sh")).toBe(true);
    expect(isRelevantAssetFile("tool", "run.ts")).toBe(true);
    expect(isRelevantAssetFile("tool", "script.js")).toBe(true);
    expect(isRelevantAssetFile("tool", "run.ps1")).toBe(true);
    expect(isRelevantAssetFile("tool", "run.cmd")).toBe(true);
    expect(isRelevantAssetFile("tool", "run.bat")).toBe(true);
  });

  test("tool: rejects non-script files", () => {
    expect(isRelevantAssetFile("tool", "README.md")).toBe(false);
    expect(isRelevantAssetFile("tool", "package.json")).toBe(false);
    expect(isRelevantAssetFile("tool", "data.txt")).toBe(false);
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

  test("script: accepts tool extensions and broader languages", () => {
    expect(isRelevantAssetFile("script", "deploy.sh")).toBe(true);
    expect(isRelevantAssetFile("script", "run.ts")).toBe(true);
    expect(isRelevantAssetFile("script", "script.js")).toBe(true);
    expect(isRelevantAssetFile("script", "run.py")).toBe(true);
    expect(isRelevantAssetFile("script", "tool.rb")).toBe(true);
    expect(isRelevantAssetFile("script", "main.go")).toBe(true);
    expect(isRelevantAssetFile("script", "run.lua")).toBe(true);
  });

  test("script: rejects non-script files", () => {
    expect(isRelevantAssetFile("script", "README.md")).toBe(false);
    expect(isRelevantAssetFile("script", "package.json")).toBe(false);
    expect(isRelevantAssetFile("script", "data.txt")).toBe(false);
  });
});

// ── deriveCanonicalAssetName ────────────────────────────────────────────────

describe("deriveCanonicalAssetName", () => {
  test("tool: returns relative path from type root", () => {
    const root = "/stash/tools";
    const file = path.join(root, "docker", "build.sh");
    expect(deriveCanonicalAssetName("tool", root, file)).toBe("docker/build.sh");
  });

  test("tool: returns file name for flat structure", () => {
    const root = "/stash/tools";
    const file = path.join(root, "deploy.sh");
    expect(deriveCanonicalAssetName("tool", root, file)).toBe("deploy.sh");
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

  test("script: returns relative path from type root", () => {
    const root = "/stash/scripts";
    const file = path.join(root, "utils", "cleanup.py");
    expect(deriveCanonicalAssetName("script", root, file)).toBe("utils/cleanup.py");
  });

  test("script: returns file name for flat structure", () => {
    const root = "/stash/scripts";
    const file = path.join(root, "deploy.sh");
    expect(deriveCanonicalAssetName("script", root, file)).toBe("deploy.sh");
  });
});

// ── resolveAssetPathFromName ────────────────────────────────────────────────

describe("resolveAssetPathFromName", () => {
  test("tool: joins type root with name", () => {
    expect(resolveAssetPathFromName("tool", "/stash/tools", "deploy.sh")).toBe(path.join("/stash/tools", "deploy.sh"));
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

  test("script: joins type root with name", () => {
    expect(resolveAssetPathFromName("script", "/stash/scripts", "deploy.sh")).toBe(
      path.join("/stash/scripts", "deploy.sh"),
    );
  });
});
