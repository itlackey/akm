/**
 * Regression tests for issue #157:
 * `akm workflow create <name>` failing with "Resolved workflow path escapes the
 * stash" for valid bare names on systems with symlinks in the path hierarchy.
 *
 * Root cause: `safeRealpath` resolved existing directories through symlinks
 * (via `fs.realpathSync`) but fell back to the raw `path.resolve` for
 * non-existent paths.  When the directory tree contains a symlink (e.g.
 * macOS /tmp → /private/tmp, or a HOME that is itself a symlink), the two
 * resolved paths could disagree, causing `isWithin` to return false.
 *
 * Fix: walk up to the nearest existing ancestor, resolve that ancestor via
 * `realpathSync`, then reconstruct the full path.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorkflowAsset } from "../src/workflows/workflow-authoring";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.AKM_STASH_DIR;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CACHE_HOME;
});

// ── Happy path: clean stash ─────────────────────────────────────────────────

describe("createWorkflowAsset — clean stash (issue #157)", () => {
  test("bare name resolves correctly in a freshly created stash", () => {
    const stashDir = makeTempDir("akm-issue157-stash-");
    const xdgCache = makeTempDir("akm-issue157-cache-");
    const xdgConfig = makeTempDir("akm-issue157-config-");
    process.env.AKM_STASH_DIR = stashDir;
    process.env.XDG_CACHE_HOME = xdgCache;
    process.env.XDG_CONFIG_HOME = xdgConfig;

    const result = createWorkflowAsset({ name: "agentic-test-workflow" });

    expect(result.ref).toBe("workflow:agentic-test-workflow");
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.path).toBe(path.join(stashDir, "workflows", "agentic-test-workflow.md"));
  });

  test("bare name with hyphens resolves correctly", () => {
    const stashDir = makeTempDir("akm-issue157-stash-");
    process.env.AKM_STASH_DIR = stashDir;

    const result = createWorkflowAsset({ name: "my-multi-step-workflow" });

    expect(result.ref).toBe("workflow:my-multi-step-workflow");
    expect(fs.existsSync(result.path)).toBe(true);
  });

  test("nested name (subdirectory) resolves correctly", () => {
    const stashDir = makeTempDir("akm-issue157-stash-");
    process.env.AKM_STASH_DIR = stashDir;

    const result = createWorkflowAsset({ name: "team/release-flow" });

    expect(result.ref).toBe("workflow:team/release-flow");
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.path).toContain(path.join("workflows", "team", "release-flow.md"));
  });

  test("resolves correctly when stash dir path contains a symlink", () => {
    // Create a real directory and a symlink pointing to it, then use the
    // symlink path as the stash dir.  This simulates environments where HOME
    // or a parent directory is a symlink (e.g. macOS /tmp → /private/tmp).
    const realDir = makeTempDir("akm-issue157-real-");
    const symlinkDir = path.join(os.tmpdir(), `akm-issue157-link-${Date.now()}`);
    tempDirs.push(symlinkDir); // cleaned up by afterEach (rm -rf is ok for dead links)
    fs.symlinkSync(realDir, symlinkDir);

    process.env.AKM_STASH_DIR = symlinkDir;

    // Must not throw "Resolved workflow path escapes the stash"
    const result = createWorkflowAsset({ name: "agentic-test-workflow" });

    expect(result.ref).toBe("workflow:agentic-test-workflow");
    expect(fs.existsSync(result.path)).toBe(true);
  });

  test("--from succeeds with valid workflow markdown", () => {
    const stashDir = makeTempDir("akm-issue157-stash-");
    const srcDir = makeTempDir("akm-issue157-src-");
    process.env.AKM_STASH_DIR = stashDir;

    const srcPath = path.join(srcDir, "release.md");
    const content = `---
description: A release workflow
tags:
  - release
---

# Workflow: Release

## Step: Validate
Step ID: validate

### Instructions
Check all inputs.

### Completion Criteria
- Inputs confirmed
`;
    fs.writeFileSync(srcPath, content, "utf8");

    const result = createWorkflowAsset({ name: "release", from: srcPath });

    expect(result.ref).toBe("workflow:release");
    expect(fs.existsSync(result.path)).toBe(true);
    expect(fs.readFileSync(result.path, "utf8")).toContain("# Workflow: Release");
  });
});

// ── Security: path traversal must still be rejected ─────────────────────────

describe("createWorkflowAsset — path escape rejection", () => {
  test("../traversal is rejected", () => {
    const stashDir = makeTempDir("akm-issue157-stash-");
    process.env.AKM_STASH_DIR = stashDir;

    expect(() => createWorkflowAsset({ name: "../outside" })).toThrow("must be a relative path without");
  });

  test("deep traversal is rejected", () => {
    const stashDir = makeTempDir("akm-issue157-stash-");
    process.env.AKM_STASH_DIR = stashDir;

    expect(() => createWorkflowAsset({ name: "a/../../outside" })).toThrow("must be a relative path without");
  });

  test("absolute path is sanitized into a relative name inside the stash", () => {
    // normalizeWorkflowName strips leading slashes, so "/etc/passwd" becomes
    // "etc/passwd" — a relative name that resolves safely inside the stash.
    // This is by design: the function converts absolute-looking user input
    // into a relative name rather than treating it as a filesystem path.
    const stashDir = makeTempDir("akm-issue157-stash-");
    process.env.AKM_STASH_DIR = stashDir;

    const result = createWorkflowAsset({ name: "/etc/passwd" });
    // Leading slash is stripped → name becomes "etc/passwd"
    expect(result.ref).toBe("workflow:etc/passwd");
    // The resulting file is inside the stash workflows dir, not at /etc/passwd
    expect(result.path.startsWith(stashDir)).toBe(true);
    expect(result.path).toContain(path.join("workflows", "etc", "passwd.md"));
  });
});
