// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Golden capture: `akm mv` move-transaction engine round-trip outcomes
 * (WI-04, plan §11 Chunk 0a / R3, engine 3 of 3). Chunk 0a brief §2.2,
 * `anchors.md` `mv-cli.ts:309-541` (`MoveJournal`, rollback, recovery),
 * `:543-673` (`applyMoveFilesystem` — the fsync + before-hash apply engine
 * outside the plan's named range: stage-divergence abort `:576`,
 * replace-divergence abort `:632`), `:453-474` (`validateCommittedMove`),
 * `:999-1018` (`persistMoveEvent`, also outside the plan's range),
 * `:1020-1080` (`finalizeMoveTransaction`).
 *
 * This suite pins file-tree / citer-rewrite / event outcomes so Chunk 6's
 * collapse into one FileChange transaction has a diff-reviewable
 * preservation oracle (plan §12.3). It is capture-only: no `src/` changes.
 * Drives the real `akm mv` CLI command path (there is no plain exported
 * function equivalent to `akmProposalAccept` — `mvCommand` is a citty
 * command) so `applyMoveFilesystem` and `persistMoveEvent` are exercised
 * end-to-end (brief §2.6 correction 5).
 *
 * Encoding (brief §3.2): journal phase sequences are informational data only
 * (never asserted against journal bytes/paths); refs are fixture-local
 * (`tests/fixtures/goldens/journal/fixture-refs.ts`, shared with WI-03);
 * "exactly-once" events are golden as counts, never a raw id-keyed map.
 *
 * Designation: `frozen-migration-input` (DESIGNATIONS.json) — preservation
 * oracle through Chunk 6.
 *
 * DEVIATION FROM BRIEF (recorded per the characterization-preserve protocol —
 * verified empirically by this suite's own capture run at HEAD `3d9ee7b`,
 * mirroring the WI-03 precedent of recording where the brief's textual
 * assumption about a surfaced error message did not survive contact with the
 * real code):
 *
 *  1. `_setMvMutationHookForTests` (`mv-cli.ts:358-360`) only fires at THREE
 *     named points — `index-rekeyed`, `state-<table>-rekeyed`,
 *     `mv-event-persisted` — all of them AFTER the filesystem commit
 *     (`finalizeMoveTransaction`'s re-key/event steps). It never fires
 *     between the citer STAGE window (`:576`) and the REPLACE window
 *     (`:632`) — both windows are inside `applyMoveFilesystem`, which runs
 *     entirely before any hook point. This suite instead uses two
 *     `src/`-change-free interception techniques: a `spyOn(fs.readFileSync)`
 *     keyed to the citer's absolute path AND a Buffer-mode (no `encoding`)
 *     call shape — which uniquely identifies `hashFile`'s divergence check
 *     at `:576`, distinct from the earlier `"utf8"`-mode planning read at
 *     `:1326` — for the STAGE window; and the `spyOn(fs.writeFileSync)`
 *     journal-phase-interception technique already established in
 *     `tests/commands/mv.test.ts` ("refuses to replace a citer that
 *     diverged after planning", keyed to the `"applying"` phase write) for
 *     the REPLACE window.
 *  2. The REPLACE window's surfaced error is NOT literally prefixed by
 *     "refusing to replace divergent citer": `applyMoveFilesystem`'s
 *     immediate self-heal (`if (!fs.existsSync(citer.absPath))
 *     fs.linkSync(citer.ownedPath, citer.absPath)`, run right before the
 *     throw at `:634`) restores the citer file to hold the EXTERNALLY
 *     MUTATED content before the outer `catch` runs `rollbackMoveJournal`.
 *     `rollbackMoveJournal`'s own per-citer divergence check then finds that
 *     same mutated content matches neither `originalHash` nor
 *     `replacementHash` and throws its OWN error
 *     (`cannot restore <path>: file diverged after exclusive ownership`),
 *     which the outer catch wraps as `Move failed (refusing to replace
 *     divergent citer <path>) and rollback failed (cannot restore <path>:
 *     file diverged after exclusive ownership). Recovery journal retained at
 *     <path>.` — the plan's named string is present but embedded
 *     (`.toContain(...)`), not a strict prefix. This is genuinely today's
 *     behavior (mirrors `tests/commands/mv.test.ts`'s own "refuses to
 *     replace a citer that diverged after planning" test, which for the same
 *     reason never asserts an exact/prefix message either). The move's
 *     journal is RETAINED (not cleaned up) in this outcome — the source file
 *     and all OTHER citers are still byte-identical, but this one citer and
 *     the transaction directory are left in the diverged/orphaned state the
 *     error itself reports; captured as-is per brief §1 ("capture, not
 *     aspiration").
 *  3. The STAGE window's error (`:576`) IS a clean, unwrapped prefix: at that
 *     point `journal` has not yet been assigned inside `applyMoveFilesystem`,
 *     so the outer catch's `else` branch (`cleanupMoveTransaction`) runs
 *     with no rollback attempt, and the original `Error("refusing to stage
 *     divergent citer <path>")` propagates unwrapped. Source, citer (beyond
 *     the test's own injected mutation), and target are all left untouched
 *     by the engine.
 */

import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { readEvents } from "../../src/core/events";
import { txnNamespaceDir } from "../../src/core/fs-txn";
import { getDbPath } from "../../src/core/paths";
import { closeDatabase, openExistingDatabase } from "../../src/storage/repositories/index-connection";
import * as indexDbModule from "../../src/storage/repositories/index-entries-repository";
import { runCliCapture } from "../_helpers/cli";
import { expectGolden, fileTreeManifest } from "../_helpers/golden";
import { makeSandboxDir, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";
import {
  MV_COMMITTED_DIVERGENCE_NAME,
  MV_COMMITTED_DIVERGENCE_TARGET_REL,
  MV_COMMITTED_DIVERGENCE_TRIGGER_NAME,
  MV_MOVE_BASE_NAME,
  MV_MOVE_BODY_CITER_NAME,
  MV_MOVE_FRONTMATTER_CITER_NAME,
  MV_MOVE_READONLY_CITER_NAME,
  MV_MOVE_TARGET_REL,
  MV_MOVE_TASK_YAML_NAME,
  MV_REPLACE_DIVERGENCE_CITER_NAME,
  MV_REPLACE_DIVERGENCE_NAME,
  MV_REPLACE_DIVERGENCE_TARGET_REL,
  MV_STAGE_DIVERGENCE_CITER_NAME,
  MV_STAGE_DIVERGENCE_NAME,
  MV_STAGE_DIVERGENCE_TARGET_REL,
  MV_TRANSIENT_REKEY_NAME,
  MV_TRANSIENT_REKEY_TARGET_REL,
  MV_TRANSIENT_REKEY_TRIGGER_NAME,
  MV_TRANSIENT_REKEY_TRIGGER_TARGET_REL,
  memoryRef,
  mvBodyCiterContent,
  mvFrontmatterCiterContent,
  mvSourceBody,
  mvTaskYamlContent,
} from "../fixtures/goldens/journal/fixture-refs";

const GOLDEN_PATH = "tests/fixtures/goldens/journal/move-txn.json";
const HEAD_SHA = "3d9ee7b1917e8c4872f135fe9993d94b61b36ed1";

interface MvOutput {
  ok: boolean;
  from: string;
  to: string;
  rewrote: Array<{ file: string; count: number }>;
  readOnlyCiters: Array<{ file: string; count: number }>;
  utilityPreserved: boolean;
  warnings?: string[];
}

interface ErrorEnvelope {
  ok: boolean;
  error: string;
  code?: string;
}

function seedAsset(root: string, relPath: string, content: string): string {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return abs;
}

/** Count of `mv` events matching `ref`, plus the distinct-idempotency-key shape (brief §3.2). */
function mvEventOutcome(ref: string): { matchingCount: number; distinctIdempotencyKeyCount: number } {
  const events = readEvents({ type: "mv", ref }).events;
  const keys = new Set(events.map((e) => String(e.metadata?.mutationTransactionId ?? "")));
  return { matchingCount: events.length, distinctIdempotencyKeyCount: keys.size };
}

function transactionsRoot(stashDir: string): string {
  // WI-6.3 mechanical repoint: the mv journal home moved from the in-stash
  // `.akm/mv-transactions` to the unified engine namespace for the stash.
  return txnNamespaceDir(stashDir);
}

function transactionsRootIsClean(stashDir: string): boolean {
  const root = transactionsRoot(stashDir);
  if (!fs.existsSync(root)) return true;
  return fs.readdirSync(root).length === 0;
}

// ── scenario 1: body + frontmatter + task-yaml citers + .derived.md twin ────

describe("goldens: mv move with citers + .derived twin (WI-04, R3)", () => {
  test("moves the file + twin, rewrites all three citer kinds, reports readOnlyCiters, emits exactly one mv event", async () => {
    const storage = withIsolatedAkmStorage();
    const roDir = makeSandboxDir("akm-goldens-mv-readonly");
    try {
      const fromRef = memoryRef(MV_MOVE_BASE_NAME);
      const baseBody = mvSourceBody("base");
      const twinBody = mvSourceBody("twin");
      const sourcePath = seedAsset(storage.stashDir, `memories/${MV_MOVE_BASE_NAME}.md`, baseBody);
      const twinPath = seedAsset(storage.stashDir, `memories/${MV_MOVE_BASE_NAME}.derived.md`, twinBody);
      const bodyCiterPath = seedAsset(
        storage.stashDir,
        `knowledge/${MV_MOVE_BODY_CITER_NAME}.md`,
        mvBodyCiterContent(fromRef),
      );
      const frontmatterCiterPath = seedAsset(
        storage.stashDir,
        `knowledge/${MV_MOVE_FRONTMATTER_CITER_NAME}.md`,
        mvFrontmatterCiterContent(fromRef),
      );
      const taskYamlPath = seedAsset(
        storage.stashDir,
        `tasks/${MV_MOVE_TASK_YAML_NAME}.yml`,
        mvTaskYamlContent(fromRef),
      );
      const roCiterPath = seedAsset(
        roDir.dir,
        `knowledge/${MV_MOVE_READONLY_CITER_NAME}.md`,
        mvBodyCiterContent(fromRef),
      );
      const roCiterRaw = fs.readFileSync(roCiterPath, "utf8");
      writeSandboxConfig({
        semanticSearchMode: "off",
        sources: [{ type: "filesystem", name: "shared", path: roDir.dir, writable: false }],
      });

      const { code, stdout } = await runCliCapture(["mv", fromRef, MV_MOVE_TARGET_REL]);
      expect(code).toBe(0);
      const json = JSON.parse(stdout) as MvOutput;
      expect(json.ok).toBe(true);
      const toRef = memoryRef(MV_MOVE_TARGET_REL);
      expect(json.from).toBe(fromRef);
      expect(json.to).toBe(toRef);

      // Every citer kind rewritten exactly once.
      const findRewrote = (rel: string) => json.rewrote.find((r) => r.file.endsWith(rel));
      expect(findRewrote(`knowledge/${MV_MOVE_BODY_CITER_NAME}.md`)?.count).toBe(1);
      expect(findRewrote(`knowledge/${MV_MOVE_FRONTMATTER_CITER_NAME}.md`)?.count).toBe(1);
      expect(findRewrote(`tasks/${MV_MOVE_TASK_YAML_NAME}.yml`)?.count).toBe(1);

      // Read-only source citer reported, never written.
      expect(json.readOnlyCiters).toEqual([{ file: roCiterPath, count: 1 }]);
      expect(fs.readFileSync(roCiterPath, "utf8")).toBe(roCiterRaw);

      // Source + twin moved byte-for-byte.
      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(fs.existsSync(twinPath)).toBe(false);
      const newPath = path.join(storage.stashDir, "memories", `${MV_MOVE_TARGET_REL}.md`);
      const newTwinPath = path.join(storage.stashDir, "memories", `${MV_MOVE_TARGET_REL}.derived.md`);
      expect(fs.readFileSync(newPath, "utf8")).toBe(baseBody);
      expect(fs.readFileSync(newTwinPath, "utf8")).toBe(twinBody);

      // Citer content actually rewritten to the new ref.
      expect(fs.readFileSync(bodyCiterPath, "utf8")).toContain(`See ${toRef} for details.`);
      expect(fs.readFileSync(frontmatterCiterPath, "utf8")).toContain(`- ${toRef}`);
      expect(fs.readFileSync(taskYamlPath, "utf8")).toBe(`schedule: "0 9 * * *"\nprompt: ${toRef}\n`);

      // Exactly one mv event.
      const mvEvent = mvEventOutcome(toRef);
      expect(mvEvent.matchingCount).toBe(1);
      expect(mvEvent.distinctIdempotencyKeyCount).toBe(1);
      expect(transactionsRootIsClean(storage.stashDir)).toBe(true);
    } finally {
      roDir.cleanup();
      storage.cleanup();
    }
  });
});

// ── scenario 2a: divergent citer at the STAGE window (mv-cli.ts:576) ────────

describe("goldens: mv divergent-citer abort at the STAGE window (WI-04, R3)", () => {
  test('citer mutated before staging -> "refusing to stage divergent citer", byte-identical after', async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const fromRef = memoryRef(MV_STAGE_DIVERGENCE_NAME);
      const sourceBody = mvSourceBody("stage");
      const sourcePath = seedAsset(storage.stashDir, `memories/${MV_STAGE_DIVERGENCE_NAME}.md`, sourceBody);
      const citerPath = seedAsset(
        storage.stashDir,
        `knowledge/${MV_STAGE_DIVERGENCE_CITER_NAME}.md`,
        mvBodyCiterContent(fromRef),
      );

      const mutatedContent = `EXTERNAL STAGE MUTATION ${fromRef}\n`;
      const originalRead = fs.readFileSync;
      let triggered = false;
      const spy = spyOn(fs, "readFileSync").mockImplementation(((
        filePath: fs.PathOrFileDescriptor,
        options?: unknown,
      ) => {
        if (!triggered && options === undefined && path.resolve(String(filePath)) === path.resolve(citerPath)) {
          // Buffer-mode read: hashFile's divergence check at mv-cli.ts:576 —
          // distinct from the earlier "utf8"-mode planning read at :1326
          // (see file-header DEVIATION 1).
          triggered = true;
          fs.writeFileSync(citerPath, mutatedContent, "utf8");
        }
        return originalRead(filePath, options as fs.EncodingOption);
      }) as typeof fs.readFileSync);

      const result = await runCliCapture(["mv", fromRef, MV_STAGE_DIVERGENCE_TARGET_REL]);
      spy.mockRestore();

      expect(triggered).toBe(true);
      expect(result.code).not.toBe(0);
      const envelope = JSON.parse(result.stderr) as ErrorEnvelope;
      expect(envelope.error).toContain("refusing to stage divergent citer");
      // The citer is untouched by the engine beyond our own injected mutation.
      expect(fs.readFileSync(citerPath, "utf8")).toBe(mutatedContent);
      expect(fs.existsSync(sourcePath)).toBe(true);
      expect(fs.readFileSync(sourcePath, "utf8")).toBe(sourceBody);
      expect(fs.existsSync(path.join(storage.stashDir, "memories", `${MV_STAGE_DIVERGENCE_TARGET_REL}.md`))).toBe(
        false,
      );
    } finally {
      storage.cleanup();
    }
  });
});

// ── scenario 2b: divergent citer at the REPLACE window (mv-cli.ts:632) ──────

describe("goldens: mv divergent-citer abort at the REPLACE window (WI-04, R3)", () => {
  test('citer mutated between stage and replace -> wrapped "refusing to replace divergent citer" (see DEVIATION 2)', async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const fromRef = memoryRef(MV_REPLACE_DIVERGENCE_NAME);
      const sourceBody = mvSourceBody("replace");
      const sourcePath = seedAsset(storage.stashDir, `memories/${MV_REPLACE_DIVERGENCE_NAME}.md`, sourceBody);
      const citerPath = seedAsset(
        storage.stashDir,
        `knowledge/${MV_REPLACE_DIVERGENCE_CITER_NAME}.md`,
        mvBodyCiterContent(fromRef),
      );

      const mutatedContent = `EXTERNAL REPLACE MUTATION ${fromRef}\n`;
      const originalWrite = fs.writeFileSync;
      let triggered = false;
      const spy = spyOn(fs, "writeFileSync").mockImplementation(((
        file: fs.PathOrFileDescriptor,
        data: string | NodeJS.ArrayBufferView,
        ...args: unknown[]
      ) => {
        const result = originalWrite(file, data, ...(args as [fs.WriteFileOptions?]));
        if (!triggered && String(file).endsWith("journal.json.tmp") && String(data).includes('"phase": "applying"')) {
          triggered = true;
          originalWrite(citerPath, mutatedContent, "utf8");
        }
        return result;
      }) as typeof fs.writeFileSync);

      const result = await runCliCapture(["mv", fromRef, MV_REPLACE_DIVERGENCE_TARGET_REL]);
      spy.mockRestore();

      expect(triggered).toBe(true);
      expect(result.code).not.toBe(0);
      const envelope = JSON.parse(result.stderr) as ErrorEnvelope;
      expect(envelope.error).toContain("refusing to replace divergent citer");
      // Source is untouched; the citer holds the externally-mutated content
      // (self-healed back to it, then rollback of THIS file fails — see
      // file-header DEVIATION 2); nothing lands at the target.
      expect(fs.existsSync(sourcePath)).toBe(true);
      expect(fs.readFileSync(sourcePath, "utf8")).toBe(sourceBody);
      expect(fs.readFileSync(citerPath, "utf8")).toBe(mutatedContent);
      expect(fs.existsSync(path.join(storage.stashDir, "memories", `${MV_REPLACE_DIVERGENCE_TARGET_REL}.md`))).toBe(
        false,
      );
    } finally {
      storage.cleanup();
    }
  });
});

// ── scenario 3: divergent-committed-target recovery refusal ─────────────────

describe("goldens: mv divergent-committed-target recovery refusal (WI-04, R3)", () => {
  test('committed target mutated externally -> "Cannot finalize move" (validateCommittedMove :453-474)', async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const fromRef = memoryRef(MV_COMMITTED_DIVERGENCE_NAME);
      seedAsset(storage.stashDir, `memories/${MV_COMMITTED_DIVERGENCE_NAME}.md`, mvSourceBody("committed"));
      const targetPath = path.join(storage.stashDir, "memories", `${MV_COMMITTED_DIVERGENCE_TARGET_REL}.md`);

      const mutatedContent = "EXTERNAL POST-COMMIT MUTATION\n";
      const originalRename = fs.renameSync;
      let triggered = false;
      const spy = spyOn(fs, "renameSync").mockImplementation(((oldPath: fs.PathLike, newPath: fs.PathLike) => {
        const result = originalRename(oldPath, newPath);
        if (!triggered && String(newPath).endsWith("journal.json")) {
          const journal = JSON.parse(fs.readFileSync(String(newPath), "utf8")) as { phase?: string };
          if (journal.phase === "filesystem-committed") {
            triggered = true;
            fs.writeFileSync(targetPath, mutatedContent, "utf8");
          }
        }
        return result;
      }) as typeof fs.renameSync);

      const result = await runCliCapture(["mv", fromRef, MV_COMMITTED_DIVERGENCE_TARGET_REL]);
      spy.mockRestore();

      expect(triggered).toBe(true);
      expect(result.code).not.toBe(0);
      const envelope = JSON.parse(result.stderr) as ErrorEnvelope;
      expect(envelope.error).toContain("Cannot finalize move");
      expect(fs.readFileSync(targetPath, "utf8")).toBe(mutatedContent);
      // Filesystem commit is irreversible (mv-cli.ts:1394-1395): the journal
      // is retained (not cleaned up) for a later mutation to resolve.
      expect(transactionsRootIsClean(storage.stashDir)).toBe(false);

      // A later mv (unrelated) also fails: recoverInterruptedMoveTransactions
      // re-runs validateCommittedMove and hits the same divergence.
      seedAsset(storage.stashDir, `memories/${MV_COMMITTED_DIVERGENCE_TRIGGER_NAME}.md`, mvSourceBody("trigger"));
      const trigger = await runCliCapture([
        "mv",
        memoryRef(MV_COMMITTED_DIVERGENCE_TRIGGER_NAME),
        "committed-divergence-trigger-new",
      ]);
      expect(trigger.code).not.toBe(0);
      const triggerEnvelope = JSON.parse(trigger.stderr) as ErrorEnvelope;
      expect(triggerEnvelope.error).toContain("Cannot finalize move");
    } finally {
      storage.cleanup();
    }
  });
});

