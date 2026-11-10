// Classification: opens a real state.db (the proposal queue) through akmExtract and akmHealth.
//
// #1289: a writing extraction checks that its proposal queue has a writable owner before it
// spends model work, and `akm health` reports the same finding for enabled learning.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmHealth } from "../../src/commands/health";
import { akmExtract } from "../../src/commands/improve/extract";
import { listProposals } from "../../src/commands/proposal/repository";
import type { AkmConfig } from "../../src/core/config/config";
import { ConfigError, UsageError } from "../../src/core/errors";
import { getStateDbPath, openStateDatabase } from "../../src/core/state-db";
import type { SessionData, SessionLogHarness } from "../../src/integrations/session-logs/types";
import { upsertExtractedSession } from "../../src/storage/repositories/extract-sessions-repository";
import {
  type IsolatedAkmStorage,
  useBundleConfig,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
const tempDirs: string[] = [];
beforeEach(() => {
  storage = withIsolatedAkmStorage();
});
afterEach(() => {
  storage.cleanup();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  for (const sub of ["memories", "lessons", "knowledge"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  return dir;
}

const CONNECTION = {
  default: { endpoint: "http://localhost:11434/v1/chat/completions", models: { fast: "test-model" } },
};

function extractStrategy(enabled: boolean) {
  return {
    strategy: "extract",
    strategies: {
      extract: { processes: { extract: { enabled, indexSessions: false, triage: { enabled: false } } } },
    },
  };
}

/** A config that registers `bundles` and turns extraction on or off. */
function configWith(bundles: Record<string, { path: string; writable: boolean }> | undefined, enabled = true) {
  return {
    semanticSearchMode: "auto",
    ...(bundles ? { bundles, defaultBundle: Object.keys(bundles)[0] } : {}),
    connections: CONNECTION,
    improve: extractStrategy(enabled),
  } as unknown as AkmConfig;
}

function session(): SessionData {
  const filePath = "/tmp/fake/s1.jsonl";
  const endedAt = Date.now() - 60_000;
  const ref = { harness: "claude", sessionId: "s1", filePath, startedAt: endedAt - 3_600_000, endedAt, title: "s1" };
  const event = (role: "user" | "assistant", text: string, ts: number) => ({
    harness: "claude",
    text,
    ts,
    sessionId: "s1",
    role,
    filePath,
  });
  return {
    ref,
    events: [
      event("user", "user message: explain how to recover from VPN-disconnect during deploy", endedAt - 3_000_000),
      event("assistant", "agent: deploy.sh hangs without VPN. The error message is misleading.", endedAt - 2_000_000),
    ],
    inlineRefs: [],
  };
}

function harness(): SessionLogHarness {
  const data = session();
  return {
    name: "claude",
    isAvailable: () => true,
    listSessions: () => [data.ref],
    readSession: () => data,
  };
}

const candidate = {
  type: "memory",
  name: "vpn-before-deploy",
  description: "Deployment requires a working VPN connection before starting.",
  body: "Connect the corporate VPN before running deploy.sh, which otherwise stalls while pushing to stage.",
  confidence: 0.9,
  evidence: "The session demonstrated the deployment failure without VPN.",
};

/** One extraction of the fake session; `config` is also written where proposal minting reads it. */
async function extract(stash: string, config: AkmConfig, options: { dryRun?: boolean } = {}) {
  writeSandboxConfig(config as unknown as Record<string, unknown>);
  const calls = { count: 0 };
  const run = () =>
    akmExtract({
      type: "claude",
      stashDir: stash,
      config,
      harnesses: [harness()],
      ...(options.dryRun ? { dryRun: true } : {}),
      chat: async () => {
        calls.count += 1;
        return JSON.stringify({ candidates: [candidate] });
      },
    });
  return { run, calls };
}

const pending = (stash: string) => listProposals(stash, { status: "pending" }, { dbPath: getStateDbPath() });

describe("extract checks its proposal destination before any model call (#1289)", () => {
  test("a primary no bundle owns, beside an external read-only bundle: no model call, no proposal", async () => {
    const primary = makeDir("akm-primary-");
    const external = makeDir("akm-external-");
    const { run, calls } = await extract(primary, configWith({ external: { path: external, writable: false } }));
    await expect(run()).rejects.toThrow(ConfigError);
    expect(calls.count).toBe(0);
    expect(pending(primary)).toHaveLength(0);
  });

  test("an explicitly read-only primary: no model call, no proposal, config untouched", async () => {
    const primary = makeDir("akm-primary-");
    const config = configWith({ stash: { path: primary, writable: false } });
    const { run, calls } = await extract(primary, config);
    const configPath = path.join(process.env.XDG_CONFIG_HOME ?? "", "akm", "config.json");
    const before = fs.readFileSync(configPath, "utf8");
    await expect(run()).rejects.toThrow(UsageError);
    expect(calls.count).toBe(0);
    expect(pending(primary)).toHaveLength(0);
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
  });

  test("a writable primary persists as before", async () => {
    const primary = makeDir("akm-primary-");
    const { run, calls } = await extract(primary, configWith({ stash: { path: primary, writable: true } }));
    const result = await run();
    expect(result.ok).toBe(true);
    expect(calls.count).toBe(1);
    expect(result.candidatesCreated).toBe(1);
    expect(pending(primary)).toHaveLength(1);
  });

  test("a non-writing preview does not need a writable owner", async () => {
    const primary = makeDir("akm-primary-");
    const { run, calls } = await extract(primary, configWith({ stash: { path: primary, writable: false } }), {
      dryRun: true,
    });
    const result = await run();
    expect(result.ok).toBe(true);
    expect(calls.count).toBe(1);
    expect(result.sessions[0]?.previewRefs).toHaveLength(1);
    expect(pending(primary)).toHaveLength(0);
  });

  test("extraction disabled by the strategy returns before the check", async () => {
    const primary = makeDir("akm-primary-");
    const config = configWith({ stash: { path: primary, writable: false } }, false);
    writeSandboxConfig(config as unknown as Record<string, unknown>);
    const result = await akmExtract({
      type: "claude",
      stashDir: primary,
      config,
      improveProfile: config.improve?.strategies?.extract,
      harnesses: [harness()],
      chat: async () => {
        throw new Error("no model call expected");
      },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/disabled/);
  });
});

describe("health reports the same proposal destination finding for enabled learning (#1289)", () => {
  const targetCheck = async () =>
    (await akmHealth({ since: "7d" })).advisories.find((c) => c.name === "proposal-queue");

  test("warns for an explicitly read-only primary", async () => {
    const primary = makeDir("akm-primary-");
    writeSandboxConfig(configWith({ stash: { path: primary, writable: false } }) as unknown as Record<string, unknown>);
    useBundleConfig(primary);
    const check = await targetCheck();
    expect(check?.status).toBe("warn");
    expect(check?.message).toMatch(/not writable/);
  });

  test("passes for a writable primary", async () => {
    const primary = makeDir("akm-primary-");
    writeSandboxConfig(configWith({ stash: { path: primary, writable: true } }) as unknown as Record<string, unknown>);
    useBundleConfig(primary);
    expect((await targetCheck())?.status).toBe("pass");
  });

  test("passes for an implicit primary", async () => {
    const primary = makeDir("akm-primary-");
    writeSandboxConfig(configWith(undefined) as unknown as Record<string, unknown>);
    useBundleConfig(primary);
    expect((await targetCheck())?.status).toBe("pass");
  });

  test("is not a finding when learning is deliberately disabled", async () => {
    const primary = makeDir("akm-primary-");
    writeSandboxConfig(
      configWith({ stash: { path: primary, writable: false } }, false) as unknown as Record<string, unknown>,
    );
    useBundleConfig(primary);
    expect((await targetCheck())?.status).toBe("unknown");
  });

  test("warns when the strategy is off but extraction ran recently (a hook-driven machine)", async () => {
    const primary = makeDir("akm-primary-");
    writeSandboxConfig(
      configWith({ stash: { path: primary, writable: false } }, false) as unknown as Record<string, unknown>,
    );
    useBundleConfig(primary);
    const db = openStateDatabase();
    try {
      upsertExtractedSession(db, {
        harness: "claude",
        sessionId: "s1",
        processedAt: new Date().toISOString(),
        outcome: "no_candidates",
        candidateCount: 0,
        proposalCount: 0,
        contentHash: "h",
      });
    } finally {
      db.close();
    }
    expect((await targetCheck())?.status).toBe("warn");
  });
});
