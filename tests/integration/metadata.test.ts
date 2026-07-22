import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import {
  applyCuratedFrontmatter,
  extractBodyOpening,
  extractCommentMetadata,
  extractDescriptionFromComments,
  extractPackageMetadata,
  extractTagsFromPath,
  fileNameToDescription,
  type IndexDocument,
  isEnrichmentComplete,
  type StashFile,
  validateStashEntry,
} from "../../src/indexer/passes/metadata";
import { recognizeStashEntries } from "../../src/indexer/scan/drain-dir";
import { buildSearchFields, buildSearchText } from "../../src/indexer/search/search-fields";
// The legacy `.stash.json` sidecar reader/writer moved to the migrator home
// (Chunk-5 flip scope-B); alias to the old local names to keep the bodies intact.
import {
  readLegacyStashOverrides as loadStashFile,
  writeLegacyStashFile as writeStashFile,
} from "../../src/migrate/legacy/legacy-stash-json";
import { sandboxXdgConfigHome, writeSandboxConfig } from "../_helpers/sandbox";

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

// ── loadStashFile ───────────────────────────────────────────────────────────

test("loadStashFile reads valid .stash.json", () => {
  const dir = tmpDir();
  const stash: StashFile = {
    entries: [
      {
        name: "docker-build",
        type: "script",
        description: "build docker images",
        tags: ["docker", "build"],
        filename: "docker-build.ts",
      },
    ],
  };
  writeFile(path.join(dir, ".stash.json"), JSON.stringify(stash));

  const result = loadStashFile(dir);
  expect(result).not.toBeNull();
  expect(result?.entries).toHaveLength(1);
  expect(result!.entries[0]!.name).toBe("docker-build");
  expect(result!.entries[0]!.description).toBe("build docker images");
  expect(result!.entries[0]!.tags).toEqual(["docker", "build"]);
});

test("loadStashFile returns null for missing file", () => {
  const dir = tmpDir();
  expect(loadStashFile(dir)).toBeNull();
});

test("loadStashFile returns null for invalid JSON", () => {
  const dir = tmpDir();
  writeFile(path.join(dir, ".stash.json"), "not json");
  expect(loadStashFile(dir)).toBeNull();
});

test("loadStashFile returns null for missing entries array", () => {
  const dir = tmpDir();
  writeFile(path.join(dir, ".stash.json"), '{"foo": "bar"}');
  expect(loadStashFile(dir)).toBeNull();
});

test("loadStashFile parses intent field", () => {
  const dir = tmpDir();
  const stash: StashFile = {
    entries: [
      {
        name: "deploy",
        type: "script",
        intent: { when: "user needs to deploy", input: "service name", output: "deployment status" },
        filename: "deploy.sh",
      },
    ],
  };
  writeFile(path.join(dir, ".stash.json"), JSON.stringify(stash));

  const result = loadStashFile(dir);
  expect(result!.entries[0]!.intent).toEqual({
    when: "user needs to deploy",
    input: "service name",
    output: "deployment status",
  });
});

// ── writeStashFile ──────────────────────────────────────────────────────────

test("writeStashFile persists .stash.json to disk", () => {
  const dir = tmpDir();
  const stash: StashFile = {
    entries: [{ name: "test", type: "script", quality: "generated" }],
  };
  writeStashFile(dir, stash);

  const raw = fs.readFileSync(path.join(dir, ".stash.json"), "utf8");
  const parsed = JSON.parse(raw);
  expect(parsed.entries[0].name).toBe("test");
  expect(parsed.entries[0].quality).toBe("generated");
});

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

