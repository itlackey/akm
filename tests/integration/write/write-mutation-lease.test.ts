import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withAssetMutationLease } from "../../../src/indexer/index-writer-lock";

const WORKER = path.resolve(import.meta.dir, "../../fixtures/write-mutation-lease-worker.ts");
const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(repo: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function worker(args: string[], env: NodeJS.ProcessEnv = process.env): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([process.execPath, WORKER, ...args], { env, stdout: "pipe", stderr: "pipe" });
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await Bun.sleep(10);
  }
}

async function assertExited(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  const code = await proc.exited;
  if (code !== 0) {
    const message = proc.stderr instanceof ReadableStream ? await new Response(proc.stderr).text() : `exit ${code}`;
    throw new Error(message);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("write mutation lease", () => {
  test("two processes cannot both preflight before the first snapshots and commits its bytes", async () => {
    const repo = tempRoot("akm-write-lease-repo-");
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "test@akm.local"]);
    git(repo, ["config", "user.name", "akm test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "seed\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "seed"]);
    const enteredA = path.join(repo, "entered-a");
    const enteredB = path.join(repo, "entered-b");
    const readyA = path.join(repo, "ready-a");
    const readyB = path.join(repo, "ready-b");
    const releaseA = path.join(repo, "release-a");
    const releaseB = path.join(repo, "release-b");
    fs.writeFileSync(releaseB, "release");

    const first = worker(["helper", repo, "first\n", enteredA, releaseA, readyA]);
    await waitForFile(readyA);
    await waitForFile(enteredA);
    const second = worker(["helper", repo, "second\n", enteredB, releaseB, readyB]);
    await waitForFile(readyB);
    await Bun.sleep(150);
    expect(fs.existsSync(enteredB)).toBe(false);

    fs.writeFileSync(releaseA, "release");
    await assertExited(first);
    await assertExited(second);

    expect(git(repo, ["show", "HEAD^:workflows/shared.md"])).toBe("first");
    expect(git(repo, ["show", "HEAD:workflows/shared.md"])).toBe("second");
  });

  test("workflow authoring waits for the shared asset mutation lease", async () => {
    const stash = tempRoot("akm-workflow-lease-stash-");
    const config = tempRoot("akm-workflow-lease-config-");
    let releaseHolder: () => void = () => {};
    let markAcquired: () => void = () => {};
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = withAssetMutationLease("test-holder", async () => {
      markAcquired();
      await release;
    });
    await acquired;

    const child = worker(["workflow", stash, "# Workflow: Leased\n\n## Step: One\nDo it.\n", "-", "-"], {
      ...process.env,
      AKM_BUNDLE_DIR: stash,
      XDG_CONFIG_HOME: config,
    });
    await Bun.sleep(250);
    expect(fs.existsSync(path.join(stash, "workflows", "leased.md"))).toBe(false);

    releaseHolder();
    await holder;
    await assertExited(child);
    expect(fs.existsSync(path.join(stash, "workflows", "leased.md"))).toBe(true);
  });
});
