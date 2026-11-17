// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The ONE core `ValidateContext` implementation (`core/adapter/validate-context.ts`)
 * — the overlay `BundleAdapter.validate()`'s interface contract mandates
 * ("one core overlay implementation, not one per adapter"). Exercised in
 * isolation here (real disk, a tmpdir per test) so the overlay semantics are
 * pinned independently of any one adapter's own test suite.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createValidateContext } from "../../../src/core/adapter/validate-context";
import type { FileChange } from "../../../src/core/file-change";

function makeRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-validate-ctx-"));
  return dir;
}

function write(root: string, relPath: string, content: string): void {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

describe("createValidateContext — readFile", () => {
  test("reads a file that exists on disk when there is no overlay", async () => {
    const root = makeRoot();
    write(root, "knowledge/foo.md", "hello from disk");
    const ctx = createValidateContext({ root });
    expect(await ctx.readFile("knowledge/foo.md")).toBe("hello from disk");
  });

  test("returns null for a path that exists on neither disk nor overlay", async () => {
    const root = makeRoot();
    const ctx = createValidateContext({ root });
    expect(await ctx.readFile("nope.md")).toBeNull();
  });

  test("a pending `create`/`update` change overlays its `after` content OVER disk", async () => {
    const root = makeRoot();
    write(root, "knowledge/foo.md", "old disk content");
    const changes: FileChange[] = [{ path: "knowledge/foo.md", after: "NEW pending content", op: "update" }];
    const ctx = createValidateContext({ root, changes });
    expect(await ctx.readFile("knowledge/foo.md")).toBe("NEW pending content");
  });

  test("a pending `create` for a file that does not yet exist on disk is served from the overlay", async () => {
    const root = makeRoot();
    const changes: FileChange[] = [{ path: "knowledge/brand-new.md", after: "freshly proposed", op: "create" }];
    const ctx = createValidateContext({ root, changes });
    expect(await ctx.readFile("knowledge/brand-new.md")).toBe("freshly proposed");
    // Disk is untouched — validate() must never write.
    expect(fs.existsSync(path.join(root, "knowledge/brand-new.md"))).toBe(false);
  });

  test("a pending `delete` makes the overlay report null even though the file still exists on disk", async () => {
    const root = makeRoot();
    write(root, "knowledge/doomed.md", "still here on disk");
    const changes: FileChange[] = [{ path: "knowledge/doomed.md", op: "delete" }];
    const ctx = createValidateContext({ root, changes });
    expect(await ctx.readFile("knowledge/doomed.md")).toBeNull();
    // The overlay is a READ projection only — the real file is never touched.
    expect(fs.existsSync(path.join(root, "knowledge/doomed.md"))).toBe(true);
  });

  test("an absolute path bypasses the overlay and reads disk directly (the stale-path base check's shape)", async () => {
    const root = makeRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "akm-validate-ctx-outside-"));
    fs.writeFileSync(path.join(outside, "marker.txt"), "outside content", "utf8");
    const ctx = createValidateContext({ root });
    expect(await ctx.readFile(path.join(outside, "marker.txt"))).toBe("outside content");
    expect(await ctx.readFile(path.join(outside, "does-not-exist.txt"))).toBeNull();
  });
});

describe("createValidateContext — list", () => {
  test("lists disk entries for a directory with no overlay", async () => {
    const root = makeRoot();
    write(root, "pages/a.md", "a");
    write(root, "pages/b.md", "b");
    const ctx = createValidateContext({ root });
    expect((await ctx.list("pages")).sort()).toEqual(["a.md", "b.md"]);
  });

  test("merges pending creates into the disk listing and removes pending deletes", async () => {
    const root = makeRoot();
    write(root, "pages/a.md", "a");
    write(root, "pages/b.md", "b");
    const changes: FileChange[] = [
      { path: "pages/c.md", after: "c", op: "create" },
      { path: "pages/b.md", op: "delete" },
    ];
    const ctx = createValidateContext({ root, changes });
    expect((await ctx.list("pages")).sort()).toEqual(["a.md", "c.md"]);
  });

  test("returns an empty list for a directory that exists on neither disk nor overlay", async () => {
    const root = makeRoot();
    const ctx = createValidateContext({ root });
    expect(await ctx.list("nowhere")).toEqual([]);
  });
});