// ── scenario 4: transient re-key failure retains journal, completes forward ─

describe("goldens: mv transient re-key failure retains journal, next mutation completes forward (WI-04, R3)", () => {
  test("index row re-key throws transiently -> journal retained, then a later mv finishes it forward (mv.test.ts:353)", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      seedAsset(storage.stashDir, `memories/${MV_TRANSIENT_REKEY_NAME}.md`, mvSourceBody("rekey"));
      seedAsset(storage.stashDir, `memories/${MV_TRANSIENT_REKEY_TRIGGER_NAME}.md`, mvSourceBody("rekey-trigger"));
      const indexed = await runCliCapture(["search", "bootstrap-index-probe"]);
      expect(indexed.code).toBe(0);

      let db = openExistingDatabase(getDbPath());
      const before = db
        .prepare("SELECT id FROM entries WHERE entry_key LIKE ?")
        .get(`%:${memoryRef(MV_TRANSIENT_REKEY_NAME)}`) as { id: number } | null | undefined;
      closeDatabase(db);
      expect(before).toBeDefined();

      const spy = spyOn(indexDbModule, "rekeyEntryInPlace").mockImplementation(() => {
        throw new Error("injected transient re-key failure (WI-04 golden capture)");
      });
      const failed = await runCliCapture(["mv", memoryRef(MV_TRANSIENT_REKEY_NAME), MV_TRANSIENT_REKEY_TARGET_REL]);
      expect(failed.code).not.toBe(0);
      const journalRetainedAfterFailure = fs.existsSync(transactionsRoot(storage.stashDir));
      spy.mockRestore();

      const recovered = await runCliCapture([
        "mv",
        memoryRef(MV_TRANSIENT_REKEY_TRIGGER_NAME),
        MV_TRANSIENT_REKEY_TRIGGER_TARGET_REL,
      ]);
      expect(recovered.stderr).toBe("");
      expect(recovered.code).toBe(0);

      db = openExistingDatabase(getDbPath());
      const after = db
        .prepare("SELECT id FROM entries WHERE entry_key LIKE ?")
        .get(`%:${memoryRef(MV_TRANSIENT_REKEY_TARGET_REL)}`) as { id: number } | null | undefined;
      closeDatabase(db);

      expect(journalRetainedAfterFailure).toBe(true);
      expect(after?.id).toBe(before?.id);
      expect(transactionsRootIsClean(storage.stashDir)).toBe(true);
    } finally {
      storage.cleanup();
    }
  });
});

