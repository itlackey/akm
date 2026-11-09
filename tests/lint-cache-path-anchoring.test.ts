// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression coverage for the unanchored `/.cache/` / `/registry/` substring
 * check that used to gate lint's file-skip logic (`isCachedLintPath` in
 * `src/commands/lint/index.ts` and its two duplicates in
 * `src/core/adapter/adapters/akm-lint.ts`).
 *
 * That check tested whether the path STRING contained the literal text
 * `/.cache/` or `/registry/` anywhere at all — not whether the file actually
 * lived inside akm's own resolved registry-cache directories. Any bundle or
 * workspace that merely happened to sit under a directory named `.cache` (a
 * normal XDG `~/.cache/...` layout, many CI sandboxes) got zero workflow-lint
 * findings, silently.
 *
 * The fix (`isAkmRegistryCachePath` in `src/core/common.ts`) anchors the
 * exclusion to `getRegistryCacheDir()`/`getRegistryIndexCacheDir()` via
 * `isWithin` (realpath + containment), not a string search. These tests
 * pin both halves: a user path that merely CONTAINS `.cache`/`registry`
 * must lint normally, and a file genuinely inside the resolved registry
 * cache must still be skipped.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmLint } from "../src/commands/lint/index";
import { workflowFrontendDiagnostics } from "../src/core/adapter/adapters/akm-lint";
import { detectAdapterId } from "../src/core/adapter/detect-adapter";
import { makeSandboxDir, sandboxEnvDir } from "./_helpers/sandbox";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const BROKEN_WORKFLOW = ["---", "type: workflow", "description: Broken", "---", ""].join("\n");

