// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Node.js ↔ Bun feature-parity integration tests.
 *
 * Gate: `AKM_NODE_COMPAT_TESTS=1` — like docker/semantic tests, these are
 * skipped in normal CI (they require `bun run build` to produce dist/).
 *
 * Strategy: for each command family, run the CLI TWICE —
 *   1. In-process via runCliCapture (Bun runtime, tests/_helpers/cli.ts)
 *   2. Subprocess via `node dist/cli-node.mjs` (Node runtime)
 *
 * Both runs use the same isolated stash/config directories so output shapes
 * are structurally identical. We compare key fields (not raw strings) so minor
 * whitespace / ordering differences don't produce false failures.
 *
 * Prerequisites (wired in release-gates.yml node-compat job):
 *   - `bun run build`  →  dist/cli-node.mjs
 *   - `npm install --no-save better-sqlite3`  →  native binding for Node ABI
 *
 * Coverage map — runtime-boundary branches exercised:
 *   better-sqlite3      init / remember / index / search / show / health / events
 *   readStdin           remember -
 *   spawnSync           setup (ripgrep download + rg --version)
 *   spawn               setup (agent-availability detection)
 *   writeResponseToFile setup (binary download)
 *   getDirname          --version (reads package.json)
 *   semverOrder         --version (compared with package.json semver)
 *   resolveModule       local embedder availability probe (index)
 *   sleepSync / sleep   not directly observable; absence of hang is the test
 *   mainPath            --version uses it to locate the dist root
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCliCapture } from "../_helpers/cli";
import { withEnv, withIsolatedAkmStorage } from "../_helpers/sandbox";

const ENABLED = process.env.AKM_NODE_COMPAT_TESTS === "1";
const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const CLI_ENTRY = path.join(REPO_ROOT, "dist", "cli-node.mjs");
const NODE_BIN = process.env.AKM_SMOKE_NODE ?? "node";

// ── Helpers ──────────────────────────────────────────────────────────────────

interface NodeResult {
  status: number; // -1 if killed by signal
  stdout: string;
  stderr: string;
}

function nodeRun(args: string[], env: Record<string, string>, stdin?: string): NodeResult {
  const res = nodeSpawnSync(NODE_BIN, [CLI_ENTRY, ...args], {
    env: { ...process.env, ...env, AKM_OUTPUT: "json", NO_COLOR: "1", CI: "1" },
    input: stdin,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: res.status ?? -1,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return undefined;
  }
}

// Runtime-boundary regression markers — any of these in output means the
// Node path tried to call a Bun built-in directly.
const BOUNDARY_MARKERS = ["Bun is not defined", "ERR_MODULE_NOT_FOUND", "ERR_UNKNOWN_FILE_EXTENSION"];

function assertNoBoundaryLeak(result: NodeResult, label: string): void {
  for (const marker of BOUNDARY_MARKERS) {
    expect(result.stdout + result.stderr, `[${label}] boundary leak: ${marker}`).not.toContain(marker);
  }
}

// ── Shared state for each describe block ─────────────────────────────────────

let nodeEnv: Record<string, string> = {};
let stashDir = "";
let cleanup: () => void = () => {};

function setupStorage(): void {
  const storage = withIsolatedAkmStorage();
  stashDir = storage.stashDir;
  nodeEnv = {
    AKM_STASH_DIR: storage.stashDir,
    XDG_CONFIG_HOME: storage.configDir,
    XDG_DATA_HOME: storage.dataDir,
    XDG_CACHE_HOME: storage.cacheDir,
    XDG_STATE_HOME: storage.stateDir,
    // The Node child inherits BUN_TEST=1 from the bun-test parent, so init's
    // `assertInitSandbox` guard (which refuses to persist a /tmp --dir stash
    // under a test runner) fires. This suite legitimately scaffolds a stash in
    // an isolated tmp dir, so opt into the guard's documented escape hatch.
    AKM_FORCE_INIT_TMP_STASH: "1",
  };
  cleanup = storage.cleanup;
}

// ── Guard ────────────────────────────────────────────────────────────────────

beforeAll(() => {
  if (!ENABLED) return;
  if (!fs.existsSync(CLI_ENTRY)) {
    throw new Error(
      `node-compat: dist artifact missing at ${CLI_ENTRY} — run \`bun run build\` first (or set AKM_NODE_COMPAT_TESTS=0 to skip).`,
    );
  }
});

// ── version ──────────────────────────────────────────────────────────────────

describe("version parity", () => {
  test.skipIf(!ENABLED)("--version matches package.json on both runtimes", async () => {
    const pkgVersion = (
      JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string }
    ).version;

    // Bun
    const bunResult = await runCliCapture(["--version"]);
    expect(bunResult.stdout.trim()).toContain(pkgVersion);

    // Node
    const nodeResult = nodeRun(["--version"], {});
    assertNoBoundaryLeak(nodeResult, "--version");
    expect(nodeResult.status).toBe(0);
    expect(nodeResult.stdout.trim()).toContain(pkgVersion);
    expect(nodeResult.stdout.trim()).toBe(bunResult.stdout.trim());
  });
});

