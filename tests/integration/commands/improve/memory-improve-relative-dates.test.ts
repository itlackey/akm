// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Memory cleanup's relative-date resolution (M-5 / #396) writes through the asset facade and writes what it wrote
 * before (P17): the body's relative dates become ISO dates, a home path in it stays, nothing is refused, the mode is kept.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { analyzeMemoryCleanup, applyMemoryCleanup } from "../../../../src/commands/improve/memory/memory-improve";
import { _setWarnSinkForTests } from "../../../../src/core/warn";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";
import { withSeam } from "../../../_helpers/seams";
import { expectSameExceptUpdated } from "../../../_helpers/updated-today";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  fs.mkdirSync(path.join(storage.stashDir, "memories"), { recursive: true });
});
afterEach(() => storage.cleanup());

test("relative dates resolve in place: the same bytes as before, a home path kept, the mode kept", async () => {
  const stash = storage.stashDir;
  fs.writeFileSync(path.join(stash, "memories", "tunnel.md"), "---\ndescription: Tunnel\n---\n\nTunnel notes.\n");
  const child = path.join(stash, "memories", "tunnel.derived.md");
  fs.writeFileSync(
    child,
    [
      "---",
      "inferred: true",
      "derivedFrom: tunnel",
      "description: Tunnel restart",
      "createdAt: 2026-03-10T12:00:00.000Z",
      "---",
      "",
      "Restarted /home/alice/vpn/restart.sh yesterday and again 2 days ago.",
      "",
    ].join("\n"),
  );
  fs.chmodSync(child, 0o640);

  const warnings: string[] = [];
  const result = await withSeam(
    _setWarnSinkForTests,
    (_level, args) => warnings.push(args.join(" ")),
    () => applyMemoryCleanup(stash, analyzeMemoryCleanup(stash)),
  );

  expect(result.relativeDatesResolved).toBe(1);
  expect(result.warnings).toBeUndefined();
  expect(warnings).toEqual([]);
  expectSameExceptUpdated(
    fs.readFileSync(child, "utf8"),
    [
      "---",
      "inferred: true",
      "derivedFrom: tunnel",
      "description: Tunnel restart",
      "createdAt: 2026-03-10T12:00:00.000Z",
      "---",
      "",
      "Restarted /home/alice/vpn/restart.sh 2026-03-09 and again 2026-03-08.",
      "",
    ].join("\n"),
  );
  expect(fs.statSync(child).mode & 0o777).toBe(0o640);
});
