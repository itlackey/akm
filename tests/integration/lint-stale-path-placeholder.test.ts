// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// #927 — `stale-path` flagged a run-time filename template (e.g.
// `/reports/portfolio-review-<timestamp>.md`) as a broken literal path. These
// pin the placeholder forms that must be skipped, and that a genuinely
// missing literal path is still reported.

import { afterEach, describe, expect, test } from "bun:test";
import os from "node:os";
import { runBaseChecks } from "../../src/commands/lint/base-linter";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

function staleIssues(storage: IsolatedAkmStorage, body: string) {
  const issues = runBaseChecks({
    filePath: `${storage.stashDir}/workflows/w.md`,
    relPath: "workflows/w.md",
    raw: `---\nname: w\n---\n\n${body}`,
    data: { name: "w" },
    body,
    frontmatter: "name: w",
    bodyStartLine: 4,
    fix: false,
    stashRoot: storage.stashDir,
    stalePathRoots: [os.homedir(), storage.stashDir],
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
    expect(issues.map((issue) => issue.detail)).toEqual(["ephemeral path: /tmp/akm-5-gone/current.md"]);
  });

  test.each([
    [
      "generated output",
      "Run the following command:\n\n```sh\nexample-tool render --shot=/tmp/example-generated-image.png\n```",
    ],
    ["ordinary fenced paths", "```sh\ncat /tmp/akm-5-gone/input.md\n```"],
    ["tilde fence", "~~~sh\ncat /tmp/akm-5-gone/input.md\n~~~"],
    ["long fence with nested short fence", "````markdown\n```sh\ncat /tmp/akm-5-gone/input.md\n```\n````"],
    ["indented fence", "   ```sh\ncat /tmp/akm-5-gone/input.md\n   ```"],
  ])("%s is documentation, not a current filesystem assertion", (_name, body) => {
    storage = withIsolatedAkmStorage();
    expect(staleIssues(storage, body)).toEqual([]);
  });

  test.each(["```", "~~~"])("%s fence contents do not change the following prose's section", (fence) => {
    storage = withIsolatedAkmStorage();
    const body = `${fence}markdown\n## History\nFor example /tmp/akm-5-gone/example.md\n${fence}\nRead /tmp/akm-5-gone/current.md as current input.`;
    const issues = staleIssues(storage, body);
    expect(issues.map((issue) => issue.detail)).toEqual(["ephemeral path: /tmp/akm-5-gone/current.md"]);
    expect(issues[0]?.line).toBe(8);
  });

  test("mismatched delimiters and short or nonempty closers do not end a fence", () => {
    storage = withIsolatedAkmStorage();
    const body = "````sh\n~~~\n```\n```` trailing text\n/tmp/akm-5-gone/example.md\n````\n/tmp/akm-5-gone/current.md";
    expect(staleIssues(storage, body).map((issue) => issue.detail)).toEqual([
      "ephemeral path: /tmp/akm-5-gone/current.md",
    ]);
  });
});
