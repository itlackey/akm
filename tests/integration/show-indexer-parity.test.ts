/**
 * Parity regression for Phase 4 (spec §10 step 4 / §6.2).
 *
 * `akm show` consults `indexer.lookupBundleRef(ref)` first, then reads the file
 * from disk. The risk called out in the v1 implementation plan is that
 * bundle-qualified refs silently regress when the
 * indexer is consulted instead of the directory walker.
 *
 * This test pins both forms — bare ref and origin-prefixed ref — and asserts
 * that `indexer.lookupBundleRef` returns the same on-disk path that `akmShowUnified`
 * resolves to. If a future refactor changes how the indexer keys assets, this
 * test fails fast instead of silently breaking show for installed sources.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmSearch } from "../../src/commands/read/search";
import { akmShowUnified, showLocal } from "../../src/commands/read/show";
import { parseBundleRef } from "../../src/core/asset/asset-ref";
import { resetConfigCache, saveConfig } from "../../src/core/config/config";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { akmIndex, lookupBundleRef } from "../../src/indexer/indexer";
import type { SourceSearchHit } from "../../src/sources/types";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { getMeta } from "../../src/storage/repositories/index-meta-repository";
import { searchVec } from "../../src/storage/repositories/index-vec-repository";
import "../../src/sources/providers/index";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "../_helpers/sandbox";

const createdTmpDirs: string[] = [];
const WEBSITE_ROOT = path.resolve(__dirname, "../fixtures/bundles/website-snapshot");
const GENERIC_ROOT = path.resolve(__dirname, "../fixtures/bundles/generic-files");
const TASK_ROOT = path.resolve(__dirname, "../fixtures/bundles/akm-task");
const OPENCODE_ROOT = path.resolve(__dirname, "../fixtures/bundles/opencode");
const LLM_WIKI_ROOT = path.resolve(__dirname, "../fixtures/bundles/llm-wiki");
const WORKFLOW_ROOT = path.resolve(__dirname, "../fixtures/bundles/akm-workflow");

function _createTmpDir(prefix = "akm-parity-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

function copyFixtureToTmp(sourceRoot: string): string {
  const parent = _createTmpDir("akm-parity-fixture-");
  const root = path.join(parent, path.basename(sourceRoot));
  fs.cpSync(sourceRoot, root, { recursive: true });
  return root;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

async function indexAdapterBundle(
  bundleId: string,
  root: string,
  adapter: "website-snapshot" | "generic-files" | "akm-task" | "opencode" | "llm-wiki" | "akm-workflow",
  writable: boolean,
): Promise<void> {
  saveConfig({
    semanticSearchMode: "off",
    defaultBundle: "local",
    bundles: {
      local: {
        path: stashDir,
        writable: true,
        components: { main: { root: ".", adapter: "akm", writable: true } },
      },
      [bundleId]: {
        path: root,
        writable,
        components: { main: { root: ".", adapter, writable } },
      },
    },
  });
  resetConfigCache();
  await akmIndex({ stashDir, full: true });
}

async function onlyHit(bundleId: string, query: string): Promise<SourceSearchHit> {
  const result = await akmSearch({
    query,
    source: bundleId,
    skipLogging: true,
    disableProjectContext: true,
    disableScopedUtility: true,
  });
  const hits = result.hits.filter((hit): hit is SourceSearchHit => "path" in hit);
  expect(hits).toHaveLength(1);
  const hit = hits[0];
  if (!hit) throw new Error(`expected one search hit for ${bundleId}:${query}`);
  return hit;
}

function createMockEmbeddingServer(embedding: number[] = [1, 0, 0, 0]): {
  url: string;
  server: ReturnType<typeof Bun.serve>;
} {
  const server = Bun.serve({
    port: 0,
    async fetch() {
      return new Response(JSON.stringify({ data: [{ embedding }] }), {
        status: 200,
        headers: { "Content-Type": "application/json", Connection: "close" },
      });
    },
  });
  return { url: `http://localhost:${server.port}/v1/embeddings`, server };
}

let stashDir = "";
let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const dataResult = sandboxXdgDataHome();
  const cacheResult = sandboxXdgCacheHome(dataResult.cleanup);
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  stashDir = stashResult.dir;
  envCleanup = stashResult.cleanup;
  resetConfigCache();
  saveConfig({ semanticSearchMode: "off" });
  resetConfigCache();
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  stashDir = "";
});

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Phase 4 parity: indexer.lookupBundleRef ↔ akmShowUnified", () => {
  test("indexed asset lookup returns the same file akmShow renders", async () => {
    const skillBody = [
      "---",
      "name: parity-skill",
      "description: A skill used to verify Phase 4 parity",
      "---",
      "# Parity skill",
      "",
      "Body content used by the parity test.",
    ].join("\n");
    // Skills live at skills/<name>/SKILL.md (see asset-spec.ts)
    writeFile(path.join(stashDir, "skills", "parity-skill", "SKILL.md"), skillBody);

    await akmIndex({ stashDir, full: true });

    const indexed = await lookupBundleRef(parseBundleRef("skills/parity-skill"));
    expect(indexed).not.toBeNull();
    if (!indexed) return;

    expect(indexed.type).toBe("skill");
    expect(indexed.name).toBe("parity-skill");
    expect(indexed.itemRef).toMatch(/\/\/skills\/parity-skill$/);

    // Reading the indexer-resolved path should yield the on-disk content.
    const fileBody = fs.readFileSync(indexed.filePath, "utf8");
    expect(fileBody).toBe(skillBody);

    // akmShow returns the same path in its rendered response.
    const shown = await akmShowUnified({ ref: "skills/parity-skill" });
    expect(shown.path).toBe(indexed.filePath);
    expect(indexed.itemRef).toMatch(/\/\/skills\/parity-skill$/);
    expect(shown.ref).toBe("skills/parity-skill");
  });

  test("a missing qualified bundle does not retarget to the primary stash", async () => {
    const body = ["---", "name: origin-skill", "description: Test", "---", "# origin"].join("\n");
    writeFile(path.join(stashDir, "skills", "origin-skill", "SKILL.md"), body);

    await akmIndex({ stashDir, full: true });

    const bare = await lookupBundleRef(parseBundleRef("skills/origin-skill"));
    const local = await lookupBundleRef(parseBundleRef("local//skills/origin-skill"));
    expect(bare).not.toBeNull();
    expect(local).toBeNull();

    const shownBare = await akmShowUnified({ ref: "skills/origin-skill" });
    await expect(akmShowUnified({ ref: "local//skills/origin-skill" })).rejects.toThrow();
    expect(shownBare.path).toBe(bare?.filePath as string);
  });

  test("lookup keys on canonical item_ref even when presentation metadata diverges", async () => {
    writeFile(path.join(stashDir, "knowledge", "identity.md"), "# Identity\n");
    await akmIndex({ stashDir, full: true });

    const dbPath = path.join(process.env.XDG_DATA_HOME as string, "akm", "index.db");
    const db = openIndexDatabase(dbPath);
    try {
      db.prepare(
        "UPDATE entries SET document_json = json_set(document_json, '$.name', 'presentation-only') WHERE type = 'knowledge'",
      ).run();
    } finally {
      closeDatabase(db);
    }

    const indexed = await lookupBundleRef(parseBundleRef("knowledge/identity"));
    expect(indexed).not.toBeNull();
    expect(indexed?.itemRef).toEndWith("//knowledge/identity");
  });

  test("lookup and show do not downgrade embedding dimension metadata", async () => {
    const { url, server } = createMockEmbeddingServer();
    const body = ["---", "name: embed-skill", "description: Test", "---", "# embed"].join("\n");
    writeFile(path.join(stashDir, "skills", "embed-skill", "SKILL.md"), body);

    saveConfig({
      semanticSearchMode: "auto",
      embedding: {
        provider: "openai-compatible",
        endpoint: url,
        model: "test-embed",
        dimension: 4,
      },
    });
    resetConfigCache();

    try {
      await akmIndex({ stashDir, full: true });
      await lookupBundleRef(parseBundleRef("skills/embed-skill"));
      await akmShowUnified({ ref: "skills/embed-skill" });

      const db = openIndexDatabase(path.join(process.env.XDG_DATA_HOME as string, "akm", "index.db"), {
        embeddingDim: 4,
      });
      try {
        expect(getMeta(db, "embeddingDim")).toBe("4");
        expect(getMeta(db, "hasEmbeddings")).toBe("1");
        expect(searchVec(db, [1, 0, 0, 0], 10)).toHaveLength(1);
      } finally {
        closeDatabase(db);
      }
    } finally {
      server.stop(true);
    }
  });

  test("missing asset lookup returns null", async () => {
    await akmIndex({ stashDir, full: true });
    const result = await lookupBundleRef(parseBundleRef("skills/does-not-exist"));
    expect(result).toBeNull();
  });

  test("website search results retain their indexed projection through show", async () => {
    await indexAdapterBundle("website-fixture", WEBSITE_ROOT, "website-snapshot", false);

    const hit = await onlyHit("website-fixture", "second crawled");
    const indexed = await lookupBundleRef(parseBundleRef(hit.ref));
    const shown = await akmShowUnified({ ref: hit.ref, skipLogging: true });

    expect(hit).toMatchObject({
      type: "website",
      name: "About Example",
      ref: "website-fixture//example-com/about",
      description: "Snapshot of https://example.com/about",
    });
    expect(indexed).toMatchObject({
      adapterId: "website-snapshot",
      type: "website",
      document: { ownsPresentation: true },
    });
    expect(shown).toMatchObject({
      type: hit.type,
      name: hit.name,
      ref: hit.ref,
      path: hit.path,
      description: hit.description,
      content: indexed?.document?.content,
    });
  });

  test("generic Markdown search results retain their indexed document type through show", async () => {
    await indexAdapterBundle("generic-fixture", copyFixtureToTmp(GENERIC_ROOT), "generic-files", true);

    const hit = await onlyHit("generic-fixture", "special structure");
    const indexed = await lookupBundleRef(parseBundleRef(hit.ref));
    const shown = await akmShowUnified({ ref: hit.ref, skipLogging: true });

    expect(hit).toMatchObject({ type: "document", name: "notes", ref: "generic-fixture//notes" });
    expect(indexed).toMatchObject({
      adapterId: "generic-files",
      type: "document",
      document: { ownsPresentation: true },
    });
    expect(shown).toMatchObject({
      type: hit.type,
      name: hit.name,
      ref: hit.ref,
      path: hit.path,
      content: indexed?.document?.content,
    });
  });

  test("generic non-Markdown search results can be shown from their indexed projection", async () => {
    await indexAdapterBundle("generic-fixture", copyFixtureToTmp(GENERIC_ROOT), "generic-files", true);

    const hit = await onlyHit("generic-fixture", "alpha");
    const indexed = await lookupBundleRef(parseBundleRef(hit.ref));
    const shown = await akmShowUnified({ ref: hit.ref, skipLogging: true });

    expect(hit).toMatchObject({ type: "file", name: "data.csv", ref: "generic-fixture//data.csv" });
    expect(indexed).toMatchObject({ adapterId: "generic-files", type: "file" });
    expect(shown).toMatchObject({
      type: hit.type,
      name: hit.name,
      ref: hit.ref,
      path: hit.path,
      content: indexed?.document?.content,
    });
  });

  test("standalone task bundles use the indexed task renderer outside a tasks directory", async () => {
    await indexAdapterBundle("task-fixture", copyFixtureToTmp(TASK_ROOT), "akm-task", true);

    const shown = await akmShowUnified({ ref: "task-fixture//nightly-index", skipLogging: true });

    expect(shown).toMatchObject({
      type: "task",
      name: "nightly-index",
      ref: "task-fixture//nightly-index",
    });
    expect(shown.content).toContain('schedule: "@daily"');
  });

  test("OpenCode command and instruction paths keep their indexed native types", async () => {
    await indexAdapterBundle("opencode-fixture", copyFixtureToTmp(OPENCODE_ROOT), "opencode", true);

    const command = await akmShowUnified({ ref: "opencode-fixture//commands/test", skipLogging: true });
    const indexedInstruction = await lookupBundleRef(parseBundleRef("opencode-fixture//AGENTS"));
    const instruction = await akmShowUnified({ ref: "opencode-fixture//AGENTS", skipLogging: true });

    expect(command).toMatchObject({ type: "command", name: "test", ref: "opencode-fixture//commands/test" });
    expect(command.template).toContain("Run the tests");
    expect(indexedInstruction?.document?.ownsPresentation).toBe(true);
    expect(instruction).toMatchObject({ type: "instruction", name: "AGENTS", ref: "opencode-fixture//AGENTS" });
    expect(instruction.content).toContain("# Sample AGENTS.md");
  });

  test("open llm-wiki page kinds cannot opt into an AKM agent renderer", async () => {
    const root = copyFixtureToTmp(LLM_WIKI_ROOT);
    const pagePath = path.join(root, "pages", "http-caching.md");
    fs.writeFileSync(
      pagePath,
      fs
        .readFileSync(pagePath, "utf8")
        .replace("pageKind: concept", "pageKind: agent\nmodel: attacker/model\ntools: [write]"),
      "utf8",
    );
    await indexAdapterBundle("wiki-fixture", root, "llm-wiki", false);

    const shown = await akmShowUnified({ ref: "wiki-fixture//pages/http-caching", skipLogging: true });

    expect(shown.type).toBe("agent");
    expect(shown.content).toContain("# HTTP caching");
    expect(shown.prompt).toBeUndefined();
    expect(shown.modelHint).toBeUndefined();
    expect(shown.toolPolicy).toBeUndefined();
  });

  test("standalone workflow actions use the adapter-owned canonical ref", async () => {
    await indexAdapterBundle("workflow-fixture", copyFixtureToTmp(WORKFLOW_ROOT), "akm-workflow", true);

    const shown = await akmShowUnified({ ref: "workflow-fixture//release", skipLogging: true });

    expect(shown.type).toBe("workflow");
    expect(shown.action).toContain("'workflow-fixture//release'");
    expect(shown.action).not.toContain("workflow-fixture//workflows/release");
  });

  test.each([
    "ordinary",
    "standalone",
  ] as const)("%s GitHub YAML workflow indexes and shows through its owning adapter", async (kind) => {
    const yaml = `name: YAML show
on: { workflow_dispatch: null }
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: verify
        run: bun test
        shell: bash
        working-directory: packages/cli
`;
    if (kind === "ordinary") {
      writeFile(path.join(stashDir, "workflows", "yaml-show.yml"), yaml);
      await akmIndex({ stashDir, full: true });
      const shown = await akmShowUnified({ ref: "workflows/yaml-show", skipLogging: true });
      expect(shown).toMatchObject({
        type: "workflow",
        name: "yaml-show",
        steps: [
          {
            id: "verify",
            orchestration: { exec: { command: ["bash", "-c", "bun test"], cwd: "packages/cli" } },
          },
        ],
      });
      return;
    }

    const root = _createTmpDir("akm-yaml-show-");
    writeFile(path.join(root, "yaml-show.yml"), yaml);
    await indexAdapterBundle("workflow-yaml", root, "akm-workflow", true);
    const shown = await akmShowUnified({ ref: "workflow-yaml//yaml-show", skipLogging: true });
    expect(shown).toMatchObject({
      type: "workflow",
      name: "yaml-show",
      steps: [
        {
          id: "verify",
          orchestration: { exec: { command: ["bash", "-c", "bun test"], cwd: "packages/cli" } },
        },
      ],
    });
  });

  test("invalid owned YAML is not indexed and show does not parse an unindexed file", async () => {
    const invalidPath = path.join(stashDir, "workflows", "invalid-template.yml");
    writeFile(
      invalidPath,
      `name: Invalid template
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: dup
        run: echo one
      - id: dup
        run: echo two
`,
    );
    await akmIndex({ stashDir, full: true });

    expect(await lookupBundleRef(parseBundleRef("workflows/invalid-template"))).toBeNull();
    await expect(akmShowUnified({ ref: "workflows/invalid-template", skipLogging: true })).rejects.toThrow(
      /not found/i,
    );
  });

  test("non-Markdown indexed files ignore Markdown heading fragments, with a warning, and render in full", async () => {
    await indexAdapterBundle("generic-fixture", copyFixtureToTmp(GENERIC_ROOT), "generic-files", true);

    const warnings: unknown[][] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args);
    });
    let shown: Awaited<ReturnType<typeof akmShowUnified>>;
    try {
      shown = await akmShowUnified({ ref: "generic-fixture//data.csv#alpha", skipLogging: true });
    } finally {
      _setWarnSinkForTests(undefined);
      _resetWarnOnceForTests();
    }

    expect(shown.content).toContain("alpha");
    expect(
      warnings.some(
        (args) =>
          args.some((a) => String(a).includes('Fragment "#alpha"')) &&
          args.some((a) => String(a).includes("not a Markdown document")),
      ),
    ).toBe(true);
  });

  test("fragment lead context is indexed-safe, provenance-rich, stale-revision stable, and bounded", async () => {
    const assetPath = path.join(stashDir, "knowledge", "memory.md");
    const sections = Array.from({ length: 24 }, (_, index) => {
      const marker = index === 23 ? "latefragmentneedle selected proof" : `ordinary section ${index + 1}`;
      return `## Turn ${index + 1}\n${marker} ${"context ".repeat(105)}`;
    });
    const original = [
      "# Profile",
      "I take yoga classes at Serenity Yoga.",
      "<!-- COMMENT_SECRET -->",
      "[private portal](https://secret.invalid/token)",
      "```text",
      "FENCED_SECRET",
      "```",
      ...sections,
    ].join("\n\n");
    writeFile(assetPath, original);
    await akmIndex({ stashDir, full: true });

    const hit = (await akmSearch({ query: "latefragmentneedle", type: "knowledge", skipLogging: true })).hits.find(
      (candidate): candidate is SourceSearchHit => "path" in candidate,
    );
    if (!hit) throw new Error("expected fragment hit");
    expect(hit.ref).toMatch(/#akm-fragment-/);
    expect(hit.selectedRef).toBe(hit.ref);
    expect(hit.parentRef).toBe("knowledge/memory");
    expect(hit.fragmentOrdinal).toBeGreaterThan(20);
    expect(hit.fragmentCount).toBeGreaterThanOrEqual(hit.fragmentOrdinal!);
    expect(hit.startLine).toBeGreaterThan(20);
    expect(hit.previousRef).toMatch(/#akm-fragment-/);
    expect(hit.fragmentEstimatedTokens).toBe(hit.estimatedTokens);
    expect(hit.parentEstimatedTokens).toBeGreaterThan(hit.estimatedTokens!);
    expect(hit.matchStage).toBe("exact");

    const exact = await akmShowUnified({ ref: hit.ref, skipLogging: true });
    expect(exact.content).toContain("latefragmentneedle selected proof");
    expect(exact.content).not.toContain("Serenity Yoga");
    expect(exact.contextMode).toBe("exact");
    expect(exact.selectedRef).toBe(hit.ref);

    // Opaque selectors continue to resolve the indexed revision even if disk
    // changes before show. Context assembly must not reconstruct from this
    // newer raw file or reintroduce bytes removed by the safe projection.
    writeFile(assetPath, "# Replaced\nNEW_DISK_ONLY <!-- NEW_COMMENT_SECRET -->");
    const contextual = await akmShowUnified({
      ref: hit.ref,
      contextMode: "lead",
      maxContextChars: 3200,
      skipLogging: true,
    });
    expect(contextual.content?.length).toBeLessThanOrEqual(3200);
    expect(contextual.content).toContain("Serenity Yoga");
    expect(contextual.content).toEndWith(exact.content!);
    expect(contextual.content).toContain("[Selected matching fragment]");
    expect(contextual.content).not.toContain("NEW_DISK_ONLY");
    expect(contextual.content).not.toContain("COMMENT_SECRET");
    expect(contextual.content).not.toContain("FENCED_SECRET");
    expect(contextual.content).not.toContain("secret.invalid");
    expect(contextual).toMatchObject({
      ref: "knowledge/memory",
      selectedRef: hit.ref,
      parentRef: "knowledge/memory",
      fragmentOrdinal: hit.fragmentOrdinal,
      fragmentCount: hit.fragmentCount,
      contextMode: "lead",
      contextMaxChars: 3200,
    });
  });

  test("lead budgets preserve a fitting selected fragment before lead and canonicalize heading aliases", async () => {
    writeFile(
      path.join(stashDir, "knowledge", "friendly.md"),
      ["# Lead", `lead ${"background ".repeat(80)}`, "", "# Details", "decisive selected answer"].join("\n"),
    );
    await akmIndex({ stashDir, full: true });

    const exact = await akmShowUnified({ ref: "knowledge/friendly#details", skipLogging: true });
    const selectedBlock = `[Selected matching fragment]\n${exact.content}`;
    const shown = await akmShowUnified({
      ref: "knowledge/friendly#details",
      contextMode: "lead",
      maxContextChars: selectedBlock.length + 12,
      skipLogging: true,
    });

    expect(shown.content?.length).toBeLessThanOrEqual(selectedBlock.length + 12);
    expect(shown.content).toEndWith(selectedBlock);
    expect(shown.content).not.toContain("background");
    expect(shown.contextTruncated).toBe(true);
    expect(shown.selectedRef).toMatch(/^knowledge\/friendly#akm-fragment-/);
    expect(shown.selectedRef).not.toContain("#details");
    expect(shown.fragmentOrdinal).toBe(2);
  });

  test("source-live exact heading responses do not claim indexed-safe provenance", async () => {
    const assetPath = path.join(stashDir, "knowledge", "source-live.md");
    writeFile(assetPath, "# Lead\nold lead\n\n# Details\nold indexed detail");
    await akmIndex({ stashDir, full: true });

    // Bypass unified show's normal freshness pass to model a disk revision
    // changing after lookup. Exact friendly headings intentionally render the
    // source-live bytes, including bytes the indexed-safe projection removes.
    writeFile(
      assetPath,
      [
        "# Lead",
        "new lead",
        "",
        "# Details",
        "new source-live detail",
        "<!-- SOURCE_LIVE_COMMENT -->",
        "[source-live link](https://source-live.invalid/token)",
        "```text",
        "SOURCE_LIVE_FENCE",
        "```",
      ].join("\n"),
    );
    const exact = await showLocal({ ref: "knowledge/source-live#details" });

    expect(exact.content).toContain("new source-live detail");
    expect(exact.content).toContain("SOURCE_LIVE_COMMENT");
    expect(exact.content).toContain("source-live.invalid/token");
    expect(exact.content).toContain("SOURCE_LIVE_FENCE");
    expect(exact.selectedRef).toBeUndefined();
    expect(exact.parentRef).toBeUndefined();
    expect(exact.fragmentOrdinal).toBeUndefined();
    expect(exact.fragmentChars).toBeUndefined();
    expect(exact.contextMode).toBeUndefined();
  });

  test("lead context rejects whole assets and invalid budgets", async () => {
    writeFile(path.join(stashDir, "knowledge", "plain.md"), "# Plain\nbody");
    await akmIndex({ stashDir, full: true });

    await expect(
      akmShowUnified({ ref: "knowledge/plain", contextMode: "lead", skipLogging: true }),
    ).rejects.toMatchObject({ code: "INVALID_FLAG_VALUE" });
    await expect(
      akmShowUnified({ ref: "knowledge/plain#plain", contextMode: "exact", maxContextChars: 10, skipLogging: true }),
    ).rejects.toMatchObject({ code: "INVALID_FLAG_VALUE" });
  });
});
