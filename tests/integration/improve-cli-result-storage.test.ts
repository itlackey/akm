// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Public-CLI regression coverage for the artifact-free improve dry-run boundary. */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type SandboxedDir, makeStashDir as sandboxMakeStashDir } from "../_helpers/sandbox";

const disposers: Array<{ cleanup: () => void }> = [];

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");
const improveCliPath = path.join(repoRoot, "src", "commands", "improve", "improve-cli.ts");

function makeStashDir(): string {
  const stash: SandboxedDir = sandboxMakeStashDir();
  // sandboxMakeStashDir lacks the lessons/memories subdirs improve expects.
  for (const sub of ["memories", "lessons"]) {
    fs.mkdirSync(path.join(stash.dir, sub), { recursive: true });
  }
  disposers.push(stash);
  return stash.dir;
}

function writeTestConfig(root: string): void {
  const configDir = path.join(root, "akm");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        test: { kind: "llm", endpoint: "https://example.test/v1/chat/completions", model: "test" },
      },
      defaults: { llmEngine: "test" },
    }),
  );
}

interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
  xdgData: string;
  roots: string[];
  artifactBefore: string[];
}

const SIGNAL_HANDLERS_READY = "AKM_TEST_SIGNAL_HANDLERS_READY";

function runCli(args: string[], stashDir: string): CliRun {
  // Fresh XDG_DATA_HOME per call so each run writes its own state.db. Use the
  // sandbox helper to keep mkdtempSync out of the test file; the dir is passed
  // to spawnSync's env (not process.env) so it never leaks.
  const data = sandboxMakeStashDir();
  const cache = sandboxMakeStashDir();
  const config = sandboxMakeStashDir();
  const state = sandboxMakeStashDir();
  disposers.push(data, cache, config, state);
  writeTestConfig(config.dir);
  const roots = [cache.dir, config.dir, data.dir, state.dir, stashDir];
  const artifactBefore = snapshotRoots(roots);
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      AKM_STASH_DIR: stashDir,
      XDG_CACHE_HOME: cache.dir,
      XDG_CONFIG_HOME: config.dir,
      XDG_DATA_HOME: data.dir,
      XDG_STATE_HOME: state.dir,
    },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    xdgData: data.dir,
    roots,
    artifactBefore,
  };
}

function snapshotRoots(roots: string[]): string[] {
  const entries: string[] = [];
  const walk = (root: string, current: string): void => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const relative = `${roots.indexOf(root)}:${path.relative(root, full)}`;
      if (entry.isDirectory()) {
        entries.push(`${relative}/`);
        walk(root, full);
      } else {
        entries.push(`${relative}:${createHash("sha256").update(fs.readFileSync(full)).digest("hex")}`);
      }
    }
  };
  for (const root of roots) walk(root, root);
  return entries;
}

/**
 * Read every row from `improve_runs` in the test-scoped state.db. The DB lives
 * under `<xdgData>/akm/state.db` per `getDataDir()`.
 */
