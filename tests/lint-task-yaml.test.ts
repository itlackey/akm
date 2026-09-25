// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm lint` no longer reports a clean scan for a task file that cannot run
 * (issue #760).
 *
 * Two blind spots, one root cause — every task reader collapsed a YAML parse
 * failure onto `{}`, and every task rule short-circuits on an empty mapping:
 *
 *   1. A `tasks/*.yml` whose YAML does not parse (bad indentation, an
 *      unterminated quote, tab characters) produced `flagged: 0`.
 *   2. A `tasks/*.yaml` file — the near-miss spelling akm never indexes and
 *      never schedules — was not even collected by the directory walk, so it
 *      was invisible rather than flagged.
 *
 * All THREE task-lint surfaces are pinned here, because the bug was present in
 * each and they must agree: the CLI sweep (`commands/lint/index.ts`), the
 * `akm` adapter's `validate` (the proposal-preflight surface), and the
 * dedicated `akm-task` format adapter.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../src/commands/lint/index";
import { akmAdapter } from "../src/core/adapter/adapters/akm-adapter";
import { akmTaskAdapter } from "../src/core/adapter/adapters/akm-task-adapter";
import type { BundleComponent } from "../src/core/adapter/types";
import { createValidateContext } from "../src/core/adapter/validate-context";
import { makeConfig } from "./_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

/**
 * Genuinely unparseable YAML: an unterminated single quote plus a tab-indented
 * continuation. `yaml`'s parser throws on this — it is not merely a document
 * that parses to a non-mapping.
 */
const MALFORMED_TASK = "version: 4\nrun: 'echo hi\nname:\n\tbroken: '@daily'\n";

const VALID_TASK = "version: 4\nrun: echo hi\n";

function writeTask(stashDir: string, relPath: string, content: string): string {
  const full = path.join(stashDir, "tasks", relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
}

function component(root: string, adapter: string): BundleComponent {
  return { id: "fixture", adapter, root, writable: true };
}

describe("akm lint — malformed task YAML (issue #760)", () => {
  let storage: IsolatedAkmStorage;
  afterEach(() => storage?.cleanup());

  test("a tasks/*.yml that does not parse is flagged, not reported clean", async () => {
    storage = withIsolatedAkmStorage();
    writeTask(storage.stashDir, "broken.yml", MALFORMED_TASK);

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });

    expect(result.summary.flagged).toBeGreaterThan(0);
    const parseFindings = result.flagged.filter(
      (issue) => issue.issue === "invalid-task-yaml" && issue.file.endsWith("broken.yml"),
    );
    expect(parseFindings.length).toBe(1);
    expect(parseFindings[0]?.detail).toMatch(/invalid|YAML|parse/i);
  });

  test("a well-formed task still lints clean — the new check is not a blanket flag", async () => {
    storage = withIsolatedAkmStorage();
    writeTask(storage.stashDir, "nightly.yml", VALID_TASK);

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });

    expect(result.flagged.filter((issue) => issue.issue === "invalid-task-yaml")).toEqual([]);
  });

  test("a v2 task auto-shims to v4 and lints clean (deprecation is a read-time stderr warning, not a lint flag)", async () => {
    // A3: parseTaskSource converts v2/v3 sources to v4 in memory instead of
    // throwing (see parse-task-source.ts and the previous-release corpus
    // test). Lint must agree with the runtime: a readable legacy task is not
    // "invalid-task-yaml" — flagging it would tell the user their working,
    // scheduled task is broken when it is not.
    storage = withIsolatedAkmStorage();
    writeTask(storage.stashDir, "legacy.yml", "version: 2\nschedule: '@daily'\nprompt: hello\n");

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });

    expect(result.flagged.filter((issue) => issue.file.endsWith("legacy.yml"))).toEqual([]);
  });

  test("a tasks/*.yaml file is flagged for its extension instead of being skipped", async () => {
    storage = withIsolatedAkmStorage();
    // Content is VALID — the finding must come from the extension alone, so the
    // near-miss cannot hide behind "well, it was broken anyway".
    writeTask(storage.stashDir, "misnamed.yaml", VALID_TASK);

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });

    const findings = result.flagged.filter((issue) => issue.file.endsWith("misnamed.yaml"));
    expect(findings.map((issue) => issue.issue)).toEqual(["invalid-task-yaml"]);
    expect(findings[0]?.detail).toMatch(/\.yaml/);
    expect(findings[0]?.detail).toMatch(/never indexed or scheduled/);
  });

  test("a malformed tasks/*.yaml reports BOTH the extension and the parse failure", async () => {
    storage = withIsolatedAkmStorage();
    writeTask(storage.stashDir, "double-trouble.yaml", MALFORMED_TASK);

    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });

    const details = result.flagged
      .filter((issue) => issue.file.endsWith("double-trouble.yaml"))
      .map((issue) => issue.detail);
    expect(details.some((d) => /invalid|YAML|parse/i.test(d))).toBe(true);
    expect(details.some((d) => /\.yaml extension/.test(d))).toBe(true);
  });
});

