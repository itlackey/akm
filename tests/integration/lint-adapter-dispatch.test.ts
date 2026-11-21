// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm lint`'s non-akm adapter dispatch (`commands/lint/index.ts#lintViaAdapter`)
 * — GAP CLOSURE proof for llm-wiki.
 *
 * Before this change, `akm lint` special-cased exactly ONE non-akm adapter
 * (`okf`) and routed every other non-akm bundle — including llm-wiki —
 * through the AKM-shaped STASH_SUBDIRS sweep. A wiki root has no `knowledge/`,
 * `memories/`, etc. subdirs, so that sweep visited NOTHING: llm-wiki's own
 * four `validate()` checks (`uncited-raw` / `missing-description` /
 * `broken-xref` / `broken-source`, `core/adapter/adapters/llm-wiki-adapter.ts`)
 * were unreachable dead code from the CLI. `akm lint` now dispatches every
 * non-akm bundle through its OWN adapter's `validate()`
 * (`commands/lint/index.ts#lintViaAdapter`), closing that gap.
 *
 * This suite builds a fresh llm-wiki-shaped bundle at runtime (never touches
 * the shared conformance fixture at `tests/fixtures/bundles/llm-wiki/`, which
 * is deliberately clean) and drives it through the real `akm lint` CLI entry
 * point — not `llmWikiAdapter.validate()` directly (that surface already has
 * its own dedicated suite, `tests/core/adapter/llm-wiki-adapter.test.ts`).
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../../src/commands/lint/index";
import { detectAdapterId } from "../../src/core/adapter/detect-adapter";
import { _setWarnSinkForTests } from "../../src/core/warn";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

function write(root: string, relPath: string, content: string): void {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

describe("akm lint dispatches an llm-wiki bundle through llmWikiAdapter.validate()", () => {
  let storage: IsolatedAkmStorage;

  afterEach(() => storage?.cleanup());

  test("a dangling cross-reference trips broken-xref; an uncited raw source trips uncited-raw; a page with no description trips missing-description", async () => {
    storage = withIsolatedAkmStorage();
    const wikiRoot = path.join(storage.root, "my-wiki");

    write(wikiRoot, "schema.md", "# Wiki schema\n\nConventions live here.\n");
    write(wikiRoot, "index.md", "# Index\n");
    write(wikiRoot, "log.md", "# Log\n");
    // A raw ingested source that NO page cites — should trip `uncited-raw`.
    write(wikiRoot, "raw/2026-source.md", "# Raw source\n\nSome ingested material.\n");
    // A page with a description AND a cited source, but a body link to a page
    // that does not exist — should trip `broken-xref` (non-blocking).
    write(
      wikiRoot,
      "pages/http-caching.md",
      "---\ndescription: HTTP caching notes\n---\n\nSee [Varnish](varnish.md) for details.\n",
    );
    // A page missing a frontmatter `description` — should trip `missing-description`.
    write(wikiRoot, "pages/no-description.md", "# No description here\n\nJust body text.\n");

    // Sanity: the fixture really auto-detects as `llm-wiki` (a real, live
    // consumer of the same `looksLikeRoot` probe order `akm lint` uses) —
    // failing this would mean the dispatch never even runs.
    expect(detectAdapterId(wikiRoot)).toBe("llm-wiki");

    const result = await akmLint({ dir: wikiRoot });
    expect(result.ok).toBe(true);
    expect(result.fixed).toEqual([]); // validate() never writes — nothing is ever auto-fixed for a non-akm bundle

    const byIssue = (issue: string) => result.flagged.filter((f) => f.issue === issue);

    const brokenXref = byIssue("broken-xref");
    expect(brokenXref.length).toBeGreaterThan(0);
    expect(brokenXref.some((f) => f.file === "pages/http-caching.md" && f.detail.includes("varnish"))).toBe(true);

    const uncitedRaw = byIssue("uncited-raw");
    expect(uncitedRaw.length).toBeGreaterThan(0);
    expect(uncitedRaw.some((f) => f.file === "raw/2026-source.md")).toBe(true);

    const missingDescription = byIssue("missing-description");
    expect(missingDescription.some((f) => f.file === "pages/no-description.md")).toBe(true);

    // Every llm-wiki finding is non-blocking (`fixed: false` — the adapter
    // MUST NOT write; `core/adapter/bundle-adapter.ts`'s validate() contract).
    for (const issue of result.flagged) expect(issue.fixed).toBe(false);
  });

  test("a clean llm-wiki bundle lints with zero findings", async () => {
    storage = withIsolatedAkmStorage();
    const wikiRoot = path.join(storage.root, "clean-wiki");

    write(wikiRoot, "schema.md", "# Wiki schema\n");
    write(wikiRoot, "pages/topic.md", "---\ndescription: A well-formed page\n---\n\nNo dangling links here.\n");

    const result = await akmLint({ dir: wikiRoot });
    expect(result.ok).toBe(true);
    expect(result.flagged).toEqual([]);
    expect(result.fixed).toEqual([]);
  });
});

/**
 * `--type` names an AKM stash subdir. For a non-akm bundle the adapter's
 * `validate()` sees the whole bundle no matter what, so the flag is a silent
 * no-op — a user scoping a run got full-bundle output with nothing saying the
 * flag had not applied (issue #762). The refusal is deliberately a WARNING and
 * not an error: full-bundle validation is a superset of the requested scope, so
 * nothing goes unreported, and a hard error would break scripts passing one
 * `--type` across mixed-adapter bundle sets.
 */
describe("akm lint warns that --type is a no-op for a non-akm adapter (issue #762)", () => {
  let storage: IsolatedAkmStorage;
  afterEach(() => storage?.cleanup());

  function wikiBundle(root: string): void {
    write(root, "schema.md", "# Wiki schema\n");
    write(root, "pages/topic.md", "---\ndescription: A well-formed page\n---\n\nBody.\n");
  }

  function captureWarnings(): string[] {
    const lines: string[] = [];
    overrideSeam(_setWarnSinkForTests, (_level, args) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
    return lines;
  }

  test("the warning names the flag and the adapter, and the findings are unchanged", async () => {
    storage = withIsolatedAkmStorage();
    const wikiRoot = path.join(storage.root, "typed-wiki");
    wikiBundle(wikiRoot);

    const warnings = captureWarnings();
    const scoped = await akmLint({ dir: wikiRoot, typeFilter: "memories" });

    expect(warnings.some((line) => /--type "memories"/.test(line) && /llm-wiki/.test(line))).toBe(true);
    // The content contract from the issue: scoping changes nothing, it only
    // gains a signal. Compare against an unscoped run of the same bundle.
    const unscoped = await akmLint({ dir: wikiRoot });
    expect(scoped.flagged).toEqual(unscoped.flagged);
  });

  test("no warning is emitted when --type is absent", async () => {
    storage = withIsolatedAkmStorage();
    const wikiRoot = path.join(storage.root, "untyped-wiki");
    wikiBundle(wikiRoot);

    const warnings = captureWarnings();
    await akmLint({ dir: wikiRoot });

    expect(warnings.filter((line) => /--type/.test(line))).toEqual([]);
  });
});
