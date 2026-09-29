// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pins `isWriteCapableSourceKind` (src/core/write-source.ts), the single
 * predicate for the write-capable source kinds. `assertSupportedKind` and
 * `adaptConfiguredSource` (same module) and `akmTasksSync`'s scheduler-kind
 * guard/filter (src/commands/tasks/tasks.ts) all defer to it now, rather than
 * each spelling the filesystem/git list separately (AGENTS.md: "All
 * write-target branching by `source.kind` belongs in
 * `src/core/write-source.ts`").
 */

import { describe, expect, test } from "bun:test";
import { isWriteCapableSourceKind } from "../src/core/write-source";

describe("isWriteCapableSourceKind", () => {
  test("filesystem and git are write-capable", () => {
    expect(isWriteCapableSourceKind("filesystem")).toBe(true);
    expect(isWriteCapableSourceKind("git")).toBe(true);
  });

  test("website, npm, and unknown kinds are not write-capable", () => {
    expect(isWriteCapableSourceKind("website")).toBe(false);
    expect(isWriteCapableSourceKind("npm")).toBe(false);
    expect(isWriteCapableSourceKind("bogus")).toBe(false);
  });
});
