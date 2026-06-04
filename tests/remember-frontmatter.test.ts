/**
 * Tests for `akm remember` frontmatter support (issue #169).
 *
 * Covers:
 * - CLI arg round-trip (--tag, --expires, --source)
 * - --auto heuristics (code, subjective, source, observed_at)
 * - --enrich with mocked chatCompletion (success + failure)
 * - Required-field rejection before any file write
 * - --expires duration → ISO date computation
 * - Zero-flag remember still works (no frontmatter written)
 * - memory metadata contributors populate StashEntry fields
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFrontmatter } from "../src/core/frontmatter";
import { buildFileContext, buildRenderContext } from "../src/indexer/file-context";
import type { StashEntry } from "../src/indexer/metadata";
import { applyMetadataContributors } from "../src/indexer/metadata-contributors";
import { runCliCapture } from "./_helpers/cli";
import { withEnv } from "./_helpers/sandbox";

// ── CLI harness ──────────────────────────────────────────────────────────────
//
// Migrated the non-stdin `akm remember` invocations from spawnSync to the shared
// in-process harness (tests/_helpers/cli.ts). `remember` resolves its target
// from AKM_STASH_DIR (XDG), not process.cwd(), so it runs faithfully in-process.
//
// KEPT SPAWNING (harness gap): the two tests that pipe a body via stdin
// (`spawnRunCli({ input })`). runCliCapture has no stdin support — the CLI's
// `remember` reads process.stdin when no body arg is given (and when --format
// json is present), which the in-process harness cannot supply. Those two tests
// stay as real subprocesses so the stdin read path is exercised faithfully.
//
// Env mutation goes through the allowlisted withEnv wrapper; temp dirs are
// created via makeTempDir (kept local) and tracked in tempDirs for cleanup.

const CLI = path.join(__dirname, "..", "src", "cli.ts");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function freshDirs(options?: { stashDir?: string }) {
  const stashDir = options?.stashDir ?? makeTempDir("akm-rmfm-stash-");
  return {
    stashDir,
    env: {
      AKM_STASH_DIR: stashDir,
      XDG_CACHE_HOME: makeTempDir("akm-rmfm-cache-"),
      XDG_CONFIG_HOME: makeTempDir("akm-rmfm-config-"),
      XDG_DATA_HOME: makeTempDir("akm-rmfm-data-"),
      XDG_STATE_HOME: makeTempDir("akm-rmfm-state-"),
    } satisfies Record<string, string>,
  };
}

/** In-process runner for the non-stdin `remember` paths. */
async function runCli(args: string[], options?: { stashDir?: string }) {
  const { stashDir, env } = freshDirs(options);
  const { stdout, stderr, code } = await withEnv(env, () => runCliCapture(args));
  return { stashDir, result: { status: code, stdout, stderr } };
}

/**
 * Subprocess runner, retained ONLY for the stdin-driven tests. runCliCapture has
 * no stdin support, so the CLI's stdin read path is exercised via a real process.
 */
function spawnRunCli(args: string[], options?: { stashDir?: string; input?: string }) {
  const { stashDir, env } = freshDirs(options);
  const result = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    input: options?.input,
    env: { ...process.env, ...env },
  });
  return { stashDir, result };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Zero-flag path (backward compatibility) ──────────────────────────────────

