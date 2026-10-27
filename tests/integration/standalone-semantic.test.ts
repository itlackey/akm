// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The compiled standalone binary embeds with the real model on the native ONNX
 * Runtime. It is built here (`scripts/build-standalone.ts`, for the host) and
 * run on a small generated stash: `akm index --full` must report a ready
 * semantic status, a vector for every entry, and the `onnxruntime-node`
 * runtime, with the shared library it preloaded on disk in akm's cache.
 *
 * Gated behind AKM_SEMANTIC_TESTS=1 like semantic-search-e2e.test.ts, because it
 * needs the model (the first run downloads it into HF_HOME, or the same
 * repo-local `.ci-cache/huggingface` the end-to-end test uses). The gated
 * workflows run it on Linux, macOS and Windows, the only places the preload of
 * each platform's library is exercised.
 *
 * Usage:
 *   AKM_SEMANTIC_TESTS=1 bun test tests/integration/standalone-semantic.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeSandboxDir, type SandboxedDir, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

const SEMANTIC_TESTS = process.env.AKM_SEMANTIC_TESTS === "1";
const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");
const HF_HOME = process.env.HF_HOME ?? path.join(PROJECT_ROOT, ".ci-cache", "huggingface");

describe.skipIf(!SEMANTIC_TESTS)("the standalone binary's semantic search", () => {
  let build: SandboxedDir;
  let binary: string;

  beforeAll(() => {
    build = makeSandboxDir("akm-standalone-semantic");
    binary = path.join(build.dir, process.platform === "win32" ? "akm.exe" : "akm");
    const built = spawnSync("bun", ["scripts/build-standalone.ts", "--outfile", binary, "--version", "0.0.0-test"], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      timeout: 300_000,
    });
    if (built.status !== 0) throw new Error(`the standalone build failed:\n${built.stdout}\n${built.stderr}`);
  }, 320_000);

  afterAll(() => {
    build.cleanup();
  });

  test("indexes a small stash with a vector per entry on onnxruntime-node", () => {
    const storage = withIsolatedAkmStorage();
    try {
      for (let note = 1; note <= 5; note++) {
        fs.writeFileSync(
          path.join(storage.stashDir, "knowledge", `note-${note}.md`),
          `---\ndescription: Note ${note} about topic ${note}\n---\n# Note ${note}\n\nThe quick brown fox number ${note} jumps over the lazy dog.\n`,
        );
      }
      writeSandboxConfig({ semanticSearchMode: "auto" });
      // The sandbox isolates this process through XDG_*; on Windows the binary would resolve its directories from
      // %APPDATA% and %LOCALAPPDATA% ahead of them and never see the config above (the gated run reported
      // `disabled`). The AKM_*_DIR overrides win on every platform, so the binary gets the sandbox's directories
      // explicitly, and the library-cache assertion below reads the same cache directory.
      const akmDirs = {
        AKM_CONFIG_DIR: path.join(process.env.XDG_CONFIG_HOME as string, "akm"),
        AKM_DATA_DIR: path.join(process.env.XDG_DATA_HOME as string, "akm"),
        AKM_CACHE_DIR: path.join(process.env.XDG_CACHE_HOME as string, "akm"),
        AKM_STATE_DIR: path.join(process.env.XDG_STATE_HOME as string, "akm"),
      };

      const run = spawnSync(binary, ["index", "--full", "--format", "json"], {
        env: { ...process.env, ...akmDirs, HF_HOME },
        encoding: "utf8",
        timeout: 600_000,
      });

      expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
      const { verification } = JSON.parse(run.stdout) as {
        verification: {
          semanticStatus: string;
          entryCount: number;
          embeddingCount: number;
          embeddingRuntime?: string;
        };
      };
      expect(verification.semanticStatus).toBe("ready-js");
      expect(verification.entryCount).toBeGreaterThan(0);
      expect(verification.embeddingCount).toBe(verification.entryCount);
      expect(verification.embeddingRuntime).toBe("onnxruntime-node");
      // The binary copied its embedded library into the cache: one version/platform directory holding one file.
      const [libraryDir, ...otherDirs] = fs.readdirSync(path.join(akmDirs.AKM_CACHE_DIR, "onnxruntime"));
      expect(otherDirs).toEqual([]);
      expect(fs.readdirSync(path.join(akmDirs.AKM_CACHE_DIR, "onnxruntime", libraryDir as string))).toHaveLength(1);
    } finally {
      storage.cleanup();
    }
  }, 620_000);
});
