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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createWorkflowAsset } from "../../src/workflows/authoring/authoring";
import { durableItemRef } from "../_helpers/durable-ref";
import { type IsolatedAkmStorage, makeSandboxDir, withEnvSync, withIsolatedAkmStorage } from "../_helpers/sandbox";

const dirCleanups: (() => void)[] = [];

function makeTempDir(prefix: string): string {
  const { dir, cleanup } = makeSandboxDir(prefix);
  dirCleanups.push(cleanup);
  return dir;
}

// Each test overrides AKM_BUNDLE_DIR with its own custom stash dir via
// withEnvSync; the outer storage supplies XDG_DATA_HOME / XDG_STATE_HOME (and
// the other XDG vars, for the one test below that needs them) so the
// test-isolation guard in src/core/paths.ts stays inert.
let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  for (const cleanup of dirCleanups.splice(0)) cleanup();
  storage.cleanup();
});

// ── Happy path: clean stash ─────────────────────────────────────────────────

describe("createWorkflowAsset — clean stash (issue #157)", () => {
  test("bare name resolves correctly in a freshly created stash", () => {
    const stashDir = makeTempDir("akm-issue157-stash-");
    const xdgCache = makeTempDir("akm-issue157-cache-");
    const xdgConfig = makeTempDir("akm-issue157-config-");

    const result = withEnvSync({ AKM_BUNDLE_DIR: stashDir, XDG_CACHE_HOME: xdgCache, XDG_CONFIG_HOME: xdgConfig }, () =>
      createWorkflowAsset({ name: "agentic-test-workflow" }),
    );

    expect(result.ref).toBe(durableItemRef(stashDir, "workflow", "agentic-test-workflow"));
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.path).toBe(path.join(stashDir, "workflows", "agentic-test-workflow.md"));
  });

  test("bare name with hyphens resolves correctly", () => {
    const stashDir = makeTempDir("akm-issue157-stash-");

    const result = withEnvSync({ AKM_BUNDLE_DIR: stashDir }, () =>
      createWorkflowAsset({ name: "my-multi-step-workflow" }),
    );

    expect(result.ref).toBe(durableItemRef(stashDir, "workflow", "my-multi-step-workflow"));
    expect(fs.existsSync(result.path)).toBe(true);
  });

  test("nested name (subdirectory) resolves correctly", () => {
    const stashDir = makeTempDir("akm-issue157-stash-");

    const result = withEnvSync({ AKM_BUNDLE_DIR: stashDir }, () => createWorkflowAsset({ name: "team/release-flow" }));

    expect(result.ref).toBe(durableItemRef(stashDir, "workflow", "team/release-flow"));
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.path).toContain(path.join("workflows", "team", "release-flow.md"));
  });

  test("resolves correctly when stash dir path contains a symlink", () => {
    // Create a real directory and a symlink pointing to it, then use the
    // symlink path as the stash dir.  This simulates environments where HOME
    // or a parent directory is a symlink (e.g. macOS /tmp → /private/tmp).
    const realDir = makeTempDir("akm-issue157-real-");
    // Nest the symlink inside a unique mkdtemp parent so the link path is
    // collision-free under the parallel sharded test harness (a bare
    // `Date.now()` name has only millisecond resolution and can EEXIST).
    const linkParent = makeTempDir("akm-issue157-link-");
    const symlinkDir = path.join(linkParent, "stash-link");
    fs.symlinkSync(realDir, symlinkDir);

    // Must not throw "Resolved workflow path escapes the stash"
    const result = withEnvSync({ AKM_BUNDLE_DIR: symlinkDir }, () =>
      createWorkflowAsset({ name: "agentic-test-workflow" }),
    );

    expect(result.ref).toBe(durableItemRef(symlinkDir, "workflow", "agentic-test-workflow"));
    expect(fs.existsSync(result.path)).toBe(true);
  });

  test("--from succeeds with valid workflow markdown", () => {
    const stashDir = makeTempDir("akm-issue157-stash-");
    const srcDir = makeTempDir("akm-issue157-src-");

    const srcPath = path.join(srcDir, "release.md");
    // Unified-format fixture (frontmatter graph + `## <id>` body — spec §2.2).
    const content = `---
type: workflow
description: A release workflow
tags:
  - release
steps:
  - id: validate
---

# Release

## validate

Check all inputs.

### gate

- Inputs confirmed
`;
    fs.writeFileSync(srcPath, content, "utf8");

    const result = withEnvSync({ AKM_BUNDLE_DIR: stashDir }, () =>
      createWorkflowAsset({ name: "release", from: srcPath }),
    );

    expect(result.ref).toBe(durableItemRef(stashDir, "workflow", "release"));
    expect(fs.existsSync(result.path)).toBe(true);
    expect(fs.readFileSync(result.path, "utf8")).toContain("# Release");
  });
});

// ── Security: path traversal must still be rejected ─────────────────────────

describe("createWorkflowAsset — path escape rejection", () => {
  test("../traversal is rejected", () => {
    const stashDir = makeTempDir("akm-issue157-stash-");

    withEnvSync({ AKM_BUNDLE_DIR: stashDir }, () => {
      expect(() => createWorkflowAsset({ name: "../outside" })).toThrow("must be a relative path without");
    });
  });

  test("deep traversal is rejected", () => {
    const stashDir = makeTempDir("akm-issue157-stash-");

    withEnvSync({ AKM_BUNDLE_DIR: stashDir }, () => {
      expect(() => createWorkflowAsset({ name: "a/../../outside" })).toThrow("must be a relative path without");
    });
  });

  test("absolute path is sanitized into a relative name inside the stash", () => {
    // normalizeWorkflowName strips leading slashes, so "/etc/passwd" becomes
    // "etc/passwd" — a relative name that resolves safely inside the stash.
    // This is by design: the function converts absolute-looking user input
    // into a relative name rather than treating it as a filesystem path.
    const stashDir = makeTempDir("akm-issue157-stash-");

    const result = withEnvSync({ AKM_BUNDLE_DIR: stashDir }, () => createWorkflowAsset({ name: "/etc/passwd" }));
    // Leading slash is stripped → name becomes "etc/passwd"
    expect(result.ref).toBe(durableItemRef(stashDir, "workflow", "etc/passwd"));
    // The resulting file is inside the stash workflows dir, not at /etc/passwd
    expect(result.path.startsWith(stashDir)).toBe(true);
    expect(result.path).toContain(path.join("workflows", "etc", "passwd.md"));
  });
});
