import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runCliCapture } from "../_helpers/cli";
import { type Cleanup, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let cleanup: Cleanup = () => {};

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

function useStorage(): ReturnType<typeof withIsolatedAkmStorage> {
  const storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
  return storage;
}

function writeFixture(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

async function runEntrypoint(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await runCliCapture(args);
  return { status: code, stdout, stderr };
}

// NOTE: the pre-execution `--shape` gate test (rejecting global
// --shape=summary before non-show commands) lives in
// tests/integration/show-argv-entrypoint.test.ts — it needs the real
// subprocess entry point, which the in-process harness intentionally skips.

// D2: the `akm show <ref> toc|section|lines|frontmatter|full` view grammar is
// gone. A trailing positional was previously rewritten into hidden `--akmView`
// flags; it must now be a usage error that points at `#fragment`, and the
// hidden flags themselves must no longer select anything.
describe("akm show view-mode grammar is removed", () => {
  const GUIDE = ["# Intro", "Welcome.", "", "## Setup", "Install things.", ""].join("\n");

  function seedGuide(): void {
    const storage = useStorage();
    writeSandboxConfig({ semanticSearchMode: "off" });
    writeFixture(path.join(storage.stashDir, "knowledge", "guide.md"), GUIDE);
  }

  for (const positional of ["toc", "frontmatter", "full", "section", "lines"]) {
    test(`a trailing \`${positional}\` positional is a usage error naming #fragment`, async () => {
      seedGuide();

      const result = await runEntrypoint(["show", "knowledge/guide", positional, "--format=json"]);

      expect(result.status).toBe(2);
      const error = JSON.parse(result.stderr) as Record<string, unknown>;
      expect(error.ok).toBe(false);
      expect(String(error.error)).toContain("akm show knowledge/guide#");
      expect(String(error.hint)).toContain("akm show knowledge/guide --detail brief");
    });
  }

  test("the hidden --akmView flag is an unknown flag", async () => {
    seedGuide();

    const result = await runEntrypoint(["show", "knowledge/guide", "--akmView=toc", "--format=json"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unknown flag "--akmView"');
  });

  test("the ref keeps resolving when a view keyword is its own conceptId", async () => {
    const storage = useStorage();
    writeSandboxConfig({ semanticSearchMode: "off" });
    writeFixture(path.join(storage.stashDir, "knowledge", "toc.md"), "# Toc\nA doc literally named toc.\n");

    const result = await runEntrypoint(["show", "knowledge/toc", "--format=json"]);

    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json.name).toBe("toc");
  });
});

// `--scope` was removed in favor of `--filter` and is not a declared flag on
// `show`: both spellings must fail loudly as an unknown flag (exit 2), never
// run unscoped.
describe("akm show --scope fails loudly for both spellings", () => {
  function seedGuide(): void {
    const storage = useStorage();
    writeSandboxConfig({ semanticSearchMode: "off" });
    writeFixture(path.join(storage.stashDir, "knowledge", "guide.md"), "# Intro\nWelcome.\n");
  }

  for (const scopeArgs of [["--scope", "user=x"], ["--scope=user=x"]]) {
    test(`${scopeArgs.join(" ")} exits 2 as an unknown flag`, async () => {
      seedGuide();

      const result = await runEntrypoint(["show", "knowledge/guide", ...scopeArgs, "--format=json"]);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Unknown flag "--scope"');
    });
  }

  test("--filter is no longer a show flag and exits 2", async () => {
    seedGuide();

    const result = await runEntrypoint(["show", "knowledge/guide", "--filter", "user=x", "--format=json"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unknown flag "--filter"');
  });
});

// F6/R-021: `show` must resolve `--detail` through ONE explicit path, and
// (owner ruling) deliberately does NOT inherit `config.output.detail` the
// way `search`/`curate` do — a bare `akm show <ref>` always returns the
// FULL asset body, regardless of the config default. Before this fix,
// `showCommand` read `--detail` via a raw argv scan
// (`invocation.getFlagValue`) that happened to ignore config as a side
// effect of not being config-aware at all; there was zero test coverage for
// `--detail brief`, `--detail full`, or the config-default case at either
// the CLI or `buildBriefResponse` layer.
describe("akm show --detail resolution (F6/R-021)", () => {
  function seedCommand(storage: ReturnType<typeof useStorage>): void {
    writeFixture(
      path.join(storage.stashDir, "commands", "release.md"),
      "---\ndescription: Release\n---\nRun release {{version}}\n",
    );
  }

  test("explicit --detail brief returns the reduced payload", async () => {
    const storage = useStorage();
    writeSandboxConfig({ semanticSearchMode: "off" });
    seedCommand(storage);

    const result = await runEntrypoint(["show", "commands/release.md", "--detail", "brief", "--format=json"]);

    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json.type).toBe("command");
    expect(json.description).toBe("Release");
    expect(json).not.toHaveProperty("template");
  });

  test("explicit --detail full returns the full payload", async () => {
    const storage = useStorage();
    writeSandboxConfig({ semanticSearchMode: "off" });
    seedCommand(storage);

    const result = await runEntrypoint(["show", "commands/release.md", "--detail", "full", "--format=json"]);

    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json.type).toBe("command");
    expect(json.template).toBe("Run release {{version}}\n");
  });

  test("no --detail flag returns full, even when config.output.detail is 'brief' (deliberate exemption)", async () => {
    const storage = useStorage();
    // config.output.detail defaults to "brief" (DEFAULT_CONFIG.output.detail)
    // and search/curate DO inherit it via getOutputMode().detail — show must
    // not, so pin the default explicitly here rather than relying on it.
    writeSandboxConfig({ semanticSearchMode: "off", output: { detail: "brief" } });
    seedCommand(storage);

    const result = await runEntrypoint(["show", "commands/release.md", "--format=json"]);

    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json.type).toBe("command");
    expect(json.template).toBe("Run release {{version}}\n");
  });
});

describe("akm show toc at each --detail level", () => {
  const GUIDE = ["# Guide", "Intro.", "", "## Install", "Run it.", "", "## Install", "Again."].join("\n");
  const TOC = [
    { level: 1, text: "Guide", slug: "guide", startLine: 1 },
    { level: 2, text: "Install", slug: "install", startLine: 4 },
    { level: 2, text: "Install", slug: "install-1", startLine: 7 },
  ];

  function seedGuide(): void {
    const storage = useStorage();
    writeSandboxConfig({ semanticSearchMode: "off" });
    writeFixture(path.join(storage.stashDir, "knowledge", "guide.md"), GUIDE);
    writeFixture(path.join(storage.stashDir, "scripts", "deploy.sh"), "#!/bin/sh\n# Deploy\necho hi\n");
  }

  async function showJson(args: string[]): Promise<Record<string, unknown>> {
    const result = await runEntrypoint(["show", ...args, "--format=json"]);
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  }

  test("--detail brief is the outline without the body", async () => {
    seedGuide();
    const json = await showJson(["knowledge/guide", "--detail", "brief"]);
    expect(json.toc).toEqual(TOC);
    expect(json).not.toHaveProperty("content");
  });

  for (const detail of [[], ["--detail", "normal"], ["--detail", "full"], ["--detail", "agent"]]) {
    test(`${detail.join(" ") || "the default detail"} carries the toc next to the body`, async () => {
      seedGuide();
      const json = await showJson(["knowledge/guide", ...detail]);
      expect(json.toc).toEqual(TOC);
      expect(json.content).toBe(GUIDE);
    });
  }

  test("every slug the CLI lists selects its section", async () => {
    seedGuide();
    const { toc } = (await showJson(["knowledge/guide", "--detail", "brief"])) as { toc: typeof TOC };
    for (const heading of toc) {
      const section = await showJson([`knowledge/guide#${heading.slug}`]);
      expect(String(section.content).split("\n")[0]).toBe(GUIDE.split("\n")[heading.startLine - 1]);
      expect(section).not.toHaveProperty("toc");
    }
    expect((await showJson(["knowledge/guide#install-1"])).content).toBe("## Install\nAgain.");
  });

  test("a non-markdown asset has no toc at any level", async () => {
    seedGuide();
    for (const detail of ["brief", "agent", "full"]) {
      expect(await showJson(["scripts/deploy.sh", "--detail", detail])).not.toHaveProperty("toc");
    }
  });

  test("--format text prints the outline", async () => {
    seedGuide();
    const result = await runEntrypoint(["show", "knowledge/guide", "--detail", "brief", "--format=text"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "toc:\n  # Guide (#guide, line 1)\n  ## Install (#install, line 4)\n  ## Install (#install-1, line 7)",
    );
  });
});

describe("akm show fragment context flags", () => {
  function seedFragmentGuide(): void {
    const storage = useStorage();
    writeSandboxConfig({ semanticSearchMode: "off" });
    writeFixture(
      path.join(storage.stashDir, "knowledge", "context.md"),
      ["# Profile", "Yoga is at Serenity Yoga.", "", "# Details", "fragmentflagneedle proof"].join("\n"),
    );
  }

  test("--context lead with --max-chars emits bounded indexed-safe metadata", async () => {
    seedFragmentGuide();

    const result = await runEntrypoint([
      "show",
      "knowledge/context#details",
      "--context",
      "lead",
      "--max-chars",
      "200",
      "--format=json",
    ]);

    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(String(json.content).length).toBeLessThanOrEqual(200);
    expect(json).toMatchObject({
      ref: "knowledge/context",
      parentRef: "knowledge/context",
      fragmentOrdinal: 2,
      fragmentCount: 2,
      contextMode: "lead",
      contextMaxChars: 200,
      contextTruncated: false,
    });
    expect(json.selectedRef).toMatch(/^knowledge\/context#akm-fragment-/);
    expect(String(json.content)).toEndWith("[Selected matching fragment]\n# Details\nfragmentflagneedle proof");
  });

  test("--max-tokens converts to the documented four-character budget", async () => {
    seedFragmentGuide();

    const result = await runEntrypoint([
      "show",
      "knowledge/context#details",
      "--context=lead",
      "--max-tokens=25",
      "--format=json",
    ]);

    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json.contextMaxChars).toBe(100);
    expect(String(json.content).length).toBeLessThanOrEqual(100);
  });

  for (const args of [
    ["--context=unknown"],
    ["--max-chars=100"],
    ["--context=lead", "--max-chars=100", "--max-tokens=25"],
  ]) {
    test(`rejects invalid context invocation ${args.join(" ")}`, async () => {
      seedFragmentGuide();

      const result = await runEntrypoint(["show", "knowledge/context#details", ...args, "--format=json"]);

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: "INVALID_FLAG_VALUE" });
    });
  }
});

describe("akm show additive body controls", () => {
  const GUIDE = ["# Intro", "background ".repeat(80), "", "## Details", "selected proof ".repeat(20)].join("\n");

  function seed(): ReturnType<typeof useStorage> {
    const storage = useStorage();
    writeSandboxConfig({ semanticSearchMode: "off", output: { detail: "brief" } });
    writeFixture(path.join(storage.stashDir, "knowledge", "guide.md"), GUIDE);
    writeFixture(path.join(storage.stashDir, "commands", "release.md"), `---\ndescription: Release\n---\n${GUIDE}`);
    writeFixture(path.join(storage.stashDir, "agents", "review.md"), `---\ndescription: Review\n---\n${GUIDE}`);
    writeFixture(path.join(storage.stashDir, "env", "demo.env"), "TOKEN=private-env-value\n");
    writeFixture(path.join(storage.stashDir, "secrets", "demo"), "private-secret-value\n");
    writeFixture(path.join(storage.stashDir, "scripts", "demo.sh"), "#!/bin/sh\necho hello\n");
    return storage;
  }

  async function json(ref: string, ...flags: string[]): Promise<Record<string, unknown>> {
    const result = await runEntrypoint(["show", ref, ...flags, "--format=json"]);
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  }

  test("--outline matches brief metadata while an unqualified read stays complete", async () => {
    seed();
    const full = await json("knowledge/guide");
    expect(full.content).toBe(GUIDE);
    expect(full).not.toHaveProperty("contentBudget");
    const outline = await json("knowledge/guide", "--outline");
    expect(outline).toEqual(await json("knowledge/guide", "--detail=brief"));
    expect(outline).not.toHaveProperty("content");
    expect(outline.toc).toEqual([
      { level: 1, text: "Intro", slug: "intro", startLine: 1 },
      { level: 2, text: "Details", slug: "details", startLine: 4 },
    ]);
  });

  for (const [ref, payload] of [
    ["knowledge/guide", "content"],
    ["commands/release", "template"],
    ["agents/review", "prompt"],
  ]) {
    test(`--max-tokens bounds ${payload} on ${ref} and retains agent metadata`, async () => {
      seed();
      const full = await json(ref!);
      const bounded = await json(ref!, "--max-tokens=25", "--detail=agent");
      // At most 100 characters, a prefix of the full body, cut at whitespace.
      const text = String(bounded[payload!]);
      expect(String(full[payload!]).startsWith(text)).toBe(true);
      expect(text.length).toBeGreaterThan(68);
      expect(text.length).toBeLessThanOrEqual(100);
      expect(String(full[payload!])[text.length]).toMatch(/\s/);
      expect(bounded.contentBudget).toEqual({
        maxTokens: 25,
        estimatedTokens: Math.ceil(text.length / 4),
        truncated: true,
      });
      expect(bounded.ref).toBe(full.ref);
      expect(bounded.path).toBe(full.path);
      expect(bounded.editable).toBe(full.editable);
    });
  }

  test("exact headings are budgeted without adding a lead or indexed provenance", async () => {
    seed();
    const exact = await json("knowledge/guide#details");
    const bounded = await json("knowledge/guide#details", "--max-tokens=25");
    expect(String(exact.content).startsWith(String(bounded.content))).toBe(true);
    expect(String(bounded.content).length).toBeLessThanOrEqual(100);
    expect(bounded.contentBudget).toMatchObject({ maxTokens: 25, truncated: true });
    expect(bounded).not.toHaveProperty("selectedRef");
    expect(bounded).not.toHaveProperty("contextMode");
    const fitting = await json("knowledge/guide#details", "--max-tokens=1000");
    expect(fitting.content).toBe(exact.content);
    expect(fitting.contentBudget).toEqual({
      maxTokens: 1000,
      estimatedTokens: Math.ceil(String(exact.content).length / 4),
      truncated: false,
    });
  });

  test("--lead preserves the old lead result and exact opaque fragments remain bounded", async () => {
    seed();
    const lead = await json("knowledge/guide#details", "--lead", "--max-tokens=90");
    expect(lead).toEqual(await json("knowledge/guide#details", "--context=lead", "--max-tokens=90"));
    expect(String(lead.content).length).toBeLessThanOrEqual(360);
    expect(String(lead.content)).toContain("[Selected matching fragment]");
    expect(lead.contextTruncated).toBe(true);
    expect(lead.contentBudget).toMatchObject({ maxTokens: 90, truncated: true });
    const opaque = await json(String(lead.selectedRef), "--max-tokens=25");
    expect(opaque.selectedRef).toBe(lead.selectedRef);
    expect(String(opaque.content).length).toBeLessThanOrEqual(100);
    expect(opaque.contextMode).toBe("exact");
    expect(opaque.contextTruncated).toBe(true);
    expect(opaque.contentBudget).toMatchObject({ truncated: true });
  });

  test("the budget skips frontmatter, never splits a surrogate pair, and the text line is true", async () => {
    const storage = seed();
    const emoji = "\u{1F600}".repeat(60);
    writeFixture(
      path.join(storage.stashDir, "knowledge", "emoji.md"),
      `---\ndescription: Emoji\ntags: [a, b]\n---\n# Emoji\n${emoji}\n`,
    );
    const bounded = await json("knowledge/emoji", "--max-tokens=5");
    const content = String(bounded.content);
    // Frontmatter kept whole and not counted: the 20-character body budget applies after it.
    expect(content.startsWith("---\ndescription: Emoji\ntags: [a, b]\n---\n")).toBe(true);
    const body = content.slice(content.indexOf("---\n", 4) + 4);
    expect(body.length).toBeLessThanOrEqual(20);
    expect(bounded.contentBudget).toEqual({
      maxTokens: 5,
      estimatedTokens: Math.ceil(body.length / 4),
      truncated: true,
    });
    // No lone surrogate anywhere.
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(content)).toBe(false);
    const text = await runEntrypoint(["show", "knowledge/emoji", "--max-tokens=5", "--format=text"]);
    expect(text.stdout).toContain("frontmatter excluded");
  });

  test("a cut that already falls on a word end keeps the whole word", async () => {
    const storage = seed();
    writeFixture(path.join(storage.stashDir, "knowledge", "wordend.md"), "12345678901234567890 tail of the note\n");
    const bounded = await json("knowledge/wordend", "--max-tokens=5");
    expect(bounded.content).toBe("12345678901234567890");
    expect(bounded.contentBudget).toEqual({ maxTokens: 5, estimatedTokens: 5, truncated: true });
  });

  test("--detail brief with a budget is a usage error; --lead errors name --lead", async () => {
    seed();
    for (const args of [
      ["--detail=brief", "--max-tokens=25"],
      ["--detail=brief", "--lead"],
      ["--outline", "--max-tokens=25"],
      ["--outline", "--lead"],
    ]) {
      expect((await runEntrypoint(["show", "knowledge/guide#details", ...args])).status, args.join(" ")).toBe(2);
    }
    // 0.10.261118 combinations of --detail brief with lead context keep working (the akm-plugins /akm-show form).
    for (const args of [
      ["--detail=brief", "--context=lead"],
      ["--detail=brief", "--context=lead", "--max-chars=100"],
      ["--detail=brief", "--context=lead", "--max-tokens=25"],
    ]) {
      const ok = await runEntrypoint(["show", "knowledge/guide#details", ...args, "--format=json"]);
      expect(ok.status, args.join(" ")).toBe(0);
      expect(JSON.parse(ok.stdout).contextMode, args.join(" ")).toBe("lead");
    }
    const noFragment = await runEntrypoint(["show", "knowledge/guide", "--lead", "--format=json"]);
    expect(noFragment.status).toBe(2);
    expect(JSON.parse(noFragment.stderr).error).toContain("--lead requires a fragment-qualified ref");
    const viaContext = await runEntrypoint(["show", "knowledge/guide", "--context=lead", "--format=json"]);
    expect(JSON.parse(viaContext.stderr).error).toContain("--context lead requires");
  });

  test("direct .meta bodies are bounded without changing the old brief read", async () => {
    const storage = seed();
    writeFixture(path.join(storage.stashDir, ".meta", "index.md"), GUIDE);
    expect((await json("meta", "--detail=brief")).content).toBe(GUIDE);
    const bounded = await json("meta", "--max-tokens=25");
    expect(GUIDE.startsWith(String(bounded.content))).toBe(true);
    expect(String(bounded.content).length).toBeLessThanOrEqual(100);
    expect(bounded.contentBudget).toMatchObject({ maxTokens: 25, truncated: true });
    const outline = await runEntrypoint(["show", "meta", "--outline", "--format=json"]);
    expect(outline.status).toBe(2);
    expect(outline.stderr).toContain("--outline is unavailable for direct .meta reads");
    expect(outline.stdout).toBe("");
  });

  test("text output discloses the approximate body-only budget and truncation", async () => {
    seed();
    const result = await runEntrypoint(["show", "knowledge/guide", "--max-tokens=25", "--format=text"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /body budget: ~\d+\/25 tokens \(4 characters\/token; frontmatter excluded\); truncated: true/,
    );
  });

  for (const [ref, flags] of [
    ["knowledge/guide", ["--outline", "--max-tokens=25"]],
    ["knowledge/guide", ["--outline", "--max-chars=100"]],
    ["knowledge/guide#details", ["--outline", "--lead"]],
    ["knowledge/guide#details", ["--outline", "--context=lead"]],
    ["knowledge/guide", ["--outline", "--detail=full"]],
    ["knowledge/guide", ["--outline", "--detail=agent"]],
    ["knowledge/guide", ["--lead"]],
    ["scripts/demo.sh#anything", ["--lead"]],
    ["knowledge/guide#details", ["--lead", "--context=exact"]],
    ["knowledge/guide#details", ["--lead", "--detail=brief"]],
    ["knowledge/guide", ["--max-tokens=25", "--detail=brief"]],
    ["knowledge/guide", ["--max-tokens=0"]],
    ["knowledge/guide", ["--max-tokens=9007199254740991"]],
  ] as const) {
    test(`rejects ${ref} ${flags.join(" ")}`, async () => {
      seed();
      const result = await runEntrypoint(["show", ref, ...flags, "--format=json"]);
      expect(result.status).toBeGreaterThan(0);
      expect(result.stdout).toBe("");
    });
  }

  for (const ref of ["env/demo", "secrets/demo"]) {
    test(`body controls cannot expose sensitive values from ${ref}`, async () => {
      seed();
      for (const flags of [["--outline"], ["--max-tokens=1000"], ["--max-tokens=1000", "--detail=full"]]) {
        const safe = await json(ref, ...flags);
        expect(safe).not.toHaveProperty("content");
        expect(safe).not.toHaveProperty("template");
        expect(safe).not.toHaveProperty("prompt");
        expect(JSON.stringify(safe)).not.toContain("private-env-value");
        expect(JSON.stringify(safe)).not.toContain("private-secret-value");
      }
      const lead = await runEntrypoint(["show", `${ref}#anything`, "--lead", "--format=json"]);
      expect(lead.status).toBe(2);
      expect(lead.stderr).toContain("sensitive");
      expect(lead.stdout).toBe("");
    });
  }
});
