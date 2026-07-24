// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  listRecentImproveRunIds,
  loadImproveResult,
  withImproveResultDataDir,
} from "../../scripts/akm-eval/src/sources/improve-result";
import { buildEvalChildEnv, createSandbox } from "../../scripts/akm-eval/src/sources/sandbox";
import { makeSandboxDir, withEnvSync } from "../_helpers/sandbox";

const RUN_SCRIPT = path.resolve("scripts/akm-eval/src/run.ts");
const storageKeys = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "AKM_STASH_DIR",
  "AKM_CONFIG_DIR",
  "AKM_DATA_DIR",
  "AKM_CACHE_DIR",
  "AKM_STATE_DIR",
] as const;
const credentialKeys = [
  "AKM_LLM_API_KEY",
  "AKM_EMBED_API_KEY",
  "AKM_ENGINE_LOCAL_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "FAST_API_KEY",
] as const;
const unsafeParentKeys = [
  "XDG_RUNTIME_DIR",
  "AKM_CLAUDE_PROJECTS_DIR",
  "AKM_SESSION_ID",
  "OPENCODE_SESSION_ID",
  "CLAUDE_PROJECT_DIR",
] as const;
const loggedKeys = [...storageKeys, ...credentialKeys, ...unsafeParentKeys] as const;
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function sandboxDir(prefix: string): string {
  const sandbox = makeSandboxDir(prefix);
  cleanups.push(sandbox.cleanup);
  return sandbox.dir;
}

