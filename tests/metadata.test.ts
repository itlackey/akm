import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyCuratedFrontmatter,
  extractCommentMetadata,
  extractDescriptionFromComments,
  extractPackageMetadata,
  extractTagsFromPath,
  fileNameToDescription,
  type IndexDocument,
  validateStashEntry,
} from "../src/indexer/passes/metadata";
import { recognizeStashEntries } from "../src/indexer/scan/drain-dir";
import { buildSearchFields, buildSearchText } from "../src/indexer/search/search-fields";

// Renderers auto-register via ensureBuiltinsRegistered in file-context.ts

const createdTmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-meta-"));
  createdTmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

// ── validateStashEntry ──────────────────────────────────────────────────────

test("validateStashEntry rejects entries without name", () => {
  expect(validateStashEntry({ type: "script" })).toBeNull();
});

test("validateStashEntry accepts a foreign/unknown type as an open token (chunk 1.5)", () => {
  const result = validateStashEntry({ name: "x", type: "invalid" });
  expect(result).not.toBeNull();
  expect(result?.type).toBe("invalid");
});

test("validateStashEntry rejects an empty type", () => {
  expect(validateStashEntry({ name: "x", type: "" })).toBeNull();
});

test("validateStashEntry accepts adapter-owned tool/vault types as open tokens", () => {
  expect(validateStashEntry({ name: "x", type: "tool" })).toMatchObject({ name: "x", type: "tool" });
  expect(validateStashEntry({ name: "x", type: "vault" })).toMatchObject({ name: "x", type: "vault" });
});

test("validateStashEntry accepts minimal valid entry", () => {
  const result = validateStashEntry({ name: "x", type: "script" });
  expect(result).not.toBeNull();
  expect(result?.name).toBe("x");
  expect(result?.type).toBe("script");
});

test("validateStashEntry parses quality, confidence, source, and aliases", () => {
  const result = validateStashEntry({
    name: "lint",
    type: "script",
    quality: "curated",
    confidence: 2,
    source: "manual",
    aliases: ["Lint", "linters"],
  });

  expect(result).not.toBeNull();
  expect(result?.quality).toBe("curated");
  expect(result?.confidence).toBe(1);
  expect(result?.source).toBe("manual");
  // R4.6: de-pluralization heuristic removed; FTS5 porter stemmer handles stemming.
  // "linters" is preserved as-is; "linter" is no longer generated.
  expect(result?.aliases).toEqual(["lint", "linters"]);
});

// ── extractDescriptionFromComments ──────────────────────────────────────────

test("extractDescriptionFromComments parses JSDoc block comment", () => {
  const dir = tmpDir();
  const file = path.join(dir, "tool.ts");
  writeFile(file, `/**\n * Generate docker compose stacks\n */\nconsole.log("hi")\n`);

  const desc = extractDescriptionFromComments(file);
  expect(desc).toBe("Generate docker compose stacks");
});

test("extractDescriptionFromComments parses hash comments after shebang", () => {
  const dir = tmpDir();
  const file = path.join(dir, "tool.sh");
  writeFile(file, `#!/usr/bin/env bash\n# Deploy to production\n# Handles rollback\necho deploy\n`);

  const desc = extractDescriptionFromComments(file);
  expect(desc).toBe("Deploy to production Handles rollback");
});

test("extractDescriptionFromComments returns null for no comments", () => {
  const dir = tmpDir();
  const file = path.join(dir, "tool.ts");
  writeFile(file, `console.log("no comments")\n`);

  expect(extractDescriptionFromComments(file)).toBeNull();
});

// ── extractPackageMetadata ──────────────────────────────────────────────────

test("extractPackageMetadata reads package.json fields", () => {
  const dir = tmpDir();
  writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "my-tool", description: "A useful tool", keywords: ["deploy", "ci"] }),
  );

  const meta = extractPackageMetadata(dir);
  expect(meta).not.toBeNull();
  expect(meta?.name).toBe("my-tool");
  expect(meta?.description).toBe("A useful tool");
  expect(meta?.keywords).toEqual(["deploy", "ci"]);
});

test("extractPackageMetadata returns null when no package.json", () => {
  const dir = tmpDir();
  expect(extractPackageMetadata(dir)).toBeNull();
});

// ── fileNameToDescription ───────────────────────────────────────────────────

