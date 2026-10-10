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

  test("--filter (the real spelling) still works and is unaffected", async () => {
    seedGuide();

    const result = await runEntrypoint(["show", "knowledge/guide", "--filter", "user=x", "--format=json"]);

    // No matching scope_user on disk -> not found in this scope, NOT a usage error.
    expect(result.status).toBe(1);
    const error = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(String(error.error)).toContain("out of scope");
  });
});

describe("entrypoint global --shape=summary ordering", () => {
  test("allows global --shape=summary before show", async () => {
    const storage = useStorage();
    // Semantic off keeps stderr empty as asserted below: with the default
    // ("auto") the local embedder fetches its model from huggingface.co
    // during auto-index, and an offline/blocked fetch warns on stderr.
    writeSandboxConfig({ semanticSearchMode: "off" });
    writeFixture(
      path.join(storage.stashDir, "commands", "release.md"),
      "---\ndescription: Release\n---\nRun release {{version}}\n",
    );

    const result = await runEntrypoint(["--format=json", "--shape=summary", "show", "commands/release.md"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json.type).toBe("command");
    expect(json.name).toBe("release");
    expect(json.description).toBe("Release");
    expect(json).not.toHaveProperty("template");
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