describe("akm adapter validate() — malformed task YAML (issue #760)", () => {
  let storage: IsolatedAkmStorage;
  afterEach(() => storage?.cleanup());

  test("reports the parse failure the CLI sweep reports, so the two surfaces agree", async () => {
    storage = withIsolatedAkmStorage();
    writeTask(storage.stashDir, "broken.yml", MALFORMED_TASK);

    const diagnostics = await akmAdapter.validate(
      component(storage.stashDir, "akm"),
      [{ path: "tasks/broken.yml", op: "update" }],
      createValidateContext({ root: storage.stashDir }),
    );

    expect(diagnostics.filter((d) => d.issue === "invalid-task-yaml").length).toBeGreaterThan(0);
  });
});

describe("akm-task adapter validate() — malformed task YAML (issue #760)", () => {
  let storage: IsolatedAkmStorage;
  afterEach(() => storage?.cleanup());

  test("a malformed .yml is invalid-task-yaml, not silence", async () => {
    storage = withIsolatedAkmStorage();
    const root = path.join(storage.root, "task-bundle");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "broken.yml"), MALFORMED_TASK, "utf8");

    const diagnostics = await akmTaskAdapter.validate(
      component(root, "akm-task"),
      [{ path: "broken.yml", op: "update" }],
      createValidateContext({ root }),
    );

    expect(diagnostics.map((d) => d.issue)).toEqual(["invalid-task-yaml"]);
    expect(diagnostics[0]?.detail).toMatch(/invalid|YAML|parse/i);
  });

  test("a .yaml task file reaches validate() and is flagged for the extension", async () => {
    storage = withIsolatedAkmStorage();
    const root = path.join(storage.root, "task-bundle");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "misnamed.yaml"), VALID_TASK, "utf8");

    const diagnostics = await akmTaskAdapter.validate(
      component(root, "akm-task"),
      [{ path: "misnamed.yaml", op: "update" }],
      createValidateContext({ root }),
    );

    expect(diagnostics.map((d) => d.issue)).toEqual(["invalid-task-yaml"]);
    expect(diagnostics[0]?.detail).toMatch(/\.yaml/);
  });

  test("`akm lint` on an akm-task bundle collects the .yaml near miss end to end", async () => {
    storage = withIsolatedAkmStorage();
    const root = path.join(storage.root, "task-bundle");
    fs.mkdirSync(root, { recursive: true });
    // A conformant `.yml` task makes the root detect as `akm-task`.
    fs.writeFileSync(path.join(root, "nightly.yml"), VALID_TASK, "utf8");
    fs.writeFileSync(path.join(root, "misnamed.yaml"), VALID_TASK, "utf8");

    const result = await akmLint({ dir: root, config: makeConfig(storage.stashDir) });

    const findings = result.flagged.filter((issue) => issue.file.endsWith("misnamed.yaml"));
    expect(findings.map((issue) => issue.issue)).toEqual(["invalid-task-yaml"]);
  });
});
