// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Issue #758 — full `add → blocked-install → rollback` lifecycle against a
 * dangerous fixture, asserting **config.json / akm.lock parity**.
 *
 * Relationship to `vault-dangerous-key-install-gate.test.ts`: that suite calls
 * `auditInstalledStashForDangerousKeys` directly and proves the gate's decision
 * is fail-CLOSED (the install is BLOCKED). It says nothing about what the
 * blocked attempt LEFT BEHIND, because it never runs an install at all — it
 * hands the audit a bare temp dir as both stash root and rollback target.
 *
 * That was the open waiver in
 * `docs/architecture/testing/manual-testing-checklist.md` §24.2 ("Durability" →
 * "full source lifecycle rollback", waiver expiry 0.9.1): *"no test walks
 * add→blocked-install→rollback against a dangerous fixture"*, whose named
 * verification is *"asserting config.json/akm.lock parity"*. The waiver lists
 * the lifecycle surfaces as **config / lock / root / index / events**.
 *
 * These tests drive the REAL `akm bundle add` CLI end-to-end (`runCliCapture`)
 * so every step the production path takes runs in order — `akmAdd` →
 * config `bundles` upsert → `upsertLockEntry` → `akmIndex` → `appendEvent` →
 * the dangerous-key audit → `akmRemove` rollback → reindex. The only seam is
 * `syncFromRef`, spied so the "download" materializes a local copy of
 * `tests/fixtures/manual-qa/dangerous-bundle/` instead of hitting a registry
 * (the same seam `source-qa-fixes.test.ts` / `update-destructive-confirm.test.ts`
 * already use to drive registry installs offline). A LOCAL-path add is
 * deliberately NOT used: `akmAdd` routes local refs to `addLocalSource`, which
 * writes no lock entry at all, so it cannot exercise lock parity.
 *
 * The fixture carries `NODE_OPTIONS=…` in `env/runtime.env` — a literal member
 * of `DANGEROUS_ENV_KEYS` (`--require` module-load RCE), reached by the
 * recursive `env/` scan — plus `knowledge/source-marker.md`, whose indexed row
 * is what makes the "no orphaned index entry" assertion non-vacuous.
 *
 * Surfaces asserted per test: config.json (byte-level), akm.lock (byte-level),
 * the materialized content root, and the search index. The events stream is
 * deliberately NOT rolled back — see the comment on `readAddEventTargets`.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG } from "../../src/core/config/config";
import { readEvents } from "../../src/core/events";
import { getConfigPath, getDbPath, getLockfilePath } from "../../src/core/paths";
import * as syncFromRefModule from "../../src/sources/providers/sync-from-ref";
import { closeDatabase, openReadonlyExistingDatabase } from "../../src/storage/repositories/index-connection";
import { getAllEntries } from "../../src/storage/repositories/index-entries-repository";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, makeSandboxDir, withIsolatedAkmStorage, withTTY } from "../_helpers/sandbox";

/** The shipped dangerous fixture (`env/runtime.env` carries `NODE_OPTIONS`). */
const DANGEROUS_FIXTURE = path.resolve(import.meta.dir, "../fixtures/manual-qa/dangerous-bundle");
const DANGEROUS_REF = "npm:qa-dangerous-bundle";
const SAFE_REF = "npm:qa-safe-bundle";

let storage: IsolatedAkmStorage;
const disposers: Array<() => void> = [];

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  storage.cleanup();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A disposable directory outside the storage sandbox, used as a content root. */
function sandboxDir(prefix: string): string {
  const created = makeSandboxDir(prefix);
  disposers.push(created.cleanup);
  return created.dir;
}

/**
 * A materialized copy of the dangerous fixture. Copied, never used in place:
 * the rollback deletes the content root, which against the repo path would
 * delete the checked-in fixture.
 */
function materializeDangerousBundle(): string {
  const root = sandboxDir("akm-758-danger");
  fs.cpSync(DANGEROUS_FIXTURE, root, { recursive: true });
  // Guard the premise rather than trusting the fixture: this whole suite is
  // meaningless if the fixture stops carrying a dangerous key.
  expect(fs.readFileSync(path.join(root, "env", "runtime.env"), "utf8")).toContain("NODE_OPTIONS=");
  return root;
}

/** A materialized bundle with only benign env keys — the install that must SURVIVE. */
function materializeSafeBundle(): string {
  const root = sandboxDir("akm-758-safe");
  fs.mkdirSync(path.join(root, "knowledge"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "knowledge", "safe-marker.md"),
    "---\ntype: knowledge\ndescription: Marker proving the previously-installed bundle survived\n---\n\n# Safe Source Marker\n\nThe unique marker is `qa-safe-source-marker`.\n",
  );
  fs.mkdirSync(path.join(root, "env"), { recursive: true });
  fs.writeFileSync(path.join(root, "env", "app.env"), "API_TOKEN=abc\nDB_URL=postgres://localhost/db\n");
  return root;
}

