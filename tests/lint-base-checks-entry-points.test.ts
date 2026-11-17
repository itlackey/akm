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
import { okfAdapter } from "../src/core/adapter/adapters/okf-adapter";
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

/** The rules every file gets and the checks of each type that has its own. */
const RULES = new Set([
  "unquoted-colon",
  "missing-updated",
  "stale-path",
  "missing-ref",
  "redacted-content",
  "missing-name-or-type",
  "missing-category",
  "invalid-task-yaml",
  "orphaned-stub",
  "placeholder-stub",
  "invalid-workflow-structure",
  "missing-skill-md",
]);

type Finding = [issue: string, detail?: string];

/** A file of the fixture bundle and the base-rule findings it must give on either route. */
const FIXTURE: Array<{ name: string; rel: string; content: string; expected: Finding[]; reportedAt?: string }> = [
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
    name: "an agent without a name or type",
    rel: "agents/nameless.md",
    content: "---\ndescription: x\nupdated: 2026-01-01\n---\n\nbody\n",
    expected: [["missing-name-or-type", "missing fields: name, type; suggested slug: nameless"]],
  },
  {
    name: "a fact without a category",
    rel: "facts/uncategorized.md",
    content: "---\ndescription: f\nupdated: 2026-01-01\n---\n\nbody\n",
    expected: [["missing-category", "fact is missing a `category` (personal|team|project|convention|meta)"]],
  },
  {
    name: "a task that does not parse",
    rel: "tasks/bad.yml",
    content: "uses: commands/review\nschedule: '@daily'\n",
    expected: [["invalid-task-yaml"]],
  },
  {
    name: "an inferred memory stub with no derived sibling",
    rel: "memories/stub.md",
    content: "---\ninferenceProcessed: true\nupdated: 2026-01-01\n---\n\nshort\n",
    expected: [["orphaned-stub", "inferenceProcessed stub with no derived sibling"]],
  },
  {
    name: "a workflow stub",
    rel: "workflows/stub.md",
    content: "---\ndescription: w\nupdated: 2026-01-01\n---\n\n# Example Workflow\n",
    expected: [["placeholder-stub", 'placeholder text: "Example Workflow"'], ["invalid-workflow-structure"]],
  },
  {
    name: "a skill folder with no SKILL.md",
    rel: "skills/broken/notes.md",
    content: "---\ndescription: n\n---\n\nbody\n",
    expected: [["missing-skill-md", "no SKILL.md in skills/broken/"]],
    reportedAt: "skills/broken",
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
  test.each(FIXTURE)("$name", async ({ rel, expected, reportedAt }) => {
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
      found.filter((f) => f.file === (reportedAt ?? rel) && RULES.has(f.issue)).map((f) => [f.issue, f.detail]);

    // The two routes agree on every finding, and the findings are the required ones.
    expect(findingsOf(validated)).toEqual(findingsOf(sweep));
    expect(findingsOf(sweep).map(([issue]) => issue)).toEqual(expected.map(([issue]) => issue));
    for (const [index, [, detail]] of expected.entries()) {
      if (detail !== undefined) expect(findingsOf(sweep)[index]?.[1]).toBe(detail);
    }
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

describe("a ref a file declares is checked wherever it points", () => {
  const FM = "---\ndescription: d\nupdated: 2026-01-01\n";

  async function missingRefs(rel: string): Promise<string[]> {
    const root = storage.stashDir;
    const config = loadConfig();
    const sweep = (await akmLint({ dir: root, config })).flagged;
    return sweep.filter((f) => f.file === rel && f.issue === "missing-ref").map((f) => f.detail);
  }

  test("a declared ref to a missing concept outside the type folders is reported, an existing one is not", async () => {
    put(storage.stashDir, "concepts/there.md", `${FM}---\n\nBody.\n`);
    put(
      storage.stashDir,
      "knowledge/a.md",
      `${FM}xrefs:\n  - concepts/there\n  - concepts/gone\nsupersededBy: concepts/also-gone\n---\n\nBody.\n`,
    );

    expect(await missingRefs("knowledge/a.md")).toEqual([
      "missing ref: concepts/gone (frontmatter xrefs; resolved to concepts/gone.md)",
      "missing ref: concepts/also-gone (frontmatter supersededBy; resolved to concepts/also-gone.md)",
    ]);
  });

  test("a path-looking word in prose that does not lead with a type folder is not a ref", async () => {
    put(storage.stashDir, "knowledge/p.md", `${FM}---\n\nSee concepts/gone and other//concepts/gone for details.\n`);

    expect(await missingRefs("knowledge/p.md")).toEqual([]);
  });

  test("a wiki page's own relative sources and wiki: xrefs resolve the way the wiki resolves them", async () => {
    const wiki = "knowledge/wikis/notes";
    put(storage.stashDir, `${wiki}/schema.md`, "# Wiki schema\n");
    put(storage.stashDir, `${wiki}/raw/there.md`, "---\ndescription: raw\n---\n\nSnapshot.\n");
    put(storage.stashDir, `${wiki}/pages/other.md`, "---\ndescription: other\n---\n\nBody.\n");
    put(
      storage.stashDir,
      `${wiki}/pages/p.md`,
      "---\ndescription: p\nxrefs:\n  - wiki:notes/pages/other\n  - wiki:notes/pages/gone\nsources:\n  - raw/there.md\n  - raw/gone.md\n---\n\nBody.\n",
    );

    expect(await missingRefs(`${wiki}/pages/p.md`)).toEqual([
      `missing ref: wiki:notes/pages/gone (frontmatter xrefs; resolved to ${wiki}/pages/gone.md)`,
      `missing ref: raw/gone.md (frontmatter sources; resolved to ${wiki}/raw/gone.md)`,
    ]);
  });

  test("the same holds in an OKF bundle, through its adapter's validate", async () => {
    const root = path.join(storage.root, "okf");
    put(root, "concepts/there.md", "---\ntype: concept\ntitle: There\n---\n\nBody.\n");
    put(
      root,
      "concepts/a.md",
      "---\ntype: concept\ntitle: A\nxrefs:\n  - concepts/there\n  - concepts/gone\n---\n\nBody.\n",
    );
    const config = loadConfig();
    const found = await okfAdapter.validate(
      { id: "okf", adapter: "okf", root, writable: true },
      [{ path: "concepts/a.md", op: "update" }],
      createValidateContext({ root, sources: [{ path: root }], config }),
    );

    expect(found.filter((f) => f.issue === "missing-ref").map((f) => f.detail)).toEqual([
      "missing ref: concepts/gone (frontmatter xrefs; resolved to concepts/gone.md)",
    ]);
  });
});
