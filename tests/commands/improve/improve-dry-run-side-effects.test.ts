// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression test: `akm improve --dry-run` must not write any AKM artifact.
 *
 * Background — the documented contract of dry-run is "report planned changes
 * without modifying anything." Past incidents have surfaced where dry-run
 * runs shared an artifact path with real runs (e.g., a `.akm/runs/<id>/`
 * directory that landed regardless of the `--dry-run` flag). The manual
 * testing checklist asserts this invariant prose-style, but no automated
 * gate pinned it — so a regression could slip through.
 *
 * This test pins the invariant across config, data, state, cache, and stash:
 * every root is byte-identical before and after `akmImprove({ dryRun: true })`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { akmImprove } from "../../../src/commands/improve/improve";
import { saveConfig } from "../../../src/core/config/config";
import { getStashLocksDir } from "../../../src/core/paths";
import { getStateDbPath } from "../../../src/core/state-db";
import { akmIndex } from "../../../src/indexer/indexer";
import {
  type Cleanup,
  makeSandboxDir,
  type SandboxedDir,
  sandboxEnvDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  withEnv,
  withMockedFetch,
} from "../../_helpers/sandbox";

const TIMEOUT_MS = 15_000;
const dryRunConfig = {
  configVersion: "0.9.0" as const,
  semanticSearchMode: "off" as const,
  engines: {
    test: { kind: "llm" as const, endpoint: "https://example.test/v1/chat/completions", model: "test" },
  },
  defaults: { llmEngine: "test" },
};

const disposers: SandboxedDir[] = [];
let sandboxRoots: Record<"cache" | "config" | "data" | "state", string>;
let envCleanup: Cleanup = () => {};

function makeTempDir(prefix: string): string {
  const d = makeSandboxDir(prefix);
  disposers.push(d);
  return d.dir;
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

function snapshotSandboxRoots(stashDir: string): Record<string, Map<string, string>> {
  return Object.fromEntries(
    Object.entries({ ...sandboxRoots, stash: stashDir }).map(([name, root]) => [name, snapshotDir(root)]),
  );
}

function expectSandboxRootsUnchanged(before: Record<string, Map<string, string>>, stashDir: string): void {
  const after = snapshotSandboxRoots(stashDir);
  const diffs = Object.keys(before).flatMap((name) =>
    diffSnapshots(before[name]!, after[name]!).map((diff) => `${name}: ${diff}`),
  );
  if (diffs.length > 0) {
    throw new Error(`Dry-run leaked AKM artifacts:\n${diffs.join("\n")}`);
  }
}

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const configResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const dataResult = sandboxEnvDir("akm-dryrun-data-", "AKM_DATA_DIR", configResult.cleanup);
  const stateResult = sandboxEnvDir("akm-dryrun-state-", "AKM_STATE_DIR", dataResult.cleanup);
  sandboxRoots = { cache: cacheResult.dir, config: configResult.dir, data: dataResult.dir, state: stateResult.dir };
  envCleanup = stateResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  for (const d of disposers.splice(0)) d.cleanup();
});