function initImproveDb(dataDir: string, runId: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "state.db"));
  try {
    db.exec(`
      CREATE TABLE improve_runs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        dry_run INTEGER NOT NULL DEFAULT 0,
        profile TEXT,
        strategy TEXT,
        result_json TEXT NOT NULL
      )
    `);
    db.prepare(
      "INSERT INTO improve_runs (id, started_at, dry_run, profile, strategy, result_json) VALUES (?, ?, 0, NULL, 'default', ?)",
    ).run(
      runId,
      "2026-07-23T00:00:00.000Z",
      JSON.stringify({
        schemaVersion: 2,
        ok: true,
        strategy: "default",
        scope: { mode: "all" },
        dryRun: false,
        memorySummary: { eligible: 0, derived: 0 },
        plannedRefs: [],
        actions: [],
      }),
    );
  } finally {
    db.close();
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

interface FakeAkmOptions {
  envLog?: string;
  improveStatus?: number;
  persistImproveResult?: boolean;
  improveResultOk?: boolean;
}

function writeFakeAkm(root: string, opts: FakeAkmOptions = {}): string {
  const file = path.join(root, "fake-akm");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
const keys = ${JSON.stringify(loggedKeys)};
const envLog = ${JSON.stringify(opts.envLog)};
if (envLog) {
  fs.appendFileSync(envLog, JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key]]))) + "\\n");
}
if (process.argv.includes("--version")) process.stdout.write("fake-akm 1.0.0\\n");
if (process.argv.includes("improve")) {
  if (${JSON.stringify(opts.persistImproveResult ?? true)}) {
    const dataDir = process.env.AKM_DATA_DIR;
    if (!dataDir) throw new Error("AKM_DATA_DIR is required");
    fs.mkdirSync(dataDir, { recursive: true });
    const db = new Database(path.join(dataDir, "state.db"));
    try {
      db.exec(\`
        CREATE TABLE IF NOT EXISTS improve_runs (
          id TEXT PRIMARY KEY,
          started_at TEXT NOT NULL,
          dry_run INTEGER NOT NULL DEFAULT 0,
          profile TEXT,
          strategy TEXT,
          result_json TEXT NOT NULL
        )
      \`);
      const runId = \`fake-improve-\${Date.now()}\`;
      db.prepare(
        "INSERT INTO improve_runs (id, started_at, dry_run, profile, strategy, result_json) VALUES (?, ?, 0, NULL, 'default', ?)",
      ).run(
        runId,
        new Date().toISOString(),
        JSON.stringify({
          schemaVersion: 2,
          ok: ${JSON.stringify(opts.improveResultOk ?? true)},
          strategy: "default",
          scope: { mode: "all" },
          dryRun: false,
          memorySummary: { eligible: 0, derived: 0 },
          plannedRefs: [],
          actions: [],
        }),
      );
    } finally {
      db.close();
    }
  }
  process.exit(${JSON.stringify(opts.improveStatus ?? 0)});
}
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

function prepareEmptySuite(root: string): { casesRoot: string; stash: string; out: string } {
  const casesRoot = path.join(root, "cases");
  const stash = path.join(root, "stash");
  const out = path.join(root, "out");
  fs.mkdirSync(path.join(casesRoot, "empty"), { recursive: true });
  fs.mkdirSync(stash, { recursive: true });
  return { casesRoot, stash, out };
}

function prepareErrorSuite(root: string): { casesRoot: string; stash: string; out: string } {
  const prepared = prepareEmptySuite(root);
  const suiteDir = path.join(prepared.casesRoot, "error-only");
  fs.mkdirSync(suiteDir, { recursive: true });
  fs.writeFileSync(
    path.join(suiteDir, "broken-retrieval.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "broken-retrieval",
      suite: "error-only",
      type: "retrieval",
      description: "Produces no valid evidence.",
      input: {},
      expected: {},
    })}\n`,
  );
  return prepared;
}

function prepareValidSuite(root: string): { casesRoot: string; stash: string; out: string } {
  const prepared = prepareEmptySuite(root);
  const suiteDir = path.join(prepared.casesRoot, "valid");
  fs.mkdirSync(suiteDir, { recursive: true });
  fs.writeFileSync(
    path.join(suiteDir, "valid-retrieval.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "valid-retrieval",
      suite: "valid",
      type: "retrieval",
      description: "Produces valid deterministic evidence.",
      input: { query: "anything" },
      expected: {},
    })}\n`,
  );
  return prepared;
}

function readOnlyRun(out: string): Record<string, unknown> {
  const runsDir = path.join(out, "runs");
  const runId = fs.readdirSync(runsDir, { withFileTypes: true }).find((entry) => entry.isDirectory())?.name;
  if (!runId) throw new Error(`no eval run under ${runsDir}`);
  return JSON.parse(fs.readFileSync(path.join(runsDir, runId, "eval-result.json"), "utf8")) as Record<string, unknown>;
}

describe("akm-eval sandbox isolation", () => {
  test("replaces hostile parent storage overrides", () => {
    const hostile: Record<string, string> = {
      ...Object.fromEntries(storageKeys.map((key) => [key, `/host/${key.toLowerCase()}`])),
      ...Object.fromEntries(unsafeParentKeys.map((key) => [key, `/host/${key.toLowerCase()}`])),
      ...Object.fromEntries(credentialKeys.map((key) => [key, `${key.toLowerCase()}-secret`])),
    };
    withEnvSync(hostile, () => {
      const sandbox = createSandbox({ inheritEnv: true });
      try {
        for (const key of storageKeys) {
          const value = sandbox.env[key];
          expect(value).not.toBe(hostile[key]);
          expect(value && isWithin(sandbox.root, value)).toBe(true);
        }
        expect(sandbox.env.AKM_CONFIG_DIR).toBe(path.join(sandbox.stashDir, ".akm"));
        expect(sandbox.env.PATH === process.env.PATH).toBe(true);
        for (const key of credentialKeys) expect(sandbox.env[key]).toBe(hostile[key]);
        for (const key of unsafeParentKeys) expect(sandbox.env[key]).toBeUndefined();
      } finally {
        sandbox.cleanup();
      }
    });
  });

  test("the narrow child env excludes host storage and session variables", () => {
    const parent = {
      PATH: "/bin",
      HOME: "/host/home",
      XDG_DATA_HOME: "/host/data",
      AKM_DATA_DIR: "/host/akm-data",
      AKM_CLAUDE_PROJECTS_DIR: "/host/claude",
      AKM_SESSION_ID: "host-session",
      OPENCODE_SESSION_ID: "opencode-session",
      XDG_RUNTIME_DIR: "/host/runtime",
      AKM_LLM_API_KEY: "llm-secret",
      AKM_EMBED_API_KEY: "embed-secret",
      AKM_ENGINE_LOCAL_API_KEY: "engine-secret",
      OPENAI_API_KEY: "openai-secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
      FAST_API_KEY: "config-referenced-secret",
      HTTPS_PROXY: "http://proxy.example",
    };

    expect(buildEvalChildEnv(parent)).toEqual({
      PATH: "/bin",
      AKM_LLM_API_KEY: "llm-secret",
      AKM_EMBED_API_KEY: "embed-secret",
      AKM_ENGINE_LOCAL_API_KEY: "engine-secret",
      OPENAI_API_KEY: "openai-secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
      FAST_API_KEY: "config-referenced-secret",
      HTTPS_PROXY: "http://proxy.example",
    });
  });

  test("improve-result reads stay on the explicitly scoped sandbox data dir", () => {
    const hostDataDir = sandboxDir("akm-eval-host-data");
    const sandbox = createSandbox();
    cleanups.push(sandbox.cleanup);
    initImproveDb(hostDataDir, "host-run");
    initImproveDb(sandbox.dataDir, "sandbox-run");

    withEnvSync({ AKM_DATA_DIR: hostDataDir }, () => {
      expect(listRecentImproveRunIds(10, sandbox.dataDir)).toEqual(["sandbox-run"]);
      expect(loadImproveResult("unused", "latest", { dataDir: sandbox.dataDir }).runId).toBe("sandbox-run");
      expect(withImproveResultDataDir(sandbox.dataDir, () => loadImproveResult("unused", "latest").runId)).toBe(
        "sandbox-run",
      );
    });
  });

  test("concurrent async improve-result scopes do not leak data directories", async () => {
    const firstDataDir = sandboxDir("akm-eval-scope-first");
    const secondDataDir = sandboxDir("akm-eval-scope-second");
    initImproveDb(firstDataDir, "first-run");
    initImproveDb(secondDataDir, "second-run");

    const [first, second] = await Promise.all([
      withImproveResultDataDir(firstDataDir, async () => {
        await Bun.sleep(15);
        return loadImproveResult("unused", "latest").runId;
      }),
      withImproveResultDataDir(secondDataDir, async () => {
        await Bun.sleep(1);
        return loadImproveResult("unused", "latest").runId;
      }),
    ]);

    expect(first).toBe("first-run");
    expect(second).toBe("second-run");
  });
});

describe("akm-eval zero-case validity", () => {
  test("records baseline zero-case runs as inconclusive without requiring fail flags", () => {
    const root = sandboxDir("akm-eval-zero-baseline");
    const { casesRoot, stash, out } = prepareEmptySuite(root);
    const result = spawnSync(
      "bun",
      [
        RUN_SCRIPT,
        "--suite",
        "empty",
        "--stash",
        stash,
        "--cases-dir",
        casesRoot,
        "--out",
        out,
        "--akm",
        writeFakeAkm(root),
        "--format",
        "none",
      ],
      { encoding: "utf8", env: process.env },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("inconclusive: zero executed cases");
    expect(readOnlyRun(out)).toMatchObject({
      metrics: {
        validity: {
          status: "inconclusive",
          executedCaseCount: 0,
          validEvidenceCaseCount: 0,
          errorCaseCount: 0,
          reasons: ["zero executed cases"],
        },
      },
    });
  });

  test("records paired zero-case runs as inconclusive and isolates every subprocess path", () => {
    const root = sandboxDir("akm-eval-zero-paired");
    const { casesRoot, stash, out } = prepareEmptySuite(root);
    const envLog = path.join(root, "env.jsonl");
    const hostile: Record<string, string> = {
      ...Object.fromEntries(storageKeys.map((key) => [key, `/host/${key.toLowerCase()}`])),
      ...Object.fromEntries(unsafeParentKeys.map((key) => [key, `/host/${key.toLowerCase()}`])),
      ...Object.fromEntries(credentialKeys.map((key) => [key, `${key.toLowerCase()}-secret`])),
    };
    const result = spawnSync(
      "bun",
      [
        RUN_SCRIPT,
        "--suite",
        "empty",
        "--mode",
        "paired",
        "--stash",
        stash,
        "--cases-dir",
        casesRoot,
        "--out",
        out,
        "--akm",
        writeFakeAkm(root, { envLog }),
        "--format",
        "none",
        "--keep-sandbox",
      ],
      {
        encoding: "utf8",
        env: { ...(process.env as Record<string, string>), ...hostile },
      },
    );

    const envelope = readOnlyRun(out) as {
      metrics: {
        validity: Record<string, unknown>;
        pairedImprove: { sandbox: string };
      };
    };
    const pairedRoot = envelope.metrics.pairedImprove.sandbox;
    cleanups.push(() => fs.rmSync(pairedRoot, { recursive: true, force: true }));

    expect(result.status).toBe(2);
    expect(envelope.metrics.validity).toEqual({
      status: "inconclusive",
      executedCaseCount: 0,
      validEvidenceCaseCount: 0,
      errorCaseCount: 0,
      baselineExecutedCaseCount: 0,
      baselineValidEvidenceCaseCount: 0,
      baselineErrorCaseCount: 0,
      reasons: ["baseline executed zero cases", "zero executed cases"],
    });
    const loggedEnvs = fs
      .readFileSync(envLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, string>);
    expect(loggedEnvs.length).toBeGreaterThanOrEqual(3);
    for (const loggedEnv of loggedEnvs) {
      for (const key of storageKeys) {
        const value = loggedEnv[key];
        expect(value).not.toBe(hostile[key]);
        expect(value && isWithin(pairedRoot, value)).toBe(true);
      }
      for (const key of credentialKeys) expect(loggedEnv[key]).toBe(hostile[key]);
      for (const key of unsafeParentKeys) expect(loggedEnv[key]).toBeUndefined();
    }
  });

  test("successful paired improve results keep an otherwise valid run conclusive", () => {
    const root = sandboxDir("akm-eval-successful-improve");
    const { casesRoot, stash, out } = prepareValidSuite(root);
    const result = spawnSync(
      "bun",
      [
        RUN_SCRIPT,
        "--suite",
        "valid",
        "--mode",
        "paired",
        "--stash",
        stash,
        "--cases-dir",
        casesRoot,
        "--out",
        out,
        "--akm",
        writeFakeAkm(root),
        "--format",
        "none",
      ],
      { encoding: "utf8", env: process.env },
    );

    expect(result.status).toBe(0);
    expect(readOnlyRun(out)).toMatchObject({
      metrics: {
        validity: { status: "conclusive", reasons: [] },
        pairedImprove: { resultOk: true, resultDryRun: false },
      },
      errors: [],
    });
  });

  test("failed paired improve commands make an otherwise valid run inconclusive", () => {
    const root = sandboxDir("akm-eval-failed-improve");
    const { casesRoot, stash, out } = prepareValidSuite(root);
    const result = spawnSync(
      "bun",
      [
        RUN_SCRIPT,
        "--suite",
        "valid",
        "--mode",
        "paired",
        "--stash",
        stash,
        "--cases-dir",
        casesRoot,
        "--out",
        out,
        "--akm",
        writeFakeAkm(root, { improveStatus: 1, improveResultOk: false }),
        "--format",
        "none",
      ],
      { encoding: "utf8", env: process.env },
    );

    const envelope = readOnlyRun(out) as {
      metrics: { validity: { status: string; reasons: string[] } };
      errors: Array<{ caseId: string; message: string }>;
    };
    expect(result.status).toBe(2);
    expect(envelope.metrics.validity.status).toBe("inconclusive");
    expect(envelope.metrics.validity.reasons).toContain("paired improve failed (exit 1)");
    expect(envelope.metrics.validity.reasons.some((reason) => reason.includes("reports ok=false"))).toBe(true);
    expect(envelope.errors).toContainEqual({ caseId: "paired-improve", message: "paired improve failed (exit 1)" });
  });

  test("missing paired improve results make an otherwise valid run inconclusive", () => {
    const root = sandboxDir("akm-eval-missing-improve-result");
    const { casesRoot, stash, out } = prepareValidSuite(root);
    const result = spawnSync(
      "bun",
      [
        RUN_SCRIPT,
        "--suite",
        "valid",
        "--mode",
        "paired",
        "--stash",
        stash,
        "--cases-dir",
        casesRoot,
        "--out",
        out,
        "--akm",
        writeFakeAkm(root, { persistImproveResult: false }),
        "--format",
        "none",
      ],
      { encoding: "utf8", env: process.env },
    );

    const envelope = readOnlyRun(out) as {
      metrics: { validity: { status: string; reasons: string[] } };
      errors: Array<{ caseId: string; message: string }>;
    };
    const missing = "paired improve produced no new persisted non-dry-run result";
    expect(result.status).toBe(2);
    expect(envelope.metrics.validity).toMatchObject({ status: "inconclusive", reasons: [missing] });
    expect(envelope.errors).toContainEqual({ caseId: "paired-improve", message: missing });
  });

  test("all-error runs are inconclusive and include case errors as validity reasons", () => {
    const root = sandboxDir("akm-eval-error-only");
    const { casesRoot, stash, out } = prepareErrorSuite(root);
    const result = spawnSync(
      "bun",
      [
        RUN_SCRIPT,
        "--suite",
        "error-only",
        "--stash",
        stash,
        "--cases-dir",
        casesRoot,
        "--out",
        out,
        "--akm",
        writeFakeAkm(root),
        "--format",
        "none",
      ],
      { encoding: "utf8", env: process.env },
    );

    const envelope = readOnlyRun(out) as {
      metrics: {
        validity: { status: string; reasons: string[]; validEvidenceCaseCount: number; errorCaseCount: number };
      };
    };
    expect(result.status).toBe(2);
    expect(envelope.metrics.validity).toMatchObject({
      status: "inconclusive",
      validEvidenceCaseCount: 0,
      errorCaseCount: 1,
    });
    expect(envelope.metrics.validity.reasons).toContain("no valid case evidence");
    expect(envelope.metrics.validity.reasons).toContain("case broken-retrieval error: case is missing `input.query`");
  });
});
