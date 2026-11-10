// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "bun:test";
import "../src/output/text";
import { formatAddPlain, formatBundleRenamePlain, formatUpdatePlain } from "../src/output/text/command-format";
import { getTextFormatterHandler } from "../src/output/text/registry";

// Characterization test for WS7 (#490): the `akm env *` plain-text formatters
// are registered as a side effect of importing the text-output barrel. This
// pins the registration set so the mechanical rename of the registering module
// (src/output/text/vault.ts -> src/output/text/env.ts) cannot silently drop a
// formatter. Asserting the exact set guards the rename's zero-behaviour-change
// contract.

// Importing the barrel triggers every `registerTextFormatter` side effect,
// including the env-* registrations in src/output/text/env.ts.

const ENV_COMMANDS = ["env-list", "env-create", "env-export", "env-remove"] as const;

describe("env text formatters (WS7 rename guard)", () => {
  for (const command of ENV_COMMANDS) {
    it(`registers a plain-text formatter for "${command}"`, () => {
      expect(typeof getTextFormatterHandler(command)).toBe("function");
    });
  }
});

// Regression coverage for R-014 (formatAddPlain rendering "Installed
// undefined" for a --provider add) and R-015 (formatUpdatePlain rendering
// "nothing to update" for a successful plain-source sync, or for a --all run
// that silently skipped configured plain sources). Both defects stem from a
// text formatter reading a field that the actual result shape never carries.

describe("formatAddPlain", () => {
  it("renders an AddResponse (eager install) shape as before", () => {
    const text = formatAddPlain({
      ref: "lodash",
      bundleId: "lodash",
      index: { directoriesScanned: 2, totalEntries: 5 },
    });
    expect(text).toBe('Installed lodash as bundle "lodash" (2 directories scanned, 5 total assets indexed)');
  });

  it("never renders 'Installed undefined' for a SourceAddResult (--provider add) shape", () => {
    // R-014 repro shape: `akm bundle add backbone --provider npm --name backbone2`
    // returned source-manage.ts's SourceAddResult (sources/added/entry/message
    // — no `ref`, no `index`), which the old formatter still read as if it
    // were an AddResponse.
    const text = formatAddPlain({
      sources: [],
      added: true,
      entry: { type: "npm", name: "backbone2", path: "backbone" },
    });
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("Installed");
    expect(text).toContain("backbone2");
    expect(text).toContain("npm");
  });

  it("renders a declarative filesystem add without claiming a sync is pending", () => {
    const text = formatAddPlain({
      sources: [],
      added: true,
      entry: { type: "filesystem", name: "my-stash", path: "/tmp/my-stash" },
    });
    expect(text).toContain("my-stash");
    expect(text).not.toContain("not yet synced");
    expect(text).toContain("akm index");
  });

  it("renders a declarative git/website add as not-yet-synced", () => {
    const text = formatAddPlain({
      sources: [],
      added: true,
      entry: { type: "git", name: "my-git", url: "https://example.com/repo.git" },
    });
    expect(text).toContain("my-git");
    expect(text).toContain("not yet synced");
    expect(text).toContain("akm bundle update my-git");
  });

  it("renders a no-op declarative add via its message, not 'Installed undefined'", () => {
    const text = formatAddPlain({ sources: [], added: false, message: "Source already configured" });
    expect(text).toBe("Source already configured");
  });
});

describe("formatUpdatePlain", () => {
  it("renders 'nothing to update' only when processed/plainSynced/skipped are all empty", () => {
    expect(formatUpdatePlain({ processed: [] })).toBe("update: nothing to update");
  });

  it("renders a successful plain git/website sync instead of 'nothing to update' (R-015/adjacent)", () => {
    // R-015-adjacent repro: a successful single-target `akm bundle update <git-name>`
    // returned processed: [] (git/website plain syncs have no UpdateResultItem
    // to report), so the old formatter rendered the same text as a true no-op.
    const text = formatUpdatePlain({
      processed: [],
      plainSynced: [{ id: "my-git", kind: "git", ref: "https://example.com/repo.git" }],
    });
    expect(text).not.toBe("update: nothing to update");
    expect(text).toContain("my-git");
    expect(text).toContain("synced");
  });

  it("renders filesystem reconciliation without claiming provider sync", () => {
    const text = formatUpdatePlain({
      processed: [],
      plainSynced: [{ id: "local", kind: "filesystem", ref: "/tmp/local" }],
    });
    expect(text).toBe("update: local reconciled (filesystem)");
  });

  it("reports skipped plain sources instead of omitting them (R-015)", () => {
    // R-015 repro: `akm bundle update --all` against a stash with only plain sources
    // returned processed: [] and rendered "nothing to update", never
    // mentioning the four configured sources anywhere.
    const text = formatUpdatePlain({
      processed: [],
      skipped: [
        { id: "docs-site", kind: "website", reason: "website caching not yet implemented for --all" },
        { id: "local-notes", kind: "filesystem", reason: "reflects your files in place" },
      ],
    });
    expect(text).not.toBe("update: nothing to update");
    expect(text).toContain("docs-site");
    expect(text).toContain("skipped");
    expect(text).toContain("local-notes");
  });

  it("still renders managed-install version changes as before", () => {
    const text = formatUpdatePlain({
      processed: [
        {
          id: "left-pad",
          changed: { any: true },
          previous: { resolvedVersion: "1.0.0" },
          installed: { resolvedVersion: "1.1.0" },
        },
      ],
    });
    expect(text).toBe("update: left-pad v1.0.0 → v1.1.0");
  });
});

// formatBundleRenamePlain used to print "Native scheduler bindings
// re-synced under the new name." whenever renameBundle's taskSync.ok was
// true — including when the sync itself had already reported per-binding
// failures in taskSync.result.failures, since the old code only ever set
// ok: true on a non-throwing sync call. Now that ok reflects
// result.failures.length === 0, the formatter must give a summary
// (installed/updated/removed counts) on success, and list each failure
// (never claiming "re-synced under the new name") when there are any.

function baseResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    oldId: "old",
    newId: "new",
    applied: true,
    config: { defaultBundleChanges: false, schedulerRefs: [] },
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

describe("formatBundleRenamePlain — unfinished workflow runs (#1239)", () => {
  it("names `run <id>` as the way to continue, and lists a blocked run with its status", () => {
    const text = formatBundleRenamePlain(
      baseResult({
        activeWorkflowRuns: [
          { id: "run-a", workflowRef: "old//workflows/foo", status: "active" },
          { id: "run-b", workflowRef: "old//workflows/foo", status: "blocked" },
        ],
      }),
    );
    expect(text).toContain("`akm workflow run <id>`");
    expect(text).toContain("`akm workflow resume <id>`");
    expect(text).toContain("run-a (old//workflows/foo, active)");
    expect(text).toContain("run-b (old//workflows/foo, blocked)");
  });
});