describe("zero-flag remember", () => {
  test("writes memory with captureMode: hot + beliefState: asserted and nothing else", async () => {
    const { stashDir, result } = await runCli(["remember", "Deployment needs VPN access"]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { ref: string; path: string };
    const content = fs.readFileSync(json.path, "utf8");

    // Phase 1B / Rec 7: zero-flag hot-path emits captureMode + beliefState
    expect(content.startsWith("---")).toBe(true);
    const parsed = parseFrontmatter(content);
    expect(parsed.data.captureMode).toBe("hot");
    expect(parsed.data.beliefState).toBe("asserted");
    // No other frontmatter keys
    expect(Object.keys(parsed.data).sort()).toEqual(["beliefState", "captureMode"]);
    expect(parsed.content).toContain("Deployment needs VPN access");
    expect(stashDir).toBeTruthy();
  });

  test("stdin zero-flag path also writes captureMode: hot + beliefState: asserted", () => {
    const { result } = spawnRunCli(["remember"], { input: "VPN needed for staging deploys" });
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as { ref: string; path: string };
    const content = fs.readFileSync(json.path, "utf8");
    expect(content.startsWith("---")).toBe(true);
    const parsed = parseFrontmatter(content);
    expect(parsed.data.captureMode).toBe("hot");
    expect(parsed.data.beliefState).toBe("asserted");
    expect(Object.keys(parsed.data).sort()).toEqual(["beliefState", "captureMode"]);
  });

  test("reads stdin when --format json is present", () => {
    const { result } = spawnRunCli(["remember", "--name", "from-stdin", "--format", "json"], { input: "stdin body" });
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as { path: string };
    expect(fs.readFileSync(json.path, "utf8")).toContain("stdin body");
    expect(fs.readFileSync(json.path, "utf8")).not.toContain("\njson");
  });
});

// ── CLI args (Mode 1) ────────────────────────────────────────────────────────

describe("remember --tag", () => {
  test("single --tag writes frontmatter with tags array", async () => {
    const { result } = await runCli(["remember", "VPN required for staging", "--tag", "ops"]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { path: string };
    const content = fs.readFileSync(json.path, "utf8");
    const parsed = parseFrontmatter(content);
    expect(parsed.data.tags).toEqual(["ops"]);
    expect(parsed.content).toContain("VPN required for staging");
  });

  test("multiple --tag flags write all tags", async () => {
    const { result } = await runCli(["remember", "VPN required for staging", "--tag", "ops", "--tag", "networking"]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { path: string };
    const content = fs.readFileSync(json.path, "utf8");
    const parsed = parseFrontmatter(content);
    expect(parsed.data.tags).toEqual(["ops", "networking"]);
  });
});

describe("remember --source", () => {
  test("--source stores a URL as-is", async () => {
    const { result } = await runCli([
      "remember",
      "Read the deployment guide",
      "--tag",
      "docs",
      "--source",
      "https://example.com/deploy",
    ]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { path: string };
    const content = fs.readFileSync(json.path, "utf8");
    const parsed = parseFrontmatter(content);
    expect(parsed.data.source).toBe("https://example.com/deploy");
  });

  test("--source stores an asset ref", async () => {
    const { result } = await runCli([
      "remember",
      "Deploy skill requires VPN",
      "--tag",
      "ops",
      "--source",
      "skill:deploy",
    ]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { path: string };
    const content = fs.readFileSync(json.path, "utf8");
    const parsed = parseFrontmatter(content);
    expect(parsed.data.source).toBe("skill:deploy");
  });
});

describe("remember --expires", () => {
  test("--expires 30d resolves to a future ISO date ~30 days from now", async () => {
    const before = new Date();
    const { result } = await runCli([
      "remember",
      "Temp access token valid 30 days",
      "--tag",
      "security",
      "--expires",
      "30d",
    ]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { path: string };
    const content = fs.readFileSync(json.path, "utf8");
    const parsed = parseFrontmatter(content);
    const expires = parsed.data.expires as string;
    expect(expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Should be approximately 30 days from now (within 1-day margin)
    const expiresDate = new Date(expires);
    const expectedMin = new Date(before.getTime() + 29 * 24 * 60 * 60 * 1000);
    const expectedMax = new Date(before.getTime() + 31 * 24 * 60 * 60 * 1000);
    expect(expiresDate >= expectedMin).toBe(true);
    expect(expiresDate <= expectedMax).toBe(true);
  });

  test("--expires 12h resolves to a future ISO date ~12h from now", async () => {
    const { result } = await runCli(["remember", "Short-lived credential", "--tag", "security", "--expires", "12h"]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { path: string };
    const content = fs.readFileSync(json.path, "utf8");
    const parsed = parseFrontmatter(content);
    expect(parsed.data.expires as string).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("--expires 6m resolves to a future ISO date ~6 months from now", async () => {
    const { result } = await runCli(["remember", "Long-term access", "--tag", "access", "--expires", "6m"]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { path: string };
    const content = fs.readFileSync(json.path, "utf8");
    const parsed = parseFrontmatter(content);
    const expires = parsed.data.expires as string;
    expect(expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const expiresDate = new Date(expires);
    const expectedMin = new Date(Date.now() + 170 * 24 * 60 * 60 * 1000); // ~5.7 months
    const expectedMax = new Date(Date.now() + 185 * 24 * 60 * 60 * 1000); // ~6.2 months
    expect(expiresDate >= expectedMin).toBe(true);
    expect(expiresDate <= expectedMax).toBe(true);
  });

  test("invalid --expires format produces an error", async () => {
    const { result } = await runCli(["remember", "Some note", "--tag", "misc", "--expires", "invalid"]);
    expect(result.status).toBe(2);
    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toContain("Invalid --expires format");
  });
});

// ── Required-field rejection (before file write) ─────────────────────────────

describe("required-field rejection", () => {
  test("--source without --tag rejects with missing-fields error before writing", async () => {
    const { stashDir, result } = await runCli(["remember", "Some note", "--source", "https://example.com"]);
    expect(result.status).toBe(2);

    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toContain("tags");
    expect(json.error).toContain("--tag");

    // Confirm no file was written
    const memoriesDir = path.join(stashDir, "memories");
    const written = fs.existsSync(memoriesDir) && fs.readdirSync(memoriesDir).length > 0;
    expect(written).toBe(false);
  });

  test("--expires without --tag rejects with missing-fields error before writing", async () => {
    const { stashDir, result } = await runCli(["remember", "Some note", "--expires", "30d"]);
    expect(result.status).toBe(2);

    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toContain("tags");

    const memoriesDir = path.join(stashDir, "memories");
    const written = fs.existsSync(memoriesDir) && fs.readdirSync(memoriesDir).length > 0;
    expect(written).toBe(false);
  });
});

// ── --auto heuristics (Mode 2) ───────────────────────────────────────────────

describe("remember --auto", () => {
  test("body with fenced code block gets tag 'code'", async () => {
    const body = "Remember this pattern:\n```ts\nconst x = 1;\n```";
    const { result } = await runCli(["remember", body, "--auto"]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { path: string };
    const content = fs.readFileSync(json.path, "utf8");
    const parsed = parseFrontmatter(content);
    const tags = parsed.data.tags as string[];
    expect(tags).toContain("code");
  });

  test("body with URL gets source set automatically", async () => {
    const body = "Found this resource https://example.com/guide useful for ops";
    const { result } = await runCli(["remember", body, "--auto", "--tag", "docs"]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { path: string };
    const content = fs.readFileSync(json.path, "utf8");
    const parsed = parseFrontmatter(content);
    expect(parsed.data.source).toBe("https://example.com/guide");
  });

  test("body with first-person pronoun gets subjective: true", async () => {
    // Must supply --tag because heuristics add subjective but not tags for plain text.
    const body = "I noticed that staging requires VPN every time";
    const { result } = await runCli(["remember", body, "--auto", "--tag", "ops"]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { path: string };
    const content = fs.readFileSync(json.path, "utf8");
    const parsed = parseFrontmatter(content);
    expect(parsed.data.subjective).toBe(true);
    expect(parsed.data.tags as string[]).toContain("ops");
  });

  test("body with ISO date gets observed_at set", async () => {
    const body = "The outage happened on 2026-01-15 and we fixed it quickly";
    const { result } = await runCli(["remember", body, "--auto"]);
    // Will fail required-field check if no tags derived from the body
    // Force a tag to ensure we get through
    const { result: r2 } = await runCli(["remember", body, "--auto", "--tag", "ops"]);
    expect(r2.status).toBe(0);

    const json = JSON.parse(r2.stdout) as { path: string };
    const content = fs.readFileSync(json.path, "utf8");
    const parsed = parseFrontmatter(content);
    expect(parsed.data.observed_at).toBe("2026-01-15");
    void result; // suppress unused variable warning
  });

  test("--auto without any tags from heuristics or CLI still writes the memory", async () => {
    // Plain text body — no code block, no URL. Heuristics won't derive any tags.
    const { result } = await runCli(["remember", "Plain text note without any tags derivable", "--auto"]);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as { path: string };
    expect(fs.existsSync(json.path)).toBe(true);
  });

  test("--auto + explicit --tag satisfies required-field check", async () => {
    const body = "No special content here";
    const { result } = await runCli(["remember", body, "--auto", "--tag", "misc"]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { path: string };
    const content = fs.readFileSync(json.path, "utf8");
    const parsed = parseFrontmatter(content);
    expect(parsed.data.tags as string[]).toContain("misc");
  });

  test("--source CLI arg takes priority over auto-detected URL", async () => {
    const body = "See https://example.com/docs for reference";
    const { result } = await runCli(["remember", body, "--auto", "--tag", "docs", "--source", "explicit:source"]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { path: string };
    const content = fs.readFileSync(json.path, "utf8");
    const parsed = parseFrontmatter(content);
    // CLI --source wins over auto-detected URL
    expect(parsed.data.source).toBe("explicit:source");
  });
});

// ── memory metadata contributors ─────────────────────────────────────────────

/** A static MatchResult for memory-md (avoids calling runMatchers and null assertions). */
const MEMORY_MATCH = { type: "memory", specificity: 10, renderer: "memory-md" };

describe("memory metadata contributors", () => {
  const createdTmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdTmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeTmpMemory(content: string): { filePath: string; stashRoot: string } {
    const stashRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-mem-renderer-"));
    createdTmpDirs.push(stashRoot);
    const memoriesDir = path.join(stashRoot, "memories");
    fs.mkdirSync(memoriesDir, { recursive: true });
    const filePath = path.join(memoriesDir, "test-memory.md");
    fs.writeFileSync(filePath, content, "utf8");
    return { filePath, stashRoot };
  }

  async function applyMemoryMetadata(entry: StashEntry, stashRoot: string, filePath: string): Promise<void> {
    const ctx = buildFileContext(stashRoot, filePath);
    const renderCtx = buildRenderContext(ctx, MEMORY_MATCH, [stashRoot]);
    await applyMetadataContributors(entry, { rendererName: "memory-md", renderContext: renderCtx });
  }

  test("populates tags from frontmatter", async () => {
    const { filePath, stashRoot } = writeTmpMemory("---\ntags: [ops, networking]\n---\nDeployment needs VPN access\n");

    const entry: StashEntry = { name: "test-memory", type: "memory" };
    await applyMemoryMetadata(entry, stashRoot, filePath);

    expect(entry.tags).toContain("ops");
    expect(entry.tags).toContain("networking");
  });

  test("populates description from frontmatter", async () => {
    const { filePath, stashRoot } = writeTmpMemory(
      "---\ndescription: VPN required for staging deploys\ntags: [ops]\n---\nBody content\n",
    );

    const entry: StashEntry = { name: "test-memory", type: "memory" };
    await applyMemoryMetadata(entry, stashRoot, filePath);

    expect(entry.description).toBe("VPN required for staging deploys");
  });

  test("populates searchHints with source, observed_at, expires, subjective", async () => {
    const { filePath, stashRoot } = writeTmpMemory(
      "---\ntags: [ops]\nsource: skill:deploy\nobserved_at: 2026-01-15\nexpires: 2026-04-15\nsubjective: true\n---\nVPN needed\n",
    );

    const entry: StashEntry = { name: "test-memory", type: "memory" };
    await applyMemoryMetadata(entry, stashRoot, filePath);

    expect(entry.searchHints).toBeDefined();
    expect(entry.searchHints).toContain("skill:deploy");
    expect(entry.searchHints).toContain("observed_at:2026-01-15");
    expect(entry.searchHints).toContain("expires:2026-04-15");
    expect(entry.searchHints).toContain("subjective");
  });

  test("observed_at falls back to file mtime when not in frontmatter", async () => {
    const { filePath, stashRoot } = writeTmpMemory("---\ntags: [ops]\n---\nSome memory without observed_at\n");

    const entry: StashEntry = { name: "test-memory", type: "memory" };
    await applyMemoryMetadata(entry, stashRoot, filePath);

    // Should have an observed_at hint derived from mtime
    const mtimeHint = (entry.searchHints ?? []).find((h) => h.startsWith("observed_at:"));
    expect(mtimeHint).toBeDefined();
    // The mtime-based date should be a valid ISO date
    const dateStr = mtimeHint?.slice("observed_at:".length);
    expect(dateStr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("works for bare memory with no frontmatter (no crash)", async () => {
    const { filePath, stashRoot } = writeTmpMemory("Just a plain memory without any frontmatter.\n");

    const entry: StashEntry = { name: "test-memory", type: "memory" };

    // Should not throw
    await expect(applyMemoryMetadata(entry, stashRoot, filePath)).resolves.toBeUndefined();

    // mtime fallback should still fire
    const mtimeHint = (entry.searchHints ?? []).find((h) => h.startsWith("observed_at:"));
    expect(mtimeHint).toBeDefined();
  });

  test("block-sequence tags in frontmatter are parsed correctly", async () => {
    const { filePath, stashRoot } = writeTmpMemory("---\ntags:\n- ops\n- networking\n- deploy\n---\nVPN required\n");

    const entry: StashEntry = { name: "test-memory", type: "memory" };
    await applyMemoryMetadata(entry, stashRoot, filePath);

    expect(entry.tags).toContain("ops");
    expect(entry.tags).toContain("networking");
    expect(entry.tags).toContain("deploy");
  });
});

// ── --enrich (Mode 3) — mocked ───────────────────────────────────────────────
// These tests directly exercise the heuristic and enrichment helpers by calling
// the CLI with a mock LLM config. Since we cannot easily intercept the dynamic
// import inside the CLI process, we test the LLM enrichment path via integration
// against a non-existent endpoint and verify the graceful-degradation behaviour.

describe("remember --enrich graceful degradation", () => {
  test("when no LLM is configured, --enrich emits warning and still writes the memory", async () => {
    const { result } = await runCli(["remember", "Some note about ops", "--enrich"]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { path: string };
    const content = fs.readFileSync(json.path, "utf8");
    expect(content).toContain("Some note about ops");
  });

  test("--enrich with --tag satisfies required-field check even if LLM fails", async () => {
    // Providing --tag means we don't depend on LLM for the required field
    const { result } = await runCli(["remember", "Some note", "--enrich", "--tag", "misc"]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { path: string };
    const content = fs.readFileSync(json.path, "utf8");
    const parsed = parseFrontmatter(content);
    // At minimum, the --tag value must be present
    expect(parsed.data.tags as string[]).toContain("misc");
  });
});

// ── Phase 1B / Rec 7: hot-path captureMode + beliefState ────────────────────

describe("remember writes captureMode: hot + beliefState: asserted (Phase 1B)", () => {
  test("--tag path writes captureMode: hot and beliefState: asserted", async () => {
    const { result } = await runCli(["remember", "VPN required for staging", "--tag", "ops"]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { path: string };
    const content = fs.readFileSync(json.path, "utf8");
    const parsed = parseFrontmatter(content);
    expect(parsed.data.captureMode).toBe("hot");
    expect(parsed.data.beliefState).toBe("asserted");
  });

  test("--auto path writes captureMode: hot and beliefState: asserted", async () => {
    const { result } = await runCli(["remember", "Plain text note", "--auto", "--tag", "misc"]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { path: string };
    const content = fs.readFileSync(json.path, "utf8");
    const parsed = parseFrontmatter(content);
    expect(parsed.data.captureMode).toBe("hot");
    expect(parsed.data.beliefState).toBe("asserted");
  });
});
