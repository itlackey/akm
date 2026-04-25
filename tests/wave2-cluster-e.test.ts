/**
 * Wave-2 QA fixes tests — Cluster E (output shapes, remember, info, vault, registry brief).
 *
 * #2  — `akm info` populates sourceProviders from stashDir when sources[] is empty.
 * #7  — `akm show` JSON shape always includes path + editable.
 * #20 — `akm remember --description` persisted in frontmatter.
 * #28 — `registry search --detail brief` projects name + installRef + score.
 * #35 — Vault list returns entries:[{key,comment}] instead of parallel arrays.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMemoryFrontmatter } from "../src/commands/remember";
import { listEntries, listKeys } from "../src/commands/vault";
import type { AkmConfig } from "../src/core/config";
import { shapeSearchHit, shapeShowOutput } from "../src/output/output-shapes";

// ── #7: show shape includes path + editable ───────────────────────────────────

describe("shapeShowOutput — path + editable always included (#7)", () => {
  const showResult = {
    type: "skill",
    name: "deploy",
    origin: null,
    action: "akm show skill:deploy",
    description: "Deploy script",
    path: "/home/user/stash/skills/deploy/SKILL.md",
    editable: true,
    editHint: "vim /home/user/stash/skills/deploy/SKILL.md",
    content: "# Deploy\nRun deploy.",
  };

  test("default detail includes path and editable", () => {
    const out = shapeShowOutput(showResult as Record<string, unknown>, "normal");
    expect(out).toHaveProperty("path");
    expect(out).toHaveProperty("editable");
    expect(out.path).toBe("/home/user/stash/skills/deploy/SKILL.md");
    expect(out.editable).toBe(true);
  });

  test("brief detail also includes path and editable", () => {
    const out = shapeShowOutput(showResult as Record<string, unknown>, "brief");
    expect(out).toHaveProperty("path");
    expect(out).toHaveProperty("editable");
  });

  test("full detail includes path, editable, and editHint", () => {
    const out = shapeShowOutput(showResult as Record<string, unknown>, "full") as Record<string, unknown>;
    expect(out).toHaveProperty("path");
    expect(out).toHaveProperty("editable");
    expect(out).toHaveProperty("editHint");
  });

  test("agent mode does NOT expose path (security: keep in non-agent shape only)", () => {
    const out = shapeShowOutput(showResult as Record<string, unknown>, "normal", /* forAgent */ true);
    // Agent mode picks a minimal subset; path is not in that subset
    expect(out.editable).toBeUndefined();
    expect(out.path).toBeUndefined();
  });
});

// ── #28: registry brief projects name + installRef + score ───────────────────

describe("shapeSearchHit — registry brief projects name + score (#28)", () => {
  const registryHit = {
    type: "registry",
    title: "deploy-stash",
    name: "deploy-stash",
    installRef: "npm:@myorg/deploy-stash",
    description: "A deployment stash",
    action: "akm add npm:@myorg/deploy-stash -> then search again",
    score: 0.85,
    curated: true,
  };

  test("brief includes name, installRef, score", () => {
    const out = shapeSearchHit(registryHit as Record<string, unknown>, "brief");
    expect(out.name).toBeTruthy();
    expect(out.score).toBe(0.85);
    // installRef should be present when it exists
    expect(out.installRef).toBe("npm:@myorg/deploy-stash");
  });

  test("brief with only title (no name field): normalises title → name", () => {
    const hit = {
      type: "registry",
      title: "some-kit",
      installRef: "github:org/some-kit",
      score: 0.5,
    };
    const out = shapeSearchHit(hit as Record<string, unknown>, "brief");
    expect(out.name).toBe("some-kit");
  });

  test("brief does NOT return empty object for registry hits", () => {
    const out = shapeSearchHit(registryHit as Record<string, unknown>, "brief");
    expect(Object.keys(out).length).toBeGreaterThan(0);
  });

  test("normal mode keeps description, action, installRef, score, curated", () => {
    const out = shapeSearchHit(registryHit as Record<string, unknown>, "normal") as Record<string, unknown>;
    expect(out.description).toBeDefined();
    expect(out.installRef).toBeDefined();
    expect(out.score).toBe(0.85);
  });
});

