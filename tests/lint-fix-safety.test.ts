// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm lint --fix` mutation safety (issue #761).
 *
 * Two gaps, both about a write nobody could see:
 *
 *   1. NO WRITABLE CHECK. Every other mutating command routes through
 *      `sources/write-source.ts`'s `ensureWritable`; `--fix` wrote directly and
 *      never consulted the flag, so it happily rewrote frontmatter in a bundle
 *      configured `writable: false`.
 *   2. NO TRANSACTIONAL CONTRACT. A single file's fix-write throwing
 *      (`base-linter.ts`'s `fs.writeFileSync`) escaped `akmLint()` entirely.
 *      The caller got an exception instead of a result — and files fixed
 *      EARLIER in the same sweep stayed mutated on disk with nothing reporting
 *      that they had.
 *
 * Both are pinned here against the real `akmLint()` entry point.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { runBaseChecks } from "../src/commands/lint/base-linter";
import { akmLint } from "../src/commands/lint/index";
import { parseFrontmatter } from "../src/core/asset/frontmatter";
import type { AkmConfig } from "../src/core/config/config";
import { UsageError } from "../src/core/errors";
import { makeConfig } from "./_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

/**
 * Permission bits are not enforced for uid 0, so the chmod-based sweep test
 * below cannot make a write fail when the suite runs as root (containers do).
 * The uid-independent half of the contract is pinned by the `runBaseChecks`
 * test at the bottom, which forces a real ENOENT that root cannot bypass.
 */
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

/** A memory with no `updated:` — the `missing-updated` base check's fixable case. */
const FIXABLE_MEMORY = "---\nname: note\ntype: memory\n---\n\nSome content.\n";

function writeMemory(stashDir: string, name: string): string {
  const full = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, FIXABLE_MEMORY, "utf8");
  return full;
}

function readOnlyConfig(stashDir: string): AkmConfig {
  const config = makeConfig(stashDir);
  return { ...config, bundles: { stash: { path: stashDir, writable: false } } as AkmConfig["bundles"] };
}

describe("akm lint --fix refuses a bundle configured writable: false (issue #761)", () => {
  let storage: IsolatedAkmStorage;
  afterEach(() => storage?.cleanup());

  test("throws a UsageError and leaves every file byte-identical", async () => {
    storage = withIsolatedAkmStorage();
    const notePath = writeMemory(storage.stashDir, "note");
    const before = fs.readFileSync(notePath, "utf8");

    const attempt = akmLint({ fix: true, config: readOnlyConfig(storage.stashDir) });
    await expect(attempt).rejects.toBeInstanceOf(UsageError);
    await expect(attempt).rejects.toThrow(/writable: false/);

    expect(fs.readFileSync(notePath, "utf8")).toBe(before);
  });

  test("a read-only bundle still LINTS — only the mutation is refused", async () => {
    storage = withIsolatedAkmStorage();
    writeMemory(storage.stashDir, "note");

    const result = await akmLint({ config: readOnlyConfig(storage.stashDir) });

    expect(result.ok).toBe(true);
    expect(result.flagged.some((issue) => issue.issue === "missing-updated")).toBe(true);
  });

  test("naming the read-only bundle explicitly with --dir is refused too", async () => {
    storage = withIsolatedAkmStorage();
    const notePath = writeMemory(storage.stashDir, "note");
    const before = fs.readFileSync(notePath, "utf8");

    // The likelier real invocation: the user points at the bundle by path
    // rather than relying on `defaultBundle`. The policy still applies.
    const attempt = akmLint({ fix: true, dir: storage.stashDir, config: readOnlyConfig(storage.stashDir) });
    await expect(attempt).rejects.toBeInstanceOf(UsageError);

    expect(fs.readFileSync(notePath, "utf8")).toBe(before);
  });

  test("an ad-hoc --dir that is not a configured bundle carries no policy and stays fixable", async () => {
    storage = withIsolatedAkmStorage();
    const adhoc = path.join(storage.root, "adhoc-bundle");
    fs.mkdirSync(path.join(adhoc, "memories"), { recursive: true });
    const notePath = writeMemory(adhoc, "note");

    const result = await akmLint({ fix: true, dir: adhoc, config: readOnlyConfig(storage.stashDir) });

    expect(result.fixed.some((issue) => issue.issue === "missing-updated")).toBe(true);
    expect(fs.readFileSync(notePath, "utf8")).toMatch(/updated:/);
  });
});