test("fileNameToDescription converts dashes and underscores to spaces", () => {
  expect(fileNameToDescription("docker-compose-generator")).toBe("docker compose generator");
  expect(fileNameToDescription("my_script_tool")).toBe("my script tool");
});

test("fileNameToDescription handles camelCase", () => {
  expect(fileNameToDescription("dockerBuild")).toBe("docker build");
});

// ── extractTagsFromPath ─────────────────────────────────────────────────────

test("extractTagsFromPath extracts tokens from path segments", () => {
  const root = "/stash/scripts";
  const file = path.join(root, "docker", "compose-generator.ts");
  const tags = extractTagsFromPath(file, root);
  expect(tags).toContain("docker");
  expect(tags).toContain("compose");
  expect(tags).toContain("generator");
});

// ── recognize (index-time metadata assembly) ────────────────────────────────

test("recognize creates entries from script files with filename heuristics", async () => {
  const dir = tmpDir();
  const tool1 = path.join(dir, "scripts", "summarize-diff.ts");
  writeFile(tool1, `console.log("summarize")\n`);

  const stash = recognizeStashEntries(dir, [tool1]);
  expect(stash.entries).toHaveLength(1);
  expect(stash.entries[0]!.name).toBe("summarize-diff.ts");
  expect(stash.entries[0]!.type).toBe("script");
  expect(stash.entries[0]!.description).toBe("summarize diff");
  expect(stash.entries[0]!.quality).toBe("generated");
  expect(stash.entries[0]!.source).toBe("filename");
  expect(stash.entries[0]!.confidence).toBe(0.55);
  expect(stash.entries[0]!.aliases).toContain("summarize diff");
  expect(stash.entries[0]!.filename).toBe("summarize-diff.ts");
});

test("recognize extracts description from code comments", async () => {
  const dir = tmpDir();
  const tool1 = path.join(dir, "scripts", "deploy.sh");
  writeFile(tool1, `#!/usr/bin/env bash\n# Deploy services to production\necho deploy\n`);

  const stash = recognizeStashEntries(dir, [tool1]);
  expect(stash.entries[0]!.description).toBe("Deploy services to production");
  expect(stash.entries[0]!.source).toBe("comments");
});

test("recognize extracts metadata from package.json", async () => {
  const dir = tmpDir();
  const tool1 = path.join(dir, "scripts", "run.ts");
  writeFile(tool1, `console.log("run")\n`);
  writeFile(
    path.join(dir, "scripts", "package.json"),
    JSON.stringify({ description: "Git diff summarizer", keywords: ["git", "diff"] }),
  );

  const stash = recognizeStashEntries(dir, [tool1]);
  expect(stash.entries[0]!.description).toBe("Git diff summarizer");
  expect(stash.entries[0]!.source).toBe("package");
  expect(stash.entries[0]!.confidence).toBe(0.8);
  expect(stash.entries[0]!.tags).toEqual(["git", "diff"]);
});

test("recognize handles multi-script directories", async () => {
  const dir = tmpDir();
  const tool1 = path.join(dir, "scripts", "docker-build.ts");
  const tool2 = path.join(dir, "scripts", "docker-compose.ts");
  writeFile(tool1, `/**\n * Build docker images\n */\n`);
  writeFile(tool2, `/**\n * Generate docker compose stacks\n */\n`);

  const stash = recognizeStashEntries(dir, [tool1, tool2]);
  expect(stash.entries).toHaveLength(2);
  expect(stash.entries[0]!.name).toBe("docker-build.ts");
  expect(stash.entries[0]!.description).toBe("Build docker images");
  expect(stash.entries[1]!.name).toBe("docker-compose.ts");
  expect(stash.entries[1]!.description).toBe("Generate docker compose stacks");
});

// ── validateStashEntry with searchHints ─────────────────────────────────────────

test("validateStashEntry accepts entries with searchHints array", () => {
  const result = validateStashEntry({
    name: "test",
    type: "script",
    searchHints: ["summarize commits", "explain changes"],
  });
  expect(result).not.toBeNull();
  expect(result?.searchHints).toEqual(["summarize commits", "explain changes"]);
});

test("validateStashEntry filters non-string elements from searchHints", () => {
  const result = validateStashEntry({
    name: "test",
    type: "script",
    searchHints: ["valid", 42, "", "also valid", null],
  });
  expect(result).not.toBeNull();
  expect(result?.searchHints).toEqual(["valid", "also valid"]);
});

