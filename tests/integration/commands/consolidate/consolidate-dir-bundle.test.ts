// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** §0.2 P9: proposals made with `consolidate --dir <dir>` name the directory's real bundle, not an invented `stash`. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolveConsolidationWriteTarget } from "../../../../src/commands/improve/consolidate";
import type { AkmConfig } from "../../../../src/core/config/config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
beforeEach(() => {
  storage = withIsolatedAkmStorage();
});
afterEach(() => storage.cleanup());

const dir = (name: string) => {
  const full = path.join(storage.root, name);
  fs.mkdirSync(full, { recursive: true });
  return full;
};

describe("consolidate --dir", () => {
  test("names the configured bundle at the directory", () => {
    const lib = dir("lib");
    const config = { bundles: { notes: { path: lib, adapter: "akm" } } } as unknown as AkmConfig;
    const target = resolveConsolidationWriteTarget({ stashDir: lib } as never, config);
    expect(target.source.name).toBe("notes");
    expect(target.config.name).toBe("notes");
  });

  test("names a directory no bundle has by its derived id", () => {
    const loose = dir("loose-notes");
    const target = resolveConsolidationWriteTarget(
      { stashDir: loose } as never,
      { bundles: {} } as unknown as AkmConfig,
    );
    expect(target.source.name).toBe("loose-notes");
  });
});