describe("akm lint --fix is transactional per file (issue #761)", () => {
  let storage: IsolatedAkmStorage;
  afterEach(() => storage?.cleanup());

  test.skipIf(runningAsRoot)(
    "one unwritable file is reported as fixed:'failed' and the sweep still fixes the rest",
    async () => {
      storage = withIsolatedAkmStorage();
      const names = ["a", "b", "c", "d", "e", "f"];
      const paths = new Map(names.map((name) => [name, writeMemory(storage.stashDir, name)]));
      const lockedPath = paths.get("c") as string;
      fs.chmodSync(lockedPath, 0o444);

      let result: Awaited<ReturnType<typeof akmLint>>;
      try {
        // The whole point: this used to throw EACCES out of akmLint().
        result = await akmLint({ fix: true, config: makeConfig(storage.stashDir) });
      } finally {
        fs.chmodSync(lockedPath, 0o644);
      }

      expect(result.ok).toBe(true);

      // The locked file is reported, in-band, as a fix that did NOT land.
      const lockedFindings = result.flagged.filter((issue) => issue.file.endsWith("c.md"));
      expect(lockedFindings.length).toBeGreaterThan(0);
      expect(lockedFindings.every((issue) => issue.fixed === "failed")).toBe(true);
      expect(lockedFindings.some((issue) => /could not write fix/.test(issue.detail))).toBe(true);

      // Every OTHER file was still fixed — the sweep did not abort at the failure.
      for (const name of names.filter((n) => n !== "c")) {
        const contents = fs.readFileSync(paths.get(name) as string, "utf8");
        expect(contents, `${name}.md should have been stamped`).toMatch(/updated:/);
      }
      expect(result.fixed.filter((issue) => issue.issue === "missing-updated").length).toBe(names.length - 1);

      // And the file that could not be written is genuinely unchanged on disk.
      expect(fs.readFileSync(lockedPath, "utf8")).toBe(FIXABLE_MEMORY);
    },
  );

  test("runBaseChecks downgrades its optimistic fixed:true to fixed:'failed' when the flush throws", () => {
    storage = withIsolatedAkmStorage();
    // A path under a directory that does not exist: `writeFileSync` raises
    // ENOENT for EVERY uid, so this half of the contract is pinned even where
    // permission bits are unenforced.
    const unwritable = path.join(storage.root, "no-such-dir", "note.md");

    const issues = runBaseChecks({
      filePath: unwritable,
      relPath: "memories/note.md",
      raw: FIXABLE_MEMORY,
      data: { name: "note", type: "memory" },
      body: "\nSome content.\n",
      frontmatter: "name: note\ntype: memory",
      fix: true,
      stashRoot: storage.stashDir,
    });

    const updated = issues.filter((issue) => issue.issue === "missing-updated");
    expect(updated.length).toBe(1);
    expect(updated[0]?.fixed).toBe("failed");
    expect(updated[0]?.detail).toMatch(/could not write fix/);
  });
});

describe("akm lint --fix preserves multiline descriptions", () => {
  let storage: IsolatedAkmStorage;
  afterEach(() => storage?.cleanup());

  test("repairs valid plain and malformed quoted wrapping without corrupting YAML", async () => {
    storage = withIsolatedAkmStorage();
    const cases = [
      {
        name: "plain-wrapped",
        description:
          "The release gate runs on localhost:5173 and preserves the complete description across physical lines.",
        frontmatter: [
          "description: The release gate runs on localhost:5173 and preserves the",
          "  complete description across physical lines.",
        ],
      },
      {
        name: "malformed-quoted-wrapped",
        description:
          '"The Account contract: GET /my/account resolves bearer subject to profile; POST rejects uninvited users."',
        frontmatter: [
          'description: "\\"The Account contract: GET /my/account resolves bearer"',
          '  subject to profile; POST rejects uninvited users."',
        ],
      },
    ] as const;

    for (const testCase of cases) {
      const filePath = path.join(storage.stashDir, "memories", `${testCase.name}.md`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        [
          "---",
          `name: ${testCase.name}`,
          "type: memory",
          ...testCase.frontmatter,
          "updated: 2026-08-17",
          "---",
          "",
          "Substantive body content.",
          "",
        ].join("\n"),
        "utf8",
      );
    }

    const result = await akmLint({ fix: true, config: makeConfig(storage.stashDir) });
    expect(result.fixed.filter((issue) => issue.issue === "unquoted-colon")).toHaveLength(cases.length);
    expect(result.flagged.filter((issue) => issue.issue === "unquoted-colon")).toEqual([]);

    for (const testCase of cases) {
      const filePath = path.join(storage.stashDir, "memories", `${testCase.name}.md`);
      const after = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
      const document = parseDocument(after.frontmatter ?? "");
      expect(document.errors, `${testCase.name} should remain valid YAML`).toEqual([]);
      expect(after.data.description).toBe(testCase.description);
    }

    const secondPass = await akmLint({ fix: true, config: makeConfig(storage.stashDir) });
    expect(secondPass.fixed.filter((issue) => issue.issue === "unquoted-colon")).toEqual([]);
    expect(secondPass.flagged.filter((issue) => issue.issue === "unquoted-colon")).toEqual([]);
  });
});
