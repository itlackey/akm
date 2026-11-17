// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The base asset checks have one implementation (`runBaseChecks`) and one decision on whether a rule applies to a file
 * (`ruleApplies`). The `akm lint` sweep and an adapter's `validate` reach them by different routes, so one fixture is run
 * through both and the findings must be the same: the skill and LLM Wiki exemptions and the bundle's `lint.skip` hold on
 * either route.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../src/commands/lint";
import { akmAdapter } from "../src/core/adapter/adapters/akm-adapter";
import { createValidateContext } from "../src/core/adapter/validate-context";
import { loadConfig } from "../src/core/config/config";
import { resolveSourceEntries } from "../src/indexer/search/search-source";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});
afterEach(() => storage.cleanup());

function put(root: string, rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const BASE_RULES = new Set([
  "unquoted-colon",
  "missing-updated",
  "stale-path",
  "missing-ref",
  "redacted-content",
  "missing-name-or-type",
]);

type Finding = [issue: string, detail: string];

/** A file of the fixture bundle and the base-rule findings it must give on either route. */
const FIXTURE: Array<{ name: string; rel: string; content: string; expected: Finding[] }> = [
  {
    name: "a note without updated",
    rel: "knowledge/no-updated.md",
    content: "---\ndescription: Note\n---\n\nBody.\n",
    expected: [["missing-updated", "no updated field in frontmatter"]],
  },
  {
    name: "a skill is exempt from missing-updated",
    rel: "skills/deploy/SKILL.md",
    content: "---\nname: deploy\ndescription: Deploy\n---\n\nBody.\n",
    expected: [],
  },
  {
    name: "a command without a name or type",
    rel: "commands/nameless.md",
    content: "---\ndescription: x\nupdated: 2026-01-01\n---\n\nrun $ARGUMENTS\n",
    expected: [["missing-name-or-type", "missing fields: name, type; suggested slug: nameless"]],
  },
  {
    name: "an LLM Wiki page is exempt from missing-updated",
    rel: "wikis/notes/pages/page.md",
    content: "---\ndescription: A page\npageKind: concept\n---\n\nBody.\n",
    expected: [],
  },
  {
    name: "an LLM Wiki raw snapshot is exempt from missing-updated",
    rel: "wikis/notes/raw/snap.md",
    content: "---\nname: snap\ndescription: Snapshot\nsourceUrl: https://example.test\ntags: [a]\n---\n\nSnapshot.\n",
    expected: [],
  },
  {
    name: "an LLM Wiki file that reads as a command is exempt from missing-name-or-type",
    rel: "wikis/notes/pages/runs.md",
    content: "---\ndescription: Runs\npageKind: concept\n---\n\nRun $ARGUMENTS.\n",
    expected: [],
  },
  {
    name: "an unquoted colon in the description",
    rel: "knowledge/colon.md",
    content: "---\ndescription: Colon: in it\nupdated: 2026-01-01\n---\n\nBody.\n",
    expected: [["unquoted-colon", "description value contains unquoted colon: Colon: in it"]],
  },
  {
    name: "a stale path",
    rel: "knowledge/stale.md",
    content: "---\ndescription: Stale\nupdated: 2026-01-01\n---\n\nWrite to /tmp/akm-5-gone/current.md.\n",
    expected: [["stale-path", "ephemeral path: /tmp/akm-5-gone/current.md"]],
  },
  {
    name: "a stale path the bundle's lint.skip names",
    rel: "knowledge/skipped.md",
    content: "---\ndescription: Skipped\nupdated: 2026-01-01\n---\n\nWrite to /tmp/akm-5-gone/current.md.\n",
    expected: [],
  },
  {
    name: "a missing prose ref and a missing frontmatter ref",
    rel: "knowledge/refs.md",
    content:
      "---\ndescription: Refs\nupdated: 2026-01-01\nxrefs:\n  - memories/gone\n---\n\nSee stash//knowledge/gone.\n",
    expected: [
      ["missing-ref", "missing ref: stash//knowledge/gone (resolved to knowledge/gone.md)"],
      ["missing-ref", "missing ref: memories/gone (frontmatter xrefs; resolved to memories/gone.md)"],
    ],
  },
  {
    name: "redacted content",
    rel: "knowledge/redacted.md",
    content: "---\ndescription: Redacted\nupdated: 2026-01-01\n---\n\nThe key is [REDACTED].\n",
    expected: [
      ["redacted-content", "asset contains [REDACTED]; restore the original non-secret prose from version history"],
    ],
  },
];

describe("the base checks give the same findings through the lint sweep and through adapter validate", () => {
  test.each(FIXTURE)("$name", async ({ rel, expected }) => {
    const root = storage.stashDir;
    put(root, "wikis/notes/schema.md", "# Wiki schema\n");
    for (const file of FIXTURE) put(root, file.rel, file.content);
    fs.writeFileSync(
      path.join(storage.root, "config", "akm", "config.json"),
      JSON.stringify({
        bundles: { stash: { path: root, writable: true, lint: { skip: { "stale-path": ["knowledge/skipped.md"] } } } },
        defaultBundle: "stash",
      }),
    );
    const config = loadConfig();

    const sweep = (await akmLint({ dir: root, config })).flagged;
    const ctx = createValidateContext({ root, sources: resolveSourceEntries(root, config) });
    const validated = await akmAdapter.validate(
      { id: "stash", adapter: "akm", root, writable: true },
      FIXTURE.map((file) => ({ path: file.rel, op: "update" as const })),
      ctx,
    );

    const findingsOf = (found: Array<{ file: string; issue: string; detail: string }>): Finding[] =>
      found.filter((f) => f.file === rel && BASE_RULES.has(f.issue)).map((f) => [f.issue, f.detail]);

    expect(findingsOf(sweep)).toEqual(expected);
    expect(findingsOf(validated)).toEqual(expected);
  });
});

describe("a bundle that is an LLM Wiki of its own", () => {
  test("gives no missing-updated or missing-name-or-type for its snapshots and pages, and still reports a broken link", async () => {
    const wiki = path.join(storage.root, "my-wiki");
    put(wiki, "schema.md", "# Wiki schema\n");
    put(
      wiki,
      "raw/snap.md",
      "---\nname: snap\ndescription: Snapshot\nsourceUrl: https://example.test\n---\n\nSnapshot.\n",
    );
    put(wiki, "pages/runs.md", "---\ndescription: Runs\n---\n\nRun $ARGUMENTS. See [Varnish](varnish.md).\n");

    const result = await akmLint({ dir: wiki });

    expect(result.flagged.filter((f) => f.issue === "missing-updated" || f.issue === "missing-name-or-type")).toEqual(
      [],
    );
    expect(result.flagged.some((f) => f.issue === "broken-xref" && f.file === "pages/runs.md")).toBe(true);
  });
});