function readImproveRuns(xdgData: string): Array<{
  id: string;
  started_at: string;
  completed_at: string | null;
  dry_run: number;
  ok: number;
  scope_mode: string;
  profile: string | null;
  strategy: string | null;
  result: Record<string, unknown>;
}> {
  const dbPath = path.join(xdgData, "akm", "state.db");
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, started_at, completed_at, dry_run, ok, scope_mode, profile, strategy, result_json
         FROM improve_runs ORDER BY started_at ASC`,
      )
      .all() as Array<{
      id: string;
      started_at: string;
      completed_at: string | null;
      dry_run: number;
      ok: number;
      scope_mode: string;
      profile: string | null;
      strategy: string | null;
      result_json: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      started_at: r.started_at,
      completed_at: r.completed_at,
      dry_run: r.dry_run,
      ok: r.ok,
      scope_mode: r.scope_mode,
      profile: r.profile,
      strategy: r.strategy,
      result: JSON.parse(r.result_json) as Record<string, unknown>,
    }));
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

describe("akm improve CLI dry-run artifact boundary", () => {
  let stashDir: string;
  beforeEach(() => {
    stashDir = makeStashDir();
  });

  test("success emits schema v2 and creates no artifact or improve_runs row", () => {
    const result = runCli(["improve", "--dry-run"], stashDir);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({ schemaVersion: 2, ok: true, dryRun: true, strategy: "default" });
    expect(readImproveRuns(result.xdgData)).toEqual([]);

    // No legacy on-disk artifact file is authored anymore.
    const runsDir = path.join(stashDir, ".akm", "runs");
    expect(fs.existsSync(runsDir)).toBe(false);

    // No "improve result written to" hint on stderr — the existing [improve]
    // log lines from improve.ts are the canonical console UX.
    expect(result.stderr).not.toContain("improve result written to");
    expect(snapshotRoots(result.roots)).toEqual(result.artifactBefore);
  });

  test("--json-to-stdout remains read-only and does not duplicate dry-run output", () => {
    const result = runCli(["improve", "--dry-run", "--json-to-stdout"], stashDir);
    expect(result.status).toBe(0);

    // Stdout has the full result body.
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.strategy).toBe("default");
    expect(parsed.memorySummary).toBeDefined();
    expect(parsed.plannedRefs).toBeDefined();
    // No envelope-only fields in legacy mode.
    expect(parsed.runId).toBeUndefined();
    expect(parsed.resultPath).toBeUndefined();
    expect(parsed.summary).toBeUndefined();

    const rows = readImproveRuns(result.xdgData);
    expect(rows.length).toBe(0);

    // No legacy on-disk file either.
    const runsDir = path.join(stashDir, ".akm", "runs");
    if (fs.existsSync(runsDir)) {
      const entries = fs.readdirSync(runsDir);
      expect(entries.length).toBe(0);
    }

    // Stderr should NOT contain the "improve result written to" hint.
    expect(result.stderr).not.toContain("improve result written to");
    expect(snapshotRoots(result.roots)).toEqual(result.artifactBefore);
  });

  test("two consecutive dry-runs persist neither invocation", () => {
    const a = runCli(["improve", "--dry-run"], stashDir);
    expect(a.status).toBe(0);
    expect(JSON.parse(a.stdout).dryRun).toBe(true);

    const b = runCli(["improve", "--dry-run"], stashDir);
    expect(b.status).toBe(0);
    expect(JSON.parse(b.stdout).dryRun).toBe(true);

    const aRows = readImproveRuns(a.xdgData);
    const bRows = readImproveRuns(b.xdgData);
    expect(aRows).toEqual([]);
    expect(bRows).toEqual([]);
    // No legacy directory under either stash root.
    expect(fs.existsSync(path.join(stashDir, ".akm", "runs"))).toBe(false);
  });

  test("--strategy appears in stdout without persistence", () => {
    const result = runCli(["improve", "--dry-run", "--strategy", "quick"], stashDir);
    expect(result.status).toBe(0);

    expect(JSON.parse(result.stdout).strategy).toBe("quick");
    expect(readImproveRuns(result.xdgData)).toEqual([]);
    expect(snapshotRoots(result.roots)).toEqual(result.artifactBefore);
  });

  test("preflight errors create no artifact and never persist a result", () => {
    const result = runCli(["improve", "--dry-run", "--strategy", "missing"], stashDir);
    expect(result.status).toBe(78);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: "UNKNOWN_IMPROVE_STRATEGY" });
    expect(readImproveRuns(result.xdgData)).toEqual([]);
    expect(snapshotRoots(result.roots)).toEqual(result.artifactBefore);
  });

  test("runtime exceptions create no artifact and never persist a dry-run result", () => {
    // Strategy resolution succeeds before runImproveSession. This invalid scope
    // throws from akmImprove after the session's signal handlers are installed.
    //
    // Chunk 1.5 opened the type token: a bare, colon-free scope word (the
    // original "not-an-asset-type" fixture) no longer throws — it is now a
    // valid (if empty-matching) `--scope <type>` filter (D1.5-1). A
    // colon-shaped scope value naming a deny-listed, deliberately-removed
    // type (`tool`/`vault`, D1.5-6) still throws the same
    // UsageError/INVALID_FLAG_VALUE, so this regression guard is retargeted
    // to that instead — its real contract (no artifact/persistence survives
    // a runtime exception raised after signal handlers install) is unchanged.
    const result = runCli(["improve", "tool:deploy.sh", "--dry-run"], stashDir);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: "INVALID_FLAG_VALUE" });
    expect(readImproveRuns(result.xdgData)).toEqual([]);
    expect(snapshotRoots(result.roots)).toEqual(result.artifactBefore);
  });

  test("SIGTERM creates no artifact and never persists a dry-run result", async () => {
    const data = sandboxMakeStashDir();
    const cache = sandboxMakeStashDir();
    const config = sandboxMakeStashDir();
    const state = sandboxMakeStashDir();
    disposers.push(data, cache, config, state);
    writeTestConfig(config.dir);
    const memories = path.join(stashDir, "memories");
    for (let index = 0; index < 5_000; index++) {
      fs.writeFileSync(path.join(memories, `signal-${index}.md`), `---\ndescription: signal ${index}\n---\n\nbody\n`);
    }
    const roots = [cache.dir, config.dir, data.dir, state.dir, stashDir];
    const before = snapshotRoots(roots);
    const preload = sandboxMakeStashDir();
    disposers.push(preload);
    const preloadPath = path.join(preload.dir, "signal-ready.mjs");
    const wrapperPath = path.join(preload.dir, "in-flight-improve.mjs");
    fs.writeFileSync(
      preloadPath,
      [
        `const originalOnce = process.once;`,
        `const installed = new Set();`,
        `process.once = function (event, listener) {`,
        `  const result = originalOnce.call(this, event, listener);`,
        `  if (event === "SIGTERM" || event === "SIGINT" || event === "SIGHUP") installed.add(event);`,
        `  if (installed.size === 3) {`,
        `    installed.clear();`,
        `    queueMicrotask(() => process.stderr.write(${JSON.stringify(`${SIGNAL_HANDLERS_READY}\n`)}));`,
        `  }`,
        `  return result;`,
        `};`,
      ].join("\n"),
    );
    fs.writeFileSync(
      wrapperPath,
      [
        `import { _setAkmImproveForTests } from ${JSON.stringify(improveCliPath)};`,
        `_setAkmImproveForTests(() => new Promise(() => {}));`,
        `process.env.AKM_NODE_ENTRY = "1";`,
        `await import(${JSON.stringify(cliPath)});`,
      ].join("\n"),
    );
    const child = spawn("bun", ["--preload", preloadPath, wrapperPath, "improve", "--dry-run"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        AKM_STASH_DIR: stashDir,
        XDG_CACHE_HOME: cache.dir,
        XDG_CONFIG_HOME: config.dir,
        XDG_DATA_HOME: data.dir,
        XDG_STATE_HOME: state.dir,
      },
    });
    const stderrChunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("CLI did not install SIGTERM handlers in time")), 10_000);
      const onData = (chunk: Buffer) => {
        stderrChunks.push(Buffer.from(chunk));
        if (!Buffer.concat(stderrChunks).toString("utf8").includes(SIGNAL_HANDLERS_READY)) return;
        clearTimeout(timeout);
        child.off("close", onClose);
        resolve();
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timeout);
        reject(new Error(`CLI exited before installing SIGTERM handlers (code=${code}, signal=${signal})`));
      };
      child.stderr.on("data", onData);
      child.once("close", onClose);
    });
    child.kill("SIGTERM");
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    expect(exit.code === 143 || exit.signal === "SIGTERM").toBe(true);
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    expect(stderr).toContain(SIGNAL_HANDLERS_READY);
    if (exit.code === 143) expect(stderr).toContain("dry-run state was not persisted");
    expect(readImproveRuns(data.dir)).toEqual([]);
    expect(snapshotRoots(roots)).toEqual(before);
  });
});