function writeWorkflowFile(stashDir: string, name: string, content: string): string {
  const filePath = path.join(stashDir, "workflows", name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

describe("lint cache-path anchoring (issue: unanchored /.cache/ /registry/ substring)", () => {
  test("a stash rooted under a path merely CONTAINING '.cache' still gets workflow-lint findings", async () => {
    const { dir: base, cleanup } = makeSandboxDir("akm-lint-cachepath");
    cleanups.push(cleanup);
    // Nest the real stash root under a directory literally named `.cache`,
    // regardless of where the process TMPDIR points — this reproduces the
    // "XDG_CACHE_HOME-style path" shape the audit flagged, independent of
    // the test runner's own TMPDIR.
    const stashDir = path.join(base, "nested", ".cache", "my-project");
    fs.mkdirSync(stashDir, { recursive: true });

    writeWorkflowFile(stashDir, "broken.md", BROKEN_WORKFLOW);

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]?.file).toContain("broken.md");
  });

  test("a stash rooted under a path merely CONTAINING 'registry' still gets workflow-lint findings", async () => {
    const { dir: base, cleanup } = makeSandboxDir("akm-lint-registrypath");
    cleanups.push(cleanup);
    const stashDir = path.join(base, "registry", "my-project");
    fs.mkdirSync(stashDir, { recursive: true });

    writeWorkflowFile(stashDir, "broken.md", BROKEN_WORKFLOW);

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]?.file).toContain("broken.md");
  });

  test("a file genuinely inside the resolved registry cache dir is still skipped by workflowFrontendDiagnostics", () => {
    const { dir: cacheDir, cleanup } = sandboxEnvDir("akm-real-cache-", "XDG_CACHE_HOME");
    cleanups.push(cleanup);

    const registryFile = path.join(cacheDir, "akm", "registry", "git-some-source", "workflows", "broken.md");
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.writeFileSync(registryFile, BROKEN_WORKFLOW, "utf8");

    const result = workflowFrontendDiagnostics("workflows/broken.md", BROKEN_WORKFLOW, registryFile);

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("a file genuinely inside the resolved registry-index cache dir is still skipped", () => {
    const { dir: cacheDir, cleanup } = sandboxEnvDir("akm-real-cache-idx-", "XDG_CACHE_HOME");
    cleanups.push(cleanup);

    const registryIndexFile = path.join(cacheDir, "akm", "registry-index", "git-abc123", "workflows", "broken.md");
    fs.mkdirSync(path.dirname(registryIndexFile), { recursive: true });
    fs.writeFileSync(registryIndexFile, BROKEN_WORKFLOW, "utf8");

    const result = workflowFrontendDiagnostics("workflows/broken.md", BROKEN_WORKFLOW, registryIndexFile);

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("a real path under the OS temp dir's own '.cache'-shaped TMPDIR still lints (sanity, mirrors os.tmpdir())", async () => {
    // Belt-and-suspenders: exercise the actual os.tmpdir()-derived sandbox
    // helper too, not just a hand-built path, so this fails the same way the
    // full `bun test ... TMPDIR=.../.cache/...` repro from the audit does.
    const tmpBase = os.tmpdir();
    if (!tmpBase.includes(".cache")) return; // only meaningful when run under a .cache-shaped TMPDIR
    const { dir: stashDir, cleanup } = makeSandboxDir("akm-lint-realtmp");
    cleanups.push(cleanup);
    writeWorkflowFile(stashDir, "broken.md", BROKEN_WORKFLOW);

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
  });

  test("a USER workflow subdirectory literally named '.cache' still gets lint findings (collectWorkflowFiles name-based exclusion)", async () => {
    // Regression for the two remaining name-based exclusions
    // (`entry.name === ".cache" || entry.name === "registry"`) in
    // `collectWorkflowFiles` — distinct from the substring bug above.
    // These skipped ANY directory named `.cache`/`registry` ANYWHERE in a
    // bundle, including ordinary user content nested under such a name, not
    // just akm's own resolved cache. `workflows/.cache/` here is user
    // content, never akm's real cache dir.
    const { dir: stashDir, cleanup } = makeSandboxDir("akm-lint-user-dotcache-dir");
    cleanups.push(cleanup);
    writeWorkflowFile(stashDir, path.join(".cache", "broken.md"), BROKEN_WORKFLOW);

    const result = await akmLint({ dir: stashDir, typeFilter: "workflows" });

    const structural = result.flagged.filter((i) => i.issue === "invalid-workflow-structure");
    expect(structural).toHaveLength(1);
    expect(structural[0]?.file).toContain(path.join(".cache", "broken.md"));
  });

  test("a USER 'raw/' source nested under a directory literally named 'registry' still trips uncited-raw (collectAdapterFiles name-based exclusion)", async () => {
    // Regression for the `segments.includes(".cache") || segments.includes("registry")`
    // exclusion in `collectAdapterFiles`, used for every non-akm adapter's
    // whole-bundle walk (llm-wiki here). A user directory literally named
    // `registry` anywhere under the bundle root — not akm's own resolved
    // registry cache — must still be linted.
    const { dir: base, cleanup } = makeSandboxDir("akm-lint-user-registry-dir");
    cleanups.push(cleanup);
    const wikiRoot = path.join(base, "my-wiki");
    fs.mkdirSync(path.join(wikiRoot, "raw", "registry"), { recursive: true });
    fs.mkdirSync(path.join(wikiRoot, "pages"), { recursive: true });
    fs.writeFileSync(path.join(wikiRoot, "schema.md"), "# Wiki schema\n\nConventions live here.\n", "utf8");
    fs.writeFileSync(path.join(wikiRoot, "index.md"), "# Index\n", "utf8");
    fs.writeFileSync(path.join(wikiRoot, "log.md"), "# Log\n", "utf8");
    // Never cited by any page's `sources:` — should trip `uncited-raw`, but
    // only if the file was actually visited despite the `registry` segment.
    fs.writeFileSync(
      path.join(wikiRoot, "raw", "registry", "orphan.md"),
      "# Orphan source\n\nSome ingested material nobody cites.\n",
      "utf8",
    );

    expect(detectAdapterId(wikiRoot)).toBe("llm-wiki");

    const result = await akmLint({ dir: wikiRoot });
    const uncitedRaw = result.flagged.filter((f) => f.issue === "uncited-raw");
    expect(uncitedRaw.some((f) => f.file.includes(path.join("raw", "registry", "orphan.md")))).toBe(true);
  });
});
