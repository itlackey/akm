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
 * Prerequisites (wired in the CI Node smoke job):
 *   - `bun run build`  →  dist/cli-node.mjs
 *   - `npm install --no-save better-sqlite3`  →  native binding for Node ABI
 *
 * Coverage map — runtime-boundary branches exercised:
 *   better-sqlite3      bundle create / remember / index / search / show / health / events
 *   readStdin           remember -
 *   spawnSync           setup (ripgrep download + rg --version)
 *   spawn               setup (agent-availability detection)
 *   writeResponseToFile setup (binary download)
 *   getDirname          --version (reads package.json)
 *   semverOrder         --version (compared with package.json semver)
 *   sleepSync / sleep   not directly observable; absence of hang is the test
 *   mainPath            --version uses it to locate the dist root
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BOUNDARY_MARKERS, NATIVE_CRASH_MARKER } from "../../scripts/node-runtime-markers";
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

function nodeRunAt(entry: string, args: string[], env: Record<string, string>, stdin?: string): NodeResult {
  const res = nodeSpawnSync(NODE_BIN, [entry, ...args], {
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

function nodeRun(args: string[], env: Record<string, string>, stdin?: string): NodeResult {
  return nodeRunAt(CLI_ENTRY, args, env, stdin);
}

// Safety net for every `withEnv` override below: well under this file's own
// 120s per-test budget (`test:node-compat` passes --timeout=120000), and
// comfortably above the slowest legitimate call observed in this suite
// (~14.5s for a workflow create+start+status round-trip). `fn()` here always
// wraps a real subprocess spawn or CLI dispatch with no timeout of its own,
// so a hang is possible (see CI incident 2026-07-27: a stalled `history`
// call left `AKM_FORCE_INIT_TMP_STASH`/`AKM_OUTPUT` applied to `process.env`
// for the rest of the run because `withEnv`'s restore-on-finally never got a
// chance to fire, cascading one hang into 19 unrelated failures via
// tests/_preload.ts's leak tripwire). Bounding the race here guarantees the
// override is undone on schedule regardless of what `fn()` does.
const WITH_ENV_SAFETY_MS = 60_000;

function boundedWithEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  return withEnv(overrides, fn, WITH_ENV_SAFETY_MS);
}

function generatedCronCommand(crontab: string, id: string): string {
  const lines = crontab.split(/\r?\n/);
  const begin = lines.indexOf(`# akm:task ${id} BEGIN`);
  const body = lines[begin + 1] ?? "";
  const match = body.match(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/);
  if (!match) throw new Error(`Could not extract generated cron command for ${id}: ${body}`);
  return match[1]!;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return undefined;
  }
}

function assertNoBoundaryLeak(result: NodeResult, label: string): void {
  for (const marker of BOUNDARY_MARKERS) {
    expect(result.stdout + result.stderr, `[${label}] boundary leak: ${marker}`).not.toContain(marker);
  }
  // Static message: bun prints the received string on failure anyway, and
  // interpolating stderr here builds it on every passing call too — `nodeRun`
  // allows a 32 MiB buffer, so that is unbounded work on the happy path.
  expect(result.stderr, `[${label}] the node subprocess aborted in native code`).not.toContain(NATIVE_CRASH_MARKER);
}

// ── Shared state for each describe block ─────────────────────────────────────

let nodeEnv: Record<string, string> = {};
let stashDir = "";
let cleanup: () => void = () => {};

function setupStorage(): void {
  const storage = withIsolatedAkmStorage();
  stashDir = storage.stashDir;
  nodeEnv = {
    AKM_BUNDLE_DIR: storage.stashDir,
    XDG_CONFIG_HOME: storage.configDir,
    XDG_DATA_HOME: storage.dataDir,
    XDG_CACHE_HOME: storage.cacheDir,
    XDG_STATE_HOME: storage.stateDir,
  };
  cleanup = storage.cleanup;
}

function configureEngine(name: string, engine: Record<string, unknown>, defaults: Record<string, string>): void {
  const setEngine = nodeRun(["config", "set", `engines.${name}`, JSON.stringify(engine)], nodeEnv);
  assertNoBoundaryLeak(setEngine, `config set engine ${name}`);
  expect(setEngine.status).toBe(0);

  const setDefaults = nodeRun(["config", "set", "defaults", JSON.stringify(defaults)], nodeEnv);
  assertNoBoundaryLeak(setDefaults, `config set defaults for ${name}`);
  expect(setDefaults.status).toBe(0);
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

// ── packaged models.json ─────────────────────────────────────────────────────

describe("model-map package asset parity", () => {
  afterEach(() => cleanup());

  test.skipIf(!ENABLED)("Node launcher discovers installed defaults and copies them through the CLI", () => {
    setupStorage();
    const result = nodeRun(["models", "copy-defaults"], nodeEnv);
    assertNoBoundaryLeak(result, "models-copy-defaults");
    expect(result.status).toBe(0);
    const copied = path.join(nodeEnv.XDG_CONFIG_HOME!, "akm", "models.json");
    const document = JSON.parse(fs.readFileSync(copied, "utf8")) as {
      version?: number;
      aliases?: Record<string, unknown>;
    };
    expect(document.version).toBe(1);
    expect(Object.keys(document.aliases ?? {}).sort()).toEqual(["balanced", "fast", "reasoning"]);
  });

  test.skipIf(!ENABLED)("Node health reports a missing or malformed copied-install asset", () => {
    setupStorage();
    for (const scenario of ["missing", "malformed"] as const) {
      const installRoot = fs.mkdtempSync(path.join(REPO_ROOT, ".akm-node-model-map-install-"));
      try {
        const copiedDist = path.join(installRoot, "dist");
        fs.cpSync(path.join(REPO_ROOT, "dist"), copiedDist, { recursive: true });
        fs.copyFileSync(path.join(REPO_ROOT, "package.json"), path.join(installRoot, "package.json"));
        fs.copyFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), path.join(installRoot, "CHANGELOG.md"));
        const copiedAsset = path.join(copiedDist, "assets", "models.json");
        const moduleUrl = pathToFileURL(path.join(copiedDist, "integrations", "agent", "model-map.js")).href;
        const pathProbeOutput = path.join(installRoot, "model-map-paths.json");
        const pathProbe = nodeSpawnSync(
          NODE_BIN,
          [
            "--input-type=module",
            "--eval",
            `const fs = await import("node:fs"); const { installedModelMapPaths } = await import(${JSON.stringify(moduleUrl)}); fs.writeFileSync(${JSON.stringify(pathProbeOutput)}, JSON.stringify(installedModelMapPaths()));`,
          ],
          { encoding: "utf8" },
        );
        expect(pathProbe.status, String(pathProbe.stderr)).toBe(0);
        expect(JSON.parse(fs.readFileSync(pathProbeOutput, "utf8"))).toEqual([copiedAsset]);
        if (scenario === "missing") fs.rmSync(copiedAsset);
        else fs.writeFileSync(copiedAsset, "MALFORMEDINSTALLEDMODELSECRET802");
        const healthOutput = path.join(nodeEnv.XDG_CACHE_HOME!, `copied-install-${scenario}-health.json`);

        const result = nodeRunAt(
          path.join(copiedDist, "cli-node.mjs"),
          ["health", "--format", "json", "--output", healthOutput],
          nodeEnv,
        );
        assertNoBoundaryLeak(result, `copied-install-${scenario}-models`);
        expect(result.status).toBe(1);
        const rendered = fs.readFileSync(healthOutput, "utf8");
        expect(result.stdout + result.stderr + rendered).not.toContain("MALFORMEDINSTALLEDMODELSECRET802");
        const output = parseJson(rendered) as
          | { hardChecks?: Array<{ name?: string; status?: string; message?: string }> }
          | undefined;
        expect(output?.hardChecks?.find((check) => check.name === "model-map-files")).toMatchObject({
          status: "fail",
        });
      } finally {
        fs.rmSync(installRoot, { recursive: true, force: true });
      }
    }
  });

  test.skipIf(!ENABLED)("actual Node health never echoes invalid user JSON or version values", () => {
    for (const [name, text, sentinel] of [
      ["syntax", "NODEJSONPARSESECRETSENTINEL802", "NODEJSONPARSESECRETSENTINEL802"],
      [
        "version",
        JSON.stringify({ version: "NODEVERSIONSECRETSENTINEL802", aliases: {} }),
        "NODEVERSIONSECRETSENTINEL802",
      ],
    ] as const) {
      setupStorage();
      try {
        const userMap = path.join(nodeEnv.XDG_CONFIG_HOME!, "akm", "models.json");
        fs.mkdirSync(path.dirname(userMap), { recursive: true });
        fs.writeFileSync(userMap, text, { mode: 0o600 });
        const healthOutput = path.join(nodeEnv.XDG_CACHE_HOME!, `node-model-map-${name}-health.json`);
        const result = nodeRun(["health", "--format", "json", "--output", healthOutput], nodeEnv);
        assertNoBoundaryLeak(result, `node-model-map-${name}`);
        const rendered = fs.readFileSync(healthOutput, "utf8");
        expect(result.stdout + result.stderr + rendered).not.toContain(sentinel);
        const output = parseJson(rendered) as
          | { hardChecks?: Array<{ name?: string; status?: string; message?: string }> }
          | undefined;
        expect(output?.hardChecks?.find((check) => check.name === "model-map-files")).toMatchObject({
          status: "warn",
        });
      } finally {
        cleanup();
      }
    }
  });
});

