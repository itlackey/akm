// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm index` progress verbosity in non-text output (index-redesign B5g,
 * #954 follow-up): `EMBEDDED_BATCH_PROGRESS_PATTERN` (the old regex this
 * suppression used to run on) matched the deleted per-entry pipeline's
 * `Embedded N/M entries.` line — the drain's real per-batch line
 * (`[drain] batch N: …`, `src/indexer/drain.ts`) and reconcile's per-root
 * line (`Reconciled "<path>": N files scanned.`, `src/indexer/reconcile.ts`)
 * never matched it, so every progress line reached stderr in JSON/yaml
 * output regardless of `--verbose`. The fix filters by the exact prefix each
 * producer exports (`DRAIN_BATCH_PROGRESS_PREFIX`,
 * `RECONCILE_ROOT_PROGRESS_PREFIX`) instead of a re-derived regex.
 *
 * Drives the real CLI (`runCliCapture`) against a real `index.db` with a
 * mock embeddings server, so this is integration-scoped (ORG-03/06).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runCliCapture } from "../../../_helpers/cli";
import {
  type IsolatedAkmStorage,
  withEnv,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  fs.mkdirSync(path.join(storage.stashDir, "knowledge"), { recursive: true });
  fs.writeFileSync(
    path.join(storage.stashDir, "knowledge", "guide-one.md"),
    "---\ndescription: A first guide entry.\n---\n\nSome body content.\n",
  );
  fs.writeFileSync(
    path.join(storage.stashDir, "knowledge", "guide-two.md"),
    "---\ndescription: A second guide entry.\n---\n\nMore body content.\n",
  );

  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      // `probeProviderLimits` tries llama.cpp's `GET /props` and Ollama's
      // `POST /api/show` before any real embedding request; neither carries
      // an `{ input }` body — reject both so the probe falls back to the
      // default window instead of hanging on an unrecognized response shape.
      if (pathname === "/props" || pathname === "/api/show") {
        return new Response(null, { status: 404 });
      }
      const body = (await request.json()) as { input: string[] };
      const data = body.input.map((_t, i) => ({ embedding: [1, 0, 0, 0], index: i }));
      return new Response(JSON.stringify({ data, model: "mock-embed" }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  writeSandboxConfig({
    semanticSearchMode: "auto",
    embedding: {
      endpoint: `http://localhost:${server.port}`,
      model: "mock-embed",
      dimension: 4,
    },
  });
});

afterEach(() => {
  server?.stop(true);
  server = undefined;
  storage.cleanup();
});

describe("akm index --format json progress verbosity", () => {
  test("without --verbose, per-batch drain and per-root reconcile lines are absent but summary lines print", async () => {
    const result = await runCliCapture(["index", "--format", "json"]);

    expect(result.code).toBe(0);
    // High-frequency, one-line-per-unit-of-work lines: suppressed.
    expect(result.stderr).not.toContain("[drain] batch ");
    expect(result.stderr).not.toContain('Reconciled "');
    // Summary/total lines: always printed, verbose or not.
    expect(result.stderr).toMatch(/\[index:scan\] Reconciled \d+ files? \(\d+ added, \d+ changed, \d+ removed\)\./);
    expect(result.stderr).toMatch(/\[index:embeddings\] \[drain\] done: \d+ pending, \d+ embedded/);
    expect(result.stderr).toContain("[embed] endpoint");
  });

  test("--verbose prints per-batch drain and per-root reconcile lines too, alongside the same summary lines", async () => {
    const result = await withEnv({ AKM_VERBOSE: "1" }, () => runCliCapture(["index", "--format", "json"]));

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("[drain] batch ");
    expect(result.stderr).toContain('Reconciled "');
    expect(result.stderr).toMatch(/\[index:scan\] Reconciled \d+ files? \(\d+ added, \d+ changed, \d+ removed\)\./);
    expect(result.stderr).toMatch(/\[index:embeddings\] \[drain\] done: \d+ pending, \d+ embedded/);
    expect(result.stderr).toContain("[embed] endpoint");
  });
});
