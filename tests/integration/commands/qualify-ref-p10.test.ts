// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * §0.2 P10: an unqualified ref in `akm log --ref`, `akm feedback` and show-usage is qualified by `qualifyRef` (the first
 * bundle that holds it, the default bundle first) and looked up by its exact `item_ref`. A concept held by two bundles
 * is the default bundle's; one held only by a second bundle is that bundle's.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmEventsList } from "../../../src/commands/log";
import { qualifyRef } from "../../../src/core/assets/read";
import { saveConfig } from "../../../src/core/config/config";
import { appendEvent } from "../../../src/core/events";
import { akmIndex } from "../../../src/indexer/indexer";
import { runCliCapture } from "../../_helpers/cli";
import { makeSandboxDir, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const cleanups: Array<() => void> = [];
let restore: () => void = () => {};

function bundleDir(name: string, files: string[]): string {
  const { dir, cleanup } = makeSandboxDir(`akm-p10-${name}-`);
  cleanups.push(cleanup);
  for (const file of files) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `---\ndescription: ${name} ${file}\n---\n\n# ${name}\n`, "utf8");
  }
  return dir;
}

beforeEach(async () => {
  const first = bundleDir("first", ["knowledge/shared.md", "knowledge/in-first.md"]);
  const second = bundleDir("second", ["knowledge/shared.md", "knowledge/only-second.md"]);
  restore = withIsolatedAkmStorage({ AKM_BUNDLE_DIR: first }).cleanup;
  saveConfig({
    semanticSearchMode: "off",
    bundles: { first: { path: first, writable: true }, second: { path: second, writable: true } },
    defaultBundle: "first",
  });
  await akmIndex({ stashDir: first, full: true });
});

afterEach(() => {
  restore();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

test("qualifyRef: the default bundle for a concept in two bundles, the holding bundle for one only in a second", () => {
  expect(qualifyRef("knowledge/shared")).toBe("first//knowledge/shared");
  expect(qualifyRef("knowledge/only-second")).toBe("second//knowledge/only-second");
  expect(qualifyRef("knowledge/shared", { bundle: "second" })).toBe("second//knowledge/shared");
  expect(qualifyRef("second//knowledge/shared")).toBe("second//knowledge/shared");
  expect(qualifyRef("knowledge/nowhere")).toBe("first//knowledge/nowhere");
});

test("akm log --ref qualifies like show: a concept only in a second bundle matches that bundle's events", () => {
  appendEvent({ eventType: "show", ref: "second//knowledge/only-second" });
  appendEvent({ eventType: "show", ref: "first//knowledge/shared" });
  const only = akmEventsList({ ref: "knowledge/only-second" });
  expect(only.ref).toBe("second//knowledge/only-second");
  expect(only.events.map((event) => event.ref)).toEqual(["second//knowledge/only-second"]);
  expect(akmEventsList({ ref: "knowledge/shared" }).ref).toBe("first//knowledge/shared");
});

test("akm feedback on a concept only in a second bundle records it on that bundle's row", async () => {
  const result = await runCliCapture(["feedback", "knowledge/only-second", "--positive", "--format", "json"]);
  expect(result.stdout).toContain("second//knowledge/only-second");
  const shared = await runCliCapture(["feedback", "knowledge/shared", "--positive", "--format", "json"]);
  expect(shared.stdout).toContain(`"ref": "knowledge/shared"`);
});
