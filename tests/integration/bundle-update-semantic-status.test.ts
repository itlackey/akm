// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm bundle update` and `akm doctor info` report semantic search from one reader: what the index recorded at its
 * last run. An update that ran no embedding pass says what the index recorded, not `pending`; an index that cannot
 * be read is `unknown` with the read error, not `pending`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { runCliCapture } from "../_helpers/cli";
import { type GitDaemon, startGitDaemon } from "../_helpers/git-daemon";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let daemon: GitDaemon;
let embeddingServer: ReturnType<typeof Bun.serve>;

function git(args: string[]): void {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

async function cli<T>(...args: string[]): Promise<T> {
  const result = await runCliCapture([...args, "--format=json"]);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as T;
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  const seed = path.join(storage.root, "seed");
  git(["init", "--initial-branch=main", seed]);
  git(["-C", seed, "config", "user.name", "AKM Test"]);
  git(["-C", seed, "config", "user.email", "akm@example.test"]);
  git(["-C", seed, "config", "commit.gpgsign", "false"]);
  fs.mkdirSync(path.join(seed, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(seed, "knowledge", "note.md"), "---\ndescription: a note\n---\n\n# A note\n");
  git(["-C", seed, "add", "-A"]);
  git(["-C", seed, "commit", "-m", "seed"]);
  git(["clone", "--bare", seed, path.join(storage.root, "remote.git")]);
  daemon = startGitDaemon(storage.root, "remote.git");
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
    saveConfig({
      semanticSearchMode: "auto",
      embedding: { endpoint: `http://127.0.0.1:${embeddingServer.port}`, model: "test-model", dimension: 4 },
    });
    await cli("bundle", "add", `git+${daemon.baseUrl}/remote.git`, "--name", "gb");

    const info = await cli<{ semanticSearch: { status: string } }>("doctor", "info");
    expect(info.semanticSearch.status).toBe("ready-js");

    const update = await cli<{ index: { semanticStatus: string } }>("bundle", "update", "gb");
    expect(update.index.semanticStatus).toBe(info.semanticSearch.status);
  }, 60_000);

  test("is disabled when semantic search is off", async () => {
    saveConfig({ semanticSearchMode: "off" });
    await cli("bundle", "add", `git+${daemon.baseUrl}/remote.git`, "--name", "gb");
    const info = await cli<{ semanticSearch: { status: string } }>("doctor", "info");
    const update = await cli<{ index: { semanticStatus: string } }>("bundle", "update", "gb");
    expect(info.semanticSearch.status).toBe("disabled");
    expect(update.index.semanticStatus).toBe("disabled");
  }, 60_000);
});

describe("doctor info on an index it cannot read", () => {
  test("reports unknown with the read error, not pending", async () => {
    saveConfig({ semanticSearchMode: "auto" });
    expect((await runCliCapture(["index"])).code).toBe(0);
    fs.writeFileSync(getDbPath(), crypto.getRandomValues(new Uint8Array(4096)));

    const info = await cli<{ semanticSearch: { status: string; reason?: string } }>("doctor", "info");

    expect(info.semanticSearch.status).toBe("unknown");
    expect(info.semanticSearch.reason).toMatch(/not a database|malformed|corrupt/i);
  }, 60_000);
});
