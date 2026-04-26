import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDbPath } from "../../src/core/paths";
import { closeDatabase, openDatabase } from "../../src/indexer/db";
import { akmIndex } from "../../src/indexer/indexer";

let testConfigDir = "";
let testCacheDir = "";
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

beforeEach(() => {
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-wf-idx-config-"));
  testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-wf-idx-cache-"));
  process.env.XDG_CONFIG_HOME = testConfigDir;
  process.env.XDG_CACHE_HOME = testCacheDir;

  const dbPath = getDbPath();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
});

afterEach(() => {
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (testConfigDir) {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
    testConfigDir = "";
  }
  if (testCacheDir) {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
    testCacheDir = "";
  }
});

function tmpStash(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-wf-idx-"));
  fs.mkdirSync(path.join(dir, "workflows"), { recursive: true });
  return dir;
}

function writeWorkflow(stashDir: string, name: string, content: string): string {
  const file = path.join(stashDir, "workflows", `${name}.md`);
  fs.writeFileSync(file, content);
  return file;
}

const VALID_WORKFLOW = `# Workflow: Ship Release

## Step: Validate
Step ID: validate

### Instructions
Confirm release notes are present.
`;

const BROKEN_WORKFLOW = `# Workflow: Bad

## Step: First
Step ID: first
### Instructions
do A

## Step: Second
Step ID: first
### Instructions
do B
`;

test("indexer admits valid workflows and writes their JSON to workflow_documents", async () => {
  const stashDir = tmpStash();
  writeWorkflow(stashDir, "good", VALID_WORKFLOW);

  const result = await akmIndex({ stashDir, full: true });
  expect(result.totalEntries).toBe(1);

  const db = openDatabase();
  try {
    const row = db
      .prepare(
        `SELECT wd.document_json, wd.schema_version, wd.source_path
           FROM workflow_documents wd
           JOIN entries e ON e.id = wd.entry_id
          WHERE e.entry_type = 'workflow' AND e.entry_key LIKE ?`,
      )
      .get(`${stashDir}:workflow:%`) as
      | { document_json: string; schema_version: number; source_path: string }
      | undefined;
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.schema_version).toBe(1);
    expect(row.source_path).toContain("good.md");
    const doc = JSON.parse(row.document_json);
    expect(doc.title).toBe("Ship Release");
    expect(doc.steps).toHaveLength(1);
    expect(doc.steps[0].instructions.text).toContain("Confirm release notes");
    expect(doc.steps[0].source.start).toBeGreaterThan(0);
  } finally {
    closeDatabase(db);
  }
});

test("indexer rejects broken workflows and surfaces every error in IndexResponse.warnings", async () => {
  const stashDir = tmpStash();
  writeWorkflow(stashDir, "good", VALID_WORKFLOW);
  const brokenPath = writeWorkflow(stashDir, "bad", BROKEN_WORKFLOW);

  const result = await akmIndex({ stashDir, full: true });
  expect(result.totalEntries).toBe(1); // only the good one
  expect(result.warnings ?? []).toBeDefined();

  const warnings = result.warnings ?? [];
  // The broken workflow has a duplicate step ID; the warning string must
  // mention the file and at least one of its errors.
  const brokenWarning = warnings.find((w) => w.includes(brokenPath));
  expect(brokenWarning).toBeDefined();
  expect(brokenWarning).toMatch(/already used|Step ID/);

  const db = openDatabase();
  try {
    const goodRow = db
      .prepare(
        `SELECT 1 FROM workflow_documents wd
           JOIN entries e ON e.id = wd.entry_id
          WHERE e.entry_key = ?`,
      )
      .get(`${stashDir}:workflow:good`);
    expect(goodRow).toBeDefined();

    const badRow = db
      .prepare(
        `SELECT 1 FROM workflow_documents wd
           JOIN entries e ON e.id = wd.entry_id
          WHERE e.entry_key = ?`,
      )
      .get(`${stashDir}:workflow:bad`);
    expect(badRow).toBeFalsy();
  } finally {
    closeDatabase(db);
  }
});