describe("akm improve --dry-run writes no AKM artifacts", () => {
  test("schema validation never dispatches repair or writes proposals, events, or locks", async () => {
    const stashDir = makeTempDir("akm-dryrun-schema-repair-");
    const lessonPath = path.join(stashDir, "lessons", "broken.md");
    fs.mkdirSync(path.dirname(lessonPath), { recursive: true });
    fs.writeFileSync(lessonPath, "---\nwhen_to_use: Testing dry planning\n---\n\nBody.\n", "utf8");
    const before = snapshotSandboxRoots(stashDir);
    const ensureIndexFn = mock(async () => {
      throw new Error("dry-run invoked ensureIndex");
    });
    const fetchCalls: string[] = [];

    const result = await withMockedFetch(
      () =>
        akmImprove({
          scope: "lesson",
          stashDir,
          dryRun: true,
          ensureIndexFn,
          collectEligibleRefsFn: (async () => ({
            plannedRefs: [{ ref: "lessons/broken", reason: "scope-type", filePath: lessonPath }],
            memorySummary: { eligible: 0, derived: 0 },
            strategyFilteredRefs: [],
          })) as never,
          config: {
            configVersion: "0.9.0",
            semanticSearchMode: "off",
            bundles: { stash: { path: stashDir, writable: true } },
            defaultBundle: "stash",
            engines: {
              repair: {
                kind: "llm",
                endpoint: "https://example.test/v1/chat/completions",
                model: "repair",
              },
            },
            defaults: { llmEngine: "repair" },
            improve: {
              strategies: {
                "dry-schema": {
                  processes: {
                    reflect: { enabled: false },
                    distill: { enabled: false },
                    consolidate: { enabled: false },
                    memoryInference: { enabled: false },
                    graphExtraction: { enabled: false },
                    extract: { enabled: false },
                    validation: { enabled: true, engine: "repair" },
                    triage: { enabled: false },
                    proactiveMaintenance: { enabled: false },
                    recombine: { enabled: false },
                    procedural: { enabled: false },
                  },
                },
              },
            },
          },
          strategy: "dry-schema",
        }),
      (url) => {
        fetchCalls.push(url);
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  description: "A repaired lesson description",
                  when_to_use: "When testing dry planning",
                }),
              },
            },
          ],
        });
      },
    );

    expect(result.plan?.gates.find((gate) => gate.name === "validation")?.removed).toBe(1);
    expect(fetchCalls).toEqual([]);
    expect(ensureIndexFn).not.toHaveBeenCalled();
    expect(fs.existsSync(getStateDbPath())).toBe(false);
    expect(fs.existsSync(path.join(getStashLocksDir(stashDir), "improve.lock"))).toBe(false);
    expectSandboxRootsUnchanged(before, stashDir);
  });

  test("live improve lint is read-only and never invokes the mutating contradiction detector", async () => {
    const stashDir = makeTempDir("akm-live-readonly-lanes-");
    const filePath = path.join(stashDir, "knowledge", "guide.md");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const original = "---\ndescription: Guide without updated metadata\n---\n\nBody.\n";
    fs.writeFileSync(filePath, original);
    const result = await akmImprove({
      stashDir,
      ensureIndexFn: async () => false,
      collectEligibleRefsFn: (async () => ({
        plannedRefs: [],
        memorySummary: { eligible: 1, derived: 0 },
        strategyFilteredRefs: [],
      })) as never,
      config: {
        ...dryRunConfig,
        bundles: { stash: { path: stashDir, writable: true } },
        defaultBundle: "stash",
        experimental: { improveAutonomy: true },
        improve: {
          strategies: {
            default: {
              processes: {
                reflect: { enabled: false },
                distill: { enabled: false },
                consolidate: { enabled: true, contradictionDetection: { enabled: true } },
              },
            },
          },
        },
      },
    });
    expect(result.lintSummary?.fixed).toBe(0);
    expect(fs.readFileSync(filePath, "utf8")).toBe(original);
  });

  test(
    "stash directory is byte-identical before and after akmImprove({ dryRun: true })",
    async () => {
      const stashDir = makeTempDir("akm-dryrun-stash-");
      writeMemory(stashDir, "alpha", "Remember alpha details.");
      writeMemory(stashDir, "beta", "Remember beta details too.");
      await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
        saveConfig(dryRunConfig);
        await akmIndex({ stashDir, full: true });

        const before = snapshotSandboxRoots(stashDir);
        expect(before.stash!.size).toBeGreaterThan(0);

        const result = await akmImprove({
          scope: "memory",
          stashDir,
          dryRun: true,
          ensureIndexFn: mock(async () => {
            throw new Error("dry-run invoked ensureIndex");
          }),
        });

        expect(result.ok).toBe(true);
        expect(result.dryRun).toBe(true);

        expectSandboxRootsUnchanged(before, stashDir);
      });
    },
    TIMEOUT_MS,
  );

  test(
    "a fresh dry-run returns an empty plan without creating index.db or root artifacts",
    async () => {
      const stashDir = makeTempDir("akm-dryrun-empty-");
      fs.mkdirSync(path.join(stashDir, "memories"), { recursive: true });
      await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
        const before = snapshotSandboxRoots(stashDir);

        const result = await akmImprove({ stashDir, dryRun: true, config: dryRunConfig });
        expect(result.ok).toBe(true);
        expect(result.dryRun).toBe(true);
        expect(result.plannedRefs).toEqual([]);

        expect(fs.existsSync(path.join(sandboxRoots.data, "index.db"))).toBe(false);
        expectSandboxRootsUnchanged(before, stashDir);
      });
    },
    TIMEOUT_MS,
  );

  test("does not index, call a model, or write contradiction frontmatter", async () => {
    const stashDir = makeTempDir("akm-dryrun-contradiction-");
    const memoriesDir = path.join(stashDir, "memories");
    fs.mkdirSync(memoriesDir, { recursive: true });
    const firstPath = path.join(memoriesDir, "deploy-a.derived.md");
    const secondPath = path.join(memoriesDir, "deploy-b.derived.md");
    fs.writeFileSync(
      firstPath,
      "---\ndescription: Deploy through VPN\ninferred: true\nsource: memories/deploy\n---\n\nUse the VPN.\n",
    );
    fs.writeFileSync(
      secondPath,
      "---\ndescription: Deploy without VPN\ninferred: true\nsource: memories/deploy\n---\n\nDo not use the VPN.\n",
    );
    const before = snapshotSandboxRoots(stashDir);
    const ensureIndexFn = mock(async () => {
      throw new Error("dry-run invoked ensureIndex");
    });
    const fetchCalls: string[] = [];

    const result = await withMockedFetch(
      () =>
        akmImprove({
          stashDir,
          dryRun: true,
          strategy: "dry-safe",
          ensureIndexFn,
          collectEligibleRefsFn: (async () => ({
            plannedRefs: [],
            memorySummary: { eligible: 2, derived: 2 },
            strategyFilteredRefs: [],
          })) as never,
          config: {
            configVersion: "0.9.0",
            semanticSearchMode: "off",
            bundles: { stash: { path: stashDir, writable: true } },
            defaultBundle: "stash",
            engines: {
              judge: {
                kind: "llm",
                endpoint: "https://example.test/v1/chat/completions",
                model: "judge",
              },
            },
            defaults: { llmEngine: "judge" },
            improve: {
              strategies: {
                "dry-safe": {
                  processes: {
                    reflect: { enabled: false },
                    distill: { enabled: false },
                    consolidate: { enabled: true, contradictionDetection: { enabled: true } },
                    memoryInference: { enabled: false },
                    graphExtraction: { enabled: false },
                    extract: { enabled: false },
                    validation: { enabled: false },
                    triage: { enabled: false },
                    proactiveMaintenance: { enabled: false },
                    recombine: { enabled: false },
                    procedural: { enabled: false },
                  },
                },
              },
            },
          },
        }),
      (url) => {
        fetchCalls.push(url);
        return new Response('{"choices":[{"message":{"content":"{\\"contradicts\\":true,\\"confidence\\":1}"}}]}');
      },
    );

    expect(result.dryRun).toBe(true);
    expect(result.memoryCleanup).toBeDefined();
    expect(result.memoryCleanup?.analyzedDerived).toBe(2);
    expect(result.memoryCleanup?.archived).toBeUndefined();
    expect(ensureIndexFn).not.toHaveBeenCalled();
    expect(fetchCalls).toEqual([]);
    expectSandboxRootsUnchanged(before, stashDir);
    expect(fs.readFileSync(firstPath, "utf8")).not.toContain("contradictedBy");
    expect(fs.readFileSync(secondPath, "utf8")).not.toContain("contradictedBy");
  });
});
