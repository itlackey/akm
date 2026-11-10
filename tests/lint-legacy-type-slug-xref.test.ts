// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../src/commands/lint";
import { resolveRefPathInStash } from "../src/commands/lint/base-linter";
import { resetMemoryArchiveCache } from "../src/core/asset/memory-archive";
import { makeConfig } from "./_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

/**
 * #882 — `akm lint` silently skipped `type:slug` xrefs (the grammar retired at
 * the write boundary, see resolve-ref.ts Q-02) instead of validating them.
 * `classifyConceptRef` only recognized the current conceptId (`type/slug`)
 * grammar via `typeNameFromConceptId`, so an old-grammar token mapped to
 * `undefined` and was treated as "not a local asset ref, skip" rather than
 * checked for existence.
 */

function writeMemory(stashDir: string, slug: string, xrefsYaml: string): void {
  const file = path.join(stashDir, "memories", `${slug}.md`);
  fs.writeFileSync(file, `---\ndescription: Test memory for #882\nxrefs:\n${xrefsYaml}\n---\n\nBody.\n`);
}

describe("akm lint validates the legacy type:slug xref grammar (#882)", () => {
  let storage: IsolatedAkmStorage;
  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => storage.cleanup());

  test("a resolvable type:slug xref is validated, not silently skipped", async () => {
    fs.writeFileSync(
      path.join(storage.stashDir, "knowledge", "target-doc.md"),
      "---\ndescription: target\n---\n\nBody.\n",
    );
    writeMemory(storage.stashDir, "legacy-ok", "  - knowledge:target-doc");

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });
    expect(result.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);
  });

  test("a dangling type:slug xref is now caught as missing-ref", async () => {
    writeMemory(storage.stashDir, "legacy-dangling", "  - memory:does-not-exist");

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });
    const missing = result.flagged.filter((f) => f.issue === "missing-ref");
    expect(missing.length).toBe(1);
    expect(missing[0]?.detail).toContain("memory:does-not-exist");
  });

  test("the current conceptId grammar still resolves and still catches dangling refs", async () => {
    fs.writeFileSync(
      path.join(storage.stashDir, "knowledge", "current-doc.md"),
      "---\ndescription: target\n---\n\nBody.\n",
    );
    writeMemory(storage.stashDir, "conceptid-mixed", "  - knowledge/current-doc\n  - memories/does-not-exist-either");

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });
    const missing = result.flagged.filter((f) => f.issue === "missing-ref");
    expect(missing.length).toBe(1);
    expect(missing[0]?.detail).toContain("memories/does-not-exist-either");
  });

  // ── derived-memory resolution (#882 follow-up) ──────────────────────────────
  // The belief-edge identity channel (`contradictedBy`/`supersededBy`) writes
  // `memory:<name>` refs today (see commands/improve/memory/derived-ref.ts
  // memoryIdentityRef) that name a memory whose file on disk is `<name>.derived.md`
  // — `.derived` is a provenance marker, not part of the asset's identity.

  test("a type:slug xref to a derived-only memory (no plain .md) resolves", async () => {
    fs.writeFileSync(
      path.join(storage.stashDir, "memories", "insight.derived.md"),
      "---\ndescription: derived target\ninferred: true\n---\n\nBody.\n",
    );
    writeMemory(storage.stashDir, "legacy-derived-ok", "  - memory:insight");

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });
    expect(result.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);
  });

  test("a conceptId xref to a derived-only memory (no plain .md) resolves", async () => {
    fs.writeFileSync(
      path.join(storage.stashDir, "memories", "another-insight.derived.md"),
      "---\ndescription: derived target\ninferred: true\n---\n\nBody.\n",
    );
    writeMemory(storage.stashDir, "conceptid-derived-ok", "  - memories/another-insight");

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });
    expect(result.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);
  });

  test("a dangling ref to a memory with no plain .md AND no .derived.md sibling is still caught", async () => {
    writeMemory(storage.stashDir, "legacy-derived-dangling", "  - memory:no-such-insight");

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });
    const missing = result.flagged.filter((f) => f.issue === "missing-ref");
    expect(missing.length).toBe(1);
    expect(missing[0]?.detail).toContain("memory:no-such-insight");
  });

  test("the plain .md wins over a .derived.md sibling when both exist", async () => {
    fs.writeFileSync(
      path.join(storage.stashDir, "memories", "both-forms.md"),
      "---\ndescription: plain form\n---\n\nBody.\n",
    );
    fs.writeFileSync(
      path.join(storage.stashDir, "memories", "both-forms.derived.md"),
      "---\ndescription: derived form\ninferred: true\n---\n\nBody.\n",
    );
    writeMemory(storage.stashDir, "both-forms-ref", "  - memory:both-forms");

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });
    expect(result.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);

    const resolved = resolveRefPathInStash("memories/both-forms.md", "memory", "both-forms", storage.stashDir);
    expect(resolved).toBe(path.join(storage.stashDir, "memories", "both-forms.md"));
  });
});

