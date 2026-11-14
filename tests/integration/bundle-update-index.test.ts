// INTEGRATION TEST — real Git processes against local repositories standing in for the upstreams of managed
// git bundles (the https URLs are mapped to them by a process-scoped Git insteadOf rule; no network).

/**
 * `akm bundle update` reindexes incrementally, and a writable install whose checkout is already at the fetched
 * commit builds nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getDbPath } from "../../src/core/paths";
import { getStateDbPath, openStateDatabase } from "../../src/core/state-db";
import { readLockfile } from "../../src/integrations/lockfile";
import { closeDatabase, openReadonlyExistingDatabase } from "../../src/storage/repositories/index-connection";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage, withTTY } from "../_helpers/sandbox";

const NAMES = ["big", "small", "wr"] as const;
type Name = (typeof NAMES)[number];
// big and small are read-only installs reached through a Git insteadOf rule. A writable checkout compares its
// origin with the ref, and `git remote get-url` applies insteadOf, so wr is served by a loopback git daemon instead.
let wrUrl = "";
let daemon: ReturnType<typeof Bun.spawn> | undefined;
const url = (name: Name) => (name === "wr" ? wrUrl : `https://git.example.test/acme/${name}.git`);

let storage: IsolatedAkmStorage;
let remotes: Record<Name, string>;
let env: Record<string, string>;

function git(args: string[], cwd?: string): string {
  const result = spawnSync("git", cwd ? ["-C", cwd, ...args] : args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function write(name: Name, file: string, description: string): void {
  const full = path.join(remotes[name], "knowledge", file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `---\ndescription: ${description}\n---\n\n# ${description}\n`);
}

function commit(name: Name, message: string): void {
  git(["add", "-A"], remotes[name]);
  git(["commit", "-m", message], remotes[name]);
}

/** The fields of `bundle update --format=json` these tests read; other commands' output is ignored. */
interface UpdateJson {
  processed: Array<{ changed: { any: boolean } }>;
  index: { mode: string; directoriesScanned: number; directoriesSkipped: number };
}

async function akm(...args: string[]): Promise<UpdateJson> {
  const result = await withEnv(env, () => withTTY(false, () => runCliCapture([...args, "--format=json"])), 120_000);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function indexRuns(): Array<{ mode: string; totalEntries: number }> {
  const db = openStateDatabase(getStateDbPath());
  try {
    return (
      db.prepare("SELECT metadata_json FROM events WHERE event_type = 'index_completed' ORDER BY id").all() as Array<{
        metadata_json: string;
      }>
    ).map((row) => JSON.parse(row.metadata_json));
  } finally {
    db.close();
  }
}

/** The indexed entries of one bundle: file path (relative to its bundle root marker) and description. */
function entries(bundleId: string): Array<{ file: string; description: string }> {
  const db = openReadonlyExistingDatabase(getDbPath());
  if (!db) return [];
  try {
    return (
      db
        .prepare("SELECT file_path, document_json FROM entries WHERE bundle_id = ? ORDER BY file_path")
        .all(bundleId) as Array<{
        file_path: string;
        document_json: string;
      }>
    ).map((row) => ({ file: path.basename(row.file_path), description: JSON.parse(row.document_json).description }));
  } finally {
    closeDatabase(db);
  }
}

const lock = (id: string) => readLockfile().find((entry) => entry.id === id);

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  remotes = {} as Record<Name, string>;
  env = { GIT_ALLOW_PROTOCOL: "file:git", GIT_CONFIG_COUNT: "2" };
  NAMES.forEach((name, i) => {
    const dir = path.join(storage.root, `remote-${name}`);
    remotes[name] = dir;
    fs.mkdirSync(dir, { recursive: true });
    git(["init", "--initial-branch=main", dir]);
    git(["config", "user.name", "AKM Test"], dir);
    git(["config", "user.email", "akm@example.test"], dir);
    git(["config", "commit.gpgsign", "false"], dir);
    if (name === "wr") return;
    env[`GIT_CONFIG_KEY_${i}`] = `url.${pathToFileURL(dir).href}.insteadOf`;
    env[`GIT_CONFIG_VALUE_${i}`] = url(name);
  });
  // The daemon must be a separate process: akm's synchronous git calls would deadlock an in-process server.
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  wrUrl = `git://127.0.0.1:${port}/remote-wr`;
  daemon = Bun.spawn(
    [
      "git",
      "daemon",
      "--reuseaddr",
      "--listen=127.0.0.1",
      `--port=${port}`,
      `--base-path=${storage.root}`,
      "--export-all",
      storage.root,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );

  for (let i = 0; i < 20; i++) write("big", `big-${i}.md`, `big note ${i}`);
  commit("big", "big");
  write("small", "keep.md", "keep");
  write("small", "edit.md", "edit v1");
  write("small", "gone.md", "gone");
  write("small", "before-rename.md", "rename me");
  commit("small", "small v1");
  write("wr", "note.md", "writable note");
  commit("wr", "wr v1");
  for (let attempt = 0; attempt < 50 && spawnSync("git", ["ls-remote", wrUrl]).status !== 0; attempt++)
    Bun.sleepSync(100);
  await akm("bundle", "add", `git+${url("big")}`, "--name", "big");
  await akm("bundle", "add", `git+${url("small")}`, "--name", "small");
  await akm("bundle", "add", `git+${url("wr")}`, "--name", "wr", "--writable");
  await akm("index");
});

