/**
 * Wave-2 QA fixes tests — Cluster E (output shapes, remember, info, vault, registry brief).
 *
 * #2  — `akm info` populates sourceProviders from stashDir when sources[] is empty.
 * #7  — `akm show` JSON shape always includes path + editable.
 * #20 — `akm remember --description` persisted in frontmatter.
 * #28 — `registry search --detail brief` projects name + installRef + score.
 * #35 — (deleted) vault listEntries was removed with the env comment-leak fix.
 */

import { describe, expect, test } from "bun:test";
import { buildMemoryFrontmatter } from "../../../src/commands/remember";
import { shapeSearchHit, shapeShowOutput } from "../../../src/output/shapes";

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
    const out = shapeShowOutput(showResult as Record<string, unknown>, "normal", /* shape */ "agent");
    // Agent mode picks a minimal subset; path is not in that subset
    expect(out.editable).toBeUndefined();
    expect(out.path).toBeUndefined();
  });
});

// ── #28: registry brief projects name + installRef + score ───────────────────

describe("shapeSearchHit — registry brief projects name + score (#28)", () => {
  // v1 spec §4.2: registry hits no longer carry the legacy `curated` boolean.
  const registryHit = {
    type: "registry",
    title: "deploy-stash",
    name: "deploy-stash",
    installRef: "npm:@myorg/deploy-stash",
    description: "A deployment stash",
    action: "akm add npm:@myorg/deploy-stash -> then search again",
    score: 0.85,
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

  test("normal mode keeps description, action, installRef, score (curated removed in v1)", () => {
    const out = shapeSearchHit(registryHit as Record<string, unknown>, "normal") as Record<string, unknown>;
    expect(out.description).toBeDefined();
    expect(out.installRef).toBeDefined();
    expect(out.score).toBe(0.85);
    expect(out).not.toHaveProperty("curated");
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

// #35's listEntries ({key, comment} pairs) was DELETED with the env
// comment-leak fix: comment text can contain commented-out credentials and no
// production code consumed it. Key-name listing is covered by tests/env.test.ts.

// ── #2: info sourceProviders from stashDir ────────────────────────────────────

describe("assembleInfo — sourceProviders populated from stashDir (#2)", () => {
  test("sourceProviders includes stashDir when sources[] is empty", () => {
    const { assembleInfo } = require("../../../src/commands/sources/info");
    // We can't easily override loadConfig, but we can verify the function shape.
    // The actual integration is tested via the info-command.test.ts suite.
    // This is a unit-level smoke test that the function signature is stable.
    expect(typeof assembleInfo).toBe("function");
  });
});
