// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared fixtures for the workspace behaviour tests (`workspace-behaviour-*.test.ts`): a seeded sandbox stash and the
 * helpers that read it back. The tests call the workspace operations (`src/workspace`) directly; these were the
 * behaviour assertions of the retired `akm ui` server tests.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createProposal } from "../../../src/commands/proposal/repository";
import { resetConfigCache } from "../../../src/core/config/config";
import { AkmError, type AkmErrorKind, CONFLICT_CODES } from "../../../src/core/errors";
import { openStateDatabase } from "../../../src/core/state-db";
import { akmIndex } from "../../../src/indexer/indexer";
import { recordImproveRun } from "../../../src/storage/repositories/improve-runs-repository";
import { scrubUrlCredentials } from "../../../src/workspace";
import { makeConfig } from "../../_helpers/factories";
import { git, makeGitRepo } from "../../_helpers/git";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

export const PLANTED_API_KEY = "sk-planted-literal-api-key-0001";
export const PLANTED_REGISTRY_PASSWORD = "registry-planted-password-0001";
export const PLANTED_CONFIG_TOKEN = "tok-planted-config-token-0002";
export const PLANTED_URL_TOKEN = "tok-planted-url-query-0003";
export const PLANTED_SECRET_FILE = "planted-secret-file-value-0004";
export const PLANTED_ENV_VALUE = "planted-env-file-value-0005";
export const PLANTED = [
  PLANTED_API_KEY,
  PLANTED_CONFIG_TOKEN,
  PLANTED_URL_TOKEN,
  PLANTED_SECRET_FILE,
  PLANTED_ENV_VALUE,
];

export const GUIDE =
  "---\ndescription: Deploy guide\n---\n# Deploy guide\nRun the deploy script. See [[knowledge/notes]].\n";
export const NOTES = "---\ndescription: Deploy notes\n---\n# Notes\nMore deploy detail.\n";
export const LESSON = "---\ndescription: Use ripgrep\nwhen_to_use: Searching repos\n---\n\nPrefer rg over grep.\n";
export const NOTES_REWRITE = "---\ndescription: Deploy notes, rewritten\n---\n# Notes\nRewritten by a proposal.\n";

// biome-ignore lint/suspicious/noExplicitAny: result shapes are asserted field by field in each test
export type Json = Record<string, any>;

/** The isolated sandbox of the current test; installed by {@link useSandbox}. */
export const ctx = {} as { storage: IsolatedAkmStorage };

/** Register a fresh isolated sandbox for each test of the calling file. */
export function useSandbox(): void {
  beforeEach(() => {
    ctx.storage = withIsolatedAkmStorage();
  });
  afterEach(() => {
    ctx.storage.cleanup();
  });
}

/**
 * What a host hands its client: the operation's result as plain JSON with URL credentials masked
 * (`scrubUrlCredentials`, exported for hosts as the last line of defence).
 */
export async function out<T = Json>(result: T | Promise<T>): Promise<Json> {
  const value = scrubUrlCredentials(await result);
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? Number(v) : v))) as Json;
}

/** Assert that `promise` rejects with an `AkmError` of this kind (and code, and message fragment). */
export async function expectAkmError(
  promise: Promise<unknown> | (() => unknown),
  expected: { kind: AkmErrorKind; code?: string; message?: string },
): Promise<AkmError> {
  let caught: unknown;
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (error) {
    caught = error;
  }
  expect(caught, "expected an AkmError").toBeInstanceOf(AkmError);
  const error = caught as AkmError;
  expect({ kind: error.kind, ...(expected.code ? { code: error.code } : {}) }).toEqual({
    kind: expected.kind,
    ...(expected.code ? { code: expected.code } : {}),
  });
  if (expected.message) expect(error.message).toContain(expected.message);
  return error;
}

/** The refusal an operation raised for a usage mistake (a `400` over HTTP). */
export const expectUsage = (promise: Promise<unknown> | (() => unknown), code?: string, message?: string) =>
  expectAkmError(promise, { kind: "usage", code, message });

/** A conflict (a `409` over HTTP): a conflict code, whatever its kind, or a config refusal the owner can address. */
export async function expectConflict(promise: Promise<unknown>, code: string): Promise<AkmError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, "expected an AkmError").toBeInstanceOf(AkmError);
  const error = caught as AkmError;
  expect(error.code).toBe(code);
  expect(CONFLICT_CODES.has(error.code) || error.kind === "config").toBe(true);
  return error;
}

export function sha1(file: string): string {
  return createHash("sha1").update(fs.readFileSync(file)).digest("hex");
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * A WAL-mode database's committed content as one hash. A commit through a
 * connection that is still open sits in `-wal` and leaves the main file as it
 * was, so checkpoint everything into the main file first and require that
 * nothing is left behind.
 */
export function dbSnapshot(file: string): string {
  const db = new Database(file);
  try {
    const result = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
    expect(result.busy).toBe(0);
  } finally {
    db.close();
  }
  const wal = `${file}-wal`;
  expect(fs.existsSync(wal) ? fs.statSync(wal).size : 0).toBe(0);
  return sha1(file);
}

/** Every file named `name` under `dir`, following no symlinks. */
export function filesNamed(dir: string, name: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === name)
    .map((entry) => path.join(entry.parentPath, entry.name));
}

