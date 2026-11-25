import { afterEach, describe, expect, test } from "bun:test";
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

function worker(args: string[], env: NodeJS.ProcessEnv = process.env): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([process.execPath, WORKER, ...args], { env, stdout: "pipe", stderr: "pipe" });
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
      AKM_CONFIG_DIR: config,
    });
    await Bun.sleep(250);
    expect(fs.existsSync(path.join(stash, "workflows", "leased.md"))).toBe(false);

    releaseHolder();
    await holder;
    await assertExited(child);
    expect(fs.existsSync(path.join(stash, "workflows", "leased.md"))).toBe(true);
  });
});
