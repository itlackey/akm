// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Integration tests for the Layer-2 proactive-maintenance selector inside the
 * `akm improve` eligibility flow:
 *  - DISABLED by default (no selection when the process flag is off).
 *  - When enabled, a never-reflected asset with NO feedback and NO retrieval
 *    signal (so neither the signal-delta gate nor P0-A would pick it) is folded
 *    into the reflect candidate set and the proactive_selected event + result
 *    summary are emitted.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { AkmDistillResult } from "../../../src/commands/improve/distill";
import { akmImprove } from "../../../src/commands/improve/improve";
import type { AkmReflectResult } from "../../../src/commands/improve/reflect";
import { saveConfig } from "../../../src/core/config/config";
import { readEvents } from "../../../src/core/events";
import { akmIndex } from "../../../src/indexer/indexer";
import { writeSkill } from "../../_helpers/assets";
import { withIsolatedAkmStorage } from "../../_helpers/sandbox";

const cleanups: Array<() => void> = [];

// Sanctioned isolation: sets AKM_STASH_DIR + all XDG_* to sandboxed temp dirs
// and returns a restoring cleanup (see tests/_helpers/sandbox.ts). Each call
// yields a fresh isolated stash for one test case.
function isolatedStash(): string {
  const iso = withIsolatedAkmStorage();
  cleanups.push(iso.cleanup);
  return iso.stashDir;
}

async function buildIndex(stashDir: string): Promise<void> {
  saveConfig({ semanticSearchMode: "off" });
  await akmIndex({ stashDir, full: true });
}

const okReflect = (ref: string): AkmReflectResult => ({
  schemaVersion: 1,
  ok: true,
  proposal: {
    id: `p-${ref.replace(/[^a-z0-9]/gi, "-")}`,
    ref,
    status: "pending",
    source: "reflect",
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    payload: { content: "# proposal" },
  },
  ref,
  agentProfile: "test",
  durationMs: 1,
});

const okDistill = (ref: string): AkmDistillResult => ({
  schemaVersion: 1,
  ok: true,
  outcome: "queued",
  inputRef: ref,
  lessonRef: `lesson:${ref.replace(/[:/]/g, "-")}-lesson`,
});

const noopIndexFns = {
  ensureIndexFn: async () => false,
  reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
};

function enabledConfig(overrides?: Record<string, unknown>): import("../../../src/core/config/config").AkmConfig {
  return {
    semanticSearchMode: "off",
    improve: {
      strategies: {
        default: {
          processes: {
            // keep noisy passes out of the way
            consolidate: { enabled: false },
            memoryInference: { enabled: false },
            graphExtraction: { enabled: false },
            extract: { enabled: false },
            proactiveMaintenance: { enabled: true, ...(overrides ?? {}) },
          },
        },
      },
    },
  } as import("../../../src/core/config/config").AkmConfig;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("proactive maintenance — explicitly disabled", () => {
  test("a never-reflected, no-signal asset is NOT selected when the process is off", async () => {
    const stash = isolatedStash();
    writeSkill(stash, "deploy", "Deploy steps.");
    await buildIndex(stash);

    const reflected: string[] = [];
    const res = await akmImprove({
      scope: "skill",
      stashDir: stash,
      // The `default` profile now ships proactiveMaintenance ON (the sustaining
      // lane), so this test must disable it explicitly to pin the "off" behaviour.
      config: enabledConfig({ enabled: false }),
      minRetrievalCount: 5, // P0-A would also not pick (no retrievals)
      ...noopIndexFns,
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(reflected).not.toContain("skill:deploy");
    expect(res.proactiveMaintenance).toBeUndefined();
    const { events } = readEvents({ type: "proactive_selected" });
    expect(events.length).toBe(0);
  });
});

describe("proactive maintenance — enabled selects due assets into the reflect set", () => {
  test("never-reflected, no-feedback, no-retrieval asset flows into reflect via the selector", async () => {
    const stash = isolatedStash();
    writeSkill(stash, "deploy", "Deploy steps.");
    await buildIndex(stash);

    const reflected: string[] = [];
    const res = await akmImprove({
      scope: "skill",
      stashDir: stash,
      config: enabledConfig(),
      minRetrievalCount: 5, // ensure P0-A is NOT the path (no retrievals at all)
      ...noopIndexFns,
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    // The ONLY eligibility path that can surface this ref is proactive maintenance.
    expect(reflected).toContain("skill:deploy");

    expect(res.proactiveMaintenance).toBeDefined();
    expect(res.proactiveMaintenance?.selected).toBeGreaterThanOrEqual(1);
    expect(res.proactiveMaintenance?.neverReflected).toBeGreaterThanOrEqual(1);

    // Aggregated observability event (exactly one per run, not per ref).
    const { events } = readEvents({ type: "proactive_selected" });
    expect(events.length).toBe(1);
    expect((events[0].metadata as { count?: number }).count).toBeGreaterThanOrEqual(1);
  });

  test("maxPerRun bounds how many due assets are folded in", async () => {
    const stash = isolatedStash();
    for (let i = 0; i < 5; i++) writeSkill(stash, `s${i}`, `Body ${i}.`);
    await buildIndex(stash);

    const reflected: string[] = [];
    const res = await akmImprove({
      scope: "skill",
      stashDir: stash,
      config: enabledConfig({ maxPerRun: 2 }),
      minRetrievalCount: 5,
      ...noopIndexFns,
      reflectFn: async ({ ref }) => {
        if (ref) reflected.push(ref);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref }) => okDistill(ref ?? ""),
    });

    expect(res.proactiveMaintenance?.dueTotal).toBe(5);
    expect(res.proactiveMaintenance?.selected).toBe(2);
    expect(reflected.length).toBe(2);
  });
});
