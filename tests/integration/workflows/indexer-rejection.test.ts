import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getDbPath } from "../../../src/core/paths";
import { resetQuiet, resetVerbose, setVerbose } from "../../../src/core/warn";
import { akmIndex } from "../../../src/indexer/indexer";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { type Cleanup, makeSandboxDir, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../../_helpers/sandbox";

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  envCleanup = cfgResult.cleanup;

  const dbPath = getDbPath();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  // Defensive: other test files may have left the warn module's quiet/verbose
  // latches on. Reset both before each test so the noise-gate assertions read
  // a clean state.
  resetQuiet();
  resetVerbose();
  delete process.env.AKM_VERBOSE;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  resetVerbose();
  delete process.env.AKM_VERBOSE;
});

function tmpStash(): string {
  const dir = makeSandboxDir("akm-wf-idx").dir;
  fs.mkdirSync(path.join(dir, "workflows"), { recursive: true });
  return dir;
}

function writeWorkflow(stashDir: string, name: string, content: string): string {
  const file = path.join(stashDir, "workflows", `${name}.md`);
  fs.writeFileSync(file, content);
  return file;
}

// Unified-format fixtures (frontmatter graph + `## <id>` body — spec §2.2).
const VALID_WORKFLOW = `---
type: workflow
description: Ship Release
steps:
  - id: validate
---

## validate

Confirm release notes are present.
`;

const BROKEN_WORKFLOW = `---
type: workflow
description: Bad
steps:
  - id: first
  - id: first
---

## first

do A
`;

test("indexer admits a valid workflow through the shared source compiler", async () => {
  const stashDir = tmpStash();
  const goodPath = writeWorkflow(stashDir, "good", VALID_WORKFLOW);

  const result = await akmIndex({ stashDir, full: true });
  expect(result.totalEntries).toBe(1);

  const db = openIndexDatabase();
  try {
    const row = db.prepare("SELECT file_path FROM entries WHERE type = 'workflow' AND file_path = ?").get(goodPath) as
      | { file_path: string }
      | undefined;
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.file_path).toContain("good.md");
  } finally {
    closeDatabase(db);
  }
});

test("indexer rejects broken workflows and surfaces every error in IndexResponse.warnings", async () => {
  const stashDir = tmpStash();
  const goodPath = writeWorkflow(stashDir, "good", VALID_WORKFLOW);
  const brokenPath = writeWorkflow(stashDir, "bad", BROKEN_WORKFLOW);

  // Use captureStderr to prevent the noise-gate summary warn() from leaking
  // to the test runner output. This test only cares about result.warnings.
  const { result } = await captureStderr(() => akmIndex({ stashDir, full: true }));
  expect(result.totalEntries).toBe(1); // only the good one
  expect(result.warnings ?? []).toBeDefined();

  const warnings = result.warnings ?? [];
  // The broken workflow has a duplicate step ID; the warning string must
  // mention the file and at least one of its errors.
  const brokenWarning = warnings.find((w) => w.includes(brokenPath));
  expect(brokenWarning).toBeDefined();
  expect(brokenWarning).toMatch(/Duplicate step id/);

  const db = openIndexDatabase();
  try {
    const goodRow = db.prepare("SELECT 1 FROM entries WHERE file_path = ?").get(goodPath);
    expect(goodRow).toBeDefined();

    const badRow = db.prepare("SELECT 1 FROM entries WHERE file_path = ?").get(brokenPath);
    expect(badRow).toBeFalsy();
  } finally {
    closeDatabase(db);
  }
});

// ── Workflow validation noise gate (issue #273) ─────────────────────────────

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const originalWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.warn = originalWarn;
  }
}

test("default verbosity emits one summary line, not per-spec workflow warnings", async () => {
  const stashDir = tmpStash();
  // Two broken workflows so we can prove the summary line is emitted instead
  // of two separate per-spec warnings on stderr.
  writeWorkflow(stashDir, "bad1", BROKEN_WORKFLOW);
  writeWorkflow(stashDir, "bad2", BROKEN_WORKFLOW);

  const { lines } = await captureStderr(() => akmIndex({ stashDir, full: true }));

  const perSpec = lines.filter((l) => l.startsWith("Skipped workflow "));
  expect(perSpec).toHaveLength(0);

  const summary = lines.filter((l) => l.includes("workflow specs skipped due to validation errors"));
  expect(summary).toHaveLength(1);
  expect(summary[0]).toMatch(/^2 workflow specs skipped/);
  expect(summary[0]).toContain("--verbose");
  expect(summary[0]).toContain("AKM_VERBOSE");
});

test("default verbosity uses singular 'workflow spec' when only one was skipped", async () => {
  const stashDir = tmpStash();
  writeWorkflow(stashDir, "bad", BROKEN_WORKFLOW);

  const { lines } = await captureStderr(() => akmIndex({ stashDir, full: true }));

  const summary = lines.filter((l) => l.includes("workflow spec skipped"));
  expect(summary).toHaveLength(1);
  expect(summary[0]).toMatch(/^1 workflow spec skipped/);
});

test("--verbose flag restores per-spec workflow warnings and suppresses the summary", async () => {
  const stashDir = tmpStash();
  writeWorkflow(stashDir, "bad1", BROKEN_WORKFLOW);
  writeWorkflow(stashDir, "bad2", BROKEN_WORKFLOW);

  setVerbose(true);
  const { lines } = await captureStderr(() => akmIndex({ stashDir, full: true }));

  const perSpec = lines.filter((l) => l.startsWith("Skipped workflow "));
  expect(perSpec).toHaveLength(2);
  const summary = lines.filter((l) => l.includes("workflow specs skipped due to validation errors"));
  expect(summary).toHaveLength(0);
});

test("AKM_VERBOSE=1 restores per-spec output even with the verbose flag unset", async () => {
  const stashDir = tmpStash();
  writeWorkflow(stashDir, "bad", BROKEN_WORKFLOW);

  process.env.AKM_VERBOSE = "1";
  const { lines } = await captureStderr(() => akmIndex({ stashDir, full: true }));

  const perSpec = lines.filter((l) => l.startsWith("Skipped workflow "));
  expect(perSpec).toHaveLength(1);
  const summary = lines.filter((l) => l.includes("workflow spec skipped"));
  expect(summary).toHaveLength(0);
});

test("AKM_VERBOSE=0 hard-disables verbose output even when --verbose flag was set", async () => {
  const stashDir = tmpStash();
  writeWorkflow(stashDir, "bad", BROKEN_WORKFLOW);

  setVerbose(true);
  process.env.AKM_VERBOSE = "0";
  const { lines } = await captureStderr(() => akmIndex({ stashDir, full: true }));

  const perSpec = lines.filter((l) => l.startsWith("Skipped workflow "));
  expect(perSpec).toHaveLength(0);
  const summary = lines.filter((l) => l.includes("workflow spec skipped"));
  expect(summary).toHaveLength(1);
});
