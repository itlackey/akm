// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-7.4 — the D6 read-once seam contract on `RunContext`.
 *
 * D6 (chunk-7 brief) makes three scope rules BINDING, each pinned below:
 *   (i)   the memo is NEVER run-wide — a memo minted for one verb invocation /
 *         pass region never serves a later one, so reflect/distill reads still
 *         observably happen at invoke time (fresh memo per `withFreshAssetMemo`);
 *   (ii)  write-through invalidation — `readAsset` after an in-run write of the
 *         same path (via `writeAsset` / `noteAssetWrite`) returns POST-write bytes;
 *   (iii) the prep-region memo is seeded only AFTER the mutating pre-loop passes
 *         return, so its first read observes the on-disk bytes those passes wrote.
 *
 * The seam is exercised with injected in-memory IO (no disk, no DB) so the memo
 * semantics are pinned deterministically and in isolation.
 */

import { describe, expect, test } from "bun:test";
import { createRunContext, type RunContextInit } from "../../../src/commands/improve/run-context";
import type { ProposalsContext } from "../../../src/commands/proposal/repository";
import type { AkmConfig } from "../../../src/core/config/config";
import type { EventsContext } from "../../../src/core/events";

/**
 * A tiny mutable in-memory file store standing in for disk. `reads` counts how
 * often the underlying reader was actually invoked, so a memo hit (which must
 * NOT re-read) is distinguishable from a genuine invoke-time read.
 */
function makeStore(initial: Record<string, string> = {}): {
  files: Map<string, string>;
  reads: string[];
  io: NonNullable<RunContextInit["io"]>;
} {
  const files = new Map(Object.entries(initial));
  const reads: string[] = [];
  return {
    files,
    reads,
    io: {
      readFile: (filePath: string): string => {
        reads.push(filePath);
        const bytes = files.get(filePath);
        if (bytes === undefined) throw new Error(`ENOENT: ${filePath}`);
        return bytes;
      },
      writeFile: (filePath: string, content: string): void => {
        files.set(filePath, content);
      },
    },
  };
}

function makeCtx(io: RunContextInit["io"], overrides: Partial<RunContextInit> = {}) {
  const init: RunContextInit = {
    stashDir: "/tmp/stash",
    config: {} as AkmConfig,
    eventsCtx: {} as EventsContext,
    proposalsCtx: {} as ProposalsContext,
    getLlmConfig: () => null,
    sourceRun: "run-7.4",
    dryRun: false,
    now: () => 1_700_000_000_000,
    io,
    ...overrides,
  };
  return createRunContext(init);
}

describe("RunContext.readAsset — memo scope (D6 rule i)", () => {
  test("the base context never memoizes: two reads re-invoke the reader (never run-wide)", () => {
    const store = makeStore({ "/a.md": "v1" });
    const ctx = makeCtx(store.io);

    expect(ctx.readAsset("/a.md")).toBe("v1");
    // Out-of-band change to the file (e.g. an accepted proposal apply mid-run).
    store.files.set("/a.md", "v2");
    // The base context has NO active memo, so the second read observes v2.
    expect(ctx.readAsset("/a.md")).toBe("v2");
    expect(store.reads).toEqual(["/a.md", "/a.md"]);
  });

  test("a forked memo caches within the scope; a SECOND fork reads fresh at invoke time", () => {
    const store = makeStore({ "/a.md": "v1" });
    const ctx = makeCtx(store.io);

    const invoke1 = ctx.withFreshAssetMemo();
    expect(invoke1.readAsset("/a.md")).toBe("v1");
    // Underlying file changes between invocations.
    store.files.set("/a.md", "v2");
    // Same forked scope → memo hit, no re-read, still v1.
    expect(invoke1.readAsset("/a.md")).toBe("v1");
    expect(store.reads).toEqual(["/a.md"]); // exactly one physical read so far

    // A fresh fork (the next verb invocation) must observe v2 — the memo is
    // NEVER shared across invocations.
    const invoke2 = ctx.withFreshAssetMemo();
    expect(invoke2.readAsset("/a.md")).toBe("v2");
    expect(store.reads).toEqual(["/a.md", "/a.md"]);
  });
});

describe("RunContext write-through invalidation (D6 rule ii)", () => {
  test("readAsset after writeAsset of the same path returns POST-write bytes", () => {
    const store = makeStore({ "/salience.md": "before" });
    const ctx = makeCtx(store.io).withFreshAssetMemo();

    expect(ctx.readAsset("/salience.md")).toBe("before");
    // The in-loop salience frontmatter stamp (distill.ts:816) writes the source.
    ctx.writeAsset("/salience.md", "after");
    // A later read in the SAME invocation must see the stamped bytes, not the
    // stale memo entry.
    expect(ctx.readAsset("/salience.md")).toBe("after");
    expect(store.files.get("/salience.md")).toBe("after"); // write reached the store
  });

  test("noteAssetWrite drops the memo entry so the next read re-reads from disk", () => {
    const store = makeStore({ "/a.md": "before" });
    const ctx = makeCtx(store.io).withFreshAssetMemo();

    expect(ctx.readAsset("/a.md")).toBe("before");
    // A write happened out-of-band (not through writeAsset) — invalidate by path.
    store.files.set("/a.md", "after");
    ctx.noteAssetWrite("/a.md");
    expect(ctx.readAsset("/a.md")).toBe("after");
  });

  test("writeAsset/noteAssetWrite on the base (memo-less) context are safe no-ops for the cache", () => {
    const store = makeStore({ "/a.md": "before" });
    const ctx = makeCtx(store.io);

    ctx.writeAsset("/a.md", "after"); // still writes through to the store
    expect(store.files.get("/a.md")).toBe("after");
    ctx.noteAssetWrite("/a.md"); // no memo to drop — must not throw
    expect(ctx.readAsset("/a.md")).toBe("after");
  });
});

describe("RunContext prep-region memo seeding (D6 rule iii)", () => {
  test("a memo forked AFTER a pre-loop write observes the written bytes on first read", () => {
    const store = makeStore({ "/asset.md": "original" });
    const runCtx = makeCtx(store.io);

    // Simulate a mutating pre-loop pass (runConsolidationPass op write) landing
    // on disk BEFORE the prep-region memo is created.
    store.files.set("/asset.md", "consolidated");

    // The prep-region memo is minted only now, after the pre-loop passes returned.
    const prepCtx = runCtx.withFreshAssetMemo();
    expect(prepCtx.readAsset("/asset.md")).toBe("consolidated");
  });
});

describe("RunContext carrier threading", () => {
  test("withFreshAssetMemo preserves every run-scoped carrier by reference", () => {
    const store = makeStore();
    const eventsCtx = { dbPath: "/tmp/state.db" } as EventsContext;
    const proposalsCtx = { dbPath: "/tmp/state.db" } as ProposalsContext;
    const signal = new AbortController().signal;
    const getLlmConfig = () => null;
    const ctx = makeCtx(store.io, { eventsCtx, proposalsCtx, signal, getLlmConfig });

    const forked = ctx.withFreshAssetMemo();
    expect(forked.stashDir).toBe("/tmp/stash");
    expect(forked.eventsCtx).toBe(eventsCtx);
    expect(forked.proposalsCtx).toBe(proposalsCtx);
    expect(forked.signal).toBe(signal);
    expect(forked.getLlmConfig).toBe(getLlmConfig);
    expect(forked.sourceRun).toBe("run-7.4");
    expect(forked.dryRun).toBe(false);
    expect(forked.now()).toBe(1_700_000_000_000);
  });
});
