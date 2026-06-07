// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression test: `akm improve --dry-run` must not write to the stash.
 *
 * Background — the documented contract of dry-run is "report planned changes
 * without modifying anything." Past incidents have surfaced where dry-run
 * runs shared an artifact path with real runs (e.g., a `.akm/runs/<id>/`
 * directory that landed regardless of the `--dry-run` flag). The manual
 * testing checklist asserts this invariant prose-style, but no automated
 * gate pinned it — so a regression could slip through.
 *
 * This test pins the invariant: snapshot the stash directory before and
 * after `akmImprove({ dryRun: true })`, then assert the snapshot is
 * byte-identical. Only the stash itself is checked. The event-log database
 * (in $XDG_DATA_HOME) and registry cache (in $XDG_CACHE_HOME) intentionally
 * receive an `improve_invoked` event even on dry-run for observability —
 * that is *not* a side effect on user content.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmImprove } from "../../../src/commands/improve/improve";
import { saveConfig } from "../../../src/core/config";
import { akmIndex } from "../../../src/indexer/indexer";

const TIMEOUT_MS = 15_000;

const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {
  AKM_STASH_DIR: process.env.AKM_STASH_DIR,
  AKM_DATA_DIR: process.env.AKM_DATA_DIR,
  AKM_STATE_DIR: process.env.AKM_STATE_DIR,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeMemory(stashDir: string, name: string, body: string): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${name} memory\n---\n\n${body}\n`, "utf8");
}

/**
 * Recursively walk `root` and return a stable, sorted map of relative paths
 * to a `{ size, contentSha256 }` digest. Stable across runs given identical
 * filesystem state. Directories are recorded by their presence (no size).
 * Symlinks are followed only if they resolve inside `root`.
 */
function snapshotDir(root: string): Map<string, string> {
  const snap = new Map<string, string>();
  if (!fs.existsSync(root)) return snap;

  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        snap.set(`${rel}/`, "dir");
        walk(full);
      } else if (entry.isFile()) {
        const bytes = fs.readFileSync(full);
        const hash = createHash("sha256").update(bytes).digest("hex");
        snap.set(rel, `${bytes.length}:${hash}`);
      }
    }
  }
  walk(root);
  return snap;
}

function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const diffs: string[] = [];
  const allKeys = new Set([...before.keys(), ...after.keys()]);
  for (const key of [...allKeys].sort()) {
    const b = before.get(key);
    const a = after.get(key);
    if (b === a) continue;
    if (b === undefined) diffs.push(`+ ${key} (${a})`);
    else if (a === undefined) diffs.push(`- ${key} (${b})`);
    else diffs.push(`~ ${key} (${b} → ${a})`);
  }
  return diffs;
}

beforeEach(() => {
  process.env.XDG_CACHE_HOME = makeTempDir("akm-dryrun-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-dryrun-config-");
  process.env.AKM_DATA_DIR = makeTempDir("akm-dryrun-data-");
  process.env.AKM_STATE_DIR = makeTempDir("akm-dryrun-state-");
});

afterEach(() => {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("akm improve --dry-run writes nothing to the stash directory", () => {
  test(
    "stash directory is byte-identical before and after akmImprove({ dryRun: true })",
    async () => {
      const stashDir = makeTempDir("akm-dryrun-stash-");
      writeMemory(stashDir, "alpha", "Remember alpha details.");
      writeMemory(stashDir, "beta", "Remember beta details too.");
      process.env.AKM_STASH_DIR = stashDir;
      saveConfig({ semanticSearchMode: "off" });
      await akmIndex({ stashDir, full: true });

      // Allow any post-index lazy writes to settle.
      const before = snapshotDir(stashDir);
      expect(before.size).toBeGreaterThan(0);

      const result = await akmImprove({
        scope: "memory",
        stashDir,
        dryRun: true,
      });

      expect(result.ok).toBe(true);
      expect(result.dryRun).toBe(true);

      const after = snapshotDir(stashDir);
      const diffs = diffSnapshots(before, after);

      if (diffs.length > 0) {
        throw new Error(
          `Dry-run leaked side effects into the stash dir:\n${diffs.join("\n")}\n` +
            "The stash MUST be byte-identical before and after a dry-run improve.",
        );
      }
    },
    TIMEOUT_MS,
  );

  test(
    "no .akm/proposals/ artifacts appear after a dry-run on an empty memory stash",
    async () => {
      const stashDir = makeTempDir("akm-dryrun-empty-");
      fs.mkdirSync(path.join(stashDir, "memories"), { recursive: true });
      process.env.AKM_STASH_DIR = stashDir;
      saveConfig({ semanticSearchMode: "off" });

      const result = await akmImprove({ stashDir, dryRun: true });
      expect(result.ok).toBe(true);
      expect(result.dryRun).toBe(true);

      const proposalsDir = path.join(stashDir, ".akm", "proposals");
      const hasProposals = fs.existsSync(proposalsDir) && fs.readdirSync(proposalsDir).length > 0;
      expect(hasProposals).toBe(false);
    },
    TIMEOUT_MS,
  );
});