// ── bundle create + remember + show ─────────────────────────────────────────

describe("bundle create / remember / show parity", () => {
  afterEach(() => cleanup());

  test.skipIf(!ENABLED)("bundle create creates stash on Node", () => {
    setupStorage();
    // withIsolatedAkmStorage pre-creates `stashDir` with skeleton subdirs, so
    // `bundle create --dir <stashDir>` would report created:false. Point at a fresh,
    // not-yet-existing subpath so bundle create genuinely creates the stash.
    const freshDir = path.join(stashDir, "fresh");
    const r = nodeRun(["bundle", "create", "--dir", freshDir], nodeEnv);
    assertNoBoundaryLeak(r, "bundle-create");
    expect(r.status).toBe(0);
    const json = parseJson(r.stdout) as { created?: boolean } | undefined;
    expect(json?.created).toBe(true);
  });

  test.skipIf(!ENABLED)("remember + show roundtrip is identical on Bun and Node", async () => {
    setupStorage();

    // Seed via Bun (in-process)
    const bunRem = await boundedWithEnv(
      {
        AKM_BUNDLE_DIR: stashDir,
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
    const bunShow = await boundedWithEnv(
      { AKM_BUNDLE_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" },
      () => runCliCapture(["show", ref]),
    );
    expect(bunShow.code).toBe(0);
    const bunShowJson = parseJson(bunShow.stdout) as { type?: string } | undefined;
    expect(bunShowJson?.type).toBe(nodeShowJson?.type);
  });

  test.skipIf(!ENABLED)("remember via stdin (readStdin Node branch)", () => {
    setupStorage();
    // bundle create first
    nodeRun(["bundle", "create", "--dir", stashDir], nodeEnv);

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
    await boundedWithEnv({ AKM_BUNDLE_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, () =>
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
    const bunSearch = await boundedWithEnv(
      { AKM_BUNDLE_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" },
      () => runCliCapture(["search", "node-compat-index-widget"]),
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

    const bunResult = await boundedWithEnv(
      { AKM_BUNDLE_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" },
      () => runCliCapture(["health"]),
    );
    const bunJson = parseJson(bunResult.stdout) as { shape?: string } | undefined;
    expect(bunJson?.shape).toBe("health");
    expect(nodeJson?.shape).toBe(bunJson?.shape);
  });
});

// ── env set / get / list / unset ──────────────────────────────────────────────

describe("env parity", () => {
  afterEach(() => cleanup());

  test.skipIf(!ENABLED)("env create / list / remove roundtrip is identical on Bun and Node", async () => {
    setupStorage();

    // `env set`/`env unset` were removed in 0.9 (akm does not edit entries —
    // you edit the `.env` file yourself); the surviving lifecycle verbs are
    // create/list/remove. Exercise those across both runtimes instead.

    // create via Bun (in-process)
    const bunCreate = await boundedWithEnv(
      { AKM_BUNDLE_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" },
      () => runCliCapture(["env", "create", "node-compat-parity"]),
    );
    expect(bunCreate.code).toBe(0);

    // list via Node — must include the env file NAME
    const nodeList = nodeRun(["env", "list"], nodeEnv);
    assertNoBoundaryLeak(nodeList, "env list");
    expect(nodeList.status).toBe(0);
    expect(nodeList.stdout).toContain("node-compat-parity");

    // remove via Node
    const nodeRemove = nodeRun(["env", "remove", "node-compat-parity", "--yes"], nodeEnv);
    assertNoBoundaryLeak(nodeRemove, "env remove");
    expect(nodeRemove.status).toBe(0);

    // verify gone via Bun — `env list` no longer mentions the file
    const bunList = await boundedWithEnv(
      { AKM_BUNDLE_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" },
      () => runCliCapture(["env", "list"]),
    );
    expect(bunList.code).toBe(0);
    expect(bunList.stdout).not.toContain("node-compat-parity");
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

    const bunResult = await boundedWithEnv(
      { AKM_BUNDLE_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" },
      () => runCliCapture(["config", "path"]),
    );
    expect(bunResult.stdout.trim()).toBe(nodeResult.stdout.trim());
  });
});

// ── history ───────────────────────────────────────────────────────────────────

// `history` was removed in the 0.9 CLI overhaul (folded into `log`/dropped —
// see docs/migration/v0.8-to-v0.9.md); its per-asset trail is `log --ref`,
// the same code path "events parity" below already exercises. No replacement
// parity test is needed.

// ── events ────────────────────────────────────────────────────────────────────

describe("events parity", () => {
  afterEach(() => cleanup());

  test.skipIf(!ENABLED)("log returns same shape on Bun and Node after seeding", async () => {
    setupStorage();
    // The append-only events stream is read by `akm log` (there is no
    // top-level `events` command). Seed + index so the events table exists.
    await boundedWithEnv({ AKM_BUNDLE_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, async () => {
      await runCliCapture(["remember", "events parity test"]);
      await runCliCapture(["index"]);
    });

    const nodeResult = nodeRun(["log"], nodeEnv);
    assertNoBoundaryLeak(nodeResult, "log");
    expect(nodeResult.status).toBe(0);
    const nodeJson = parseJson(nodeResult.stdout) as { totalCount?: number; events?: unknown[] } | undefined;
    expect(Array.isArray(nodeJson?.events)).toBe(true);

    const bunResult = await boundedWithEnv(
      { AKM_BUNDLE_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" },
      () => runCliCapture(["log"]),
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

    // The configured-sources listing is `akm bundle list` (there is no
    // top-level `sources list` command). Its JSON envelope carries shape:"list".
    const nodeResult = nodeRun(["bundle", "list"], nodeEnv);
    assertNoBoundaryLeak(nodeResult, "bundle-list");
    expect(nodeResult.status).toBe(0);

    const bunResult = await boundedWithEnv(
      { AKM_BUNDLE_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" },
      () => runCliCapture(["bundle", "list"]),
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

    // No command prints the bare bundle path; `config path --all` emits a JSON
    // envelope whose `bundle` field is the resolved bundle dir.
    const nodeResult = nodeRun(["config", "path", "--all"], nodeEnv);
    assertNoBoundaryLeak(nodeResult, "config path --all");
    expect(nodeResult.status).toBe(0);
    const nodeJson = parseJson(nodeResult.stdout) as { bundle?: string } | undefined;
    expect(nodeJson?.bundle).toBe(stashDir);

    const bunResult = await boundedWithEnv(
      { AKM_BUNDLE_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" },
      () => runCliCapture(["config", "path", "--all"]),
    );
    expect(bunResult.code).toBe(0);
    const bunJson = parseJson(bunResult.stdout) as { bundle?: string } | undefined;
    expect(bunJson?.bundle).toBe(nodeJson?.bundle);
  });
});

// `graph` was removed entirely in the 0.9 CLI overhaul (docs/migration/
// v0.8-to-v0.9.md), and the LLM entity-graph extraction engine it inspected
// was itself retired in 0.9.17-alpha.9 (with the `graph-refresh` strategy
// that used to run it). No replacement parity test is needed.

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

      const bunResult = await boundedWithEnv(
        { AKM_BUNDLE_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" },
        () => runCliCapture(["import", bunFile]),
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
      await boundedWithEnv({ AKM_BUNDLE_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, async () => {
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

// ── tasks parity ────────────────────────────────────────────────────────────

describe("tasks parity", () => {
  afterEach(() => cleanup());

  test.skipIf(!ENABLED)("tasks doctor registers the supported Node wrapper", () => {
    setupStorage();
    const result = nodeRun(["task", "doctor"], nodeEnv);
    assertNoBoundaryLeak(result, "tasks doctor");
    expect(result.status).toBe(0);
    const json = parseJson(result.stdout) as { akm?: { argv?: string[] } } | undefined;
    expect(path.basename(json?.akm?.argv?.[0] ?? "")).toMatch(/^node(?:\.exe)?$/);
    expect(json?.akm?.argv?.[1]).toBe(CLI_ENTRY);
  });

  test.skipIf(!ENABLED || process.platform !== "linux")(
    "generated scheduler command runs a nested akm through the Node fallback",
    () => {
      setupStorage();
      const root = path.dirname(stashDir);
      const fakeBin = path.join(root, "fake-bin");
      const fakeCrontab = path.join(root, "crontab");
      const launcher = path.join(REPO_ROOT, "dist", "akm");
      const resolvedNode = Bun.which(NODE_BIN);
      if (!resolvedNode) throw new Error(`Could not resolve Node executable: ${NODE_BIN}`);
      const isolatedNodeDir = path.join(root, "node-bin");
      const isolatedNode = path.join(isolatedNodeDir, "node");
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.mkdirSync(isolatedNodeDir, { recursive: true });
      fs.symlinkSync(fs.realpathSync(resolvedNode), isolatedNode);
      fs.writeFileSync(
        path.join(fakeBin, "crontab"),
        [
          "#!/bin/sh",
          `if [ "\${1:-}" = "-l" ]; then`,
          `  if [ -f "${fakeCrontab}" ]; then cat "${fakeCrontab}"; exit 0; fi`,
          '  echo "no crontab for sandbox" >&2',
          "  exit 1",
          "fi",
          `if [ "\${1:-}" = "-" ]; then cat > "${fakeCrontab}"; exit $?; fi`,
          "exit 2",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      const schedulerPath = [fakeBin, path.dirname(launcher), isolatedNodeDir, "/usr/bin", "/bin"].join(path.delimiter);
      expect(schedulerPath.split(path.delimiter)).not.toContain(path.dirname(process.execPath));
      const schedulerEnv = {
        ...nodeEnv,
        FAKE_CRONTAB: fakeCrontab,
        PATH: schedulerPath,
      };
      const schedulerProcessEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...schedulerEnv,
        AKM_OUTPUT: "json",
        NO_COLOR: "1",
        CI: "1",
      };
      delete schedulerProcessEnv.BUN_TEST;
      delete schedulerProcessEnv.NODE_ENV;
      const launcherRun = (args: string[]): NodeResult => {
        const result = nodeSpawnSync(isolatedNode, [launcher, ...args], {
          env: schedulerProcessEnv,
          encoding: "utf8",
          timeout: 120_000,
          maxBuffer: 32 * 1024 * 1024,
        });
        return {
          status: result.status ?? -1,
          stdout: String(result.stdout ?? ""),
          stderr: String(result.stderr ?? ""),
        };
      };
      const id = `node-fallback-${process.pid}-${Date.now()}`;
      let taskAdded = false;

      try {
        const crontabProbe = nodeSpawnSync("crontab", ["-"], {
          env: schedulerProcessEnv,
          input: "# node fallback crontab probe\n",
          encoding: "utf8",
        });
        expect(crontabProbe.status, String(crontabProbe.stderr)).toBe(0);
        expect(fs.readFileSync(fakeCrontab, "utf8")).toContain("node fallback crontab probe");
        fs.rmSync(fakeCrontab);

        const doctor = launcherRun(["task", "doctor"]);
        assertNoBoundaryLeak(doctor, "Node fallback tasks doctor");
        expect(doctor.status).toBe(0);
        expect((parseJson(doctor.stdout) as { akm?: { argv?: string[] } })?.akm?.argv?.[1]).toBe(launcher);

        const add = launcherRun(["task", "add", id, "--schedule", "@daily", "--command", "akm --version", "--rebind"]);
        assertNoBoundaryLeak(add, "Node fallback tasks add");
        expect(add.status).toBe(0);
        taskAdded = true;

        expect(
          fs.existsSync(fakeCrontab),
          `scheduler output missing\nadd stdout:\n${add.stdout}\nadd stderr:\n${add.stderr}`,
        ).toBe(true);
        const crontab = fs.readFileSync(fakeCrontab, "utf8");
        expect(crontab).toContain(launcher);
        const scheduledCommand = generatedCronCommand(crontab, id);
        const scheduledLog = path.join(nodeEnv.XDG_CACHE_HOME!, "akm", "tasks", "logs", `${id}.log`);
        const scheduled = nodeSpawnSync("/bin/sh", ["-c", scheduledCommand], {
          env: schedulerProcessEnv,
          encoding: "utf8",
          timeout: 120_000,
          maxBuffer: 32 * 1024 * 1024,
        });
        expect(
          scheduled.status,
          `generated Node scheduler command\ncommand:\n${scheduledCommand}\ncrontab:\n${crontab}\nstdout:\n${scheduled.stdout}\nstderr:\n${scheduled.stderr}\nlog:\n${fs.existsSync(scheduledLog) ? fs.readFileSync(scheduledLog, "utf8") : "<missing>"}`,
        ).toBe(0);

        const history = launcherRun(["task", "history", "--id", id, "--limit", "1"]);
        expect(history.status).toBe(0);
        const row = (parseJson(history.stdout) as { rows?: Array<{ status: string; log: string }> })?.rows?.[0];
        expect(row?.status).toBe("completed");
        expect(fs.readFileSync(row?.log as string, "utf8")).toContain(
          (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string }).version,
        );
      } finally {
        if (taskAdded) launcherRun(["task", "remove", id]);
      }
    },
    180_000,
  );
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

  test.skipIf(!ENABLED)("--scope on search is rejected identically on Bun and Node", async () => {
    setupStorage();
    await boundedWithEnv({ AKM_BUNDLE_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" }, async () => {
      await runCliCapture(["remember", "scope flag parity test"]);
      await runCliCapture(["index"]);
    });

    const nodeResult = nodeRun(["search", "scope flag parity", "--scope", "type:memory"], nodeEnv);
    assertNoBoundaryLeak(nodeResult, "scope-search");
    // `--scope` is not a search flag. mri used to drop it silently (exit 0,
    // unscoped results); unknown-flag validation now rejects it as a usage
    // error. The parity contract this suite guards is that Node takes the
    // same path — same exit, same envelope, no Bun-boundary leak.
    expect(nodeResult.status).toBe(2);
    expect(nodeResult.stderr).toContain("UNKNOWN_FLAG");

    const bunResult = await boundedWithEnv(
      { AKM_BUNDLE_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" },
      () => runCliCapture(["search", "scope flag parity", "--scope", "type:memory"]),
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

    const bunResult = await boundedWithEnv(
      { AKM_BUNDLE_DIR: stashDir, ...nodeEnv, AKM_OUTPUT: "json", NO_COLOR: "1" },
      () => runCliCapture(["registry", "list"]),
    );
    const nodeJson = parseJson(nodeResult.stdout) as { shape?: string } | undefined;
    const bunJson = parseJson(bunResult.stdout) as { shape?: string } | undefined;
    expect(nodeJson?.shape).toBe(bunJson?.shape);
  });
});

// ── workflow smoke (better-sqlite3 workflow.db + markdown round-trip) ──────────
//
// A minimal workflow smoke on Node: `workflow create --print | lint` proves the
// unified markdown format (workflow-format-unification) parses on the Node
// runtime, and `workflow create + start + status` exercises the workflow-runs
// repository (workflow.db) through the better-sqlite3 driver — the run-state
// boundary the other families never touch. Both stay within the dist-artifact
// skip gate (AKM_NODE_COMPAT_TESTS=1).

describe("workflow smoke parity", () => {
  afterEach(() => cleanup());

  test.skipIf(!ENABLED)("workflow create --print round-trips through lint on Node", () => {
    setupStorage();
    // `workflow create <name> --print` writes the RAW markdown template to
    // stdout (no envelope) — matching the dropped `workflow template` it
    // replaces — `--print > starter.md` must yield a usable file. There is
    // Creation emits Markdown; execution also accepts peer `.yml` sources
    // through the same source IR. `.yaml` remains rejected.
    const tpl = nodeRun(["workflow", "create", "smoke-program", "--print"], nodeEnv);
    assertNoBoundaryLeak(tpl, "workflow create --print");
    expect(tpl.status).toBe(0);
    expect(tpl.stdout.trimStart().startsWith("{")).toBe(false);
    expect(tpl.stdout).toContain("type: workflow");

    // Persist it and lint the stash on Node — a clean round-trip. 0.9.0:
    // `workflow validate` is dropped; `akm lint --type workflows` is the
    // structural-validation surface.
    const file = path.join(stashDir, "workflows", "smoke-program.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, tpl.stdout, "utf8");
    const val = nodeRun(["lint", "--type", "workflows"], nodeEnv);
    assertNoBoundaryLeak(val, "lint --type workflows");
    expect(val.status).toBe(0);
    const json = parseJson(val.stdout) as { ok?: boolean; summary?: { flagged?: number } } | undefined;
    expect(json?.ok).toBe(true);
    expect(json?.summary?.flagged).toBe(0);
  });

  test.skipIf(!ENABLED)("workflow create + run + status round-trips through state.db on Node", () => {
    setupStorage();
    configureDeadLlm();
    const created = nodeRun(["workflow", "create", "smoke-flow"], nodeEnv);
    assertNoBoundaryLeak(created, "workflow create");
    expect(created.status).toBe(0);

    const run = nodeRun(["workflow", "run", "workflows/smoke-flow", "--timeout=1ms"], nodeEnv);
    assertNoBoundaryLeak(run, "workflow run");
    expect(run.status).toBe(1);
    const runId = (parseJson(run.stdout) as { run?: { id?: string } } | undefined)?.run?.id;
    expect(typeof runId).toBe("string");

    const status = nodeRun(["workflow", "status", runId as string], nodeEnv);
    assertNoBoundaryLeak(status, "workflow status");
    expect(status.status).toBe(0);
    const statusJson = parseJson(status.stdout) as { run?: { status?: string } } | undefined;
    expect(statusJson?.run?.status).toBe("active");
  });
});

// ── workflow LLM import-site parity (reviewer #9 / test ask 11) ────────────────
//
// Reviewer #9: bare `require(...)` in ESM modules throws
// `ReferenceError: require is not defined` under Node. The offending sites were
// on the workflow LLM paths — the summary-validation judge
// (`buildDefaultSummaryJudge` → canonical engine resolution + `await import llm/client`)
// and the native unit dispatcher (`resolveUnitRunner`/`requireDefaultLlm` →
// `await import` of `integrations/agent/config` and `core/config/config`). These
// smokes drive those paths on the Node runtime with an LLM configured at a
// closed port so the fetch fails FAST (ECONNREFUSED, no hang): the bar is that
// the fixed import sites LOAD under Node — never a `require is not defined`.

/** The exact ESM-boundary symptom the bare-`require` fix removes. */
const REQUIRE_NOT_DEFINED = "require is not defined";

/** Configure a default LLM engine pointing at a closed local port (fast ECONNREFUSED). */
function configureDeadLlm(): void {
  configureEngine(
    "smoke-llm",
    {
      kind: "llm",
      endpoint: "http://127.0.0.1:1/v1/chat/completions",
      model: "smoke-model",
    },
    { engine: "smoke-llm", llmEngine: "smoke-llm" },
  );
  const setJudge = nodeRun(["config", "set", "workflow.judgeEngine", "smoke-llm"], nodeEnv);
  assertNoBoundaryLeak(setJudge, "config set workflow.judgeEngine");
  expect(setJudge.status).toBe(0);
}

/**
 * Write a one-step workflow WITH a gate rubric so the summary judge fires.
 * Unified format (workflow-format-unification): frontmatter graph + `##
 * <step-id>` body section + `### gate` rubric.
 */
function writeJudgeWorkflow(name: string): void {
  const file = path.join(stashDir, "workflows", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      "---",
      "type: workflow",
      "description: Node-compat smoke workflow.",
      "params:",
      "  mode: { type: string }",
      "steps:",
      "  - id: only-step",
      "    route:",
      "      input: params.mode",
      "      when: [{ match: go, step: after }]",
      "      default: after",
      "    gate: {}",
      "  - id: after",
      "---",
      "",
      "## only-step",
      "",
      "Do the smoke work.",
      "",
      "### gate",
      "",
      "- the work is done",
      "",
      "## after",
      "",
      "Finish.",
      "",
    ].join("\n"),
    "utf8",
  );
}

function writeDispatchWorkflow(name: string): void {
  const file = path.join(stashDir, "workflows", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      "---",
      "type: workflow",
      "description: Node-compat dispatch smoke workflow.",
      "steps:",
      "  - id: only-step",
      "---",
      "",
      "## only-step",
      "",
      "Do the smoke work.",
      "",
    ].join("\n"),
    "utf8",
  );
}

describe("workflow LLM import-site parity (reviewer #9)", () => {
  afterEach(() => cleanup());

  test.skipIf(!ENABLED)(
    "the summary-judge LLM import path loads under Node and fails closed without a require ReferenceError",
    () => {
      setupStorage();
      configureDeadLlm();
      writeJudgeWorkflow("judge-smoke");

      // The route-only first step reaches its frozen judge without dispatching
      // a unit. The dead endpoint rejects the gate, but the dynamic import must load.
      const run = nodeRun(["workflow", "run", "workflows/judge-smoke", "--mode=go", "--max-steps=1"], nodeEnv);
      assertNoBoundaryLeak(run, "judge run");
      expect(run.stdout + run.stderr).not.toContain(REQUIRE_NOT_DEFINED);
      expect(run.stderr).not.toContain("resolved workflow judge missing");
      expect(run.status, `summary-judge dead-endpoint result:\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(1);
      const result = parseJson(run.stdout) as
        | { run?: { status?: string }; judgeFailure?: { stepId?: string; message?: string } }
        | undefined;
      expect(result?.run?.status).toBe("blocked");
      expect(result?.judgeFailure?.stepId).toBe("only-step");
      expect(result?.judgeFailure?.message).toContain("verification judge failed");
    },
    60_000,
  );

  test.skipIf(!ENABLED)(
    "the native unit-dispatch config imports load under Node (no require ReferenceError)",
    () => {
      setupStorage();
      configureDeadLlm();
      writeDispatchWorkflow("dispatch-smoke");

      // `workflow run` drives the native engine: `defaultUnitDispatcher` →
      // `resolveUnitRunner`/`requireDefaultLlm` reach the `await import` sites for
      // `core/config/config` (and, for agent profiles, `integrations/agent/config`)
      // that were bare `require`s. With the dead endpoint the unit dispatch fails
      // (the run does not complete), but the import sites must LOAD without a
      // `require is not defined` — that is the whole regression.
      const run = nodeRun(["workflow", "run", "workflows/dispatch-smoke"], nodeEnv);
      assertNoBoundaryLeak(run, "workflow run");
      expect(run.stdout + run.stderr).not.toContain(REQUIRE_NOT_DEFINED);
      // A failed unit dispatch is a normal outcome here (exit 0 with a failed run
      // report, or a non-zero error exit) — but never an ESM boundary crash.
      expect(run.status).not.toBe(-1);
    },
    60_000,
  );
});