// ── Golden fixture capture ──────────────────────────────────────────────────
//
// Re-runs a representative slice of the scenarios above (fresh sandboxes) to
// assemble the committed golden fixture, kept independent of the assertion
// tests so capture never depends on bun:test's within-file execution order.
describe("golden fixture: serialize mv move-transaction outcomes (WI-04, R3)", () => {
  test("golden fixture: move-txn.json", async () => {
    // -- move with citers + twin --
    const moveWithCitersOutcome = await (async () => {
      const storage = withIsolatedAkmStorage();
      const roDir = makeSandboxDir("akm-goldens-mv-readonly-capture");
      try {
        const fromRef = memoryRef(MV_MOVE_BASE_NAME);
        seedAsset(storage.stashDir, `memories/${MV_MOVE_BASE_NAME}.md`, mvSourceBody("base"));
        seedAsset(storage.stashDir, `memories/${MV_MOVE_BASE_NAME}.derived.md`, mvSourceBody("twin"));
        seedAsset(storage.stashDir, `knowledge/${MV_MOVE_BODY_CITER_NAME}.md`, mvBodyCiterContent(fromRef));
        seedAsset(
          storage.stashDir,
          `knowledge/${MV_MOVE_FRONTMATTER_CITER_NAME}.md`,
          mvFrontmatterCiterContent(fromRef),
        );
        seedAsset(storage.stashDir, `tasks/${MV_MOVE_TASK_YAML_NAME}.yml`, mvTaskYamlContent(fromRef));
        const roCiterPath = seedAsset(
          roDir.dir,
          `knowledge/${MV_MOVE_READONLY_CITER_NAME}.md`,
          mvBodyCiterContent(fromRef),
        );
        writeSandboxConfig({
          semanticSearchMode: "off",
          sources: [{ type: "filesystem", name: "shared", path: roDir.dir, writable: false }],
        });

        const { code, stdout } = await runCliCapture(["mv", fromRef, MV_MOVE_TARGET_REL]);
        const json = JSON.parse(stdout) as MvOutput;
        const toRef = memoryRef(MV_MOVE_TARGET_REL);
        return {
          ok: code === 0 && json.ok,
          from: json.from,
          to: json.to,
          // json.rewrote[].file is already a stash-relative posix path
          // (mv-cli.ts:1334/:1404 -- plan.relPath = toPosix(path.relative(stashDir, absPath))),
          // unlike json.readOnlyCiters[].file below (an ABSOLUTE path, since
          // a read-only source lives outside the writable stash).
          rewroteRelPaths: json.rewrote.map((r) => r.file).sort(),
          rewroteCounts: Object.fromEntries(json.rewrote.map((r) => [r.file, r.count])),
          readOnlyCiterCount: json.readOnlyCiters.length,
          readOnlyCiterRelPathWithinRoDir: json.readOnlyCiters[0]
            ? path.relative(roDir.dir, json.readOnlyCiters[0].file).split(path.sep).join("/")
            : null,
          readOnlyCiterCountsMatch: json.readOnlyCiters.every((r) => r.count === 1),
          readOnlyCiterFileUntouched: fs.readFileSync(roCiterPath, "utf8") === mvBodyCiterContent(fromRef),
          fileTree: fileTreeManifest(storage.stashDir),
          mvEvent: mvEventOutcome(toRef),
          transactionsRootClean: transactionsRootIsClean(storage.stashDir),
        };
      } finally {
        roDir.cleanup();
        storage.cleanup();
      }
    })();

    // -- stage-window divergent-citer abort --
    const stageDivergenceOutcome = await (async () => {
      const storage = withIsolatedAkmStorage();
      try {
        const fromRef = memoryRef(MV_STAGE_DIVERGENCE_NAME);
        const sourceBody = mvSourceBody("stage");
        const sourcePath = seedAsset(storage.stashDir, `memories/${MV_STAGE_DIVERGENCE_NAME}.md`, sourceBody);
        const citerPath = seedAsset(
          storage.stashDir,
          `knowledge/${MV_STAGE_DIVERGENCE_CITER_NAME}.md`,
          mvBodyCiterContent(fromRef),
        );
        const mutatedContent = `EXTERNAL STAGE MUTATION ${fromRef}\n`;
        const originalRead = fs.readFileSync;
        let triggered = false;
        const spy = spyOn(fs, "readFileSync").mockImplementation(((
          filePath: fs.PathOrFileDescriptor,
          options?: unknown,
        ) => {
          if (!triggered && options === undefined && path.resolve(String(filePath)) === path.resolve(citerPath)) {
            triggered = true;
            fs.writeFileSync(citerPath, mutatedContent, "utf8");
          }
          return originalRead(filePath, options as fs.EncodingOption);
        }) as typeof fs.readFileSync);

        const result = await runCliCapture(["mv", fromRef, MV_STAGE_DIVERGENCE_TARGET_REL]);
        spy.mockRestore();
        const envelope = result.code !== 0 ? (JSON.parse(result.stderr) as ErrorEnvelope) : null;
        return {
          triggered,
          exitNonZero: result.code !== 0,
          errorContainsExpectedText: envelope?.error.includes("refusing to stage divergent citer") ?? false,
          sourceUntouched: fs.existsSync(sourcePath) && fs.readFileSync(sourcePath, "utf8") === sourceBody,
          citerHoldsOnlyTestMutation: fs.readFileSync(citerPath, "utf8") === mutatedContent,
          targetCreated: fs.existsSync(path.join(storage.stashDir, "memories", `${MV_STAGE_DIVERGENCE_TARGET_REL}.md`)),
        };
      } finally {
        storage.cleanup();
      }
    })();

    // -- replace-window divergent-citer abort --
    const replaceDivergenceOutcome = await (async () => {
      const storage = withIsolatedAkmStorage();
      try {
        const fromRef = memoryRef(MV_REPLACE_DIVERGENCE_NAME);
        const sourceBody = mvSourceBody("replace");
        const sourcePath = seedAsset(storage.stashDir, `memories/${MV_REPLACE_DIVERGENCE_NAME}.md`, sourceBody);
        const citerPath = seedAsset(
          storage.stashDir,
          `knowledge/${MV_REPLACE_DIVERGENCE_CITER_NAME}.md`,
          mvBodyCiterContent(fromRef),
        );
        const mutatedContent = `EXTERNAL REPLACE MUTATION ${fromRef}\n`;
        const originalWrite = fs.writeFileSync;
        let triggered = false;
        const spy = spyOn(fs, "writeFileSync").mockImplementation(((
          file: fs.PathOrFileDescriptor,
          data: string | NodeJS.ArrayBufferView,
          ...args: unknown[]
        ) => {
          const result = originalWrite(file, data, ...(args as [fs.WriteFileOptions?]));
          if (!triggered && String(file).endsWith("journal.json.tmp") && String(data).includes('"phase": "applying"')) {
            triggered = true;
            originalWrite(citerPath, mutatedContent, "utf8");
          }
          return result;
        }) as typeof fs.writeFileSync);

        const result = await runCliCapture(["mv", fromRef, MV_REPLACE_DIVERGENCE_TARGET_REL]);
        spy.mockRestore();
        const envelope = result.code !== 0 ? (JSON.parse(result.stderr) as ErrorEnvelope) : null;
        return {
          triggered,
          exitNonZero: result.code !== 0,
          errorContainsExpectedText: envelope?.error.includes("refusing to replace divergent citer") ?? false,
          sourceUntouched: fs.existsSync(sourcePath) && fs.readFileSync(sourcePath, "utf8") === sourceBody,
          citerHoldsOnlyTestMutation: fs.readFileSync(citerPath, "utf8") === mutatedContent,
          targetCreated: fs.existsSync(
            path.join(storage.stashDir, "memories", `${MV_REPLACE_DIVERGENCE_TARGET_REL}.md`),
          ),
        };
      } finally {
        storage.cleanup();
      }
    })();

    // -- divergent-committed-target recovery refusal --
    const committedDivergenceOutcome = await (async () => {
      const storage = withIsolatedAkmStorage();
      try {
        const fromRef = memoryRef(MV_COMMITTED_DIVERGENCE_NAME);
        seedAsset(storage.stashDir, `memories/${MV_COMMITTED_DIVERGENCE_NAME}.md`, mvSourceBody("committed"));
        const targetPath = path.join(storage.stashDir, "memories", `${MV_COMMITTED_DIVERGENCE_TARGET_REL}.md`);
        const mutatedContent = "EXTERNAL POST-COMMIT MUTATION\n";
        const originalRename = fs.renameSync;
        let triggered = false;
        const spy = spyOn(fs, "renameSync").mockImplementation(((oldPath: fs.PathLike, newPath: fs.PathLike) => {
          const result = originalRename(oldPath, newPath);
          if (!triggered && String(newPath).endsWith("journal.json")) {
            const journal = JSON.parse(fs.readFileSync(String(newPath), "utf8")) as { phase?: string };
            if (journal.phase === "filesystem-committed") {
              triggered = true;
              fs.writeFileSync(targetPath, mutatedContent, "utf8");
            }
          }
          return result;
        }) as typeof fs.renameSync);

        const result = await runCliCapture(["mv", fromRef, MV_COMMITTED_DIVERGENCE_TARGET_REL]);
        spy.mockRestore();
        const envelope = result.code !== 0 ? (JSON.parse(result.stderr) as ErrorEnvelope) : null;

        seedAsset(storage.stashDir, `memories/${MV_COMMITTED_DIVERGENCE_TRIGGER_NAME}.md`, mvSourceBody("trigger"));
        const trigger = await runCliCapture([
          "mv",
          memoryRef(MV_COMMITTED_DIVERGENCE_TRIGGER_NAME),
          "committed-divergence-trigger-new",
        ]);
        const triggerEnvelope = trigger.code !== 0 ? (JSON.parse(trigger.stderr) as ErrorEnvelope) : null;

        return {
          triggered,
          exitNonZero: result.code !== 0,
          errorContainsExpectedText: envelope?.error.includes("Cannot finalize move") ?? false,
          journalRetained: !transactionsRootIsClean(storage.stashDir),
          laterUnrelatedMoveAlsoRefusedForward: triggerEnvelope !== null && trigger.code !== 0,
          laterErrorAlsoContainsExpectedText: triggerEnvelope?.error.includes("Cannot finalize move") ?? false,
        };
      } finally {
        storage.cleanup();
      }
    })();

    // -- transient re-key failure retains journal, next mutation forward --
    const transientRekeyOutcome = await (async () => {
      const storage = withIsolatedAkmStorage();
      try {
        seedAsset(storage.stashDir, `memories/${MV_TRANSIENT_REKEY_NAME}.md`, mvSourceBody("rekey"));
        seedAsset(storage.stashDir, `memories/${MV_TRANSIENT_REKEY_TRIGGER_NAME}.md`, mvSourceBody("rekey-trigger"));
        await runCliCapture(["search", "bootstrap-index-probe"]);
        let db = openExistingDatabase(getDbPath());
        const before = db
          .prepare("SELECT id FROM entries WHERE entry_key LIKE ?")
          .get(`%:${memoryRef(MV_TRANSIENT_REKEY_NAME)}`) as { id: number } | null | undefined;
        closeDatabase(db);

        const spy = spyOn(indexDbModule, "rekeyEntryInPlace").mockImplementation(() => {
          throw new Error("injected transient re-key failure (WI-04 golden capture)");
        });
        const failed = await runCliCapture(["mv", memoryRef(MV_TRANSIENT_REKEY_NAME), MV_TRANSIENT_REKEY_TARGET_REL]);
        const journalRetainedAfterFailure = fs.existsSync(transactionsRoot(storage.stashDir));
        spy.mockRestore();

        const recovered = await runCliCapture([
          "mv",
          memoryRef(MV_TRANSIENT_REKEY_TRIGGER_NAME),
          MV_TRANSIENT_REKEY_TRIGGER_TARGET_REL,
        ]);
        db = openExistingDatabase(getDbPath());
        const after = db
          .prepare("SELECT id FROM entries WHERE entry_key LIKE ?")
          .get(`%:${memoryRef(MV_TRANSIENT_REKEY_TARGET_REL)}`) as { id: number } | null | undefined;
        closeDatabase(db);

        return {
          firstAttemptFailed: failed.code !== 0,
          journalRetainedAfterFailure,
          secondMoveSucceeded: recovered.code === 0,
          rowIdPreserved: after?.id === before?.id,
          transactionsRootCleanAfterRecovery: transactionsRootIsClean(storage.stashDir),
        };
      } finally {
        storage.cleanup();
      }
    })();

    expectGolden(GOLDEN_PATH, {
      scenario: "mv move-transaction round-trip outcomes (WI-04, R3, engine 3 of 3)",
      capturedAtHead: HEAD_SHA,
      notes: [
        "No journal bytes/paths asserted -- journal phase sequences are informational only (brief S3.2 rule 4); " +
          "Chunk 6 replaces the journal engines. Only observable outcomes (file trees, citer rewrites, exactly-once " +
          "events, abort error text, recovery end-states) are the preserved contract.",
        "Post-filesystem-commit is roll-forward-only (mv-cli.ts:1394-1395, comment: 'Filesystem commit is " +
          "irreversible. Any finalization error leaves the journal for the next mutation to finish forward; it " +
          "never rolls back.') -- the divergent-committed-target scenario pins this: the journal is RETAINED (not " +
          "cleaned up, not rolled back) and a later unrelated mv also refuses forward with the same error, until " +
          "the divergence is resolved out-of-band.",
        "DEVIATION from the brief's testsFirst description (recorded in full in this file's header comment): " +
          "_setMvMutationHookForTests only fires post-filesystem-commit, never between the stage (:576) and " +
          "replace (:632) windows, so this suite uses spyOn interception instead (a src/-change-free technique, " +
          "one of them already established in tests/commands/mv.test.ts); and the REPLACE window's real surfaced " +
          "error is a wrapped 'Move failed (refusing to replace divergent citer <path>) and rollback failed " +
          "(cannot restore <path>: file diverged after exclusive ownership).' string -- the plan's named text is " +
          "present but embedded, not a strict prefix (mirrors mv.test.ts's own such test, which for the same " +
          "reason never asserts an exact/prefix message either). The STAGE window's error IS a clean unwrapped " +
          "prefix, since `journal` was never assigned at that point in applyMoveFilesystem.",
      ],
      moveWithCiters: moveWithCitersOutcome,
      stageDivergence: stageDivergenceOutcome,
      replaceDivergence: replaceDivergenceOutcome,
      committedDivergence: committedDivergenceOutcome,
      transientRekey: transientRekeyOutcome,
    });
  });
});
