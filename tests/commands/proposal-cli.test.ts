import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { createProposal, isProposalSkipped } from "../../src/core/proposals";
import { runCliCapture } from "../_helpers/cli";
import { makeSandboxDir, type SandboxedDir, withEnv } from "../_helpers/sandbox";

// Migrated from per-test spawnSync("bun", [cliPath, ...]) to the in-process
// harness (tests/_helpers/cli.ts). Proposals are seeded in-process via
// createProposal() against an isolated stash dir; the CLI then reads that stash
// back through AKM_STASH_DIR. The preload (tests/_preload.ts) sandboxes
// HOME / XDG dirs per test, so runCli only needs to point AKM_STASH_DIR at the
// seeded stash for the duration of the call (via the allowlisted withEnv
// wrapper). The spawn version set cwd: repoRoot, which is already the in-process
// cwd — no chdir needed — so every test migrates cleanly.

const disposers: SandboxedDir[] = [];

function makeTempDir(prefix = "akm-proposal-cli-"): string {
  const d = makeSandboxDir(prefix);
  disposers.push(d);
  return d.dir;
}

function makeStashDir(): string {
  const stash = makeTempDir("akm-proposal-cli-stash-");
  for (const sub of ["lessons", "skills", "memories", "knowledge"]) {
    fs.mkdirSync(path.join(stash, sub), { recursive: true });
  }
  return stash;
}

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

async function runCli(
  args: string[],
  options: { stashDir: string; env?: Record<string, string | undefined> } = { stashDir: "" },
): Promise<{ stdout: string; stderr: string; status: number }> {
  const { code, stdout, stderr } = await withEnv({ AKM_STASH_DIR: options.stashDir || undefined, ...options.env }, () =>
    runCliCapture(args),
  );
  return { stdout, stderr, status: code };
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
  test("happy path: lists pending proposal as JSON with totalCount", async () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);
    const result = await runCli(["proposals", "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.totalCount).toBe(1);
    expect(Array.isArray(parsed.proposals)).toBe(true);
    expect(parsed.proposals[0].id).toBe(created.id);
  });

  test("supports --ref filtering", async () => {
    const stash = makeStashDir();
    seedProposal(stash, "lesson:rg-over-grep");
    seedProposal(stash, "lesson:docker-cleanup");
    const result = await runCli(["proposals", "--ref", "lesson:docker-cleanup", "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.totalCount).toBe(1);
    expect(parsed.proposals[0].ref).toBe("lesson:docker-cleanup");
  });

  test("error path: invalid --status value → UsageError exit 2 with code", async () => {
    const stash = makeStashDir();
    seedProposal(stash);
    const result = await runCli(["proposals", "--status=bogus", "--format=json"], { stashDir: stash });
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.code).toBe("INVALID_FLAG_VALUE");
  });

  test("accepts --status=reverted (parser allows reverted status)", async () => {
    // Regression: parseProposalStatus must accept "reverted" so that
    // `akm proposal list --status reverted` works for archived/reverted proposals.
    const stash = makeStashDir();
    seedProposal(stash);
    const result = await runCli(["proposals", "--status=reverted", "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    // No proposals have been reverted in this fixture, so the list is empty.
    expect(parsed.totalCount).toBe(0);
    expect(Array.isArray(parsed.proposals)).toBe(true);
  });
});

describe("akm show proposal (CLI)", () => {
  test("happy path: returns proposal + validation report", async () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);
    const result = await runCli(["show", "proposal", created.id, "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.proposal.id).toBe(created.id);
    expect(parsed.validation.ok).toBe(true);
  });
});

describe("akm accept / reject / diff proposal (CLI)", () => {
  test("accept materialises asset on disk and exits 0", async () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);
    const result = await runCli(["accept", created.id, "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(fs.existsSync(parsed.assetPath as string)).toBe(true);
  });

  test("reject requires --reason", async () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);
    const result = await runCli(["reject", created.id, "--format=json"], { stashDir: stash });
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.code).toBe("MISSING_REQUIRED_ARGUMENT");
  });

  test("reject archives proposal with reason", async () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);
    // --yes is required in non-interactive mode since WS-6 added confirmation prompts.
    const result = await runCli(["reject", created.id, "--reason", "duplicate", "--yes", "--format=json"], {
      stashDir: stash,
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.reason).toBe("duplicate");
    const list = await runCli(["proposals", "--format=json"], { stashDir: stash });
    expect(JSON.parse(list.stdout).totalCount).toBe(0);
  });

  test("diff proposal shows a unified diff", async () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);
    const result = await runCli(["diff", created.id, "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.id).toBe(created.id);
    expect(parsed.unified).toContain("/dev/null");
  });

  test("single-id accept is NOT guarded (revertable) — proceeds without --yes", async () => {
    // WS0: the bulk-accept guard must not leak onto the single-id path.
    const stash = makeStashDir();
    const created = seedProposal(stash);
    const result = await runCli(["accept", created.id, "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
  });
});

describe("akm accept --source bulk safety guard (WS0)", () => {
  test("bulk accept without --yes aborts in non-interactive mode (exit 2)", async () => {
    const stash = makeStashDir();
    seedProposal(stash);
    const result = await runCli(["accept", "--source", "reflect", "--format=json"], { stashDir: stash });
    // confirmDestructive throws NON_INTERACTIVE_REQUIRES_YES (UsageError → exit 2)
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.code).toBe("NON_INTERACTIVE_REQUIRES_YES");
    // Proposal must NOT have been promoted.
    const list = await runCli(["proposals", "--format=json"], { stashDir: stash });
    expect(JSON.parse(list.stdout).totalCount).toBe(1);
  });

  test("bulk accept with --yes proceeds and promotes matching proposals", async () => {
    const stash = makeStashDir();
    seedProposal(stash);
    const result = await runCli(["accept", "--source", "reflect", "--yes", "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.accepted).toBe(1);
    expect(parsed.dryRun).toBe(false);
    const list = await runCli(["proposals", "--format=json"], { stashDir: stash });
    expect(JSON.parse(list.stdout).totalCount).toBe(0);
  });

  test("bulk accept --dry-run auto-passes the guard (no --yes needed)", async () => {
    const stash = makeStashDir();
    seedProposal(stash);
    const result = await runCli(["accept", "--source", "reflect", "--dry-run", "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.dryRun).toBe(true);
    // Nothing promoted — proposal still pending.
    const list = await runCli(["proposals", "--format=json"], { stashDir: stash });
    expect(JSON.parse(list.stdout).totalCount).toBe(1);
  });
});

describe("akm propose (CLI)", () => {
  test("--task and --file are mutually exclusive", async () => {
    const stash = makeStashDir();
    const promptFile = path.join(makeTempDir("akm-proposal-prompt-"), "prompt.md");
    fs.writeFileSync(promptFile, "author a lesson", "utf8");
    const result = await runCli(
      ["propose", "lesson", "rg-over-grep", "--task", "inline", "--file", promptFile, "--format=json"],
      { stashDir: stash },
    );
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.code).toBe("INVALID_FLAG_VALUE");
  });
});