describe("createValidateContext — resolveRef", () => {
  test("resolves a bare conceptId to an existing direct on-disk path (the OKF/llm-wiki own-conceptId shape)", async () => {
    const root = makeRoot();
    write(root, "tables/customers.md", "---\ntype: table\n---\n");
    const ctx = createValidateContext({ root });
    expect((await ctx.resolveRef("tables/customers")).exists).toBe(true);
    expect((await ctx.resolveRef("tables/missing")).exists).toBe(false);
  });

  test("resolves a bare conceptId through the AKM placement type table (the akm adapter's own shape)", async () => {
    const root = makeRoot();
    write(root, "memories/kept.md", "---\nupdated: 2026-01-01\n---\nbody\n");
    const ctx = createValidateContext({ root });
    expect((await ctx.resolveRef("memories/kept")).exists).toBe(true);
    expect((await ctx.resolveRef("memories/absent")).exists).toBe(false);
  });

  test("strips a `bundle//` qualifier before resolving (mirrors the legacy resolver's bundle-agnostic leniency)", async () => {
    const root = makeRoot();
    write(root, "memories/kept.md", "---\nupdated: 2026-01-01\n---\nbody\n");
    const ctx = createValidateContext({ root });
    expect((await ctx.resolveRef("some-bundle//memories/kept")).exists).toBe(true);
  });

  test("strips a `#fragment` before resolving", async () => {
    const root = makeRoot();
    write(root, "memories/kept.md", "---\nupdated: 2026-01-01\n---\nbody\n");
    const ctx = createValidateContext({ root });
    expect((await ctx.resolveRef("memories/kept#some-heading")).exists).toBe(true);
  });

  test("a pending `create` overlay makes a previously-missing ref resolve", async () => {
    const root = makeRoot();
    const changes: FileChange[] = [{ path: "tables/new.md", after: "---\ntype: table\n---\n", op: "create" }];
    const ctx = createValidateContext({ root, changes });
    expect((await ctx.resolveRef("tables/new")).exists).toBe(true);
  });

  test("a pending `delete` overlay makes a previously-existing ref stop resolving", async () => {
    const root = makeRoot();
    write(root, "tables/gone.md", "---\ntype: table\n---\n");
    const changes: FileChange[] = [{ path: "tables/gone.md", op: "delete" }];
    const ctx = createValidateContext({ root, changes });
    expect((await ctx.resolveRef("tables/gone")).exists).toBe(false);
  });

  test("checks extra (cross-bundle) roots on disk when the primary root does not resolve the ref", async () => {
    const root = makeRoot();
    const extra = makeRoot();
    write(extra, "tables/elsewhere.md", "---\ntype: table\n---\n");
    const ctx = createValidateContext({ root, sources: [{ path: extra }] });
    expect((await ctx.resolveRef("tables/elsewhere")).exists).toBe(true);
  });

  test("never overlays a pending change onto an extra (non-primary) root", async () => {
    const root = makeRoot();
    const extra = makeRoot();
    // The change targets a path relative to `root`; it must not leak into `extra`'s resolution.
    const changes: FileChange[] = [{ path: "tables/only-in-primary.md", after: "x", op: "create" }];
    const ctx = createValidateContext({ root, sources: [{ path: extra }], changes });
    expect((await ctx.resolveRef("tables/only-in-primary")).exists).toBe(true); // resolves via the primary root's overlay
    expect(fs.existsSync(path.join(extra, "tables/only-in-primary.md"))).toBe(false); // never written to the extra root
  });
  // ── PR #745 review (Copilot) — resolveRef hardening ───────────────────────

  test("a ref naming a DIRECTORY does not count as a resolved target", async () => {
    const root = makeRoot();
    // A directory named exactly like the ref, with no matching file. `existsSync`
    // would call this resolved and silently suppress a real missing-ref.
    fs.mkdirSync(path.join(root, "pages", "ghost-page"), { recursive: true });
    const ctx = createValidateContext({ root });
    expect((await ctx.resolveRef("pages/ghost-page")).exists).toBe(false);
  });

  test("rejects refs that escape the bundle root via `..`", async () => {
    const root = makeRoot();
    const outside = makeRoot();
    write(outside, "secret.md", "---\ntype: knowledge\n---\n");
    const rel = `${path.relative(root, outside).split(path.sep).join("/")}/secret`;
    expect(rel.includes("..")).toBe(true); // precondition: this really does traverse out
    const ctx = createValidateContext({ root });
    expect((await ctx.resolveRef(rel)).exists).toBe(false);
  });

  test("rejects absolute-path refs", async () => {
    const root = makeRoot();
    write(root, "tables/real.md", "---\ntype: table\n---\n");
    const ctx = createValidateContext({ root });
    expect((await ctx.resolveRef("/etc/passwd")).exists).toBe(false);
    expect((await ctx.resolveRef(`${root}/tables/real.md`)).exists).toBe(false);
  });
});
