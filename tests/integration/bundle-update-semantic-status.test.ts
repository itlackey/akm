// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm bundle update` and `akm doctor info` report semantic search from one reader: what the index recorded at its
 * last run. An update that ran no embedding pass says what the index recorded, not `pending`; an index that cannot
 * be read is `unknown` with the read error, not `pending`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { runCliCapture } from "../_helpers/cli";
import { type GitDaemon, seedServedRepo } from "../_helpers/git-daemon";
import { type IsolatedAkmStorage, withDefaultBundle, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let daemon: GitDaemon;
let embeddingServer: ReturnType<typeof Bun.serve>;

async function cli<T>(...args: string[]): Promise<T> {
  const result = await runCliCapture([...args, "--format=json"]);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as T;
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  daemon = seedServedRepo(storage.root);
  embeddingServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = (await request.json()) as { input?: unknown };
      const count = Array.isArray(body.input) ? body.input.length : 1;
      return Response.json({
        data: Array.from({ length: count }, () => ({ embedding: [0.1, 0.2, 0.3, 0.4] })),
        model: "test",
      });
    },
  });
});

afterEach(() => {
  daemon.stop();
  embeddingServer.stop(true);
  storage.cleanup();
});

describe("semantic status of an update that ran no embedding pass", () => {
  test("equals what doctor info reports for the index, not pending", async () => {
    saveConfig(
      withDefaultBundle(
        {
          semanticSearchMode: "auto",
          embedding: { endpoint: `http://127.0.0.1:${embeddingServer.port}`, model: "test-model", dimension: 4 },
        },
        storage.stashDir,
      ),
    );
    await cli("bundle", "add", `git+${daemon.baseUrl}/remote.git`, "--name", "gb");

    const info = await cli<{ semanticSearch: { status: string } }>("doctor", "info");
    expect(info.semanticSearch.status).toBe("ready-js");

    const update = await cli<{ index: { semanticStatus: string } }>("bundle", "update", "gb");
    expect(update.index.semanticStatus).toBe(info.semanticSearch.status);
  }, 60_000);

  test("is disabled when semantic search is off", async () => {
    saveConfig(withDefaultBundle({ semanticSearchMode: "off" }, storage.stashDir));
    await cli("bundle", "add", `git+${daemon.baseUrl}/remote.git`, "--name", "gb");
    const info = await cli<{ semanticSearch: { status: string } }>("doctor", "info");
    const update = await cli<{ index: { semanticStatus: string } }>("bundle", "update", "gb");
    expect(info.semanticSearch.status).toBe("disabled");
    expect(update.index.semanticStatus).toBe("disabled");
  }, 60_000);
});

describe("doctor info on an index it cannot read", () => {
  test("reports unknown with the read error, not pending", async () => {
    saveConfig(withDefaultBundle({ semanticSearchMode: "auto" }, storage.stashDir));
    expect((await runCliCapture(["index"])).code).toBe(0);
    fs.writeFileSync(getDbPath(), crypto.getRandomValues(new Uint8Array(4096)));

    const info = await cli<{ semanticSearch: { status: string; reason?: string } }>("doctor", "info");

    expect(info.semanticSearch.status).toBe("unknown");
    expect(info.semanticSearch.reason).toContain("index.db is damaged");
  }, 60_000);
});
