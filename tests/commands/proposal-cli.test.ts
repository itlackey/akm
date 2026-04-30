/**
 * End-to-end CLI integration tests for `akm proposal {list,show,accept,reject,diff}`.
 *
 * Exercises the citty dispatcher as a real subprocess so:
 *   - flag parsing,
 *   - exit-code mapping (UsageError → 2, NotFoundError → 1, success → 0),
 *   - JSON envelope shape,
 * are all covered end-to-end. A pre-built stash directory (created via the
 * direct `createProposal` helper) seeds the proposal queue so each subcommand
 * has a deterministic id to act on.
 *
 * Backfill for issue #284 GAP-CRIT 1.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createProposal } from "../../src/core/proposals";

const tempDirs: string[] = [];

function makeTempDir(prefix = "akm-proposal-cli-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStashDir(): string {
  const stash = makeTempDir("akm-proposal-cli-stash-");
  for (const sub of ["lessons", "skills", "memories", "knowledge"]) {
    fs.mkdirSync(path.join(stash, sub), { recursive: true });
  }
  return stash;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function runCli(
  args: string[],
  options: { stashDir: string; env?: Record<string, string | undefined> } = { stashDir: "" },
): { stdout: string; stderr: string; status: number } {
  const xdgCache = makeTempDir("akm-proposal-cli-cache-");
  const xdgConfig = makeTempDir("akm-proposal-cli-config-");
  const home = makeTempDir("akm-proposal-cli-home-");
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    cwd: repoRoot,
    env: {
      ...process.env,
      AKM_STASH_DIR: options.stashDir || undefined,
      HOME: home,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      ...options.env,
    },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  };
}

const VALID_LESSON = `---\ndescription: Use ripgrep before grep\nwhen_to_use: Searching large repos\n---\n\nPrefer rg.\n`;

function seedProposal(stash: string, ref = "lesson:rg-over-grep") {
  return createProposal(stash, {
    ref,
    source: "reflect",
    payload: { content: VALID_LESSON },
  });
}

beforeEach(() => {
  // (Each test creates its own stash dir so we get fresh state.)
});

describe("akm proposal list (CLI)", () => {
  test("happy path: lists pending proposal as JSON with totalCount", () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);
    const result = runCli(["proposal", "list", "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.totalCount).toBe(1);
    expect(Array.isArray(parsed.proposals)).toBe(true);
    expect(parsed.proposals[0].id).toBe(created.id);
    expect(parsed.proposals[0].ref).toBe("lesson:rg-over-grep");
    expect(parsed.proposals[0].status).toBe("pending");
  });

  test("error path: invalid --status value → UsageError exit 2 with code", () => {
    const stash = makeStashDir();
    seedProposal(stash);
    const result = runCli(["proposal", "list", "--status=bogus", "--format=json"], { stashDir: stash });
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("INVALID_FLAG_VALUE");
    expect(envelope.error).toContain("Invalid --status value");
  });
});

describe("akm proposal show (CLI)", () => {
  test("happy path: returns proposal + validation report", () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);
    const result = runCli(["proposal", "show", created.id, "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.proposal).toBeDefined();
    expect(parsed.proposal.id).toBe(created.id);
    expect(parsed.proposal.ref).toBe("lesson:rg-over-grep");
    expect(parsed.validation).toBeDefined();
    expect(parsed.validation.ok).toBe(true);
  });

  test("error path: missing id → NotFoundError, exit 1", () => {
    const stash = makeStashDir();
    const result = runCli(["proposal", "show", "00000000-dead-beef-0000-000000000000", "--format=json"], {
      stashDir: stash,
    });
    expect(result.status).toBe(1);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("FILE_NOT_FOUND");
    expect(envelope.error).toContain("00000000-dead-beef-0000-000000000000");
  });
});

describe("akm proposal accept (CLI)", () => {
  test("happy path: materialises asset on disk and exits 0", () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);
    const result = runCli(["proposal", "accept", created.id, "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.id).toBe(created.id);
    expect(parsed.ref).toBe("lesson:rg-over-grep");
    expect(parsed.assetPath).toBeDefined();
    expect(fs.existsSync(parsed.assetPath as string)).toBe(true);
  });

  test("error path: missing id → NotFoundError exit 1", () => {
    const stash = makeStashDir();
    const result = runCli(["proposal", "accept", "11111111-dead-beef-0000-000000000000", "--format=json"], {
      stashDir: stash,
    });
    expect(result.status).toBe(1);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("FILE_NOT_FOUND");
  });
});

describe("akm proposal reject (CLI)", () => {
  test("happy path: archives proposal with reason, exit 0", () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);
    const result = runCli(["proposal", "reject", created.id, "--reason", "duplicate", "--format=json"], {
      stashDir: stash,
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.reason).toBe("duplicate");
    // Live queue should now be empty.
    const list = runCli(["proposal", "list", "--format=json"], { stashDir: stash });
    expect(JSON.parse(list.stdout).totalCount).toBe(0);
  });

  test("error path: rejecting a non-pending proposal → UsageError INVALID_FLAG_VALUE, exit 2", () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);
    // Reject once → archive.
    const first = runCli(["proposal", "reject", created.id, "--format=json"], { stashDir: stash });
    expect(first.status).toBe(0);
    // Reject again → must surface UsageError because it's no longer pending.
    const second = runCli(["proposal", "reject", created.id, "--format=json"], { stashDir: stash });
    expect(second.status).toBe(2);
    const envelope = JSON.parse(second.stderr);
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("INVALID_FLAG_VALUE");
    expect(envelope.error).toMatch(/not pending|already/i);
  });

  test("error path: missing id → NotFoundError exit 1", () => {
    const stash = makeStashDir();
    const result = runCli(["proposal", "reject", "22222222-dead-beef-0000-000000000000", "--format=json"], {
      stashDir: stash,
    });
    expect(result.status).toBe(1);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.code).toBe("FILE_NOT_FOUND");
  });
});

describe("akm proposal diff (CLI)", () => {
  test("happy path: new asset diff contains /dev/null marker", () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);
    const result = runCli(["proposal", "diff", created.id, "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.id).toBe(created.id);
    expect(parsed.ref).toBe("lesson:rg-over-grep");
    expect(parsed.isNew).toBe(true);
    expect(parsed.unified).toContain("/dev/null");
    expect(parsed.unified).toContain("Prefer rg");
  });

  test("error path: missing id → NotFoundError exit 1", () => {
    const stash = makeStashDir();
    const result = runCli(["proposal", "diff", "33333333-dead-beef-0000-000000000000", "--format=json"], {
      stashDir: stash,
    });
    expect(result.status).toBe(1);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("FILE_NOT_FOUND");
  });
});
