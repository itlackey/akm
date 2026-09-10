// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm index status` (index-redesign B5a) — a cheap, read-only snapshot of
 * `index.db`'s current state, replacing the old rebuild-lock's "is a run in
 * progress" question with something actually useful once index runs no
 * longer take a lock at all: files tracked, entries, unit coverage for the
 * active embedding identity, and the last reconcile time.
 *
 * This drives a REAL `index.db` via `akmIndex`, so it is an integration test
 * per the ORG-03..06 classification rule.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { assembleIndexStatus } from "../../../../src/commands/sources/index-status";
import { resetConfigCache } from "../../../../src/core/config/config";
import { resetQuiet, setQuiet } from "../../../../src/core/warn";
import { akmIndex } from "../../../../src/indexer/indexer";
import { runCliCapture } from "../../../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});
afterEach(() => {
  storage.cleanup();
  resetConfigCache();
  resetQuiet();
});

function writeMemory(name: string, body: string): void {
  fs.writeFileSync(
    path.join(storage.stashDir, "memories", name),
    `---\ndescription: ${name}\n---\n\n${body}\n`,
    "utf8",
  );
}

describe("assembleIndexStatus", () => {
  test("before any index run: the empty, first-run shape — never an error for a plain absent database", () => {
    const status = assembleIndexStatus({ dbPath: path.join(storage.dataDir, "does-not-exist.db") });

    expect(status.files).toBe(0);
    expect(status.entries).toBe(0);
    expect(status.units).toEqual({ total: 0, withVector: 0, pending: 0 });
    expect(status.activeIdentity).toBeNull();
    expect(status.lastReconcileAt).toBeNull();
    expect(status.builtAt).toBeNull();
    expect(status.unreadable).toBeUndefined();
  });

  test("after a real index run: files/entries/units and lastReconcileAt/builtAt reflect the just-built index", async () => {
    writeMemory("one.md", "Body content for entry one.");
    writeMemory("two.md", "Body content for entry two.");
    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: { stash: { path: storage.stashDir, writable: true } },
      defaultBundle: "stash",
    });
    resetConfigCache();

    await akmIndex({ stashDir: storage.stashDir, full: true });

    const status = assembleIndexStatus();
    expect(status.files).toBeGreaterThanOrEqual(2);
    expect(status.entries).toBe(2);
    // Semantic search is off: every unit exists (derived at reconcile time,
    // independent of embedding) but none has a vector yet.
    expect(status.units.total).toBeGreaterThan(0);
    expect(status.units.withVector).toBe(0);
    expect(status.units.pending).toBe(status.units.total);
    expect(status.activeIdentity).toBeNull();
    expect(typeof status.lastReconcileAt).toBe("string");
    expect(typeof status.builtAt).toBe("string");
  });

  test("units.withVector reflects real embedding coverage once semantic search runs", async () => {
    writeMemory("embedded.md", "Body content to embed.");
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/props" || pathname === "/api/show") return new Response(null, { status: 404 });
        const body = (await request.json()) as { input?: unknown };
        const count = Array.isArray(body.input) ? body.input.length : 1;
        return new Response(
          JSON.stringify({
            data: Array.from({ length: count }, () => ({ embedding: [1, 0, 0, 0] })),
            model: "test",
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    });
    try {
      writeSandboxConfig({
        semanticSearchMode: "auto",
        bundles: { stash: { path: storage.stashDir, writable: true } },
        defaultBundle: "stash",
        embedding: { endpoint: `http://localhost:${server.port}`, model: "test-model", dimension: 4 },
      });
      resetConfigCache();

      const result = await akmIndex({ stashDir: storage.stashDir, full: true });
      expect(result.verification.semanticStatus).toBe("ready-vec");

      const status = assembleIndexStatus();
      expect(status.units.total).toBeGreaterThan(0);
      expect(status.units.withVector).toBe(status.units.total);
      expect(status.units.pending).toBe(0);
      expect(status.activeIdentity).not.toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("an unreadable (corrupt) index database reports unreadable, not an empty index (#791)", () => {
    const dbPath = path.join(storage.dataDir, "corrupt.db");
    fs.writeFileSync(dbPath, "not a sqlite database");

    setQuiet(true);
    try {
      const status = assembleIndexStatus({ dbPath });
      expect(status.unreadable).toBeDefined();
      expect(status.files).toBe(0);
      expect(status.entries).toBe(0);
    } finally {
      resetQuiet();
    }
  });
});

describe("akm index status (CLI)", () => {
  test("--format json returns the same shape as assembleIndexStatus()", async () => {
    writeMemory("cli-one.md", "Some content.");
    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: { stash: { path: storage.stashDir, writable: true } },
      defaultBundle: "stash",
    });
    resetConfigCache();
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const result = await runCliCapture(["index", "status", "--format", "json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as ReturnType<typeof assembleIndexStatus>;
    expect(parsed.entries).toBe(1);
    expect(parsed.units.total).toBeGreaterThan(0);
  });

  test("--format text prints a human-readable summary, distinct from --format json", async () => {
    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: { stash: { path: storage.stashDir, writable: true } },
      defaultBundle: "stash",
    });
    resetConfigCache();
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const json = await runCliCapture(["index", "status", "--format", "json"]);
    const text = await runCliCapture(["index", "status", "--format", "text"]);
    expect(json.code).toBe(0);
    expect(text.code).toBe(0);
    expect(() => JSON.parse(json.stdout)).not.toThrow();
    expect(() => JSON.parse(text.stdout)).toThrow();
    expect(text.stdout).toContain("Index:");
    expect(text.stdout).toContain("Entries:");
    expect(text.stdout).toContain("Units:");
  });
});