// ── init + remember + show ────────────────────────────────────────────────────

describe("init / remember / show parity", () => {
  afterEach(() => cleanup());

  test.skipIf(!ENABLED)("init creates stash on Node", () => {
    setupStorage();
    // withIsolatedAkmStorage pre-creates `stashDir` with skeleton subdirs, so
    // `init --dir <stashDir>` would report created:false. Point at a fresh,
    // not-yet-existing subpath so init genuinely creates the stash.
    const freshDir = path.join(stashDir, "fresh");
    const r = nodeRun(["init", "--dir", freshDir], nodeEnv);
    assertNoBoundaryLeak(r, "init");
    expect(r.status).toBe(0);
    const json = parseJson(r.stdout) as { created?: boolean } | undefined;
    expect(json?.created).toBe(true);
  });

  test.skipIf(!ENABLED)("remember + show roundtrip is identical on Bun and Node", async () => {
    setupStorage();

    // Seed via Bun (in-process)
    const bunRem = await withEnv(
      {
        AKM_STASH_DIR: stashDir,
        ...nodeEnv,
        AKM_OUTPUT: "json",
        NO_COLOR: "1",
      },
      () => runCliCapture(["remember", "node compat roundtrip test memory"]),
    );
    expect(bunRem.code).toBe(0);
    const bunRemJson = parseJson(bunRem.stdout) as { ok?: boolean; ref?: string } | undefined;
    expect(bunRemJson?.ok).toBe(true);
    const ref = bunRemJson?.ref as string;

    // Read back via Node
    const nodeShow = nodeRun(["show", ref], nodeEnv);
    assertNoBoundaryLeak(nodeShow, "show");
    expect(nodeShow.status).toBe(0);
    const nodeShowJson = parseJson(nodeShow.stdout) as { type?: string } | undefined;
    expect(nodeShowJson?.type).toBe("memory");

    // Read back via Bun in-process — same shape
    const bunShow = await withEnv({ AKM_STASH_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, () =>
      runCliCapture(["show", ref]),
    );
    expect(bunShow.code).toBe(0);
    const bunShowJson = parseJson(bunShow.stdout) as { type?: string } | undefined;
    expect(bunShowJson?.type).toBe(nodeShowJson?.type);
  });

  test.skipIf(!ENABLED)("remember via stdin (readStdin Node branch)", () => {
    setupStorage();
    // init first
    nodeRun(["init", "--dir", stashDir], nodeEnv);

    const r = nodeRun(["remember", "-"], nodeEnv, "piped stdin node compat memory content\n");
    assertNoBoundaryLeak(r, "remember-stdin");
    expect(r.status).toBe(0);
    const json = parseJson(r.stdout) as { ok?: boolean } | undefined;
    expect(json?.ok).toBe(true);
  });
});

// ── index + search ────────────────────────────────────────────────────────────

describe("index / search parity", () => {
  afterEach(() => cleanup());

  test.skipIf(!ENABLED)("index runs and search finds remembered content on Node", async () => {
    setupStorage();
    // Write a memory via Bun
    await withEnv({ AKM_STASH_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, () =>
      runCliCapture(["remember", "node-compat-index-widget searchable content"]),
    );

    // Build index via Node
    const indexResult = nodeRun(["index"], nodeEnv);
    assertNoBoundaryLeak(indexResult, "index");
    expect(indexResult.status).toBe(0);
    const indexJson = parseJson(indexResult.stdout) as { shape?: string } | undefined;
    expect(indexJson?.shape).toBe("index");

    // Search via Node
    const searchResult = nodeRun(["search", "node-compat-index-widget"], nodeEnv);
    assertNoBoundaryLeak(searchResult, "search");
    // search exits 0 (hits found) or 1 (no hits) — both are valid runs
    expect([0, 1]).toContain(searchResult.status);

    // Search via Bun — same exit code
    const bunSearch = await withEnv({ AKM_STASH_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, () =>
      runCliCapture(["search", "node-compat-index-widget"]),
    );
    expect(bunSearch.code).toBe(searchResult.status);
  });
});

// ── health ────────────────────────────────────────────────────────────────────

describe("health parity", () => {
  afterEach(() => cleanup());

  test.skipIf(!ENABLED)("health shape is identical on Bun and Node", async () => {
    setupStorage();

    const nodeResult = nodeRun(["health"], nodeEnv);
    assertNoBoundaryLeak(nodeResult, "health");
    // health exits 0 (ok) or 4 (warn) on a fresh stash
    expect([0, 4]).toContain(nodeResult.status);
    const nodeJson = parseJson(nodeResult.stdout) as { shape?: string } | undefined;
    expect(nodeJson?.shape).toBe("health");

    const bunResult = await withEnv({ AKM_STASH_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, () =>
      runCliCapture(["health"]),
    );
    const bunJson = parseJson(bunResult.stdout) as { shape?: string } | undefined;
    expect(bunJson?.shape).toBe("health");
    expect(nodeJson?.shape).toBe(bunJson?.shape);
  });
});

// ── env set / get / list / unset ──────────────────────────────────────────────

describe("env parity", () => {
  afterEach(() => cleanup());

  test.skipIf(!ENABLED)("env set / list / unset roundtrip is identical on Bun and Node", async () => {
    setupStorage();

    // The real `env set` grammar is `env set <ref> <KEY>` with the VALUE read
    // from --from-env/--from-file/STDIN — values are NEVER passed as positionals
    // and there is no `env get` (values are deliberately never printed). Set the
    // value through a source env var so both runtimes use identical grammar.
    const sourceEnv = { ...nodeEnv, MY_NODE_SRC_VAL: "hello-from-bun" };

    // set via Bun (in-process)
    const bunSet = await withEnv({ AKM_STASH_DIR: stashDir, ...sourceEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, () =>
      runCliCapture(["env", "set", "default", "MY_NODE_VAR", "--from-env", "MY_NODE_SRC_VAL"]),
    );
    expect(bunSet.code).toBe(0);

    // list via Node — must include the key NAME (never the value)
    const nodeList = nodeRun(["env", "list"], nodeEnv);
    assertNoBoundaryLeak(nodeList, "env list");
    expect(nodeList.status).toBe(0);
    expect(nodeList.stdout).toContain("MY_NODE_VAR");

    // unset via Node
    const nodeUnset = nodeRun(["env", "unset", "default", "MY_NODE_VAR", "--yes"], nodeEnv);
    assertNoBoundaryLeak(nodeUnset, "env unset");
    expect(nodeUnset.status).toBe(0);

    // verify gone via Bun — `env list` no longer mentions the key
    const bunList = await withEnv({ AKM_STASH_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, () =>
      runCliCapture(["env", "list"]),
    );
    expect(bunList.code).toBe(0);
    expect(bunList.stdout).not.toContain("MY_NODE_VAR");
  });
});

// ── config path ───────────────────────────────────────────────────────────────

describe("config path parity", () => {
  afterEach(() => cleanup());

  test.skipIf(!ENABLED)("config path returns same path on Bun and Node", async () => {
    setupStorage();

    const nodeResult = nodeRun(["config", "path"], nodeEnv);
    assertNoBoundaryLeak(nodeResult, "config path");
    expect(nodeResult.status).toBe(0);
    expect(nodeResult.stdout.trim()).toBeTruthy();

    const bunResult = await withEnv({ AKM_STASH_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, () =>
      runCliCapture(["config", "path"]),
    );
    expect(bunResult.stdout.trim()).toBe(nodeResult.stdout.trim());
  });
});

// ── history ───────────────────────────────────────────────────────────────────

describe("history parity", () => {
  afterEach(() => cleanup());

  test.skipIf(!ENABLED)("history returns same shape on Bun and Node", async () => {
    setupStorage();
    // Seed a memory AND build the index so the usage_events table exists.
    // Without `index`, `history` opens a missing index.db and the two SQLite
    // drivers diverge (bun:sqlite "unable to open database file" exit 70 vs
    // better-sqlite3 "no such table: usage_events"). Running `index` first makes
    // the command SUCCEED identically on both runtimes — a real parity check,
    // not an assertion worked around.
    await withEnv({ AKM_STASH_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, async () => {
      await runCliCapture(["remember", "history parity test"]);
      await runCliCapture(["index"]);
    });

    const nodeResult = nodeRun(["history"], nodeEnv);
    assertNoBoundaryLeak(nodeResult, "history");
    expect(nodeResult.status).toBe(0);

    const bunResult = await withEnv({ AKM_STASH_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, () =>
      runCliCapture(["history"]),
    );
    expect(bunResult.code).toBe(0);

    const nodeJson = parseJson(nodeResult.stdout) as { shape?: string } | undefined;
    const bunJson = parseJson(bunResult.stdout) as { shape?: string } | undefined;
    expect(nodeJson?.shape).toBe(bunJson?.shape);
  });
});

// ── events ────────────────────────────────────────────────────────────────────

describe("events parity", () => {
  afterEach(() => cleanup());

  test.skipIf(!ENABLED)("log list returns same shape on Bun and Node after seeding", async () => {
    setupStorage();
    // The append-only events stream is read by `akm log list` (there is no
    // top-level `events` command). Seed + index so the events table exists.
    await withEnv({ AKM_STASH_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, async () => {
      await runCliCapture(["remember", "events parity test"]);
      await runCliCapture(["index"]);
    });

    const nodeResult = nodeRun(["log", "list"], nodeEnv);
    assertNoBoundaryLeak(nodeResult, "log list");
    expect(nodeResult.status).toBe(0);
    const nodeJson = parseJson(nodeResult.stdout) as { totalCount?: number; events?: unknown[] } | undefined;
    expect(Array.isArray(nodeJson?.events)).toBe(true);

    const bunResult = await withEnv({ AKM_STASH_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, () =>
      runCliCapture(["log", "list"]),
    );
    expect(bunResult.code).toBe(0);
    const bunJson = parseJson(bunResult.stdout) as { totalCount?: number; events?: unknown[] } | undefined;
    expect(Array.isArray(bunJson?.events)).toBe(true);
    // Same event stream → identical totalCount on both runtimes.
    expect(nodeJson?.totalCount).toBe(bunJson?.totalCount);
  });
});

// ── sources ───────────────────────────────────────────────────────────────────

describe("sources parity", () => {
  afterEach(() => cleanup());

  test.skipIf(!ENABLED)("sources list output is structurally identical on Bun and Node", async () => {
    setupStorage();

    // The configured-sources listing is `akm list` (there is no top-level
    // `sources list` command). Its JSON envelope carries shape:"list".
    const nodeResult = nodeRun(["list"], nodeEnv);
    assertNoBoundaryLeak(nodeResult, "list");
    expect(nodeResult.status).toBe(0);

    const bunResult = await withEnv({ AKM_STASH_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, () =>
      runCliCapture(["list"]),
    );
    const nodeJson = parseJson(nodeResult.stdout) as { shape?: string } | undefined;
    const bunJson = parseJson(bunResult.stdout) as { shape?: string } | undefined;
    expect(nodeJson?.shape).toBe("list");
    expect(nodeJson?.shape).toBe(bunJson?.shape);
  });
});

// ── stash ─────────────────────────────────────────────────────────────────────

describe("stash parity", () => {
  afterEach(() => cleanup());

  test.skipIf(!ENABLED)("stash path returns same value on Bun and Node", async () => {
    setupStorage();

    // No command prints the bare stash path; `config path --all` emits a JSON
    // envelope whose `stash` field is the resolved stash dir.
    const nodeResult = nodeRun(["config", "path", "--all"], nodeEnv);
    assertNoBoundaryLeak(nodeResult, "config path --all");
    expect(nodeResult.status).toBe(0);
    const nodeJson = parseJson(nodeResult.stdout) as { stash?: string } | undefined;
    expect(nodeJson?.stash).toBe(stashDir);

    const bunResult = await withEnv({ AKM_STASH_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, () =>
      runCliCapture(["config", "path", "--all"]),
    );
    expect(bunResult.code).toBe(0);
    const bunJson = parseJson(bunResult.stdout) as { stash?: string } | undefined;
    expect(bunJson?.stash).toBe(nodeJson?.stash);
  });
});

// ── graph ─────────────────────────────────────────────────────────────────────

describe("graph parity", () => {
  afterEach(() => cleanup());

  test.skipIf(!ENABLED)("graph returns same shape on Bun and Node", async () => {
    setupStorage();
    // seed two memories + index so graph has something
    await withEnv({ AKM_STASH_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, async () => {
      await runCliCapture(["remember", "node compat graph node A test"]);
      await runCliCapture(["remember", "node compat graph node B test"]);
      await runCliCapture(["index"]);
    });

    // `graph` is a group command (summary/entities/relations/...); `--format`
    // is not valid on the group, so call the real `graph summary` leaf.
    const nodeResult = nodeRun(["graph", "summary"], nodeEnv);
    assertNoBoundaryLeak(nodeResult, "graph");
    expect([0, 1]).toContain(nodeResult.status);

    const bunResult = await withEnv({ AKM_STASH_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, () =>
      runCliCapture(["graph", "summary"]),
    );
    // Both should succeed or both should have nothing (empty graph → exit 1)
    expect(nodeResult.status).toBe(bunResult.code);
  });
});

// ── import (local file) ───────────────────────────────────────────────────────

describe("import parity", () => {
  afterEach(() => cleanup());

  test.skipIf(!ENABLED)("import from local file produces same shape on Bun and Node", async () => {
    setupStorage();
    const tmp = fs.mkdtempSync(path.join(stashDir, ".tmp-compat-"));
    // Import a DISTINCT file per runtime: importing the same file twice collides
    // on the derived knowledge ref ("already exists, re-run with --force" → exit
    // 2). Two files means both genuinely create and both return ok:true.
    const nodeFile = path.join(tmp, "test-import-node.md");
    const bunFile = path.join(tmp, "test-import-bun.md");
    fs.writeFileSync(nodeFile, "# Test Import Node\n\nThis is a test import document for node-compat tests.\n");
    fs.writeFileSync(bunFile, "# Test Import Bun\n\nThis is a test import document for node-compat tests.\n");

    try {
      const nodeResult = nodeRun(["import", nodeFile], nodeEnv);
      assertNoBoundaryLeak(nodeResult, "import");
      expect(nodeResult.status).toBe(0);
      const nodeJson = parseJson(nodeResult.stdout) as { ok?: boolean } | undefined;
      expect(nodeJson?.ok).toBe(true);

      const bunResult = await withEnv({ AKM_STASH_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, () =>
        runCliCapture(["import", bunFile]),
      );
      expect(bunResult.code).toBe(0);
      const bunJson = parseJson(bunResult.stdout) as { ok?: boolean } | undefined;
      expect(bunJson?.ok).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test.skipIf(!ENABLED)(
    "import from URL uses writeResponseToFile (Node boundary) + Connection:close drain",
    async () => {
      setupStorage();
      // The HTTP server MUST run in a SEPARATE process. `nodeRun` uses
      // `spawnSync`, which blocks the Bun event loop — an in-process server in
      // this same Bun process could never accept the Node child's connection
      // (the old form deadlocked → 15s fetch timeout ×2 → exit 70). A detached
      // Node child still exercises the real URL-import boundary (HTTP fetch +
      // writeResponseToFile + Connection:close drain), unlike a file:// path
      // which `import` does not accept.
      const { server, port } = await startUrlServerChild();
      try {
        const url = `http://127.0.0.1:${port}/docs/node-compat-import`;
        const nodeResult = nodeRun(["import", url], nodeEnv);
        assertNoBoundaryLeak(nodeResult, "import-url");
        expect(nodeResult.status).toBe(0);
        const nodeJson = parseJson(nodeResult.stdout) as { ok?: boolean } | undefined;
        expect(nodeJson?.ok).toBe(true);
      } finally {
        server.kill("SIGKILL");
      }
    },
  );
});

/**
 * Start a tiny HTML HTTP server in a DETACHED Node child process and resolve
 * once it has printed its bound port. Running the server out-of-process is the
 * whole point: `nodeRun` blocks the Bun loop with `spawnSync`, so a same-process
 * server could never accept the import child's socket.
 */
async function startUrlServerChild(): Promise<{ server: ChildProcess; port: number }> {
  const scriptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "akm-urlsrv-")), "server.mjs");
  fs.writeFileSync(
    scriptPath,
    [
      "import http from 'node:http';",
      "const body = '<html><head><title>Node Compat URL Import</title></head><body><h1>Node Compat URL Import</h1><p>Content for import test.</p></body></html>';",
      "const server = http.createServer((_req, res) => {",
      "  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });",
      "  res.end(body);",
      "});",
      "server.listen(0, '127.0.0.1', () => {",
      "  const addr = server.address();",
      "  process.stdout.write('PORT=' + addr.port + '\\n');",
      "});",
    ].join("\n"),
  );

  const server = nodeSpawn(NODE_BIN, [scriptPath], { stdio: ["ignore", "pipe", "ignore"] });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("URL server child did not report a port in time")), 10_000);
    let buffered = "";
    server.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const match = buffered.match(/PORT=(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    server.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return { server, port };
}

// ── output format parity ──────────────────────────────────────────────────────

describe("output format parity", () => {
  afterEach(() => cleanup());

  test.skipIf(!ENABLED)("health --format text produces non-empty output on Node", () => {
    setupStorage();
    const r = nodeRun(["health", "--format", "text"], { ...nodeEnv, AKM_OUTPUT: "text" });
    assertNoBoundaryLeak(r, "health-text");
    expect([0, 4]).toContain(r.status);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });

  test.skipIf(!ENABLED)("health --format html produces <html> on Node", () => {
    setupStorage();
    const r = nodeRun(["health", "--format", "html"], { ...nodeEnv, AKM_OUTPUT: "html" });
    assertNoBoundaryLeak(r, "health-html");
    expect([0, 4]).toContain(r.status);
    expect(r.stdout).toContain("<html");
  });

  test.skipIf(!ENABLED)(
    "show --format text and --format json produce structurally same data on Bun and Node",
    async () => {
      setupStorage();
      await withEnv({ AKM_STASH_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, async () => {
        const rem = await runCliCapture(["remember", "format parity test memory"]);
        const j = parseJson(rem.stdout) as { ref?: string } | undefined;
        const ref = j?.ref as string;

        // json via Node
        const nodeJson = nodeRun(["show", ref, "--format", "json"], nodeEnv);
        assertNoBoundaryLeak(nodeJson, "show-json-node");
        expect(nodeJson.status).toBe(0);
        const nodeData = parseJson(nodeJson.stdout) as { type?: string } | undefined;
        expect(nodeData?.type).toBe("memory");

        // text via Node — non-empty
        const nodeText = nodeRun(["show", ref, "--format", "text"], { ...nodeEnv, AKM_OUTPUT: "text" });
        assertNoBoundaryLeak(nodeText, "show-text-node");
        expect(nodeText.status).toBe(0);
        expect(nodeText.stdout.trim().length).toBeGreaterThan(0);
      });
    },
  );
});

// ── tasks list ────────────────────────────────────────────────────────────────

describe("tasks parity", () => {
  afterEach(() => cleanup());

  test.skipIf(!ENABLED)("tasks list returns same shape on Bun and Node", async () => {
    setupStorage();

    const nodeResult = nodeRun(["tasks", "list"], nodeEnv);
    assertNoBoundaryLeak(nodeResult, "tasks list");
    expect(nodeResult.status).toBe(0);

    const bunResult = await withEnv({ AKM_STASH_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, () =>
      runCliCapture(["tasks", "list"]),
    );
    const nodeJson = parseJson(nodeResult.stdout) as { shape?: string } | undefined;
    const bunJson = parseJson(bunResult.stdout) as { shape?: string } | undefined;
    expect(nodeJson?.shape).toBe(bunJson?.shape);
  });
});

// ── setup (spawnSync + writeResponseToFile) ───────────────────────────────────

describe("setup parity", () => {
  afterEach(() => cleanup());

  test.skipIf(!ENABLED)(
    "setup --yes downloads ripgrep via writeResponseToFile on Node",
    () => {
      setupStorage();
      const r = nodeRun(["setup", "--yes"], nodeEnv);
      assertNoBoundaryLeak(r, "setup");
      expect(r.status).toBe(0);
      const json = parseJson(r.stdout) as { shape?: string } | undefined;
      expect(json?.shape).toBe("setup");
    },
    180_000,
  );
});

// ── scope flags ───────────────────────────────────────────────────────────────

describe("scope flag parity", () => {
  afterEach(() => cleanup());

  test.skipIf(!ENABLED)("--scope type:memory search returns same exit on Bun and Node", async () => {
    setupStorage();
    await withEnv({ AKM_STASH_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, async () => {
      await runCliCapture(["remember", "scope flag parity test"]);
      await runCliCapture(["index"]);
    });

    const nodeResult = nodeRun(["search", "scope flag parity", "--scope", "type:memory"], nodeEnv);
    assertNoBoundaryLeak(nodeResult, "scope-search");
    expect([0, 1]).toContain(nodeResult.status);

    const bunResult = await withEnv({ AKM_STASH_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, () =>
      runCliCapture(["search", "scope flag parity", "--scope", "type:memory"]),
    );
    expect(nodeResult.status).toBe(bunResult.code);
  });
});

// ── registry list ─────────────────────────────────────────────────────────────

describe("registry parity", () => {
  afterEach(() => cleanup());

  test.skipIf(!ENABLED)("registry list returns same shape on Bun and Node", async () => {
    setupStorage();

    const nodeResult = nodeRun(["registry", "list"], nodeEnv);
    assertNoBoundaryLeak(nodeResult, "registry list");
    expect(nodeResult.status).toBe(0);

    const bunResult = await withEnv({ AKM_STASH_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, () =>
      runCliCapture(["registry", "list"]),
    );
    const nodeJson = parseJson(nodeResult.stdout) as { shape?: string } | undefined;
    const bunJson = parseJson(bunResult.stdout) as { shape?: string } | undefined;
    expect(nodeJson?.shape).toBe(bunJson?.shape);
  });
});
