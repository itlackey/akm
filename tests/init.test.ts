/**
 * Tests for `akm init` (#284 GAP-HIGH 12).
 *
 * Verifies that `akmInit` materialises every registered asset-type directory
 * on disk, including the `lessons/` directory required by the proposal queue.
 * Adds a simple regression guard so a future TYPE_DIRS rename doesn't quietly
 * drop the lessons folder from the bootstrap.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { akmInit } from "../src/commands/sources/init";
import { loadUserConfig, saveConfig } from "../src/core/config/config";
import { resolveTypeConventions } from "../src/core/standards/resolve-type-conventions";
import { type Cleanup, sandboxHome, sandboxXdgCacheHome, sandboxXdgConfigHome } from "./_helpers/sandbox";

/** Asset types that ship a default per-type SOFT convention template (#646). */
const CONVENTION_TYPES = ["lesson", "skill", "command", "agent", "knowledge", "memory", "workflow", "script", "fact"];

function conventionPath(stashDir: string, type: string): string {
  return path.join(stashDir, "facts", "conventions", "assets", `${type}.md`);
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

let cleanup: Cleanup = () => {};

beforeEach(() => {
  process.env.AKM_FORCE_INIT_TMP_STASH = "1";
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const homeResult = sandboxHome(cfgResult.cleanup);
  cleanup = homeResult.cleanup;
});

afterEach(() => {
  delete process.env.AKM_FORCE_INIT_TMP_STASH;
  cleanup();
  cleanup = () => {};
});

describe("akm init", () => {
  test("creates the lessons/ directory on disk under the stash root", async () => {
    const stashDir = makeTempDir("akm-init-stash-");
    // Remove dir so init reports created=true
    fs.rmSync(stashDir, { recursive: true, force: true });
    const result = await akmInit({ dir: stashDir });
    expect(result.stashDir).toBe(stashDir);
    expect(result.created).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "lessons"))).toBe(true);
    // Also verify other core type dirs exist (fingerprint of TYPE_DIRS sweep).
    expect(fs.existsSync(path.join(stashDir, "skills"))).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "memories"))).toBe(true);
  });

  test("scaffolds a .gitignore ignoring env/ and secrets/ (08-F1)", async () => {
    const stashDir = makeTempDir("akm-init-gitignore-");
    fs.rmSync(stashDir, { recursive: true, force: true });
    await akmInit({ dir: stashDir });
    const gitignore = fs.readFileSync(path.join(stashDir, ".gitignore"), "utf8");
    expect(gitignore).toMatch(/^env\/$/m);
    expect(gitignore).toMatch(/^secrets\/$/m);
  });

  test("gitignore scaffold is idempotent and preserves the user's own rules", async () => {
    const stashDir = makeTempDir("akm-init-gitignore-idem-");
    fs.rmSync(stashDir, { recursive: true, force: true });
    fs.mkdirSync(stashDir, { recursive: true });
    fs.writeFileSync(path.join(stashDir, ".gitignore"), "# my rules\n*.log\n");

    await akmInit({ dir: stashDir });
    await akmInit({ dir: stashDir }); // second run must not duplicate the block

    const gitignore = fs.readFileSync(path.join(stashDir, ".gitignore"), "utf8");
    expect(gitignore).toContain("*.log"); // user rule preserved
    expect(gitignore).toMatch(/^env\/$/m);
    const markerCount = gitignore.split("# akm: keep secret material out of git by default").length - 1;
    expect(markerCount).toBe(1);
  });

  test("re-running on an existing stash is idempotent and keeps lessons/", async () => {
    const stashDir = makeTempDir("akm-init-stash-2-");
    await akmInit({ dir: stashDir });
    // Drop the lessons dir to confirm a re-run rebuilds it.
    fs.rmSync(path.join(stashDir, "lessons"), { recursive: true, force: true });
    expect(fs.existsSync(path.join(stashDir, "lessons"))).toBe(false);
    await akmInit({ dir: stashDir });
    expect(fs.existsSync(path.join(stashDir, "lessons"))).toBe(true);
  });

  test("copies stash skeleton files to a newly created stash", async () => {
    const stashDir = makeTempDir("akm-init-skeleton-");
    fs.rmSync(stashDir, { recursive: true, force: true });
    const result = await akmInit({ dir: stashDir });
    expect(result.created).toBe(true);
    const readmePath = path.join(stashDir, "README.md");
    expect(fs.existsSync(readmePath)).toBe(true);
    const content = fs.readFileSync(readmePath, "utf8");
    expect(content).toContain("AKM Stash");
    expect(content).toContain("akm curate");
    expect(content).toContain("akm search");
  });

  test("does not overwrite skeleton files that already exist", async () => {
    const stashDir = makeTempDir("akm-init-skeleton-existing-");
    fs.rmSync(stashDir, { recursive: true, force: true });
    await akmInit({ dir: stashDir });
    const readmePath = path.join(stashDir, "README.md");
    fs.writeFileSync(readmePath, "custom content", "utf8");
    await akmInit({ dir: stashDir });
    expect(fs.readFileSync(readmePath, "utf8")).toBe("custom content");
  });

  test("seeds default per-type SOFT convention templates (#646)", async () => {
    const stashDir = makeTempDir("akm-init-conventions-");
    fs.rmSync(stashDir, { recursive: true, force: true });
    await akmInit({ dir: stashDir });

    for (const type of CONVENTION_TYPES) {
      expect(fs.existsSync(conventionPath(stashDir, type))).toBe(true);
      // Resolves through the same disk reader the authoring seam uses, with a
      // non-empty soft body (frontmatter stripped).
      expect(resolveTypeConventions(stashDir, type).length).toBeGreaterThan(0);
    }
  });

  test("convention templates carry category: convention and NO hard-rule phrasing (#645 boundary)", async () => {
    const stashDir = makeTempDir("akm-init-conv-soft-");
    fs.rmSync(stashDir, { recursive: true, force: true });
    await akmInit({ dir: stashDir });

    for (const type of CONVENTION_TYPES) {
      const raw = fs.readFileSync(conventionPath(stashDir, type), "utf8");
      expect(raw).toContain("category: convention");
      // Must not restate the validator's HARD bounds — those live solely in
      // src/core/authoring-rules.ts. A user editing these must not weaken the gate.
      expect(raw).not.toContain("20–400");
      expect(raw).not.toContain("20-400");
      expect(raw).not.toContain("exactly two");
      expect(raw).not.toMatch(/\b400\b/);
    }
  });

  test("re-init backfills a deleted convention file but does not overwrite an edited one", async () => {
    const stashDir = makeTempDir("akm-init-conv-backfill-");
    fs.rmSync(stashDir, { recursive: true, force: true });
    await akmInit({ dir: stashDir });

    // Delete one convention file and edit another.
    const skillPath = conventionPath(stashDir, "skill");
    const factPath = conventionPath(stashDir, "fact");
    fs.rmSync(skillPath, { force: true });
    fs.writeFileSync(factPath, "user-edited convention", "utf8");
    expect(fs.existsSync(skillPath)).toBe(false);

    // Re-init on the EXISTING stash should backfill the missing file...
    await akmInit({ dir: stashDir });
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(resolveTypeConventions(stashDir, "skill").length).toBeGreaterThan(0);
    // ...but never clobber the user-edited one.
    expect(fs.readFileSync(factPath, "utf8")).toBe("user-edited convention");
  });

  test("recursive skeleton copy preserves nested subpaths under the stash root", async () => {
    const stashDir = makeTempDir("akm-init-conv-subpath-");
    fs.rmSync(stashDir, { recursive: true, force: true });
    await akmInit({ dir: stashDir });
    // The nested asset landed at its mirrored subpath, not flattened to root.
    expect(fs.existsSync(conventionPath(stashDir, "skill"))).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "skill.md"))).toBe(false);
  });

  // ── Default-stash persist decision matrix (#footgun: --dir must not clobber) ──
  describe("default stash persist decision matrix", () => {
    test("no --dir, no existing stashDir → default-path init persists stashDir", async () => {
      expect(loadUserConfig().stashDir).toBeUndefined();
      const result = await akmInit();
      expect(result.defaultStashUpdated).toBe(true);
      expect(result.previousStashDir).toBeUndefined();
      expect(loadUserConfig().stashDir).toBe(result.stashDir);
    });

    test("--dir X, NO existing stashDir → first-time bootstrap persists X", async () => {
      const dirX = makeTempDir("akm-init-bootstrap-");
      fs.rmSync(dirX, { recursive: true, force: true });
      expect(loadUserConfig().stashDir).toBeUndefined();
      const result = await akmInit({ dir: dirX });
      expect(result.defaultStashUpdated).toBe(true);
      expect(loadUserConfig().stashDir).toBe(dirX);
    });

    test("--dir X, existing stashDir=Y, NO --set-default → Y preserved, X scaffolded", async () => {
      const dirY = makeTempDir("akm-init-existing-Y-");
      saveConfig({ ...loadUserConfig(), stashDir: dirY });

      const dirX = makeTempDir("akm-init-secondary-X-");
      fs.rmSync(dirX, { recursive: true, force: true });
      const result = await akmInit({ dir: dirX });

      // Config still points at Y — default pointer left alone.
      expect(loadUserConfig().stashDir).toBe(dirY);
      expect(result.stashDir).toBe(dirX);
      expect(result.defaultStashUpdated).toBe(false);
      expect(result.previousStashDir).toBe(dirY);

      // ...but X is still fully scaffolded (regression for the non-persist case).
      expect(fs.existsSync(path.join(dirX, "lessons"))).toBe(true);
      expect(fs.existsSync(path.join(dirX, "facts"))).toBe(true);
      expect(fs.existsSync(conventionPath(dirX, "skill"))).toBe(true);
    });

    test("--dir X, existing stashDir=Y, WITH --set-default → config now points at X", async () => {
      const dirY = makeTempDir("akm-init-setdefault-Y-");
      saveConfig({ ...loadUserConfig(), stashDir: dirY });

      const dirX = makeTempDir("akm-init-setdefault-X-");
      fs.rmSync(dirX, { recursive: true, force: true });
      const result = await akmInit({ dir: dirX, setDefault: true });

      expect(loadUserConfig().stashDir).toBe(dirX);
      expect(result.defaultStashUpdated).toBe(true);
      expect(result.previousStashDir).toBeUndefined();
    });

    test("--dir X where X equals existing stashDir → no-op, no spurious rewrite", async () => {
      const dirX = makeTempDir("akm-init-equal-");
      saveConfig({ ...loadUserConfig(), stashDir: dirX });
      const result = await akmInit({ dir: dirX });
      expect(result.defaultStashUpdated).toBe(false);
      expect(loadUserConfig().stashDir).toBe(dirX);
    });
  });

  test("source convention templates ship under src/assets and are picked up by copy-assets", () => {
    // Build sanity: the embedded source files exist (copy-assets mirrors
    // src/assets/**/* into dist/assets/ verbatim, so shipping follows).
    const repoRoot = path.resolve(import.meta.dir, "..");
    for (const type of CONVENTION_TYPES) {
      const srcPath = path.join(
        repoRoot,
        "src",
        "assets",
        "stash-skeleton",
        "facts",
        "conventions",
        "assets",
        `${type}.md`,
      );
      expect(fs.existsSync(srcPath)).toBe(true);
    }
  });
});
