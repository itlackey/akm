/**
 * Regression test (#1168 review §3.1): a transient reflect failure (transport
 * error, parse error, timeout, budget abort, crash) must not write a `failed`
 * ledger row. That row advances `last_attempt_at`, so the negative feedback that
 * planned the ref would stop passing the signal delta until new feedback
 * arrives. Distill's transport failure writes no row for the same reason.
 * A guard rejection (`content_policy_reject`) is a verdict and still records.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { akmImprove } from "../../../src/commands/improve/improve";
import { saveConfig } from "../../../src/core/config/config";
import { appendEvent } from "../../../src/core/events";
import type { AkmDistillResult, AkmReflectResult } from "../../../src/core/improve-types";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { akmIndex } from "../../../src/indexer/indexer";
import { listImproveLedgerRows } from "../../../src/storage/repositories/improve-ledger-repository";
import { withImproveAutonomy, withTestImproveLlm } from "../../_helpers/improve-config";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  mutateScopedEnv,
  withIsolatedAkmStorage,
} from "../../_helpers/sandbox";

const dirCleanups: (() => void)[] = [];
let storage: IsolatedAkmStorage;

beforeEach(() => {
  const data = makeSandboxDir("akm-reflect-transient-data-");
  const state = makeSandboxDir("akm-reflect-transient-state-");
  dirCleanups.push(data.cleanup, state.cleanup);
  storage = withIsolatedAkmStorage({ AKM_DATA_DIR: data.dir, AKM_STATE_DIR: state.dir });
});

afterEach(() => {
  storage.cleanup();
  for (const cleanup of dirCleanups.splice(0)) cleanup();
});

async function runWithReflectFailure(reason: string): Promise<{ stash: string; mode: string | undefined }> {
  const { dir: stash, cleanup } = makeSandboxDir("akm-reflect-transient-stash-");
  dirCleanups.push(cleanup);
  fs.mkdirSync(path.join(stash, "skills", "deploy-guide"), { recursive: true });
  fs.writeFileSync(
    path.join(stash, "skills", "deploy-guide", "SKILL.md"),
    "---\ndescription: Deploy guide\nwhen_to_use: When deploying\n---\n\nDeploy carefully.\n",
    "utf8",
  );
  mutateScopedEnv("AKM_BUNDLE_DIR", stash);
  saveConfig(
    withImproveAutonomy(
      withTestImproveLlm({
        semanticSearchMode: "off",
        bundles: { stash: { path: stash, writable: true } },
        defaultBundle: "stash",
        defaultWriteTarget: "stash",
        index: { enrichment: { enabled: false } },
      }),
    ),
  );
  await akmIndex({ stashDir: stash, full: true });
  appendEvent({
    eventType: "feedback",
    ref: "stash//skills/deploy-guide",
    metadata: { signal: "negative", reason: "fixture" },
  });

  const result = await akmImprove({
    stashDir: stash,
    ensureIndexFn: async () => undefined,
    reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
    reflectFn: async (options): Promise<AkmReflectResult> =>
      ({
        schemaVersion: 2,
        ok: false,
        reason,
        error: `reflect failed: ${reason}`,
        ref: options.ref ?? "unknown",
        exitCode: null,
      }) as AkmReflectResult,
    distillFn: async (options): Promise<AkmDistillResult> => ({
      schemaVersion: 1,
      ok: true,
      outcome: "queued",
      inputRef: options.ref,
      proposalRef: `lessons/${options.ref.replace(/[:/]/g, "-")}-lesson`,
    }),
  });
  const mode = (result.actions ?? []).find(
    (a) => a.ref === "skills/deploy-guide" && a.mode.startsWith("reflect"),
  )?.mode;
  return { stash, mode };
}

function reflectRows(stash: string) {
  const db = openStateDatabase(getStateDbPath());
  try {
    return listImproveLedgerRows(db, stash, ["reflect"]);
  } finally {
    db.close();
  }
}

describe("improve loop: reflect failure and the signal cursor", () => {
  for (const reason of ["parse_error", "timeout", "aborted", "spawn_failed", "non_zero_exit"]) {
    test(`a ${reason} reflect failure writes no ledger row`, async () => {
      const { stash, mode } = await runWithReflectFailure(reason);
      expect(mode).toBe("reflect-failed");
      expect(reflectRows(stash)).toEqual([]);
    });
  }

  test("a guard rejection still records a failed row", async () => {
    const { stash, mode } = await runWithReflectFailure("content_policy_reject");
    expect(mode).toBe("reflect-guard-rejected");
    expect(reflectRows(stash).map((r) => r.outcome)).toEqual(["failed"]);
  });
});