test("validateStashEntry omits searchHints if all filtered out", () => {
  const result = validateStashEntry({
    name: "test",
    type: "script",
    searchHints: ["", "  "],
  });
  expect(result).not.toBeNull();
  expect(result?.searchHints).toBeUndefined();
});

test("validateStashEntry accepts usage as string", () => {
  const result = validateStashEntry({
    name: "test",
    type: "script",
    usage: "Run after checking branch state",
  });
  expect(result).not.toBeNull();
  expect(result?.usage).toEqual(["Run after checking branch state"]);
});

test("validateStashEntry normalizes usage array", () => {
  const result = validateStashEntry({
    name: "test",
    type: "script",
    usage: ["  First step  ", "", "Second step", 2, null],
  });
  expect(result).not.toBeNull();
  expect(result?.usage).toEqual(["First step", "Second step"]);
});

// ── recognize populates searchHints ─────────────────────────────────────────

test("recognize does not generate heuristic searchHints (LLM-only)", async () => {
  const dir = tmpDir();
  const tool = path.join(dir, "scripts", "summarize-diff.ts");
  writeFile(tool, `/**\n * Summarize git diff changes\n */\n`);

  const stash = recognizeStashEntries(dir, [tool]);
  // Search hints are only generated when LLM is configured, not heuristically
  expect(stash.entries[0]!.searchHints).toBeUndefined();
});

test("extractCommentMetadata parses curated header tags from scripts", () => {
  const dir = tmpDir();
  const file = path.join(dir, "deploy.sh");
  writeFile(
    file,
    [
      "#!/usr/bin/env bash",
      "# @description Deploy service to production",
      "# @tags deploy, production, ops",
      "# @aliases release-service, push-live",
      "# @searchHints deploy service, release rollout",
      "# @usage Run after validating the release branch",
      "# @usage Use with a service slug",
      "# @intent.when user needs to roll out a service",
      "# @intent.input service slug",
      "# @intent.output deployment status",
      "# @run bash deploy.sh $1",
      "# @setup bun install",
      "# @cwd scripts/deploy",
      "# @scope agent=opencode, run=release",
      "echo deploy",
    ].join("\n"),
  );

  const metadata = extractCommentMetadata(file);
  expect(metadata).toEqual({
    description: "Deploy service to production",
    tags: ["deploy", "production", "ops"],
    aliases: ["release-service", "push-live"],
    searchHints: ["deploy service", "release rollout"],
    usage: ["Run after validating the release branch", "Use with a service slug"],
    intent: {
      when: "user needs to roll out a service",
      input: "service slug",
      output: "deployment status",
    },
    run: "bash deploy.sh $1",
    setup: "bun install",
    cwd: "scripts/deploy",
    scope: { agent: "opencode", run: "release" },
  });
});

test("recognize applies curated frontmatter fields for markdown assets", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "commands", "deploy.md");
  writeFile(
    file,
    [
      "---",
      "description: Deploy a service safely",
      "tags:",
      "  - deploy",
      "  - production",
      "aliases:",
      "  - release service",
      "searchHints:",
      "  - deploy rollout",
      "  - ship service",
      "usage:",
      "  - Use after approvals complete",
      "examples:",
      "  - Deploy api to prod",
      "run: akm run deploy",
      "setup: bun install",
      "cwd: tools/release",
      "intent:",
      "  when: user needs to deploy",
      "  input: service name",
      "  output: deployment status",
      "scope:",
      "  user: alice",
      "  agent: opencode",
      "---",
      "Deploy $1",
    ].join("\n"),
  );

  const stash = recognizeStashEntries(dir, [file]);
  expect(stash.entries).toHaveLength(1);
  expect(stash.entries[0]).toMatchObject({
    description: "Deploy a service safely",
    tags: ["deploy", "production"],
    searchHints: ["deploy rollout", "ship service"],
    usage: ["Use after approvals complete"],
    examples: ["Deploy api to prod"],
    run: "akm run deploy",
    setup: "bun install",
    cwd: "tools/release",
    intent: {
      when: "user needs to deploy",
      input: "service name",
      output: "deployment status",
    },
    scope: { user: "alice", agent: "opencode" },
    source: "frontmatter",
  });
  expect(stash.entries[0]!.aliases).toEqual(expect.arrayContaining(["release service", "deploy production"]));
});