{
  /**
   * `akm lint --fix` migration of the retired `type:slug` xref grammar (see
   * `legacyTypeSlugParts` in `src/commands/lint/base-linter.ts`) to conceptId
   * form in the frontmatter xref channels (`xrefs:` / `supersededBy:` /
   * `contradictedBy:`).
   *
   * A value is rewritten ONLY when the conceptId form still resolves to a real
   * asset — a dangling legacy ref must stay reported as `missing-ref` in its
   * ORIGINAL spelling, never rewritten into a differently-spelled dangling ref.
   */

  function writeMemory(stashDir: string, slug: string, frontmatter: string): void {
    fs.writeFileSync(path.join(stashDir, "memories", `${slug}.md`), `---\n${frontmatter}---\n\nBody.\n`);
  }

  function read(stashDir: string, slug: string): string {
    return fs.readFileSync(path.join(stashDir, "memories", `${slug}.md`), "utf8");
  }

  describe("akm lint --fix: legacy type:slug xref migration", () => {
    let storage: IsolatedAkmStorage;
    beforeEach(() => {
      storage = withIsolatedAkmStorage();
      resetMemoryArchiveCache();
    });
    afterEach(() => {
      resetMemoryArchiveCache();
      storage.cleanup();
    });

    test("a plain lint (no --fix) reports the legacy ref as resolvable and changes nothing", async () => {
      const stashDir = storage.stashDir;
      writeMemory(stashDir, "live", "description: real target\n");
      writeMemory(stashDir, "holder", "description: h\nxrefs:\n  - memory:live\n");
      const before = read(stashDir, "holder");

      const result = await akmLint({ dir: stashDir, config: makeConfig(stashDir) });

      expect(result.flagged.filter((f) => f.issue === "missing-ref")).toEqual([]);
      expect(read(stashDir, "holder")).toBe(before);
    });

    test("--fix rewrites a resolvable legacy ref to conceptId form: block-list spelling", async () => {
      const stashDir = storage.stashDir;
      writeMemory(stashDir, "live", "description: real target\n");
      writeMemory(stashDir, "holder", "description: h\nxrefs:\n  - memory:live\n");

      const result = await akmLint({ dir: stashDir, fix: true, config: makeConfig(stashDir) });

      expect(result.fixed.some((f) => f.detail.includes("legacy xref grammar migrated"))).toBe(true);
      const after = read(stashDir, "holder");
      expect(after).toContain("memories/live");
      expect(after).not.toContain("memory:live");
    });

    test("--fix rewrites inline-flow and scalar spellings", async () => {
      const stashDir = storage.stashDir;
      writeMemory(stashDir, "live", "description: real target\n");
      writeMemory(stashDir, "flow", "description: h\nxrefs: [memory:live]\n");
      writeMemory(stashDir, "scalar", "description: h\nsupersededBy: memory:live\n");

      await akmLint({ dir: stashDir, fix: true, config: makeConfig(stashDir) });

      expect(read(stashDir, "flow")).toContain("xrefs: [memories/live]");
      expect(read(stashDir, "scalar")).toContain("supersededBy: memories/live");
    });

    test("a dangling legacy ref is NOT rewritten and stays reported as missing-ref", async () => {
      const stashDir = storage.stashDir;
      writeMemory(stashDir, "holder", "description: h\nxrefs:\n  - memory:gone\n");

      const result = await akmLint({ dir: stashDir, fix: true, config: makeConfig(stashDir) });

      expect(result.fixed.some((f) => f.detail.includes("legacy xref grammar migrated"))).toBe(false);
      const after = read(stashDir, "holder");
      expect(after).toContain("memory:gone");
      expect(after).not.toContain("memories/gone");
      expect(result.flagged.some((f) => f.issue === "missing-ref" && f.detail.includes("memory:gone"))).toBe(true);
    });

    test("a surviving legacy ref alongside a dangling one in the same list: only the resolvable one is rewritten", async () => {
      const stashDir = storage.stashDir;
      writeMemory(stashDir, "live", "description: real target\n");
      writeMemory(stashDir, "holder", "description: h\ncontradictedBy:\n  - memory:live\n  - memory:gone\n");

      const result = await akmLint({ dir: stashDir, fix: true, config: makeConfig(stashDir) });

      const after = read(stashDir, "holder");
      expect(after).toContain("memories/live");
      expect(after).toContain("memory:gone");
      expect(result.flagged.some((f) => f.issue === "missing-ref" && f.detail.includes("memory:gone"))).toBe(true);
    });

    test("comments and unrelated keys survive the rewrite byte-for-byte", async () => {
      const stashDir = storage.stashDir;
      writeMemory(stashDir, "live", "description: real target\n");
      fs.writeFileSync(
        path.join(stashDir, "memories", "holder.md"),
        "---\n# a comment\ndescription: h\ntags:\n  - one\nxrefs:\n  - memory:live\nupdated: 2026-01-01\n---\n\nBody.\n",
      );

      await akmLint({ dir: stashDir, fix: true, config: makeConfig(stashDir) });

      const after = read(stashDir, "holder");
      expect(after).toContain("# a comment");
      expect(after).toContain("tags:");
      expect(after).toContain("  - one");
      expect(after).toContain("updated: 2026-01-01");
      expect(after).toContain("xrefs:\n  - memories/live");
    });
  });
}
