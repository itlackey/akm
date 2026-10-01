// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Integration tests for the Layer-2 proactive-maintenance selector inside the
 * `akm improve` eligibility flow:
 *  - DISABLED by default (no selection when the process flag is off).
 *  - When enabled, a never-reflected asset with NO feedback and NO retrieval
 *    signal (so the signal-delta gate would not pick it) is selected and
 *    scored, and the proactive_selected event + result summary are emitted. It
 *    is never planned for reflect: only negative feedback (or an explicit ref
 *    scope) plans a rewrite, so improve does not rewrite on a proactive cadence.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { akmImprove } from "../../../../src/commands/improve/improve";
import { saveConfig } from "../../../../src/core/config/config";
import { appendEvent, readEvents } from "../../../../src/core/events";
import type { AkmDistillResult, AkmReflectResult } from "../../../../src/core/improve-types";
import { openStateDatabase } from "../../../../src/core/state-db";
import { akmIndex } from "../../../../src/indexer/indexer";
import { writeSkill } from "../../../_helpers/assets";
import { withTestImproveLlm } from "../../../_helpers/improve-config";
import { withIsolatedAkmStorage } from "../../../_helpers/sandbox";

const cleanups: Array<() => void> = [];

// Sanctioned isolation: sets AKM_BUNDLE_DIR + all XDG_* to sandboxed temp dirs
// and returns a restoring cleanup (see tests/_helpers/sandbox.ts). Each call
// yields a fresh isolated stash for one test case.
function isolatedStash(): string {
  const iso = withIsolatedAkmStorage();
  cleanups.push(iso.cleanup);
  return iso.stashDir;
}

async function buildIndex(stashDir: string): Promise<void> {
  saveConfig(withTestImproveLlm({ semanticSearchMode: "off" }));
  await akmIndex({ stashDir, full: true });
}

const okReflect = (ref: string): AkmReflectResult => ({
  schemaVersion: 2,
  ok: true,
  proposal: {
    id: `p-${ref.replace(/[^a-z0-9]/gi, "-")}`,
    ref,
    status: "pending",
    source: "reflect",
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    payload: { content: "# proposal" },
    changes: [{ path: "lessons/proposal.md", after: "# proposal", op: "update" }],
    proposedTarget: { source: "stash", root: "/tmp/stash" },
  },
  ref,
  engine: "test",
  durationMs: 1,
});

const okDistill = (ref: string): AkmDistillResult => ({
  schemaVersion: 1,
  ok: true,
  outcome: "queued",
  inputRef: ref,
  proposalRef: `lessons/${ref.replace(/[:/]/g, "-")}-lesson`,
});

const noopIndexFns = {
  ensureIndexFn: async () => false,
  reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
};

function enabledConfig(overrides?: Record<string, unknown>): import("../../../../src/core/config/config").AkmConfig {
  return withTestImproveLlm({
    semanticSearchMode: "off",
    improve: {
      strategies: {
        default: {
          processes: {
            // keep noisy passes out of the way
            consolidate: { enabled: false },
            memoryInference: { enabled: false },
            extract: { enabled: false },
            proactiveMaintenance: { enabled: true, ...(overrides ?? {}) },
          },
        },
      },
    },
  } as import("../../../../src/core/config/config").AkmConfig);
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The refs a run scored: only a ref in the scored pool gets an `asset_outcome` row. */
function scoredRefs(): string[] {
  const db = openStateDatabase();
  try {
    return (db.prepare("SELECT asset_ref FROM asset_outcome").all() as Array<{ asset_ref: string }>).map(
      (row) => row.asset_ref,
    );
  } finally {
    db.close();
  }
}

describe("proactive maintenance — explicitly disabled", () => {
  test("a never-reflected, no-signal asset is NOT selected when the process is off", async () => {
    const stash = isolatedStash();
    writeSkill(stash, "deploy", "Deploy steps.");
    await buildIndex(stash);

    const reflected: string[] = [];
    const res = await akmImprove({
      scope: "skill",
      stashDir: stash,
      // Keep the opt-out explicit so this test does not depend on a shipped preset.
      config: enabledConfig({ enabled: false }),
      ...noopIndexFns,
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(reflected).not.toContain("skills/deploy");
    expect(res.proactiveMaintenance).toBeUndefined();
    const { events } = readEvents({ type: "proactive_selected" });
    expect(events.length).toBe(0);
  });
});

describe("proactive maintenance — enabled selects and scores due assets, and never plans a reflect", () => {
  test("never-reflected, no-feedback, no-retrieval asset is selected and scored, not reflected", async () => {
    const stash = isolatedStash();
    writeSkill(stash, "deploy", "Deploy steps.");
    await buildIndex(stash);

    const reflected: string[] = [];
    const res = await akmImprove({
      scope: "skill",
      stashDir: stash,
      config: enabledConfig(),
      ...noopIndexFns,
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    // The ONLY path that can surface this ref is proactive maintenance, and it scores the ref: it plans nothing.
    expect(scoredRefs().some((ref) => ref.endsWith("skills/deploy"))).toBe(true);
    expect(reflected).toEqual([]);
    expect(res.plannedRefs).toEqual([]);

    expect(res.proactiveMaintenance).toBeDefined();
    expect(res.proactiveMaintenance?.selected).toBeGreaterThanOrEqual(1);
    expect(res.proactiveMaintenance?.neverReflected).toBeGreaterThanOrEqual(1);

    // Aggregated observability event (exactly one per run, not per ref).
    const { events } = readEvents({ type: "proactive_selected" });
    expect(events.length).toBe(1);
    expect((events[0]!.metadata as { count?: number }).count).toBeGreaterThanOrEqual(1);
  });

  test("maxPerRun bounds how many due assets are selected", async () => {
    const stash = isolatedStash();
    for (let i = 0; i < 5; i++) writeSkill(stash, `s${i}`, `Body ${i}.`);
    await buildIndex(stash);

    const reflected: string[] = [];
    const res = await akmImprove({
      scope: "skill",
      stashDir: stash,
      config: enabledConfig({ maxPerRun: 2 }),
      ...noopIndexFns,
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(res.proactiveMaintenance?.dueTotal).toBe(5);
    expect(res.proactiveMaintenance?.selected).toBe(2);
    expect(scoredRefs()).toHaveLength(2);
    expect(reflected).toEqual([]);
  });

  test("the shipped proactive-maintenance strategy still runs: negative feedback is reflected, the lane's pick is only selected", async () => {
    const stash = isolatedStash();
    writeSkill(stash, "complained", "Names a removed flag.");
    writeSkill(stash, "quiet", "Never reflected, no feedback.");
    await buildIndex(stash);
    appendEvent({
      eventType: "feedback",
      ref: "stash//skills/complained",
      metadata: { signal: "negative", reason: "names a removed flag" },
    });

    const reflected: string[] = [];
    const res = await akmImprove({
      scope: "skill",
      stashDir: stash,
      config: withTestImproveLlm({ semanticSearchMode: "off" }),
      strategy: "proactive-maintenance",
      ...noopIndexFns,
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(res.ok).toBe(true);
    expect(reflected).toEqual(["skills/complained"]);
    expect(res.proactiveMaintenance?.selectedRefs).toEqual(["skills/quiet"]);
  });
});