test("recognize preserves curated aliases from comment metadata", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "scripts", "deploy-service.sh");
  writeFile(file, ["#!/usr/bin/env bash", "# @aliases release workflow, ship service", "echo deploy"].join("\n"));

  const stash = recognizeStashEntries(dir, [file]);
  expect(stash.entries[0]!.aliases).toEqual(
    expect.arrayContaining(["release workflow", "ship service", "deploy service"]),
  );
});

// ── Wave 1: captureMode / whenToUse / lessonStrength / evidenceSources ──────

test("applyCuratedFrontmatter extracts captureMode='hot' and 'background'", () => {
  const hotEntry: IndexDocument = { name: "m", type: "memory" };
  applyCuratedFrontmatter(hotEntry, { captureMode: "hot" });
  expect(hotEntry.captureMode).toBe("hot");

  const bgEntry: IndexDocument = { name: "m", type: "memory" };
  applyCuratedFrontmatter(bgEntry, { captureMode: "background" });
  expect(bgEntry.captureMode).toBe("background");
});

test("applyCuratedFrontmatter ignores unknown captureMode values", () => {
  const entry: IndexDocument = { name: "m", type: "memory" };
  applyCuratedFrontmatter(entry, { captureMode: "freeform-bogus" });
  expect(entry.captureMode).toBeUndefined();
});

test("applyCuratedFrontmatter maps when_to_use frontmatter to whenToUse field", () => {
  const entry: IndexDocument = { name: "skill", type: "skill" };
  applyCuratedFrontmatter(entry, { when_to_use: "When provisioning a new tenant cluster" });
  expect(entry.whenToUse).toBe("When provisioning a new tenant cluster");
});

test("applyCuratedFrontmatter ignores blank when_to_use values", () => {
  const entry: IndexDocument = { name: "skill", type: "skill" };
  applyCuratedFrontmatter(entry, { when_to_use: "   " });
  expect(entry.whenToUse).toBeUndefined();
});

test("applyCuratedFrontmatter sets lessonStrength from an array's length", () => {
  const entry: IndexDocument = { name: "lesson", type: "lesson" };
  applyCuratedFrontmatter(entry, { lessonStrength: ["memories/a", "memories/b", "memories/c"] });
  expect(entry.lessonStrength).toBe(3);
});

test("applyCuratedFrontmatter sets lessonStrength from a numeric value", () => {
  const entry: IndexDocument = { name: "lesson", type: "lesson" };
  applyCuratedFrontmatter(entry, { lessonStrength: 7 });
  expect(entry.lessonStrength).toBe(7);
});

test("applyCuratedFrontmatter clamps negative lessonStrength to zero", () => {
  const entry: IndexDocument = { name: "lesson", type: "lesson" };
  applyCuratedFrontmatter(entry, { lessonStrength: -3 });
  expect(entry.lessonStrength).toBe(0);
});

test("applyCuratedFrontmatter omits lessonStrength when absent", () => {
  const entry: IndexDocument = { name: "lesson", type: "lesson" };
  applyCuratedFrontmatter(entry, {});
  expect(entry.lessonStrength).toBeUndefined();
});

test("applyCuratedFrontmatter extracts evidenceSources as a string list", () => {
  const entry: IndexDocument = { name: "lesson", type: "lesson" };
  applyCuratedFrontmatter(entry, { evidenceSources: ["memories/a", "memories/b"] });
  expect(entry.evidenceSources).toEqual(["memories/a", "memories/b"]);
});

test("applyCuratedFrontmatter indexes only current derived-memory backrefs", () => {
  const current: IndexDocument = { name: "child.derived", type: "memory" };
  applyCuratedFrontmatter(current, { inferred: true, source: "team//memories/parent" });
  expect(current.derivedFrom).toBe("memories/parent");

  const retired: IndexDocument = { name: "old-child.derived", type: "memory" };
  applyCuratedFrontmatter(retired, { inferred: true, source: ["memory", "parent"].join(":") });
  expect(retired.derivedFrom).toBeUndefined();
});

