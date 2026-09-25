// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// r3-3: formatBundleRenamePlain used to print "Native scheduler bindings
// re-synced under the new name." whenever renameBundle's taskSync.ok was
// true — including when the sync itself had already reported per-binding
// failures in taskSync.result.failures, since the old code only ever set
// ok: true on a non-throwing sync call. Now that ok reflects
// result.failures.length === 0, the formatter must give a summary
// (installed/updated/removed counts) on success, and list each failure
// (never claiming "re-synced under the new name") when there are any.

import { describe, expect, it } from "bun:test";
import { formatBundleRenamePlain } from "../src/output/text/command-format";

function baseResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    oldId: "old",
    newId: "new",
    applied: true,
    config: { defaultBundleChanges: false, defaultWriteTargetChanges: false, schedulerRefs: [] },
    index: { entries: 0 },
    state: { proposalRefs: 0, proposalTargets: 0, taskHistoryRefs: 0 },
    contentRefs: [],
    nativeSchedulerRows: [],
    ...overrides,
  };
}

describe("formatBundleRenamePlain — taskSync", () => {
  it("prints an installed/updated/removed summary when every binding re-synced", () => {
    const text = formatBundleRenamePlain(
      baseResult({
        taskSync: {
          ok: true,
          result: { installed: ["foo"], updated: [], removed: [], unchanged: [], skipped: [], failures: [] },
        },
      }),
    );
    expect(text).toContain("re-synced under the new name");
    expect(text).toContain("1 installed, 0 updated, 0 removed");
  });

  it("lists each failure and points to `akm task sync`, without claiming a re-sync, when a binding failed", () => {
    const text = formatBundleRenamePlain(
      baseResult({
        taskSync: {
          ok: false,
          result: {
            installed: [],
            updated: [],
            removed: [],
            unchanged: [],
            skipped: [],
            failures: [{ path: "tasks/foo.yml", ref: "new//tasks/foo", reason: "version is required and must be 4" }],
          },
        },
      }),
    );
    expect(text).not.toContain("re-synced under the new name");
    expect(text).toContain("new//tasks/foo: version is required and must be 4");
    expect(text).toContain("akm task sync");
  });

  it("still reports a thrown sync error distinctly from a per-binding failure", () => {
    const text = formatBundleRenamePlain(
      baseResult({ taskSync: { ok: false, error: "scheduler backend unavailable" } }),
    );
    expect(text).toContain("Re-syncing native scheduler bindings failed: scheduler backend unavailable");
    expect(text).toContain("akm task sync");
    expect(text).not.toContain("re-synced under the new name");
  });
});