/**
 * Run `akm bundle add <ref>` with `syncFromRef` resolving to `contentRoot`, as
 * a non-TTY stdin and without `--allow-dangerous-env-keys` — the fail-closed
 * configuration the gate is specified for.
 *
 * stdin's TTY-ness is forced rather than inherited: on a TTY the audit takes
 * the interactive branch and blocks on `p.confirm`, so a suite that merely
 * assumed non-TTY would hang when someone ran `bun test` from a terminal.
 */
async function addBundleNonInteractive(ref: string, contentRoot: string): Promise<{ code: number; stderr: string }> {
  const spy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
    id: ref,
    source: "npm",
    ref,
    artifactUrl: `https://registry.npmjs.org/${ref.slice(4)}/-/${ref.slice(4)}-1.0.0.tgz`,
    contentDir: contentRoot,
    cacheDir: contentRoot,
    extractedDir: contentRoot,
    resolvedVersion: "1.0.0",
    integrity: "sha512-qa-fixture",
    syncedAt: "2026-08-10T00:00:00.000Z",
    writable: false,
  });
  try {
    // Non-TTY is the fail-closed arm of the gate: no prompt, refuse outright.
    const result = await withTTY(false, () => runCliCapture(["bundle", "add", ref]));
    return { code: result.code, stderr: result.stderr };
  } finally {
    spy.mockRestore();
  }
}

// ── Surface readers ──────────────────────────────────────────────────────────

// Resolved through the real helpers, NOT rebuilt from `storage.*`. `getConfigDir`
// has three branches (AKM_CONFIG_DIR, XDG/APPDATA, transient-AKM_BUNDLE_DIR) and
// `getDataDir` differs again on win32; a hand-joined path agrees with them only
// by coincidence on Linux. It would fail OPEN if it ever stopped agreeing —
// `readOrNull` returns null for a path that is simply wrong, and the
// "no trace of the refused bundle" assertions below would pass against nothing.
const configPath = getConfigPath;
const lockfilePath = getLockfilePath;

/** Raw bytes of a lifecycle file, or `null` when the file does not exist. */
function readOrNull(target: string): string | null {
  return fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
}

interface LifecycleSnapshot {
  configJson: string | null;
  lockfile: string | null;
}

function snapshotLifecycleFiles(): LifecycleSnapshot {
  return { configJson: readOrNull(configPath()), lockfile: readOrNull(lockfilePath()) };
}

/** Every indexed row, as `{ bundleId, filePath }` — enough to spot an orphan. */
function readIndexedRows(): Array<{ bundleId: string; filePath: string }> {
  const db = openReadonlyExistingDatabase(getDbPath());
  if (!db) return [];
  try {
    return getAllEntries(db).map((row) => ({ bundleId: row.bundleId, filePath: row.filePath }));
  } finally {
    closeDatabase(db);
  }
}

/**
 * `target` metadata of every recorded `add` event.
 *
 * The events stream is an append-only AUDIT LOG of attempts, not installed
 * state, and `akm bundle add` appends its `add` event before the audit runs.
 * A refused install therefore stays visible here on purpose — an operator
 * investigating a blocked install needs the attempt on record. Asserted
 * explicitly so this stays a decision rather than an accident: it is the one
 * surface the rollback deliberately does not revert.
 */
function readAddEventTargets(): string[] {
  // Filtered by the query, not after a capped fetch: with `limit` the `add` rows
  // could be pushed out of the window by unrelated event volume.
  return readEvents({ type: "add" }).events.map((event) =>
    String((event.metadata as { target?: unknown } | undefined)?.target ?? ""),
  );
}

// ── Assertions ───────────────────────────────────────────────────────────────

/** The blocked-install error envelope, named by its stable `code`. */
function expectBlockedByDangerousKeyGate(result: { code: number; stderr: string }): void {
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('"code": "DANGEROUS_ENV_KEY"');
  expect(result.stderr).toContain("NODE_OPTIONS");
  // The success envelope must not also be printed (F4).
  expect(result.stderr).not.toContain('"ok": true');
}