test("validateStashEntry preserves captureMode, whenToUse, lessonStrength, evidenceSources", () => {
  const result = validateStashEntry({
    name: "m",
    type: "memory",
    captureMode: "hot",
    whenToUse: "for triage",
    lessonStrength: 4,
    evidenceSources: ["memories/x"],
  });
  expect(result).not.toBeNull();
  expect(result?.captureMode).toBe("hot");
  expect(result?.whenToUse).toBe("for triage");
  expect(result?.lessonStrength).toBe(4);
  expect(result?.evidenceSources).toEqual(["memories/x"]);
});

// ── SPEC-6: fact `category` capture into the index ───────────────────────────
//
// Convention facts are selected for prompt injection by their `category:`
// frontmatter (resolveStashStandards), but the indexer never captured that key
// onto IndexDocument — so no rank-time or filter policy can see it. SPEC-6 step 1
// (docs/architecture/specs/stash-conventions-code-spec.md) captures it in
// applyCuratedFrontmatter (alongside beliefState) and whitelists it through
// validateStashEntry so it survives the document_json projection.

/**
 * SPEC-6 adds `category?: string` to IndexDocument. Read it through a typed
 * accessor so this file still compiles before the implementation lands; the
 * dependent tests then go red on the runtime value instead of a compile error.
 */
function entryCategory(entry: IndexDocument | null | undefined): string | undefined {
  return (entry as (IndexDocument & { category?: string }) | null | undefined)?.category;
}

test("applyCuratedFrontmatter captures category frontmatter onto the entry (SPEC-6)", () => {
  const entry: IndexDocument = { name: "conventions/backlinks", type: "fact" };
  applyCuratedFrontmatter(entry, { category: "convention" });
  expect(entryCategory(entry)).toBe("convention");
});

test("applyCuratedFrontmatter trims category and ignores blank or non-string values (SPEC-6)", () => {
  const trimmed: IndexDocument = { name: "f", type: "fact" };
  applyCuratedFrontmatter(trimmed, { category: "  meta  " });
  expect(entryCategory(trimmed)).toBe("meta");

  const blank: IndexDocument = { name: "f", type: "fact" };
  applyCuratedFrontmatter(blank, { category: "   " });
  expect(entryCategory(blank)).toBeUndefined();

  const nonString: IndexDocument = { name: "f", type: "fact" };
  applyCuratedFrontmatter(nonString, { category: 42 });
  expect(entryCategory(nonString)).toBeUndefined();

  const absent: IndexDocument = { name: "f", type: "fact" };
  applyCuratedFrontmatter(absent, {});
  expect(entryCategory(absent)).toBeUndefined();
});

test("validateStashEntry whitelists category (SPEC-6)", () => {
  const result = validateStashEntry({ name: "team/tool-stack", type: "fact", category: "convention" });
  expect(result).not.toBeNull();
  expect(entryCategory(result)).toBe("convention");

  // Non-string values are dropped, not coerced.
  const bad = validateStashEntry({ name: "team/tool-stack", type: "fact", category: ["convention"] });
  expect(bad).not.toBeNull();
  expect(entryCategory(bad)).toBeUndefined();
});

test("recognize populates entry.category from fact frontmatter (SPEC-6 end-to-end)", async () => {
  const factsRoot = path.join(tmpDir(), "facts");
  const file = path.join(factsRoot, "conventions", "organization.md");
  writeFile(
    file,
    ["---", "category: convention", "description: House placement rules", "---", "", "# Org", "", "Body.", ""].join(
      "\n",
    ),
  );

  const stash = recognizeStashEntries(factsRoot, [file]);
  expect(stash.entries).toHaveLength(1);
  expect(stash.entries[0]!.name).toBe("conventions/organization");
  expect(entryCategory(stash.entries[0])).toBe("convention");
});

test("category is NOT folded into FTS search fields — capture only (SPEC-6 pin)", () => {
  // SPEC-6 shipped `category` as capture-only metadata: the CHANGELOG claims
  // "search results and ranking are unchanged". Pin that claim directly so a
  // future buildSearchFields edit (e.g. SPEC-8's content-field work) cannot
  // silently start indexing the category value. The sentinel token appears
  // nowhere else on the entry, so any leak into a field is unambiguous.
  const base: IndexDocument = {
    name: "conventions/backlinks",
    type: "fact",
    description: "how backlinks are declared",
    tags: ["conventions"],
  };
  const withCategory: IndexDocument = { ...base, category: "sentinelcategorytoken" };

  // Adding a category leaves every FTS field byte-identical…
  expect(buildSearchFields(withCategory)).toEqual(buildSearchFields(base));
  // …and the value never reaches the concatenated search/embedding text.
  expect(buildSearchText(withCategory)).not.toContain("sentinelcategorytoken");
});

