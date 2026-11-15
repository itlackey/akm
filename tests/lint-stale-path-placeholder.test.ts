// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// #927 — `stale-path` flagged a run-time filename template (e.g.
// `/reports/portfolio-review-<timestamp>.md`) as a broken literal path. These
// pin the placeholder forms that must be skipped, and that a genuinely
// missing literal path is still reported.

import { afterEach, describe, expect, test } from "bun:test";
import { runBaseChecks } from "../src/commands/lint/base-linter";
import { runBaseValidateChecks } from "../src/core/adapter/adapters/shared";
import { createValidateContext } from "../src/core/adapter/validate-context";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

function staleIssues(storage: IsolatedAkmStorage, body: string) {
  const issues = runBaseChecks({
    filePath: `${storage.stashDir}/workflows/w.md`,
    relPath: "workflows/w.md",
    raw: `---\nname: w\n---\n\n${body}`,
    data: { name: "w" },
    body,
    frontmatter: "name: w",
    fix: false,
    stashRoot: storage.stashDir,
  });
  return issues.filter((issue) => issue.issue === "stale-path");
}

describe("stale-path skips run-time filename templates (#927)", () => {
  let storage: IsolatedAkmStorage;
  afterEach(() => storage?.cleanup());

  test.each([
    ["angle-bracket placeholder", "Write to /home/founder3/akm/reports/portfolio-review-<timestamp>.md."],
    ["brace placeholder", "Write to /home/founder3/akm/reports/portfolio-review-{stamp}.md."],
    ["${VAR} placeholder", "Write to /home/founder3/akm/reports/portfolio-review-${STAMP}.md."],
    ["YYYYMMDD date-format run", "Write to /home/founder3/akm/reports/portfolio-review-YYYYMMDD.md."],
    ["HHMMSS date-format run", "Write to /home/founder3/akm/reports/portfolio-review-HHMMSS.md."],
    ["glob star", "Write to /home/founder3/akm/reports/portfolio-review-*.md."],
    ["glob question mark", "Write to /home/founder3/akm/reports/portfolio-review-?.md."],
  ])("%s is not reported", (_label, body) => {
    storage = withIsolatedAkmStorage();
    expect(staleIssues(storage, body)).toEqual([]);
  });

  test("a genuinely missing literal path is still reported", () => {
    storage = withIsolatedAkmStorage();
    const issues = staleIssues(storage, `Write to ${storage.stashDir}/reports/portfolio-review-final.md.`);
    expect(issues.length).toBe(1);
    expect(issues[0]?.detail).toContain("portfolio-review-final");
  });

  test("an existing literal path is not reported", () => {
    storage = withIsolatedAkmStorage();
    expect(staleIssues(storage, `Read from \`${storage.stashDir}\` for config.`)).toEqual([]);
  });

  test("sentence punctuation after a path is not part of it", () => {
    storage = withIsolatedAkmStorage();
    expect(staleIssues(storage, `Read from ${storage.stashDir}.`)).toEqual([]);
  });

  test.each([
    ["historical wording", "Historically the run wrote to /tmp/akm-5-gone/out.md."],
    ["example wording", "For example, copy it to /tmp/akm-5-gone/out.md."],
    ["other-host home", "Config lives at /home/akm-5-nobody/.config/x.json."],
  ])("%s is not current guidance", (_label, body) => {
    storage = withIsolatedAkmStorage();
    expect(staleIssues(storage, body)).toEqual([]);
  });

  test("a historical section and a current section are told apart", () => {
    storage = withIsolatedAkmStorage();
    const issues = staleIssues(
      storage,
      "## History\n\nWrote /tmp/akm-5-gone/old.md.\n\n## Usage\n\nWrite to /tmp/akm-5-gone/current.md.\n",
    );
    expect(issues.map((issue) => issue.detail)).toEqual(["nonexistent path: /tmp/akm-5-gone/current.md"]);
  });

  test("the adapter validate path applies the same rules", async () => {
    storage = withIsolatedAkmStorage();
    const body = [
      "Historically wrote /tmp/akm-5-gone/old.md.",
      "Write to /tmp/akm-5-gone/current.md.",
      "Config at /home/akm-5-nobody/.config/x.json.",
      "See core//tasks/akm-5-gone.",
    ].join("\n");
    const diagnostics = await runBaseValidateChecks(
      "knowledge/n.md",
      { data: { name: "n", updated: "2026-01-01" }, content: body, frontmatter: "name: n\nupdated: 2026-01-01" },
      storage.stashDir,
      createValidateContext({ root: storage.stashDir }),
    );
    expect(diagnostics.map((d) => `${d.issue}: ${d.detail}`)).toEqual([
      "stale-path: nonexistent path: /tmp/akm-5-gone/current.md",
      "missing-ref: missing ref: core//tasks/akm-5-gone",
    ]);
  });
});
