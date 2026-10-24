/**
 * Output-shape tests:
 *
 *   - `akm show` JSON shape always includes path + editable.
 *   - `registry search --detail brief` projects name + installRef + score.
 */

import { describe, expect, test } from "bun:test";
import { shapeSearchHit, shapeShowOutput } from "../../../src/output/shapes/helpers";

// ── show shape includes path + editable ──────────────────────────────────────

describe("shapeShowOutput — path + editable always included (#7)", () => {
  const showResult = {
    type: "skill",
    name: "deploy",
    origin: null,
    action: "akm show skills/deploy",
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

  test("agent mode exposes exact local access information", () => {
    const out = shapeShowOutput(showResult as Record<string, unknown>, "normal", /* shape */ "agent");
    expect(out.editable).toBe(true);
    expect(out.path).toBe("/home/user/stash/skills/deploy/SKILL.md");
  });
});

// ── registry brief projects name + installRef + score ────────────────────────

describe("shapeSearchHit — registry brief projects name + score (#28)", () => {
  // Registry hits do not carry a `curated` boolean.
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

  test("normal mode keeps description, action, installRef, score (curated removed in v1)", () => {
    const out = shapeSearchHit(registryHit as Record<string, unknown>, "normal") as Record<string, unknown>;
    expect(out.description).toBeDefined();
    expect(out.installRef).toBeDefined();
    expect(out.score).toBe(0.85);
    expect(out).not.toHaveProperty("curated");
  });
});