// ── SPEC-2: merge path-derived scope/domain tokens into tags ─────────────────
//
// The stash-organization conventions require the directory (scope/domain)
// tokens of a nested asset to reach the tags column even when the author set
// explicit tags. Tokens are derived from the canonical ref subpath
// (canonicalName) during recognize, independent of where the stash root is
// anchored. Filename tokens are
// deliberately NOT merged when explicit tags exist (they already live in the
// FTS name column and aliases). See
// docs/architecture/specs/stash-conventions-code-spec.md SPEC-2.

/** Frontmatter memory doc with an explicit tags list. */
function memoryDocWithTags(tags: string[]): string {
  return ["---", "tags:", ...tags.map((t) => `  - ${t}`), "---", "Plain memory body prose."].join("\n");
}

function sortedTags(entry: IndexDocument | undefined): string[] {
  return [...(entry?.tags ?? [])].sort();
}

/**
 * SPEC-2 introduces an exported pure helper on the metadata pass. Loaded
 * dynamically so this file still compiles (and unrelated tests still run)
 * before the implementation lands; each dependent test goes red with a clear
 * missing-export error instead of a module-load failure.
 */
async function loadExtractDirTagsFromName(): Promise<(name: string) => string[]> {
  const mod = (await import("../src/indexer/passes/metadata")) as unknown as Record<string, unknown>;
  const fn = mod.extractDirTagsFromName;
  if (typeof fn !== "function") {
    throw new Error(
      "SPEC-2 not implemented: expected src/indexer/passes/metadata to export extractDirTagsFromName(name: string): string[]",
    );
  }
  return fn as (name: string) => string[];
}

test("extractDirTagsFromName tokenizes directory segments of a ref subpath (SPEC-2)", async () => {
  const extractDirTagsFromName = await loadExtractDirTagsFromName();
  // Single directory segment, lowercased.
  expect([...extractDirTagsFromName("projectA/auth-tip")].sort()).toEqual(["projecta"]);
  // Multiple segments; each split on -/_/. with single-char tokens dropped
  // (same tokenization as extractTagsFromPath).
  expect([...extractDirTagsFromName("team-alpha/projectA/note")].sort()).toEqual(["alpha", "projecta", "team"]);
  expect([...extractDirTagsFromName("client-x/note")].sort()).toEqual(["client"]);
});

test("extractDirTagsFromName returns no tokens for a name at the type root (SPEC-2)", async () => {
  const extractDirTagsFromName = await loadExtractDirTagsFromName();
  // No directory segments: the filename itself must contribute nothing.
  expect(extractDirTagsFromName("auth-tip")).toEqual([]);
});

test("recognize merges directory tokens into explicit tags for nested assets (SPEC-2)", async () => {
  const memRoot = path.join(tmpDir(), "memories");
  const file = path.join(memRoot, "projectA", "auth-tip.md");
  writeFile(file, memoryDocWithTags(["auth"]));

  const stash = recognizeStashEntries(memRoot, [file]);
  expect(stash.entries).toHaveLength(1);
  expect(stash.entries[0]!.name).toBe("projectA/auth-tip");
  // Explicit tag kept AND the directory scope token added; filename tokens
  // ("auth-tip" -> "tip") must NOT be merged when explicit tags exist.
  expect(sortedTags(stash.entries[0])).toEqual(["auth", "projecta"]);
});

test("recognize adds no directory tokens for an explicit-tags asset at the type root (SPEC-2)", async () => {
  const memRoot = path.join(tmpDir(), "memories");
  const file = path.join(memRoot, "root-note.md");
  writeFile(file, memoryDocWithTags(["auth"]));

  const stash = recognizeStashEntries(memRoot, [file]);
  expect(stash.entries).toHaveLength(1);
  // No directory segments at the type root: explicit tags stay exact — no
  // filename tokens ("root", "note") sneak in.
  expect(stash.entries[0]!.tags).toEqual(["auth"]);
});

