/**
 * The compiled standalone binary's semantic search, built here
 * (`scripts/build-standalone.ts`, for the host) and run on a small generated
 * stash. The binary embeds no native file. Where akm offers local embeddings,
 * `akm setup --yes --embedding local` gets onnxruntime-node's binding and library
 * into akm's cache (from the shared copy in `.ci-cache/akm/onnxruntime/` when a
 * run has kept one, else from the npm registry) and the model, and
 * `akm index --full` reports a ready status, a vector for every entry and the
 * `onnxruntime-node` runtime. Everywhere else the same setup warns and saves
 * keyword search; with semantic search turned on anyway the index reports it
 * unavailable for the platform, `akm health` warns, and search is keyword.
 *
 * Gated behind AKM_SEMANTIC_TESTS=1 like semantic-search-e2e.test.ts, because it
 * needs the model (the first run downloads it into HF_HOME, or the same
 * repo-local `.ci-cache/huggingface` the end-to-end test uses). The gated
 * workflows run it on Linux, macOS and Windows, the only places the binary runs
 * on each.
 *
 * Usage:
 *   AKM_SEMANTIC_TESTS=1 bun test tests/integration/standalone-semantic.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { hasLocalEmbeddings, ONNXRUNTIME_VERSION } from "../../src/llm/embedders/onnx-runtime";
import { keepOnnxRuntime, seedOnnxRuntime } from "../_helpers/onnx-runtime-cache";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../_helpers/sandbox";

const SEMANTIC_TESTS = process.env.AKM_SEMANTIC_TESTS === "1";
const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");
const HF_HOME = process.env.HF_HOME ?? path.join(PROJECT_ROOT, ".ci-cache", "huggingface");

interface Verification {
  semanticStatus: string;
  entryCount: number;
  embeddingCount: number;
  embeddingRuntime?: string;
}

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

  /** A sandbox with five notes, and `akm` run in it as the binary with akm's directories under it. */
  function sandbox(): {
    storage: IsolatedAkmStorage;
    cacheDir: string;
    akm(...args: string[]): ReturnType<typeof spawnSync>;
  } {
    const storage = withIsolatedAkmStorage();
    for (let note = 1; note <= 5; note++) {
      fs.writeFileSync(
        path.join(storage.stashDir, "knowledge", `note-${note}.md`),
        `---\ndescription: Note ${note} about topic ${note}\n---\n# Note ${note}\n\nThe quick brown fox number ${note} jumps over the lazy dog.\n`,
      );
    }
    const akmDirs = {
      AKM_CONFIG_DIR: path.join(process.env.XDG_CONFIG_HOME as string, "akm"),
      AKM_DATA_DIR: path.join(process.env.XDG_DATA_HOME as string, "akm"),
      AKM_CACHE_DIR: path.join(process.env.XDG_CACHE_HOME as string, "akm"),
      AKM_STATE_DIR: path.join(process.env.XDG_STATE_HOME as string, "akm"),
    };
    const akm = (...args: string[]) =>
      spawnSync(binary, args, { env: { ...process.env, ...akmDirs, HF_HOME }, encoding: "utf8", timeout: 600_000 });
    return { storage, cacheDir: akmDirs.AKM_CACHE_DIR, akm };
  }

  const shown = (run: ReturnType<typeof spawnSync>) => `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`;

  test("embeds no native file", () => {
    const text = fs.readFileSync(binary).toString("latin1");
    // Bun keeps an embedded file under `/$bunfs/root/` (`B:/~BUN/root/` on Windows) and writes a `.node` one to the temp directory to load it.
    expect(text.match(/(?:\$bunfs|~BUN)[\\/]root[\\/][^\0"'\s]*\.node/g) ?? []).toEqual([]);
  });

  test.skipIf(!hasLocalEmbeddings())(
    "setup gets the runtime and the model, and the index embeds a vector per entry on onnxruntime-node",
    () => {
      const { storage, cacheDir, akm } = sandbox();
      try {
        seedOnnxRuntime(cacheDir);

        const setup = akm("setup", "--yes", "--no-init", "--embedding", "local", "--format", "json");
        expect(setup.status, shown(setup)).toBe(0);
        expect(JSON.parse(setup.stdout as string).semanticAssets).toBe("ready");
        keepOnnxRuntime(cacheDir);
        const folder = path.join(cacheDir, "onnxruntime", `${ONNXRUNTIME_VERSION}-${process.platform}-${process.arch}`);
        expect(fs.readdirSync(folder).sort()).toEqual(
          [
            "onnxruntime_binding.node",
            process.platform === "darwin" ? `libonnxruntime.${ONNXRUNTIME_VERSION}.dylib` : "libonnxruntime.so.1",
          ].sort(),
        );

        const index = akm("index", "--full", "--format", "json");
        expect(index.status, shown(index)).toBe(0);
        const { verification } = JSON.parse(index.stdout as string) as { verification: Verification };
        expect(verification.semanticStatus).toBe("ready-js");
        expect(verification.entryCount).toBeGreaterThan(0);
        expect(verification.embeddingCount).toBe(verification.entryCount);
        expect(verification.embeddingRuntime).toBe("onnxruntime-node");
      } finally {
        storage.cleanup();
      }
    },
    620_000,
  );

  test.skipIf(hasLocalEmbeddings())(
    "everywhere else: setup saves keyword search, the index reports the platform, health warns, search works",
    () => {
      const { storage, cacheDir, akm } = sandbox();
      try {
        const setup = akm("setup", "--yes", "--no-init", "--embedding", "local", "--format", "json");
        expect(setup.status, shown(setup)).toBe(0);
        expect(setup.stderr).toMatch(
          /Local embeddings are not available on \S+; choose a remote endpoint or keyword search\./,
        );
        expect(JSON.parse(setup.stdout as string).semanticAssets).toBeUndefined();
        const config = JSON.parse(
          fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME as string, "akm", "config.json"), "utf8"),
        );
        expect(config.semanticSearchMode).toBe("off");

        // A config that turns semantic search on anyway, as one copied from another machine does.
        writeSandboxConfig({ semanticSearchMode: "auto" });
        const index = akm("index", "--full", "--format", "json");
        expect(index.status, shown(index)).toBe(0);
        const { verification } = JSON.parse(index.stdout as string) as { verification: Verification };
        expect(verification.semanticStatus).toBe("blocked");
        expect(verification.embeddingCount).toBe(0);

        const health = akm("health", "--no-probe", "--format", "json");
        const check = (
          JSON.parse(health.stdout as string) as {
            hardChecks: { name: string; status: string; evidence?: { unavailable?: string } }[];
          }
        ).hardChecks.find((c) => c.name === "semantic-search");
        expect(check?.status, shown(health)).toBe("warn");
        expect(check?.evidence?.unavailable).toBe("platform");

        const search = akm("search", "quick brown fox", "--format", "json");
        expect(search.status, shown(search)).toBe(0);
        expect((JSON.parse(search.stdout as string) as { searchMode?: string }).searchMode).toBe("keyword");
        expect(search.stdout as string).toContain("note-");
        expect(fs.existsSync(path.join(cacheDir, "onnxruntime"))).toBe(false);
      } finally {
        storage.cleanup();
      }
    },
    620_000,
  );
});