/** No lifecycle surface may still reference the refused bundle's content root. */
function expectNoTraceOfRefusedBundle(dangerousRoot: string): void {
  expect(fs.existsSync(dangerousRoot)).toBe(false);
  // `?? ""` deliberately: an absent file genuinely has no trace of the bundle,
  // and only these two `not.toContain` readers may treat it that way. Callers
  // asserting the lockfile's CONTENT assert on the value directly, so a missing
  // file fails there instead of being papered over with a `?? "[]"` default.
  const configText = readOrNull(configPath()) ?? "";
  expect(configText).not.toContain(dangerousRoot);
  expect(configText).not.toContain(DANGEROUS_REF);
  const lockText = readOrNull(lockfilePath()) ?? "";
  expect(lockText).not.toContain(dangerousRoot);
  expect(lockText).not.toContain(DANGEROUS_REF);
  for (const row of readIndexedRows()) {
    expect(row.filePath.startsWith(dangerousRoot)).toBe(false);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("dangerous-key blocked install — rollback leaves config.json/akm.lock parity (#758)", () => {
  test("pristine workspace: a blocked install records the bundle in NEITHER file", async () => {
    const before = snapshotLifecycleFiles();
    expect(before.configJson).toBeNull();
    expect(before.lockfile).toBeNull();

    const dangerousRoot = materializeDangerousBundle();
    expectBlockedByDangerousKeyGate(await addBundleNonInteractive(DANGEROUS_REF, dangerousRoot));

    // Residue, precisely pinned. `akm bundle add` scaffolds config.json and
    // akm.lock on its way in (the config/lock writers create their file on
    // first mutation), so the two files DO exist afterwards where they did not
    // before. What matters — and what is asserted here — is that neither
    // carries a partial record of the refused bundle: config.json holds stock
    // defaults with no `bundles` key at all, and akm.lock is the empty array.
    // Comparing against the imported DEFAULT_CONFIG (rather than a frozen
    // literal) keeps this exact even as defaults evolve.
    const after = snapshotLifecycleFiles();
    expect(after.configJson).not.toBeNull();
    // `toEqual` against DEFAULT_CONFIG already proves `bundles` is absent —
    // DEFAULT_CONFIG has no such key, so any bundle record fails the compare.
    expect(JSON.parse(after.configJson ?? "")).toEqual(DEFAULT_CONFIG);
    expect(JSON.parse(after.lockfile ?? "")).toEqual([]);

    expectNoTraceOfRefusedBundle(dangerousRoot);
    expect(readIndexedRows()).toEqual([]);
    // The attempt itself stays on the audit trail — see readAddEventTargets.
    expect(readAddEventTargets()).toEqual([DANGEROUS_REF]);
  }, 30_000);

  test("workspace with user config and no bundles: config.json is byte-identical afterwards", async () => {
    // A pre-existing, non-default config.json — the rollback must not clobber
    // unrelated operator settings on its way past. Seeded through the real
    // `akm config set` so the baseline bytes come from the same canonical
    // serializer the rollback will write with; a hand-written config.json
    // would be re-serialized on the way through and fail parity for a reason
    // that has nothing to do with rollback fidelity.
    expect((await runCliCapture(["config", "set", "output.detail", "full"])).code).toBe(0);
    const before = snapshotLifecycleFiles();
    expect(before.configJson).toContain('"detail": "full"');

    const dangerousRoot = materializeDangerousBundle();
    expectBlockedByDangerousKeyGate(await addBundleNonInteractive(DANGEROUS_REF, dangerousRoot));

    const after = snapshotLifecycleFiles();
    expect(after.configJson).toBe(before.configJson);
    expect(JSON.parse(after.lockfile ?? "")).toEqual([]);
    expectNoTraceOfRefusedBundle(dangerousRoot);
  }, 30_000);

  test("a bundle already installed: the blocked second add leaves the FIRST bundle's records intact", async () => {
    // A rollback that reverts too much is as wrong as one that reverts too
    // little, so the pre-existing install is asserted whole — config entry,
    // lock entry, content root, and indexed rows — not merely "still listed".
    const safeRoot = materializeSafeBundle();
    const firstAdd = await addBundleNonInteractive(SAFE_REF, safeRoot);
    expect(firstAdd.code).toBe(0);

    const before = snapshotLifecycleFiles();
    expect(before.configJson).toContain(SAFE_REF);
    expect(before.lockfile).toContain(SAFE_REF);
    const safeBundleKeys = Object.keys(
      (JSON.parse(before.configJson as string) as { bundles?: Record<string, unknown> }).bundles ?? {},
    );
    expect(safeBundleKeys).toHaveLength(1);
    const indexedBefore = readIndexedRows();
    expect(indexedBefore.some((row) => row.filePath.startsWith(safeRoot))).toBe(true);

    const dangerousRoot = materializeDangerousBundle();
    expectBlockedByDangerousKeyGate(await addBundleNonInteractive(DANGEROUS_REF, dangerousRoot));

    // Byte-level parity of BOTH lifecycle files — the assertion the §24.2
    // waiver names. Byte-level, not "deep-equal after parsing": a rollback
    // that rewrote the surviving bundle's entry into an equivalent-but-
    // different serialization would still be a rollback that touched records
    // it had no business touching.
    const after = snapshotLifecycleFiles();
    expect(after.configJson).toBe(before.configJson);
    expect(after.lockfile).toBe(before.lockfile);

    // …and the refused bundle left nothing behind on any other surface.
    expectNoTraceOfRefusedBundle(dangerousRoot);

    // …while the first install is untouched: root on disk, indexed rows, and
    // its visibility to `akm bundle list`.
    expect(fs.existsSync(path.join(safeRoot, "knowledge", "safe-marker.md"))).toBe(true);
    expect(readIndexedRows()).toEqual(indexedBefore);
    const listed = await runCliCapture(["bundle", "list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(SAFE_REF);
    expect(listed.stdout).not.toContain(DANGEROUS_REF);

    expect(readAddEventTargets()).toEqual([SAFE_REF, DANGEROUS_REF]);
  }, 30_000);
});
