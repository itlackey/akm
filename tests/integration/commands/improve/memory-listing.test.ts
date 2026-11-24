// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Memory inference, memory cleanup and consolidate's listing (when the index holds no memory) work on the memories
 * akm lists (F33): a memory in a dot-directory or a git-ignored one is not acted on, a symlinked memory is, and a
 * file under `memories/` that is no memory (a script) is not read as one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { inspectConsolidationPool } from "../../../../src/commands/improve/consolidate";
import { analyzeMemoryCleanup } from "../../../../src/commands/improve/memory/memory-improve";
import type { AkmConfig } from "../../../../src/core/config/config";
import { collectPendingMemories } from "../../../../src/indexer/passes/memory-inference";
import { type Cleanup, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

let cleanup: Cleanup;
let stashDir: string;
let outside: string;

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  stashDir = storage.stashDir;
  cleanup = storage.cleanup;
  outside = fs.mkdtempSync(path.join(path.dirname(stashDir), "memory-listing-outside-"));
});

afterEach(() => {
  fs.rmSync(outside, { recursive: true, force: true });
  cleanup();
});

function write(rel: string, content: string): void {
  const file = path.join(stashDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

/** A stash that is a git repository ignoring `memories/ignored*`. */
function gitIgnoring(): void {
  fs.writeFileSync(path.join(stashDir, ".gitignore"), "memories/ignored*\n", "utf8");
  const init = Bun.spawnSync(["git", "init", "-q", stashDir]);
  expect(init.exitCode).toBe(0);
}

/** One memory of each kind the listing decides: listed, in a dot-directory, git-ignored, linked, not a memory. */
function writeMemories(body: (name: string) => string): void {
  write("memories/listed.md", body("listed"));
  write("memories/.hidden/dot.md", body("dot"));
  write("memories/ignored.md", body("ignored"));
  write("memories/run.sh", "#!/bin/sh\necho not a memory\n");
  fs.writeFileSync(path.join(outside, "linked.md"), body("linked"), "utf8");
  fs.symlinkSync(path.join(outside, "linked.md"), path.join(stashDir, "memories", "linked.md"));
  gitIgnoring();
}

describe("memories as akm lists them (F33)", () => {
  test("memory inference considers the listed and the linked memory only", () => {
    writeMemories((name) => `---\ndescription: ${name}\n---\n\nA ${name} memory body long enough to infer from.\n`);

    expect(
      collectPendingMemories(stashDir)
        .map((record) => record.ref)
        .sort(),
    ).toEqual(["memories/linked", "memories/listed"]);
  });

  test("memory cleanup analyzes the listed and the linked derived memory only", () => {
    writeMemories((name) => `---\ninferred: true\nsource: memories/${name}-parent\n---\n\nDerived ${name} facts.\n`);

    expect(analyzeMemoryCleanup(stashDir).analyzedDerived).toBe(2);
  });

  test("consolidate's listing without an index holds the listed and the linked memory only", () => {
    writeMemories((name) => `---\ndescription: ${name}\n---\n\nThe ${name} memory body, long enough to matter.\n`);
    const config = {
      semanticSearchMode: "off",
      profiles: { improve: { default: { processes: { consolidate: { enabled: true } } } } },
    } as unknown as AkmConfig;

    const pool = inspectConsolidationPool({ config }, stashDir, []);

    expect(pool.memories.map((memory) => memory.ref).sort()).toEqual(["memories/linked", "memories/listed"]);
  });
});
