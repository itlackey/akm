import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createProposal, isProposalSkipped } from "../../src/core/proposals";

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
  const result = createProposal(stash, {
    ref,
    source: "reflect",
    force: true,
    payload: { content: VALID_LESSON },
  });
  if (isProposalSkipped(result)) throw new Error("unexpected skip in seedProposal");
  return result;
}

describe("akm proposals (CLI)", () => {
  test("happy path: lists pending proposal as JSON with totalCount", () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);
    const result = runCli(["proposals", "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.totalCount).toBe(1);
    expect(Array.isArray(parsed.proposals)).toBe(true);
    expect(parsed.proposals[0].id).toBe(created.id);
  });

  test("supports --ref filtering", () => {
    const stash = makeStashDir();
    seedProposal(stash, "lesson:rg-over-grep");
    seedProposal(stash, "lesson:docker-cleanup");
    const result = runCli(["proposals", "--ref", "lesson:docker-cleanup", "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.totalCount).toBe(1);
    expect(parsed.proposals[0].ref).toBe("lesson:docker-cleanup");
  });

  test("error path: invalid --status value → UsageError exit 2 with code", () => {
    const stash = makeStashDir();
    seedProposal(stash);
    const result = runCli(["proposals", "--status=bogus", "--format=json"], { stashDir: stash });
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.code).toBe("INVALID_FLAG_VALUE");
  });
});

describe("akm show proposal (CLI)", () => {
  test("happy path: returns proposal + validation report", () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);
    const result = runCli(["show", "proposal", created.id, "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.proposal.id).toBe(created.id);
    expect(parsed.validation.ok).toBe(true);
  });
});

describe("akm accept / reject / diff proposal (CLI)", () => {
  test("accept materialises asset on disk and exits 0", () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);
    const result = runCli(["accept", created.id, "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(fs.existsSync(parsed.assetPath as string)).toBe(true);
  });

  test("reject requires --reason", () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);
    const result = runCli(["reject", created.id, "--format=json"], { stashDir: stash });
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.code).toBe("MISSING_REQUIRED_ARGUMENT");
  });

  test("reject archives proposal with reason", () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);
    const result = runCli(["reject", created.id, "--reason", "duplicate", "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.reason).toBe("duplicate");
    const list = runCli(["proposals", "--format=json"], { stashDir: stash });
    expect(JSON.parse(list.stdout).totalCount).toBe(0);
  });

  test("diff proposal shows a unified diff", () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);
    const result = runCli(["diff", created.id, "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.id).toBe(created.id);
    expect(parsed.unified).toContain("/dev/null");
  });
});

describe("akm propose (CLI)", () => {
  test("--task and --file are mutually exclusive", () => {
    const stash = makeStashDir();
    const promptFile = path.join(makeTempDir("akm-proposal-prompt-"), "prompt.md");
    fs.writeFileSync(promptFile, "author a lesson", "utf8");
    const result = runCli(
      ["propose", "lesson", "rg-over-grep", "--task", "inline", "--file", promptFile, "--format=json"],
      { stashDir: stash },
    );
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.code).toBe("INVALID_FLAG_VALUE");
  });
});