test("validateStashEntry still rejects the deny-listed tool/vault types (D1.5-6)", () => {
  expect(validateStashEntry({ name: "x", type: "tool" })).toBeNull();
  expect(validateStashEntry({ name: "x", type: "vault" })).toBeNull();
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

test("loadStashFile parses usage field", () => {
  const dir = tmpDir();
  const stash: StashFile = {
    entries: [
      {
        name: "git-diff",
        type: "script",
        usage: ["Run after fetching main", "Use --stat for quick output"],
        filename: "run.ts",
      },
    ],
  };
  writeFile(path.join(dir, ".stash.json"), JSON.stringify(stash));

  const result = loadStashFile(dir);
  expect(result!.entries[0]!.usage).toEqual(["Run after fetching main", "Use --stat for quick output"]);
});

test("loadStashFile parses searchHints field", () => {
  const dir = tmpDir();
  const stash: StashFile = {
    entries: [
      {
        name: "git-diff",
        type: "script",
        searchHints: ["summarize git commits", "explain what changed"],
        filename: "run.ts",
      },
    ],
  };
  writeFile(path.join(dir, ".stash.json"), JSON.stringify(stash));

  const result = loadStashFile(dir);
  expect(result!.entries[0]!.searchHints).toEqual(["summarize git commits", "explain what changed"]);
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

// ── isEnrichmentComplete ────────────────────────────────────────────────────

test("isEnrichmentComplete returns true when description, tags, and searchHints are all populated", () => {
  const entry: IndexDocument = {
    name: "deploy",
    type: "script",
    description: "Deploy services to production",
    tags: ["deploy", "production"],
    searchHints: ["deploy a service to production", "roll out new code"],
  };
  expect(isEnrichmentComplete(entry)).toBe(true);
});

test("isEnrichmentComplete returns false when description is missing", () => {
  const entry: IndexDocument = {
    name: "deploy",
    type: "script",
    tags: ["deploy", "production"],
    searchHints: ["deploy a service to production"],
  };
  expect(isEnrichmentComplete(entry)).toBe(false);
});

test("isEnrichmentComplete returns false when description is an empty string", () => {
  const entry: IndexDocument = {
    name: "deploy",
    type: "script",
    description: "   ",
    tags: ["deploy"],
    searchHints: ["deploy a service"],
  };
  expect(isEnrichmentComplete(entry)).toBe(false);
});

test("isEnrichmentComplete returns false when tags array is empty", () => {
  const entry: IndexDocument = {
    name: "deploy",
    type: "script",
    description: "Deploy services to production",
    tags: [],
    searchHints: ["deploy a service to production"],
  };
  expect(isEnrichmentComplete(entry)).toBe(false);
});

test("isEnrichmentComplete returns false when tags is missing", () => {
  const entry: IndexDocument = {
    name: "deploy",
    type: "script",
    description: "Deploy services to production",
    searchHints: ["deploy a service to production"],
  };
  expect(isEnrichmentComplete(entry)).toBe(false);
});

test("isEnrichmentComplete returns false when searchHints is missing", () => {
  const entry: IndexDocument = {
    name: "deploy",
    type: "script",
    description: "Deploy services to production",
    tags: ["deploy", "production"],
  };
  expect(isEnrichmentComplete(entry)).toBe(false);
});

test("isEnrichmentComplete returns false when searchHints array is empty", () => {
  const entry: IndexDocument = {
    name: "deploy",
    type: "script",
    description: "Deploy services to production",
    tags: ["deploy", "production"],
    searchHints: [],
  };
  expect(isEnrichmentComplete(entry)).toBe(false);
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
// validateStashEntry so it survives the .stash.json / entry_json round-trip.

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

test("loadStashFile preserves category on entries (SPEC-6 whitelist round-trip)", () => {
  const dir = tmpDir();
  writeFile(
    path.join(dir, ".stash.json"),
    JSON.stringify({
      entries: [{ name: "active-projects", type: "fact", category: "meta", filename: "active-projects.md" }],
    }),
  );
  const result = loadStashFile(dir);
  expect(result).not.toBeNull();
  expect(entryCategory(result?.entries[0])).toBe("meta");
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
  const mod = (await import("../../src/indexer/passes/metadata")) as unknown as Record<string, unknown>;
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

test("recognize merges directory tokens from the canonical ref subpath into explicit tags (SPEC-2)", async () => {
  const stashRoot = tmpDir();
  const file = path.join(stashRoot, "memories", "projectA", "auth-tip.md");
  writeFile(file, memoryDocWithTags(["auth"]));

  const stash = recognizeStashEntries(stashRoot, [file]);
  expect(stash.entries).toHaveLength(1);
  expect(stash.entries[0]!.type).toBe("memory");
  // canonicalName is the ref subpath relative to the TYPE root ("memories"),
  // so "memories" itself is not a tag — only the scope dir "projectA" is.
  expect(stash.entries[0]!.name).toBe("projectA/auth-tip");
  expect(sortedTags(stash.entries[0])).toEqual(["auth", "projecta"]);
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

test("loadStashFile keeps literal tags for nested-name entries — no dir-token merge (SPEC-2)", () => {
  // .stash.json-declared entries are hand-curated manifests: the SPEC-2 merge
  // applies only to file-derived entries via recognize. A nested ref
  // subpath in a declared entry's name must NOT grow directory tokens.
  const dir = tmpDir();
  const stash: StashFile = {
    entries: [
      {
        name: "projectA/deploy",
        type: "script",
        description: "deploy projectA services",
        tags: ["auth"],
        filename: "deploy.sh",
      },
    ],
  };
  writeFile(path.join(dir, ".stash.json"), JSON.stringify(stash));

  const result = loadStashFile(dir);
  expect(result?.entries).toHaveLength(1);
  expect(result!.entries[0]!.name).toBe("projectA/deploy");
  expect(result!.entries[0]!.tags).toEqual(["auth"]);
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

// ── SPEC-8: config-gated indexing of the self-situating body opening ─────────
//
// With `index.indexBodyOpening: true` in the user config, recognize's
// md branch extracts the first non-heading, non-fence, non-empty paragraph of
// the body (capped at 280 chars) into a new IndexDocument field `bodyOpening`,
// and buildSearchFields folds it into the lowest-weight `content` FTS field.
// Default (flag absent or explicitly false) keeps entries and search fields
// byte-identical to today. Secret/env file bodies are never read; session-kind
// memories (the `akm_memory_kind` marker in outer OR inner nested frontmatter,
// the same patterns base-linter recognises) are excluded. See
// docs/architecture/specs/stash-conventions-code-spec.md SPEC-8.

/**
 * SPEC-8 adds `bodyOpening?: string` to IndexDocument. Read it through a typed
 * accessor so this file still compiles before the implementation lands; the
 * dependent tests then go red on the runtime value instead of a compile error.
 */
function entryBodyOpening(entry: IndexDocument | null | undefined): string | undefined {
  return (entry as (IndexDocument & { bodyOpening?: string }) | null | undefined)?.bodyOpening;
}

/**
 * Run `fn` with an isolated XDG_CONFIG_HOME whose akm config sets
 * `index.indexBodyOpening` to `flag` (the key — and the whole config file — is
 * omitted when `flag` is `undefined`, exercising the true default). Resets the
 * config cache on both sides so the sandboxed value is actually read and
 * nothing leaks into later tests.
 */
async function withIndexBodyOpeningConfig<T>(flag: boolean | undefined, fn: () => Promise<T>): Promise<T> {
  const cfg = sandboxXdgConfigHome();
  try {
    if (flag !== undefined) writeSandboxConfig({ index: { indexBodyOpening: flag } });
    resetConfigCache();
    return await fn();
  } finally {
    resetConfigCache();
    cfg.cleanup();
  }
}

const OPENING_PARA = "This memory situates the auth-refresh work inside the payments-platform project.";

/** Markdown memory doc with a fixed frontmatter block and the given body lines. */
function memoryDocWithBody(bodyLines: string[]): string {
  return ["---", "description: Auth refresh notes", "tags:", "  - auth", "---", "", ...bodyLines, ""].join("\n");
}

test("flag on: first body paragraph lands in entry.bodyOpening (SPEC-8)", async () => {
  await withIndexBodyOpeningConfig(true, async () => {
    const memRoot = path.join(tmpDir(), "memories");
    const file = path.join(memRoot, "auth-notes.md");
    writeFile(file, memoryDocWithBody([OPENING_PARA, "", "Second paragraph pangolin prose must not be captured."]));

    const stash = recognizeStashEntries(memRoot, [file]);
    expect(stash.entries).toHaveLength(1);
    // Short paragraph (< 280 chars): captured whole, byte-exact — and ONLY the
    // first paragraph (the pangolin paragraph stays out).
    expect(entryBodyOpening(stash.entries[0])).toBe(OPENING_PARA);
  });
});

test("flag on: bodyOpening folds into the content search field, not hints (SPEC-8)", async () => {
  await withIndexBodyOpeningConfig(true, async () => {
    const memRoot = path.join(tmpDir(), "memories");
    const file = path.join(memRoot, "auth-notes.md");
    writeFile(file, memoryDocWithBody([OPENING_PARA]));

    const stash = recognizeStashEntries(memRoot, [file]);
    const fields = buildSearchFields(stash.entries[0]!);
    // Lowest-weight catch-all column carries the (lowercased) opening…
    expect(fields.content).toContain("situates the auth-refresh work");
    // …and no higher-weight column picks it up (SPEC-8 explicitly rejects
    // folding into hints, which carries xrefs/when_to_use).
    expect(fields.hints).not.toContain("situates");
    expect(fields.name).not.toContain("situates");
    expect(fields.description).not.toContain("situates");
    expect(fields.tags).not.toContain("situates");
    // The concatenated search/embedding text picks it up via content.
    expect(buildSearchText(stash.entries[0]!)).toContain("situates the auth-refresh work");
  });
});

test("flag on: a paragraph spanning multiple lines is captured up to the paragraph break (SPEC-8)", async () => {
  await withIndexBodyOpeningConfig(true, async () => {
    const memRoot = path.join(tmpDir(), "memories");
    const file = path.join(memRoot, "wrapped.md");
    writeFile(
      file,
      memoryDocWithBody([
        "First line of the opening paragraph continues onto",
        "a second physical line before the paragraph break.",
        "",
        "Trailing paragraph stays out.",
      ]),
    );

    const stash = recognizeStashEntries(memRoot, [file]);
    const opening = entryBodyOpening(stash.entries[0]);
    expect(opening).toBeDefined();
    // Whitespace-normalized comparison: the join character between the two
    // physical lines (newline vs space) is not pinned, the content is.
    expect((opening ?? "").replace(/\s+/g, " ").trim()).toBe(
      "First line of the opening paragraph continues onto a second physical line before the paragraph break.",
    );
    expect(opening).not.toContain("Trailing paragraph");
  });
});

test("flag on: heading-first bodies skip headings and capture the first prose paragraph (SPEC-8)", async () => {
  await withIndexBodyOpeningConfig(true, async () => {
    const memRoot = path.join(tmpDir(), "memories");
    const file = path.join(memRoot, "heading-first.md");
    writeFile(
      file,
      memoryDocWithBody([
        "# Auth notes",
        "",
        "## Context",
        "",
        "The orientation paragraph situates this memory under projectA.",
        "",
        "More prose afterwards.",
      ]),
    );

    const stash = recognizeStashEntries(memRoot, [file]);
    expect(entryBodyOpening(stash.entries[0])).toBe("The orientation paragraph situates this memory under projectA.");
  });
});

test("flag on: fenced-first bodies skip the fence and capture the first prose paragraph (SPEC-8)", async () => {
  await withIndexBodyOpeningConfig(true, async () => {
    const memRoot = path.join(tmpDir(), "memories");
    const file = path.join(memRoot, "fence-first.md");
    writeFile(
      file,
      memoryDocWithBody([
        "```bash",
        "echo fence interior prose that must never be extracted",
        "```",
        "",
        "Fence-follower paragraph provides the orientation prose.",
      ]),
    );

    const stash = recognizeStashEntries(memRoot, [file]);
    const opening = entryBodyOpening(stash.entries[0]);
    expect(opening).toBe("Fence-follower paragraph provides the orientation prose.");
    expect(opening).not.toContain("fence interior");
  });
});

test("flag on: bodyOpening is capped at 280 chars (SPEC-8)", async () => {
  await withIndexBodyOpeningConfig(true, async () => {
    // 70 distinct 7-char words joined by spaces = 559 chars, well over the cap.
    const words = Array.from({ length: 70 }, (_, i) => `token${String(i).padStart(2, "0")}`);
    const longPara = words.join(" ");
    const memRoot = path.join(tmpDir(), "memories");
    const file = path.join(memRoot, "long-opening.md");
    writeFile(file, memoryDocWithBody([longPara]));

    const stash = recognizeStashEntries(memRoot, [file]);
    const opening = entryBodyOpening(stash.entries[0]);
    expect(opening).toBeDefined();
    const text = opening ?? "";
    expect(text.length).toBeLessThanOrEqual(280);
    // A cap, not a gutting: after allowing for word-boundary trimming and an
    // optional ellipsis, a substantial prefix of the paragraph must survive
    // and must be a literal prefix (no reordering / summarising).
    const stripped = text.replace(/(\.{3}|…)\s*$/, "").trimEnd();
    expect(stripped.length).toBeGreaterThanOrEqual(250);
    expect(longPara.startsWith(stripped)).toBe(true);
  });
});

test("flag on: frontmatter-only files yield no bodyOpening (SPEC-8)", async () => {
  await withIndexBodyOpeningConfig(true, async () => {
    const memRoot = path.join(tmpDir(), "memories");
    const file = path.join(memRoot, "fm-only.md");
    writeFile(file, ["---", "description: Facts only", "tags:", "  - auth", "---", ""].join("\n"));

    const stash = recognizeStashEntries(memRoot, [file]);
    expect(stash.entries).toHaveLength(1);
    expect(entryBodyOpening(stash.entries[0])).toBeUndefined();
  });
});

test("flag on: a body with only headings and fences yields no bodyOpening (SPEC-8)", async () => {
  await withIndexBodyOpeningConfig(true, async () => {
    const memRoot = path.join(tmpDir(), "memories");
    const file = path.join(memRoot, "no-prose.md");
    writeFile(file, memoryDocWithBody(["# Title", "", "## Section", "", "```ts", "const x = 1;", "```"]));

    const stash = recognizeStashEntries(memRoot, [file]);
    expect(stash.entries).toHaveLength(1);
    expect(entryBodyOpening(stash.entries[0])).toBeUndefined();
  });
});

test("flag on: session-kind memories are excluded via the outer akm_memory_kind marker (SPEC-8)", async () => {
  await withIndexBodyOpeningConfig(true, async () => {
    const memRoot = path.join(tmpDir(), "memories");
    const file = path.join(memRoot, "session-outer.md");
    writeFile(
      file,
      [
        "---",
        "description: Session checkpoint 2026-07-10",
        "akm_memory_kind: session_checkpoint",
        "---",
        "",
        "Raw transcript paragraph that must not become bodyOpening.",
        "",
      ].join("\n"),
    );

    const stash = recognizeStashEntries(memRoot, [file]);
    // Still indexed as a memory — only the body-opening capture is skipped.
    expect(stash.entries).toHaveLength(1);
    expect(entryBodyOpening(stash.entries[0])).toBeUndefined();
    expect(buildSearchText(stash.entries[0]!)).not.toContain("transcript paragraph");
  });
});

test("flag on: session-kind memories are excluded via the inner nested akm_memory_kind marker (SPEC-8)", async () => {
  await withIndexBodyOpeningConfig(true, async () => {
    // `akm remember` wraps the session-capture hook's file in its own
    // frontmatter; the hook's `akm_memory_kind` block survives at the top of
    // the body (the nested pattern base-linter's parseInnerFrontmatterBlock
    // recognises). Neither the marker block nor the transcript may be captured.
    const memRoot = path.join(tmpDir(), "memories");
    const file = path.join(memRoot, "session-inner.md");
    writeFile(
      file,
      [
        "---",
        "description: Session checkpoint",
        "---",
        "",
        "---",
        "akm_memory_kind: session_checkpoint",
        "refs: []",
        "---",
        "",
        "Raw transcript prose that must not become bodyOpening.",
        "",
      ].join("\n"),
    );

    const stash = recognizeStashEntries(memRoot, [file]);
    expect(stash.entries).toHaveLength(1);
    expect(entryBodyOpening(stash.entries[0])).toBeUndefined();
    expect(buildSearchText(stash.entries[0]!)).not.toContain("transcript prose");
  });
});

test("flag on: secret files are never read for bodyOpening (SPEC-8)", async () => {
  await withIndexBodyOpeningConfig(true, async () => {
    // Whole-file secret with a .md extension — the strongest temptation for an
    // md-branch extractor. The existing guard (assetType !== "secret") must
    // keep the file bytes out of the entry entirely.
    const stashRoot = tmpDir();
    const secretFile = path.join(stashRoot, "secrets", "deploy-key.md");
    writeFile(secretFile, "walrus-credential value paragraph that must never be indexed.\n");

    const stash = recognizeStashEntries(stashRoot, [secretFile]);
    expect(stash.entries).toHaveLength(1);
    expect(stash.entries[0]!.type).toBe("secret");
    expect(entryBodyOpening(stash.entries[0])).toBeUndefined();
    expect(JSON.stringify(stash.entries[0])).not.toContain("walrus");
    expect(buildSearchText(stash.entries[0]!)).not.toContain("walrus");
  });
});

test("flag on: env files are never read for bodyOpening (SPEC-8)", async () => {
  await withIndexBodyOpeningConfig(true, async () => {
    const stashRoot = tmpDir();
    const envFile = path.join(stashRoot, "env", "ci.env");
    writeFile(envFile, ["# staging credentials walrus paragraph", "API_KEY=walrus-value-token", ""].join("\n"));

    const stash = recognizeStashEntries(stashRoot, [envFile]);
    expect(stash.entries).toHaveLength(1);
    expect(stash.entries[0]!.type).toBe("env");
    expect(entryBodyOpening(stash.entries[0])).toBeUndefined();
    // Key NAMES may surface (existing behavior); comment text and values never.
    expect(JSON.stringify(stash.entries[0])).not.toContain("walrus");
    expect(buildSearchText(stash.entries[0]!)).not.toContain("walrus");
  });
});

test("flag on: flat-walk memories gain bodyOpening through the shared pipeline (SPEC-8)", async () => {
  await withIndexBodyOpeningConfig(true, async () => {
    const stashRoot = tmpDir();
    const file = path.join(stashRoot, "memories", "projectA", "auth-tip.md");
    writeFile(file, memoryDocWithBody([OPENING_PARA]));

    const stash = recognizeStashEntries(stashRoot, [file]);
    expect(stash.entries).toHaveLength(1);
    expect(stash.entries[0]!.type).toBe("memory");
    expect(entryBodyOpening(stash.entries[0])).toBe(OPENING_PARA);
  });
});

test("default (flag absent): no bodyOpening and body prose reaches no search field (SPEC-8)", async () => {
  await withIndexBodyOpeningConfig(undefined, async () => {
    const memRoot = path.join(tmpDir(), "memories");
    const file = path.join(memRoot, "plain-note.md");
    writeFile(
      file,
      memoryDocWithBody(["The zebrafish opening paragraph situates this memory in the payments platform."]),
    );

    const stash = recognizeStashEntries(memRoot, [file]);
    const entry = stash.entries[0];
    expect(entryBodyOpening(entry)).toBeUndefined();
    // Byte-identical-to-today pin: the sentinel body token appears in NO FTS
    // field and not in the concatenated search/embedding text.
    const fields = buildSearchFields(entry!);
    for (const value of Object.values(fields)) {
      expect(value).not.toContain("zebrafish");
    }
    expect(buildSearchText(entry!)).not.toContain("zebrafish");
  });
});

test("index.indexBodyOpening: false behaves exactly like the default (SPEC-8)", async () => {
  await withIndexBodyOpeningConfig(false, async () => {
    const memRoot = path.join(tmpDir(), "memories");
    const file = path.join(memRoot, "plain-note.md");
    writeFile(
      file,
      memoryDocWithBody(["The zebrafish opening paragraph situates this memory in the payments platform."]),
    );

    const stash = recognizeStashEntries(memRoot, [file]);
    const entry = stash.entries[0];
    expect(entryBodyOpening(entry)).toBeUndefined();
    expect(buildSearchText(entry!)).not.toContain("zebrafish");
  });
});

// ── SPEC-8 review fixes: extractBodyOpening leading-block + setext handling ──
//
// A leading `---`…`---` block is skipped ONLY when its interior actually
// reads as YAML frontmatter (blank / indented / `key:` lines). Ordinary prose
// bracketed by decorative thematic breaks is the self-situating opening the
// feature exists to index and must be captured, not discarded.

test("extractBodyOpening captures prose wrapped in decorative thematic breaks (SPEC-8 review fix)", () => {
  const body = "---\nThis orientation paragraph situates the work.\n---\n\nDetails follow here.\n";
  expect(extractBodyOpening(body)).toBe("This orientation paragraph situates the work.");
});

test("extractBodyOpening still skips a frontmatter-shaped inner block without the session marker (SPEC-8)", () => {
  const body = [
    "---",
    "title: Wrapped doc",
    "tags:",
    "  - auth",
    "created: 2026-07-11",
    "---",
    "",
    "Real opening prose after the nested block.",
    "",
  ].join("\n");
  expect(extractBodyOpening(body)).toBe("Real opening prose after the nested block.");
});

test("extractBodyOpening treats a lone unclosed leading --- as a thematic break (SPEC-8)", () => {
  expect(extractBodyOpening("---\n\nOpening prose after a lone break.\n")).toBe("Opening prose after a lone break.");
});

test("extractBodyOpening skips setext '=' headings instead of capturing underline + title (SPEC-8 review fix)", () => {
  const body = "Title Of Doc\n=====\n\nProse after the setext heading.\n";
  expect(extractBodyOpening(body)).toBe("Prose after the setext heading.");
});

test("extractBodyOpening skips leading HTML comment blocks (PR-715 review)", () => {
  // The stash skeleton's own convention facts open with a multi-line
  // <!-- SOFT guidance --> block: comment text is not orientation prose.
  const body = [
    "<!--",
    "  SOFT guidance only — advice, not a contract. Editing this file cannot",
    "  weaken the gate.",
    "-->",
    "",
    "# Title",
    "",
    "The real orientation paragraph.",
    "",
  ].join("\n");
  expect(extractBodyOpening(body)).toBe("The real orientation paragraph.");
});

test("extractBodyOpening skips single-line HTML comments and comment-ending paragraph boundaries (PR-715 review)", () => {
  expect(extractBodyOpening("<!-- one-line note -->\n\nActual prose here.\n")).toBe("Actual prose here.");
  // A comment opening after prose ends the paragraph rather than absorbing it.
  expect(extractBodyOpening("Lead sentence.\n<!-- trailing machinery -->\nMore text.\n")).toBe("Lead sentence.");
});

test("extractBodyOpening never splits a surrogate pair at the cap (PR-715 review)", () => {
  // One long unbroken token forces the no-word-boundary fallback slice; align
  // an astral-plane char across the cut so a naive slice leaves a lone
  // high surrogate.
  const prefix = "x".repeat(278); // next slot (index 278, cap-1=279) lands mid-pair
  const body = `${prefix}\u{1F600}\u{1F600}after`;
  const opening = extractBodyOpening(body);
  expect(opening).toBeDefined();
  const text = opening as string;
  const lastBeforeEllipsis = text.charCodeAt(text.length - 2);
  expect(lastBeforeEllipsis >= 0xd800 && lastBeforeEllipsis <= 0xdbff).toBe(false);
  // Round-trip through the encoder must not produce a replacement char.
  expect(new TextDecoder().decode(new TextEncoder().encode(text))).toBe(text);
});

test("extractBodyOpening keeps prose above a dash row (setext-H2 reading deliberately not applied) (SPEC-8)", () => {
  // Deliberate pin: a `---` row after captured lines ENDS the paragraph and
  // keeps it. Dash rows in stash bodies are overwhelmingly decorative breaks
  // or callout borders (the case the review fix above serves), so CommonMark's
  // setext-H2 interpretation is not applied to them — unlike `=` rows, which
  // can only be setext underlines.
  expect(extractBodyOpening("Ambiguous Title\n---\n\nFollowing prose.\n")).toBe("Ambiguous Title");
});

test("flag on: a decorative-callout opening is captured end-to-end (SPEC-8 review fix)", async () => {
  await withIndexBodyOpeningConfig(true, async () => {
    const memRoot = path.join(tmpDir(), "memories");
    const file = path.join(memRoot, "callout.md");
    writeFile(
      file,
      memoryDocWithBody(["---", "This orientation paragraph situates the work.", "---", "", "Details follow here."]),
    );

    const stash = recognizeStashEntries(memRoot, [file]);
    expect(stash.entries).toHaveLength(1);
    // The callout is NOT mistaken for nested frontmatter (no session marker,
    // not frontmatter-shaped), so the orientation prose is the capture.
    expect(entryBodyOpening(stash.entries[0])).toBe("This orientation paragraph situates the work.");
  });
});

// ── SPEC-8: bodyOpening survives the .stash.json whitelist ──────────────────

test("validateStashEntry preserves bodyOpening verbatim for .stash.json round-trips (SPEC-8)", () => {
  const result = validateStashEntry({ name: "auth-notes", type: "memory", bodyOpening: OPENING_PARA });
  expect(result?.bodyOpening).toBe(OPENING_PARA);
});

test("validateStashEntry drops blank or non-string bodyOpening (SPEC-8)", () => {
  expect(validateStashEntry({ name: "a", type: "memory", bodyOpening: "   " })?.bodyOpening).toBeUndefined();
  expect(validateStashEntry({ name: "b", type: "memory", bodyOpening: 42 })?.bodyOpening).toBeUndefined();
  expect(validateStashEntry({ name: "c", type: "memory" })?.bodyOpening).toBeUndefined();
});