afterEach(() => {
  daemon?.kill();
  storage.cleanup();
});

describe("akm bundle update reindexes incrementally", () => {
  test("a changed, added, deleted and renamed file are all indexed, without a full rebuild", async () => {
    expect(entries("small").map((e) => e.file)).toEqual(["before-rename.md", "edit.md", "gone.md", "keep.md"]);
    const runsBefore = indexRuns().length;

    write("small", "edit.md", "edit v2");
    write("small", "added.md", "added");
    fs.rmSync(path.join(remotes.small, "knowledge", "gone.md"));
    git(["mv", "knowledge/before-rename.md", "knowledge/after-rename.md"], remotes.small);
    commit("small", "small v2");

    const result = await akm("bundle", "update", "small");

    expect(result.index.mode).toBe("incremental");
    const runs = indexRuns();
    expect(runs.length).toBe(runsBefore + 1);
    expect(runs.at(-1)?.mode).toBe("incremental");
    expect(entries("small")).toEqual([
      { file: "added.md", description: "added" },
      { file: "after-rename.md", description: "rename me" },
      { file: "edit.md", description: "edit v2" },
      { file: "keep.md", description: "keep" },
    ]);
  });

  test("updating one bundle does not rescan another", async () => {
    write("small", "edit.md", "edit v2");
    commit("small", "small v2");

    const result = await akm("bundle", "update", "small");

    // The 20-file big bundle sits in one directory, which the incremental run skips; a full run scans it.
    expect(result.index.directoriesSkipped).toBeGreaterThanOrEqual(1);
    expect(result.index.directoriesScanned).toBeLessThanOrEqual(result.index.directoriesSkipped);
    expect(entries("big")).toHaveLength(20);
  });
});

describe("akm bundle update on a writable install that brought nothing", () => {
  test("builds nothing and leaves the index and the lock alone", async () => {
    const runsBefore = indexRuns();
    const lockBefore = lock("wr");

    const result = await akm("bundle", "update", "wr");

    expect(result.processed[0]?.changed.any).toBe(false);
    expect(result.index.directoriesScanned).toBe(0);
    expect(indexRuns()).toEqual(runsBefore);
    expect(lock("wr")).toEqual(lockBefore);
  });

  test("an upstream change still builds and is indexed", async () => {
    const runsBefore = indexRuns().length;
    write("wr", "second.md", "second");
    commit("wr", "wr v2");

    const result = await akm("bundle", "update", "wr");

    expect(result.processed[0]?.changed.any).toBe(true);
    expect(indexRuns().length).toBe(runsBefore + 1);
    expect(entries("wr").map((e) => e.file)).toContain("second.md");
  });

  test("--force still builds", async () => {
    const runsBefore = indexRuns().length;

    await akm("bundle", "update", "wr", "--force");

    expect(indexRuns().length).toBe(runsBefore + 1);
  });

  test("a local unpublished edit is not indexed by the update; the next index run picks it up", async () => {
    const checkout = lock("wr")?.localRoot as string;
    fs.writeFileSync(path.join(checkout, "knowledge", "local.md"), "---\ndescription: local edit\n---\n\n# local\n");
    const runsBefore = indexRuns().length;

    const result = await akm("bundle", "update", "wr");

    expect(result.processed[0]?.changed.any).toBe(false);
    expect(indexRuns().length).toBe(runsBefore);
    expect(entries("wr").map((e) => e.file)).not.toContain("local.md");
    expect(fs.existsSync(path.join(checkout, "knowledge", "local.md"))).toBe(true);

    await akm("index");
    expect(entries("wr").map((e) => e.file)).toContain("local.md");
  });
});