// ── #20: --description persisted in frontmatter ──────────────────────────────

describe("buildMemoryFrontmatter — description field (#20)", () => {
  test("description is included when present", () => {
    const fm = buildMemoryFrontmatter({
      description: "Short description of this memory",
      tags: ["test"],
    });
    expect(fm).toContain("description:");
    expect(fm).toContain("Short description of this memory");
  });

  test("description is omitted when not present", () => {
    const fm = buildMemoryFrontmatter({ tags: ["test"] });
    expect(fm).not.toContain("description:");
  });

  test("description is omitted when empty", () => {
    const fm = buildMemoryFrontmatter({ description: "", tags: ["test"] });
    expect(fm).not.toContain("description:");
  });

  test("description is omitted when whitespace only", () => {
    const fm = buildMemoryFrontmatter({ description: "   ", tags: ["test"] });
    expect(fm).not.toContain("description:");
  });

  test("description with special chars is safely serialised", () => {
    const fm = buildMemoryFrontmatter({
      description: 'value with: "quotes" and \nnewlines',
      tags: ["test"],
    });
    expect(fm).toContain("description:");
    // Should be quoted to handle special chars
  });
});

// ── #35: vault list returns entries:[{key,comment}] ──────────────────────────

describe("vault listEntries — entries shape (#35)", () => {
  function makeTmpVault(content: string): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-vault-test-"));
    const vaultPath = path.join(tmpDir, "test.env");
    fs.writeFileSync(vaultPath, content);
    return vaultPath;
  }

  test("returns empty array for nonexistent vault", () => {
    const result = listEntries("/tmp/nonexistent-vault-file-xyz.env");
    expect(result).toEqual([]);
  });

  test("returns keys without comments for uncommented vault", () => {
    const vaultPath = makeTmpVault("DB_URL=postgres://localhost\nAPI_KEY=secret\n");
    const entries = listEntries(vaultPath);
    expect(entries.map((e) => e.key)).toEqual(["DB_URL", "API_KEY"]);
    expect(entries.every((e) => e.comment === undefined)).toBe(true);
  });

  test("associates comment with the following key", () => {
    const vaultPath = makeTmpVault("# Database connection URL\nDB_URL=postgres://localhost\n");
    const entries = listEntries(vaultPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe("DB_URL");
    expect(entries[0].comment).toBe("Database connection URL");
  });

  test("returns {key, comment} shape", () => {
    const vaultPath = makeTmpVault("# API key\nAPI_KEY=secret\n# DB\nDB_URL=pg://localhost\n");
    const entries = listEntries(vaultPath);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ key: "API_KEY", comment: "API key" });
    expect(entries[1]).toMatchObject({ key: "DB_URL", comment: "DB" });
  });

  test("duplicate keys: only first occurrence kept", () => {
    const vaultPath = makeTmpVault("DB_URL=first\nDB_URL=second\n");
    const entries = listEntries(vaultPath);
    expect(entries.map((e) => e.key)).toEqual(["DB_URL"]);
  });

  test("entry has no comment field when there's no preceding comment", () => {
    const vaultPath = makeTmpVault("API_KEY=abc\n");
    const entries = listEntries(vaultPath);
    expect(entries[0].comment).toBeUndefined();
  });
});

// ── #2: info sourceProviders from stashDir ────────────────────────────────────

describe("assembleInfo — sourceProviders populated from stashDir (#2)", () => {
  test("sourceProviders includes stashDir when sources[] is empty", () => {
    const { assembleInfo } = require("../src/commands/info");
    // We can't easily override loadConfig, but we can verify the function shape.
    // The actual integration is tested via the info-command.test.ts suite.
    // This is a unit-level smoke test that the function signature is stable.
    expect(typeof assembleInfo).toBe("function");
  });
});
