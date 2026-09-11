import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmSearch } from "../src/commands/read/search";
import { akmShowUnified as akmShow } from "../src/commands/read/show";
import { akmInit } from "../src/commands/sources/init";
import { resetConfigCache, saveConfig } from "../src/core/config/config";
import { readEvents } from "../src/core/events";
import { getConfigPath } from "../src/core/paths";
import { akmIndex } from "../src/indexer/indexer";
import type { SearchHit, SourceSearchHit } from "../src/sources/types";
import { seedLockEntries } from "./_helpers/lockfile";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage } from "./_helpers/sandbox";

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-stash-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function isLocalHit(hit: SearchHit): hit is SourceSearchHit {
  return hit.type !== "registry";
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("source commands and resolution", () => {
  // Each test points AKM_BUNDLE_DIR at its own fixture stash (a per-test
  // content fixture, not isolation boilerplate); the outer XDG cache/config/
  // data/state dirs come from withIsolatedAkmStorage for clean isolation.
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    resetConfigCache();
  });

  afterEach(() => {
    resetConfigCache();
    storage.cleanup();
  });

  test("akmSearch only includes script files with supported extensions and returns run", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");
    writeFile(path.join(stashDir, "scripts", "script.ts"), "console.log('x')\n");
    writeFile(path.join(stashDir, "scripts", "README.md"), "ignore\n");

    await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
      const result = await akmSearch({ query: "", type: "script" });
      const localHits = result.hits.filter(isLocalHit);

      expect(localHits.length).toBe(2);
      expect(localHits.every((hit) => hit.type === "script")).toBe(true);
      expect(localHits.some((hit) => hit.name === "README.md")).toBe(false);
      expect(localHits.some((hit) => typeof hit.run === "string")).toBe(true);
    });
  });

  test("akmSearch creates bun run from nearest package.json up to scripts root", async () => {
    const stashDir = createTmpDir("akm-stash-");
    const nestedScript = path.join(stashDir, "scripts", "group", "nested", "job.js");
    writeFile(nestedScript, "console.log('job')\n");
    writeFile(path.join(stashDir, "scripts", "group", "package.json"), '{"name":"group"}');
    writeFile(path.join(stashDir, "scripts", "package.json"), '{"name":"root"}');

    await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
      const result = await akmSearch({ query: "job", type: "script" });
      const hit = result.hits.filter(isLocalHit)[0];

      expect(result.hits.length).toBe(1);
      expect(hit!.run).toContain("bun");
      expect(hit!.run).toContain("job.js");
    });
  });

  test("akmSearch detects setup from package.json in nearby directory", async () => {
    const stashDir = createTmpDir("akm-stash-");
    const nestedScript = path.join(stashDir, "scripts", "group", "nested", "job.js");
    writeFile(nestedScript, "console.log('job')\n");
    writeFile(path.join(stashDir, "scripts", "group", "nested", "package.json"), '{"name":"group"}');

    await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
      const result = await akmSearch({ query: "job", type: "script" });
      const hit = result.hits.filter(isLocalHit)[0];
      expect(result.hits.length).toBe(1);
      // Search hits only expose run, not setup/cwd
      expect(hit!.run).toContain("bun");
      expect(hit!.run).toContain("job.js");
    });
  });

  test("akmSearch resolves script run correctly for search path directories", async () => {
    const primaryStashDir = createTmpDir("akm-stash-primary-");
    const searchPathDir = createTmpDir("akm-stash-searchpath-");

    writeFile(path.join(primaryStashDir, "scripts", "placeholder.sh"), "#!/usr/bin/env bash\necho primary\n");
    writeFile(path.join(searchPathDir, "scripts", "group", "nested", "job.js"), "console.log('job')\n");
    writeFile(path.join(searchPathDir, "scripts", "group", "package.json"), '{"name":"group"}');

    saveConfig({ semanticSearchMode: "off", bundles: { extra: { path: searchPathDir } } });

    await withEnv({ AKM_BUNDLE_DIR: primaryStashDir }, async () => {
      await akmIndex({ stashDir: primaryStashDir, full: true });

      const result = await akmSearch({ query: "job", type: "script" });
      const searchPathHit = result.hits.filter(isLocalHit).find((hit) => hit.path.includes(searchPathDir));

      expect(searchPathHit).toBeDefined();
      expect(searchPathHit?.run ?? "").toContain("bun");
      expect(searchPathHit?.run ?? "").toContain("job.js");
    });
  });

  test("akmSearch includes explainability reasons for indexed hits", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "scripts", "summarize-diff.ts"), "console.log('summarize')\n");

    saveConfig({ semanticSearchMode: "auto" });

    await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
      await akmIndex({ stashDir, full: true });
      const result = await akmSearch({ query: "summarize diff", type: "script" });

      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.hits[0]!.whyMatched).toBeDefined();
      // Ranking mode depends on whether semantic search (embeddings) is available.
      // Accept "fts bm25 relevance", "semantic similarity", or "hybrid (fts + semantic)".
      expect(
        result.hits[0]!.whyMatched?.includes("fts bm25 relevance") ||
          result.hits[0]!.whyMatched?.includes("semantic similarity") ||
          result.hits[0]!.whyMatched?.includes("hybrid (fts + semantic)"),
      ).toBe(true);
      expect(result.hits[0]!.whyMatched).toContain("matched name tokens");
    });
  });

  test("akmSearch includes ref, action, and size for local hits", async () => {
    const stashDir = createTmpDir("akm-stash-");
    const scriptPath = path.join(stashDir, "scripts", "deploy.sh");
    writeFile(scriptPath, "#!/usr/bin/env bash\necho deploy\n");

    saveConfig({ semanticSearchMode: "off" });

    await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
      await akmIndex({ stashDir, full: true });
      const result = await akmSearch({ query: "deploy", type: "script" });
      const hit = result.hits.filter(isLocalHit)[0];

      expect(hit!.ref).toContain("scripts/deploy.sh");
      expect(hit!.action).toContain("akm show");
      expect(hit!.size).toBe("small");
    });
  });

  test("akmSearch includes origin for installed-source hits", async () => {
    const stashDir = createTmpDir("akm-stash-");
    const installedStash = createTmpDir("akm-installed-");
    writeFile(path.join(stashDir, "scripts", "placeholder.sh"), "#!/usr/bin/env bash\necho placeholder\n");
    writeFile(path.join(installedStash, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    saveConfig({
      semanticSearchMode: "off",
      bundles: { "deploy-stash": { npm: "@scope/deploy-stash", registryId: "npm:@scope/deploy-stash" } },
    });
    seedLockEntries([{ id: "deploy-stash", source: "npm", ref: "@scope/deploy-stash", localRoot: installedStash }]);

    await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
      await akmIndex({ stashDir, full: true });
      const result = await akmSearch({ query: "deploy", type: "script" });

      // The hit's origin is the bundle id (the slug-legal bundle key).
      expect(result.hits.filter(isLocalHit).some((hit) => hit.origin === "deploy-stash")).toBe(true);
    });
  });

  test("akmShow returns full payloads for skill/command/agent", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "skills", "ops", "SKILL.md"), "# Ops\n");
    writeFile(path.join(stashDir, "commands", "release.md"), '---\ndescription: "Release command"\n---\nrun release\n');
    writeFile(
      path.join(stashDir, "agents", "coach.md"),
      '---\ndescription: "Coach"\nmodel: "gpt-5"\n---\nGuide users\n',
    );

    await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
      const skill = await akmShow({ ref: "skills/ops" });
      const command = await akmShow({ ref: "commands/release.md" });
      const agent = await akmShow({ ref: "agents/coach.md" });

      expect(skill.type).toBe("skill");
      expect(skill.action).toContain("Read and follow");
      expect(skill.content ?? "").toMatch(/Ops/);
      expect(command.type).toBe("command");
      expect(command.action).toContain("dispatch");
      expect(command.template ?? "").toMatch(/run release/);
      expect(command.description).toBe("Release command");
      expect(agent.type).toBe("agent");
      expect(agent.action).toContain("verbatim");
      expect(agent.prompt ?? "").toMatch(/Guide users/);
      expect(agent.modelHint).toBe("gpt-5");
    });
  });

  test("akmShow returns clear error when stash type root is missing", async () => {
    const stashDir = createTmpDir("akm-stash-");
    try {
      await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
        // QA #27: error should not leak "Stash type root" wording; be user-facing.
        // 0.9.0 (Q-02): the retired `type:name` colon grammar is gone — the
        // message now emits the slash conceptId (`agents/missing.md`).
        await expect(akmShow({ ref: "agents/missing.md" })).rejects.toThrow(
          /Asset not found for ref: agents\/missing\.md|not found for ref/i,
        );
      });
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true });
    }
  });

  test("akmShow accepts a foreign conceptId shape and reports a normal index miss", async () => {
    const stashDir = createTmpDir("akm-stash-");
    await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
      await expect(akmShow({ ref: "widget/foo" })).rejects.toThrow(/asset not found/i);
    });
  });

  test("akmShow does not reserve adapter-owned tool/vault concept paths", async () => {
    const stashDir = createTmpDir("akm-stash-");
    await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
      await expect(akmShow({ ref: "tool/deploy.sh" })).rejects.toThrow(/asset not found/i);
      await expect(akmShow({ ref: "vault/prod" })).rejects.toThrow(/asset not found/i);
    });
  });

  test("akmShow rejects traversal and absolute path refs", async () => {
    const stashDir = createTmpDir("akm-stash-");
    await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
      // The new-grammar conceptId validator (`validateName`) is the path-safety
      // guard: a `../`-leading conceptId trips traversal, an absolute path trips
      // the absolute-path guard — both at the input-parse boundary.
      await expect(akmShow({ ref: "../outside.sh" })).rejects.toThrow(/Path traversal/);
      await expect(akmShow({ ref: "/etc/passwd" })).rejects.toThrow(/Absolute path/);
    });
  });

  test("akmShow blocks symlink escapes outside stash type root", async () => {
    const stashDir = createTmpDir("akm-stash-");
    const outsideDir = createTmpDir("akm-outside-");
    const outsideFile = path.join(outsideDir, "outside.sh");
    const symlinkFile = path.join(stashDir, "scripts", "link.sh");
    writeFile(outsideFile, "echo outside\n");
    fs.mkdirSync(path.join(stashDir, "scripts"), { recursive: true });

    try {
      fs.symlinkSync(outsideFile, symlinkFile);
    } catch {
      // Symlinks not supported in this environment — skip
      return;
    }

    await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
      // Symlinks are skipped by the indexer, so the asset won't be found
      await expect(akmShow({ ref: "scripts/link.sh" })).rejects.toThrow(/not found for ref/);
    });
  });

  // ── Knowledge tests ─────────────────────────────────────────────────────────

  const KNOWLEDGE_DOC = `---
title: API Guide
description: "API documentation"
---
# Overview

This is the API guide.

## Authentication

Use bearer tokens.

## Endpoints

### GET /users

Returns all users.

### POST /users

Creates a user.
`;

  test("akmSearch finds knowledge assets", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC);

    await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
      const result = await akmSearch({ query: "", type: "knowledge" });

      expect(result.hits.length).toBe(1);
      expect(result.hits[0]!.type).toBe("knowledge");
      expect(result.hits[0]!.name).toBe("api-guide");
    });
  });

  test("akmShow returns full content for knowledge by default", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC);

    await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
      const result = await akmShow({ ref: "knowledge/api-guide.md" });

      expect(result.type).toBe("knowledge");
      expect(result.content).toContain("# Overview");
      expect(result.content).toContain("## Authentication");
    });
  });

  test("akmShow extracts a section for knowledge via #fragment", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC);

    await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
      const result = await akmShow({ ref: "knowledge/api-guide.md#authentication" });

      expect(result.type).toBe("knowledge");
      expect(result.content).toContain("bearer tokens");
      expect(result.content).not.toContain("Endpoints");
    });
  });

  test("search-emitted Markdown fragment selectors round-trip through show with frontmatter offsets", async () => {
    const stashDir = createTmpDir("akm-stash-");
    const body = Array.from({ length: 500 }, () => "background transcript material").join(" ");
    writeFile(
      path.join(stashDir, "knowledge", "fragment-roundtrip.md"),
      `---\ndescription: fragment fixture\n---\n\n${body}\n\nNeedleFragmentCase: Proof Appears Here!`,
    );
    await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
      const searched = await akmSearch({ query: "NeedleFragmentCase", type: "knowledge" });
      const hit = searched.hits[0];
      // index-redesign-contract.md B5f item 1 — the hit's primary `ref` is
      // always the bare entry now; the fragment-qualified selector lives on
      // `selectedRef`.
      expect(hit && isLocalHit(hit) ? hit.ref : undefined).toBe("knowledge/fragment-roundtrip");
      expect(hit && isLocalHit(hit) ? hit.selectedRef : undefined).toMatch(/#akm-fragment-/);
      if (!hit || !isLocalHit(hit) || !hit.selectedRef) throw new Error("expected a local fragment hit");
      // Search refs address the indexed safe revision. A concurrent disk edit
      // must not make the opaque selector disappear or show different bytes.
      writeFile(
        path.join(stashDir, "knowledge", "fragment-roundtrip.md"),
        "---\ndescription: changed\n---\nnew disk bytes",
      );
      const shown = await akmShow({ ref: hit.selectedRef });
      expect(shown.content).toBe("NeedleFragmentCase: Proof Appears Here!");
      expect(shown.content).not.toContain("new disk bytes");
      const selection = readEvents({ type: "select" }).events.at(-1);
      expect(selection).toMatchObject({
        ref: "knowledge/fragment-roundtrip",
        metadata: { query: "NeedleFragmentCase", rankPosition: 0 },
      });
    });
  });

  test("workflow fragment evidence keeps the executable parent ref and action", async () => {
    const stashDir = createTmpDir("akm-stash-");
    const body = Array.from({ length: 500 }, () => "workflow background material").join(" ");
    writeFile(
      path.join(stashDir, "workflows", "release.md"),
      [
        "---",
        "type: workflow",
        "description: Executable release workflow",
        "steps:",
        "  - id: release",
        "    unit:",
        '      exec: { command: ["sh", "-c", "true"] }',
        "---",
        "",
        "## release",
        "",
        body,
        "",
        "workflowfragmentneedle proves the release path.",
      ].join("\n"),
    );
    await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
      const hit = (await akmSearch({ query: "workflowfragmentneedle", type: "workflow" })).hits.find(isLocalHit);
      if (!hit) throw new Error("expected a local workflow hit");
      expect(hit.ref).toBe("workflows/release");
      expect(hit.action).toContain("akm workflow run 'workflows/release'");
      expect(hit.action).not.toContain("#akm-fragment-");
    });
  });

  test("search→show covers preamble, duplicate headings, and fallback fragment shapes", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(
      path.join(stashDir, "knowledge", "preamble.md"),
      `preambleuniquetoken evidence\n\n# Later\nordinary text`,
    );
    writeFile(
      path.join(stashDir, "knowledge", "duplicate.md"),
      `# Repeat\nfirst copy\n\n# Repeat\nduplicateuniquetoken evidence`,
    );
    writeFile(
      path.join(stashDir, "knowledge", "transcript.md"),
      `${Array.from({ length: 450 }, () => "background transcript").join(" ")}\n\ntranscriptuniquetoken evidence`,
    );
    writeFile(
      path.join(stashDir, "knowledge", "oversized-section.md"),
      `# Oversized\n\n${Array.from({ length: 900 }, () => "section background").join(" ")}\n\noversizedsectiontoken evidence`,
    );
    await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
      const cases: Array<[string, string]> = [
        ["preambleuniquetoken", "preambleuniquetoken"],
        ["duplicateuniquetoken", "duplicateuniquetoken"],
        ["transcriptuniquetoken", "transcriptuniquetoken"],
        ["oversizedsectiontoken", "oversizedsectiontoken"],
      ];
      for (const [query, expected] of cases) {
        const hit = (await akmSearch({ query, type: "knowledge" })).hits[0];
        // index-redesign-contract.md B5f item 1 — `ref` stays the bare entry;
        // `selectedRef` carries the fragment-qualified selector.
        expect(hit && isLocalHit(hit) ? hit.selectedRef : undefined).toMatch(/#akm-fragment-/);
        if (!hit || !isLocalHit(hit) || !hit.selectedRef) throw new Error("expected local fragment hit");
        expect((await akmShow({ ref: hit.selectedRef })).content).toContain(expected);
      }
    });
  });

  test("akmShow lists the available slugs when the fragment does not match", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "knowledge", "api-guide.md"), KNOWLEDGE_DOC);

    await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
      await expect(akmShow({ ref: "knowledge/api-guide.md#nonexistent" })).rejects.toThrow(
        /Available fragments: #overview, #authentication, #endpoints/,
      );
    });
  });

  test("akmShow for script type returns run", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
      const result = await akmShow({ ref: "scripts/deploy.sh" });

      expect(result.type).toBe("script");
      expect(result.run).toBeTruthy();
      expect(typeof result.run).toBe("string");
      expect(result.run).toContain("bash");
    });
  });

  test("akmInit returns created false when stash dir already exists", async () => {
    const tmpHome = createTmpDir("akm-home-");
    // Pre-create the akm directory at the new default location (~/akm)
    const stashPath = path.join(tmpHome, "akm");
    fs.mkdirSync(stashPath, { recursive: true });

    try {
      await withEnv({ HOME: tmpHome, AKM_BUNDLE_DIR: undefined }, async () => {
        const result = await akmInit();
        expect(result.created).toBe(false);
        expect(result.bundleDir).toBe(stashPath);
      });
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("akmShow renders a .txt script as plain text instead of refusing it", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "scripts", "readme.txt"), "not a script\n");

    try {
      await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
        const result = await akmShow({ ref: "scripts/readme.txt" });
        expect(result.type).toBe("script");
        expect(result.content).toContain("not a script");
      });
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true });
    }
  });

  test("akmInit creates knowledge directory", async () => {
    const tmpHome = createTmpDir("akm-home-");

    try {
      await withEnv({ HOME: tmpHome, AKM_BUNDLE_DIR: undefined }, async () => {
        const result = await akmInit();
        expect(fs.existsSync(path.join(result.bundleDir, "knowledge"))).toBe(true);
      });
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // ── Script tests ────────────────────────────────────────────────────────────

  test("akmSearch finds script assets with broad extensions", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "scripts", "cleanup.sh"), "#!/usr/bin/env bash\necho cleanup\n");
    writeFile(path.join(stashDir, "scripts", "process.py"), "print('hello')\n");
    writeFile(path.join(stashDir, "scripts", "README.md"), "ignore\n");

    try {
      await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
        const result = await akmSearch({ query: "", type: "script" });

        expect(result.hits.length).toBe(2);
        expect(result.hits.every((hit: SearchHit) => hit.type === "script")).toBe(true);
        expect(result.hits.some((hit: SearchHit) => hit.name === "README.md")).toBe(false);
      });
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true });
    }
  });

  test("akmSearch returns run for runnable script extensions", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    try {
      await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
        const result = await akmSearch({ query: "", type: "script" });
        const hit = result.hits.filter(isLocalHit)[0];

        expect(result.hits.length).toBe(1);
        expect(hit!.run).toBeTruthy();
        expect(hit!.run).toContain("bash");
      });
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true });
    }
  });

  test("akmShow returns run for python script (auto-detected interpreter)", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "scripts", "process.py"), "# A python script\nprint('hello')\n");

    try {
      await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
        const result = await akmShow({ ref: "scripts/process.py" });

        expect(result.type).toBe("script");
        expect(result.run).toBeDefined();
        expect(result.run).toContain("python");
      });
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true });
    }
  });

  test("akmShow returns run for runnable script", async () => {
    const stashDir = createTmpDir("akm-stash-");
    writeFile(path.join(stashDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
      const result = await akmShow({ ref: "scripts/deploy.sh" });

      expect(result.type).toBe("script");
      expect(result.run).toBeTruthy();
      expect(result.run).toContain("bash");
    });
  });

  test("akmInit writes config outside the stash directory", async () => {
    const tmpHome = createTmpDir("akm-home-");

    try {
      await withEnv({ HOME: tmpHome, AKM_BUNDLE_DIR: undefined }, async () => {
        const result = await akmInit();
        expect(result.configPath).toBe(getConfigPath());
        expect(result.configPath.startsWith(result.bundleDir)).toBe(false);
        expect(fs.existsSync(result.configPath)).toBe(true);
        expect(fs.existsSync(path.join(result.bundleDir, "config.json"))).toBe(false);
      });
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
