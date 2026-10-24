/**
 * Wave-2 QA fixes tests — Cluster E (output shapes, remember, info, vault, registry brief).
 *
 * #7  — `akm show` JSON shape always includes path + editable.
 * #28 — `registry search --detail brief` projects name + installRef + score.
 * #35 — (deleted) vault listEntries was removed with the env comment-leak fix.
 *
 * #2 (info sourceProviders) and #20 (remember --description frontmatter) were
 * covered here only by unit-shape-smoke tests; Phase 2 triage moved their
 * real coverage elsewhere (see the deletion notes below) so this file no
 * longer imports `assembleInfo` or `buildMemoryFrontmatter`.
 */

import { describe, expect, test } from "bun:test";
import { shapeSearchHit, shapeShowOutput } from "../../../src/output/shapes/helpers";

// ── #7: show shape includes path + editable ───────────────────────────────────

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

  // D6 (Phase 2 triage): "brief does NOT return empty object for registry
  // hits" was DELETED here — it asserted `Object.keys(out).length > 0` on
  // this same `registryHit` fixture, which `:72-78` above already asserts
  // key-by-key (name/score/installRef individually present).

  test("normal mode keeps description, action, installRef, score (curated removed in v1)", () => {
    const out = shapeSearchHit(registryHit as Record<string, unknown>, "normal") as Record<string, unknown>;
    expect(out.description).toBeDefined();
    expect(out.installRef).toBeDefined();
    expect(out.score).toBe(0.85);
    expect(out).not.toHaveProperty("curated");
  });
});

// D4 (Phase 2 triage): the "buildMemoryFrontmatter — description field (#20)"
// describe block (5 tests: included/omitted-absent/omitted-empty/
// omitted-whitespace/special-chars-serialised) was DELETED here. It is
// superseded by tests/remember-unit.test.ts:36-97 ("buildMemoryFrontmatter —
// YAML injection guard"), which actually parses the emitted YAML (this file's
// version only did substring `toContain` checks) and pins the same
// included/omitted-absent/omitted-whitespace/special-chars behavior, plus the
// exact `description: ""` case added there alongside this deletion so the
// omitted-when-empty case is not lost.

// #35's listEntries ({key, comment} pairs) was DELETED with the env
// comment-leak fix: comment text can contain commented-out credentials and no
// production code consumed it. Key-name listing is covered by tests/env.test.ts.

// D5 (Phase 2 triage): the "assembleInfo — sourceProviders populated from
// stashDir (#2)" describe block was DELETED here. Its sole test asserted only
// `typeof assembleInfo === "function"` — its own comment called it a
// signature smoke test. Real coverage now lives in
// tests/integration/info-command.test.ts ("returns sourceProviders from
// config" and, strengthened alongside this deletion, "sourceProviders is
// empty with no configured bundle, and reflects a configured bundle").
