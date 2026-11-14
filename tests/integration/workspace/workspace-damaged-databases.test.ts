// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A damaged index.db is a derived cache the workspace reads around (the asset
 * comes from its file, no durable ref); a damaged state.db holds what akm cannot
 * regenerate, so every reader raises one classified error that names the file.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { readEvents } from "../../../src/core/events";
import { getDbPath } from "../../../src/core/paths";
import { getStateDbPath } from "../../../src/core/state-db";
import { akmIndex } from "../../../src/indexer/indexer";
import { assets, documents } from "../../../src/workspace";
import { ctx, expectAkmError, seed, useSandbox } from "./workspace-behaviour-helpers";

useSandbox();

const repoRoot = path.resolve(import.meta.dir, "../../..");

/** A fresh process: an in-process run could borrow a state.db handle opened before the damage. */
async function child(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: repoRoot,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function damage(
  file: string,
  how: "meta-only" | "interior" | "zero-length" | "zero-filled" | "garbage" | "truncated",
): void {
  const size = fs.statSync(file).size;
  for (const side of ["-wal", "-shm"]) fs.rmSync(file + side, { force: true });
  if (how === "zero-length") fs.writeFileSync(file, "");
  else if (how === "zero-filled") fs.writeFileSync(file, Buffer.alloc(size));
  else if (how === "garbage") fs.writeFileSync(file, Buffer.from("this is not a database ".repeat(400)));
  else if (how === "interior") {
    const bytes = fs.readFileSync(file);
    bytes.fill(0xa5, 4096, Math.min(bytes.length, 4096 * 6));
    fs.writeFileSync(file, bytes);
  } else if (how === "truncated") fs.truncateSync(file, Math.floor(size / 2));
  else {
    fs.rmSync(file);
    const db = new Database(file);
    db.exec("CREATE TABLE index_meta(key TEXT PRIMARY KEY, value TEXT)");
    db.close();
  }
}

describe("index.db that cannot serve", () => {
  for (const how of ["meta-only", "interior", "zero-length", "zero-filled", "garbage"] as const) {
    test(`${how}: assets.show and assets.related answer from the file, readSource says there is no index`, async () => {
      await seed();
      await akmIndex({ stashDir: ctx.storage.stashDir });
      damage(getDbPath(), how);

      const shown = await assets.show({ ref: "knowledge/guide" });
      expect(shown.durableRef).toBeNull();
      expect(shown.asset?.content).toContain("Deploy guide");
      expect((await assets.related({ ref: "knowledge/guide" })).available).toBe(false);
      await expectAkmError(documents.readSource({ ref: "knowledge/guide" }), {
        kind: "usage",
        message: "no search index for this library yet",
      });
    });
  }
});

describe("damaged state.db", () => {
  for (const how of ["zero-filled", "garbage", "truncated"] as const) {
    test(`${how}: assets.show, events, feedback, log and index raise the classified error naming the file (health reports it as one finding)`, async () => {
      await seed();
      expect((await child(["index"])).code).toBe(0);
      const file = getStateDbPath();
      damage(file, how);

      await expectAkmError(assets.show({ ref: "knowledge/guide" }), { kind: "config", message: file });
      expect(() => readEvents({}, { readOnly: true })).toThrow(file);

      for (const args of [["feedback", "knowledge/guide", "--positive"], ["doctor", "log"], ["index"]]) {
        const out = await child(args);
        expect(out.code, args.join(" ") + out.stdout + out.stderr).toBe(78);
        expect(out.stdout + out.stderr).toContain(file);
      }
      const health = await child(["health", "--format", "json"]);
      expect(health.code).toBe(1);
      expect(health.stdout).toContain(file);
    });
  }
});