export function countRows(table: string): number {
  const db = openStateDatabase();
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** A stash with indexed knowledge, planted secrets, a git history, usage, feedback and one improve run. */
export async function seed(): Promise<void> {
  const stash = ctx.storage.stashDir;
  fs.mkdirSync(path.join(stash, "knowledge"), { recursive: true });
  fs.mkdirSync(path.join(stash, "env"), { recursive: true });
  fs.mkdirSync(path.join(stash, "secrets"), { recursive: true });
  fs.writeFileSync(path.join(stash, "knowledge", "guide.md"), GUIDE);
  fs.writeFileSync(path.join(stash, "knowledge", "notes.md"), NOTES);
  fs.writeFileSync(path.join(stash, "env", "prod.env"), `API_TOKEN=${PLANTED_ENV_VALUE}\n`);
  fs.writeFileSync(path.join(stash, "secrets", "deploy-key"), PLANTED_SECRET_FILE);

  makeGitRepo({ dir: stash });
  git(stash, ["add", "knowledge"]);
  git(stash, ["commit", "-q", "-m", "akm improve auto-sync"]);
  fs.writeFileSync(path.join(stash, "knowledge", "later.md"), "# later\n");
  git(stash, ["add", "knowledge"]);
  git(stash, ["commit", "-q", "-m", "akm accept: reflect abcd1234 stash//knowledge/later"]);
  fs.writeFileSync(path.join(stash, "knowledge", "more.md"), "# more\n");
  git(stash, ["add", "knowledge"]);
  git(stash, ["commit", "-q", "-m", "akm save 2026-10-16 10:00:00"]);

  writeSandboxConfig({
    ...makeConfig(stash),
    semanticSearchMode: "off",
    connections: {
      default: {
        endpoint: `https://llm.example.test/v1/chat/completions?token=${PLANTED_URL_TOKEN}`,
        models: { fast: "chat-model" },
        apiKey: PLANTED_API_KEY,
      },
    },
    someToken: PLANTED_CONFIG_TOKEN,
  });
  resetConfigCache();
  await akmIndex({ stashDir: stash, full: true });

  const db = openStateDatabase();
  try {
    const insert = db.prepare(
      "INSERT INTO usage_events (event_type, query, entry_ref, signal, metadata, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    insert.run("search", "deploy", null, null, null, "user", now);
    insert.run("show", null, "stash//knowledge/guide", null, null, "user", now);
    insert.run("search", "ignored", null, null, null, "improve", now);
    insert.run(
      "feedback",
      null,
      "stash//knowledge/guide",
      "positive",
      JSON.stringify({ reason: "clear" }),
      "user",
      now,
    );
    insert.run("feedback", null, "stash//knowledge/guide", "negative", null, "user", now);
    recordImproveRun(db, {
      id: "run-1",
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      completedAt: new Date(Date.now() - 60_000).toISOString(),
      stashDir: stash,
      dryRun: false,
      strategy: "default",
      scopeMode: "all",
      scopeValue: null,
      guidance: null,
      ok: true,
      result: {
        schemaVersion: 2,
        ok: true,
        dryRun: false,
        plannedRefs: [],
        scope: { mode: "all" },
        memorySummary: { eligible: 0, derived: 0 },
        strategy: "default",
        triage: { promoted: 2, rejected: 1, deferred: 0, failed: 0, skippedByCap: 0 },
        sync: { committed: true, pushed: false, skipped: false },
        preRunSync: { committed: false, pushed: false, skipped: true, reason: "no remote" },
        usageReport: {
          byProcessEngineModel: [
            { process: "reflect", engine: "default", model: "chat-model", calls: 3, failures: 1 },
            { process: "triage.judgment", engine: "default", model: "chat-model", calls: 2, failures: 0 },
          ],
          noCalls: [],
        },
      } as never,
    });
  } finally {
    db.close();
  }
}

/** A pending reflect proposal for `ref`; returns its id. */
export function propose(ref: string, content: string = LESSON): string {
  return createProposal(ctx.storage.stashDir, {
    ref,
    source: "reflect",
    sourceRun: "run-1",
    target: { source: "stash", root: ctx.storage.stashDir },
    payload: { content, frontmatter: { description: "Use ripgrep", when_to_use: "Searching repos" } },
  }).id;
}

export const commitCount = (): number => Number(git(ctx.storage.stashDir, ["rev-list", "--count", "HEAD"]).trim());
export const lastSubject = (): string => git(ctx.storage.stashDir, ["log", "-1", "--format=%s"]).trim();
export const lessonFile = (name: string): string => path.join(ctx.storage.stashDir, "lessons", `${name}.md`);

/** A `crontab` on PATH that keeps the table in a file of the sandbox: the OS scheduler is never touched. */
export function fakeCrontab() {
  const bin = path.join(ctx.storage.root, "cronbin");
  const file = path.join(ctx.storage.root, "crontab.txt");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "crontab"),
    `#!/bin/sh\ncase "$1" in -l) [ -f "${file}" ] && cat "${file}" || exit 1;; -) cat > "${file}";; esac\n`,
    { mode: 0o755 },
  );
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before}`;
  return {
    file,
    restore: () => {
      process.env.PATH = before;
    },
  };
}