test("recognize keeps the empty-tags path-derived fallback unchanged for nested assets (SPEC-2)", async () => {
  const memRoot = path.join(tmpDir(), "memories");
  const file = path.join(memRoot, "projectA", "auth-tip.md");
  writeFile(file, "Plain memory body prose with no frontmatter.\n");

  const stash = recognizeStashEntries(memRoot, [file]);
  expect(stash.entries).toHaveLength(1);
  // Byte-compat with today's extractTagsFromPath fallback: directory AND
  // filename tokens, deduped.
  expect(sortedTags(stash.entries[0])).toEqual(["auth", "projecta", "tip"]);
});

test("recognize keeps the empty-tags fallback unchanged at the type root (SPEC-2)", async () => {
  const memRoot = path.join(tmpDir(), "memories");
  const file = path.join(memRoot, "auth-tip.md");
  writeFile(file, "Plain memory body prose with no frontmatter.\n");

  const stash = recognizeStashEntries(memRoot, [file]);
  expect(stash.entries).toHaveLength(1);
  expect(sortedTags(stash.entries[0])).toEqual(["auth", "tip"]);
});

test("recognize derives the scope token for a nested asset without explicit tags (SPEC-2)", async () => {
  // Tags are derived from canonicalName (the ref subpath), so a nested
  // no-frontmatter memory carries its directory scope token alongside the
  // filename tokens — independent of where the stash root is anchored.
  const stashRoot = tmpDir();
  const memRoot = path.join(stashRoot, "memories");
  const file = path.join(memRoot, "projectA", "auth-tip.md");
  writeFile(file, "Plain memory body prose with no frontmatter.\n");

  // Anchoring at the true stash root and at the type dir yields the same entry.
  const fromRoot = recognizeStashEntries(stashRoot, [file]);
  const fromTypeDir = recognizeStashEntries(memRoot, [file]);
  expect(fromRoot.entries).toHaveLength(1);
  expect(sortedTags(fromRoot.entries[0])).toEqual(["auth", "projecta", "tip"]);
  expect(sortedTags(fromRoot.entries[0])).toEqual(sortedTags(fromTypeDir.entries[0]));
});

test("author-restated scope token is deduped by normalizeTerms after the merge (SPEC-2)", async () => {
  const memRoot = path.join(tmpDir(), "memories");
  const file = path.join(memRoot, "projectA", "pin.md");
  writeFile(file, memoryDocWithTags(["projectA", "auth"]));

  const stash = recognizeStashEntries(memRoot, [file]);
  expect(stash.entries).toHaveLength(1);
  const tags = stash.entries[0]!.tags ?? [];
  expect(tags.filter((t) => t === "projecta")).toHaveLength(1);
  expect(sortedTags(stash.entries[0])).toEqual(["auth", "projecta"]);
});

test("recognize merges directory tokens into package.json-keyword tags for nested non-md assets (SPEC-2)", async () => {
  // The other explicit-tags channel: non-md assets get tags from package.json
  // keywords (Priority 1). A NESTED script must gain its directory token on
  // top of the keywords, while the root-level case stays exact (pinned by the
  // "extracts metadata from package.json" test above).
  const dir = tmpDir();
  const tool = path.join(dir, "scripts", "tools", "run.ts");
  writeFile(tool, `console.log("run")\n`);
  writeFile(
    path.join(dir, "scripts", "tools", "package.json"),
    JSON.stringify({ description: "Git diff summarizer", keywords: ["git", "diff"] }),
  );

  const stash = recognizeStashEntries(dir, [tool]);
  expect(stash.entries).toHaveLength(1);
  expect(stash.entries[0]!.name).toBe("tools/run.ts");
  expect(sortedTags(stash.entries[0])).toEqual(["diff", "git", "tools"]);
});

test("multi-token directory segments tokenize like extractTagsFromPath in the merge (SPEC-2)", async () => {
  const memRoot = path.join(tmpDir(), "memories");
  const file = path.join(memRoot, "client-x", "billing-tip.md");
  writeFile(file, memoryDocWithTags(["billing"]));

  const stash = recognizeStashEntries(memRoot, [file]);
  expect(stash.entries).toHaveLength(1);
  // "client-x" splits to ["client", "x"]; single-char "x" is dropped, and the
  // raw segment must not survive as a "client x" phrase tag.
  expect(sortedTags(stash.entries[0])).toEqual(["billing", "client"]);
});
