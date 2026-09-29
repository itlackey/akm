// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Item 4 (alpha.9 plan §5.4/§8 step 8): the `memory-cleanup-archive` health
 * advisory reports a non-git bundle's archive size/count, since the purge
 * sweep never touches one. `isGitBackedStash` is a plain `.git`-presence
 * check, so no subprocess seam is needed here.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectArchiveUsageAdvisory } from "../../../src/commands/health/archive-usage";

function sandbox(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akm-archive-usage-"));
}

function markGitBacked(stashDir: string): void {
  fs.mkdirSync(path.join(stashDir, ".git"), { recursive: true });
}

function seedArchiveFile(stashDir: string, relPath: string, contents: string): void {
  const filePath = path.join(stashDir, ".akm", "memory-cleanup", "archive", relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

describe("collectArchiveUsageAdvisory", () => {
  test("silent when the bundle is git-backed — the purge sweep covers it", () => {
    const stashDir = sandbox();
    markGitBacked(stashDir);
    seedArchiveFile(stashDir, "2026-01-01-memories-old/cleanup.md", "---\nkind: memory-cleanup-archive\n---\n");
    seedArchiveFile(stashDir, "2026-01-01-memories-old/memories/old.md", "old body");
    expect(collectArchiveUsageAdvisory(stashDir)).toBeUndefined();
  });

  test("silent when there is no archive directory at all", () => {
    const stashDir = sandbox();
    expect(collectArchiveUsageAdvisory(stashDir)).toBeUndefined();
  });

  test("silent when the archive directory exists but is empty", () => {
    const stashDir = sandbox();
    fs.mkdirSync(path.join(stashDir, ".akm", "memory-cleanup", "archive"), { recursive: true });
    expect(collectArchiveUsageAdvisory(stashDir)).toBeUndefined();
  });

  test("reports size and file count for a non-git bundle with a non-empty archive", () => {
    const stashDir = sandbox();
    seedArchiveFile(stashDir, "2026-01-01-memories-old/cleanup.md", "1234567890"); // 10 bytes
    seedArchiveFile(stashDir, "2026-01-01-memories-old/memories/old.md", "12345"); // 5 bytes
    seedArchiveFile(stashDir, "2026-02-01-memories-other/cleanup.md", "123"); // 3 bytes

    const advisory = collectArchiveUsageAdvisory(stashDir);

    expect(advisory?.name).toBe("memory-cleanup-archive");
    expect(advisory?.status).toBe("pass");
    expect(advisory?.evidence).toEqual({ files: 3, bytes: 18 });
    expect(advisory?.message).toContain("3 archived file(s)");
  });
});
