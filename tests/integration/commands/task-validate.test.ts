// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #907: `akm task validate <path>` parses ONE task file by filesystem path
 * — not a concept ref/id, and the file need not live in any configured
 * bundle — and reports the same diagnostic `akm task sync` would produce
 * for it, without touching the scheduler. Follows the in-process CLI
 * harness pattern established by tasks-cli-envelope.test.ts: the file under
 * test lives in its own scratch directory, deliberately separate from the
 * `AKM_BUNDLE_DIR` stash, to prove the "need not live in a bundle" claim.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runCliStatusWithBundleDir as runCli } from "../../_helpers/cli";
import { makeSandboxDir, type SandboxedDir } from "../../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

function makeStashDir(): string {
  const d = makeSandboxDir("akm-task-validate-stash-");
  disposers.push(d);
  return d.dir;
}

/** Deliberately OUTSIDE the stash — the file under test need not live in a configured bundle. */
function makeScratchDir(): string {
  const d = makeSandboxDir("akm-task-validate-scratch-");
  disposers.push(d);
  return d.dir;
}

function writeFixture(dir: string, name: string, content: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe("akm task validate <path> (#907)", () => {
  test("a valid task source v4 file -> outcome 'valid', exit 0, resolved compiled-task shape present", async () => {
    const stash = makeStashDir();
    const scratch = makeScratchDir();
    // Same v4 shell-run fixture proven good by tests/tasks-scheduler-sync-v4.test.ts.
    const filePath = writeFixture(scratch, "nightly.yml", "version: 4\nrun: echo yes\nshell: sh\nschedule: '@daily'\n");

    const { stdout, status } = await runCli(["task", "validate", filePath], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.shape).toBe("task-validate");
    expect(env.ok).toBe(true);
    expect(env.outcome).toBe("valid");
    expect(env.sourceVersion).toBe(4);
    expect(env.path).toBe(filePath);
    expect(env.reason).toBeUndefined();
    expect(env.resolved).toBeDefined();
    expect(env.resolved.id).toBe("nightly");
    expect(env.resolved.version).toBe(4);
    expect(env.resolved.target).toEqual({ kind: "run", run: "echo yes", shell: "sh" });
    expect(env.resolved.schedule).toEqual([{ cron: "@daily", inputs: {}, source: "schedule", ordinal: 0 }]);
    // #907 review: never the file's own directory (an absolute path) — this
    // shape has no bundleName field at all, since validate never resolves one.
    expect(env.resolved.bundleName).toBeUndefined();
  });

  test("a task v2 file the deterministic migrator converts -> outcome 'converts', exit 0, no engine required", async () => {
    const stash = makeStashDir();
    const scratch = makeScratchDir();
    // Same v2 fixture proven convertible by tests/migrate-format.test.ts. A
    // `prompt:` task converts to a command-kind (`uses: akm/command`) target
    // — #907 review: validate must not require a configured engine to
    // report this `valid`/`converts` (no execution lowering runs at all), so
    // this test deliberately configures NO engine.
    const filePath = writeFixture(scratch, "legacy.yml", 'version: 2\nschedule: "@daily"\nprompt: Say hello\n');

    const { stdout, status } = await runCli(["task", "validate", filePath], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(true);
    expect(env.outcome).toBe("converts");
    expect(env.sourceVersion).toBe(2);
    expect(env.resolved).toBeDefined();
    expect(env.resolved.target.kind).toBe("uses");
  });

  test("a task v2 file the migrator cannot convert -> outcome 'blocked', exit 1, reason names the human-decision case", async () => {
    const stash = makeStashDir();
    const scratch = makeScratchDir();
    // Same unmigratable v2 fixture as tests/tasks-scheduler-sync-v4.test.ts's
    // #867 "one invalid desired task degrades" case (a schedule/command pair
    // task v2 never accepted, so the v2 -> v3 planner refuses it).
    const filePath = writeFixture(scratch, "b-invalid.yml", "version: 2\nschedule: '@daily'\ncommand: echo no\n");

    const { stdout, status } = await runCli(["task", "validate", filePath], stash);
    expect(status).toBe(1);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(false);
    expect(env.outcome).toBe("blocked");
    expect(env.sourceVersion).toBe(2);
    expect(env.reason).toContain("needs a human decision");
    expect(env.resolved).toBeUndefined();
  });

  test("a YAML file with no version field -> outcome 'not-a-task', exit 1", async () => {
    const stash = makeStashDir();
    const scratch = makeScratchDir();
    const filePath = writeFixture(
      scratch,
      "compose.yml",
      "name: my-service\nimage: nginx:latest\nports:\n  - '80:80'\n",
    );

    const { stdout, status } = await runCli(["task", "validate", filePath], stash);
    expect(status).toBe(1);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(false);
    expect(env.outcome).toBe("not-a-task");
    expect(env.sourceVersion).toBeUndefined();
    expect(env.resolved).toBeUndefined();
    expect(env.reason).toContain("version");
  });

  test("garbled YAML that does not parse at all -> outcome 'invalid' (not 'not-a-task'), exit 1", async () => {
    const stash = makeStashDir();
    const scratch = makeScratchDir();
    // An unclosed flow sequence — a genuine YAML syntax error, distinct from
    // "well-formed YAML with no version field" (the 'not-a-task' case above).
    // #907 review item 4: this must classify as 'invalid', carrying the
    // parser's own reason.
    const filePath = writeFixture(scratch, "garbled.yml", "version: 4\nrun: [unclosed\n");

    const { stdout, status } = await runCli(["task", "validate", filePath], stash);
    expect(status).toBe(1);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(false);
    expect(env.outcome).toBe("invalid");
    expect(env.sourceVersion).toBeUndefined();
    expect(env.resolved).toBeUndefined();
    expect(env.reason).toMatch(/flow sequence/i);
  });

  test("a task source v4 file missing an executable selector -> outcome 'invalid', exit 1", async () => {
    const stash = makeStashDir();
    const scratch = makeScratchDir();
    const filePath = writeFixture(scratch, "no-selector.yml", "version: 4\nschedule: '@daily'\n");

    const { stdout, status } = await runCli(["task", "validate", filePath], stash);
    expect(status).toBe(1);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(false);
    expect(env.outcome).toBe("invalid");
    expect(env.sourceVersion).toBe(4);
    expect(env.reason).toContain("uses or run");
    expect(env.resolved).toBeUndefined();
  });

  test("a v4 file with a cron sync's local backend cannot parse -> outcome 'invalid', exit 1 (#907 review item 1)", async () => {
    const stash = makeStashDir();
    const scratch = makeScratchDir();
    // Only 4 fields — `parseSchedule` requires 5. task-source-v4.ts's own
    // grammar check only requires a nonempty string with no GitHub Actions
    // expression, so this passes THAT check and would previously report
    // 'valid' here, only for `akm task sync` to reject it later.
    const filePath = writeFixture(scratch, "bad-cron.yml", "version: 4\nrun: echo hi\nschedule: '99 * * *'\n");

    const { stdout, status } = await runCli(["task", "validate", filePath], stash);
    expect(status).toBe(1);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(false);
    expect(env.outcome).toBe("invalid");
    expect(env.sourceVersion).toBe(4);
    expect(env.reason).toContain("expected 5 fields");
    expect(env.resolved).toBeUndefined();
  });

  test("a v4 file whose schedule entry leaves a required input unsatisfied -> outcome 'invalid', exit 1 (#907 review item 1)", async () => {
    const stash = makeStashDir();
    const scratch = makeScratchDir();
    const filePath = writeFixture(
      scratch,
      "bad-schedule-input.yml",
      [
        "version: 4",
        "run: echo hi",
        "inputs:",
        "  ticket:",
        "    type: string",
        "    required: true",
        "schedule:",
        "  - cron: '0 8 * * 1'",
        "",
      ].join("\n"),
    );

    const { stdout, status } = await runCli(["task", "validate", filePath], stash);
    expect(status).toBe(1);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(false);
    expect(env.outcome).toBe("invalid");
    expect(env.sourceVersion).toBe(4);
    expect(env.reason).toContain("declared inputs");
    expect(env.resolved).toBeUndefined();
  });

  test("a v4 file with a retired schedule[].enabled AND an ordinary grammar defect -> outcome 'invalid', exit 1, not the unmigratable-version wording", async () => {
    const stash = makeStashDir();
    const scratch = makeScratchDir();
    // Version 4 is supported; the unknown `bogus` field is an ordinary
    // grammar defect and must be reported as such, even though the file
    // also carries the retired schedule[].enabled shape the in-memory shim
    // otherwise tolerates.
    const filePath = writeFixture(
      scratch,
      "bogus-with-enabled.yml",
      "version: 4\nrun: echo hi\nshell: sh\nbogus: 1\nschedule:\n  - cron: '0 4 * * *'\n    enabled: true\n",
    );

    const { stdout, status } = await runCli(["task", "validate", filePath], stash);
    expect(status).toBe(1);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(false);
    expect(env.outcome).toBe("invalid");
    expect(env.sourceVersion).toBe(4);
    expect(env.reason).toContain("bogus is an unsupported field");
    expect(env.reason).not.toContain("needs a human decision");
    expect(env.resolved).toBeUndefined();
  });

  test("a nonexistent path -> usage error, exit 2", async () => {
    const stash = makeStashDir();
    const scratch = makeScratchDir();
    const filePath = path.join(scratch, "does-not-exist.yml");

    const { stderr, status } = await runCli(["task", "validate", filePath], stash);
    expect(status).toBe(2);
    const env = JSON.parse(stderr.trim());
    expect(env.ok).toBe(false);
    expect(env.code).toBe("INVALID_FLAG_VALUE");
    expect(env.error).toContain("not found");
  });

  test("a directory path -> usage error, exit 2", async () => {
    const stash = makeStashDir();
    const scratch = makeScratchDir();

    const { stderr, status } = await runCli(["task", "validate", scratch], stash);
    expect(status).toBe(2);
    const env = JSON.parse(stderr.trim());
    expect(env.ok).toBe(false);
    expect(env.code).toBe("INVALID_FLAG_VALUE");
    expect(env.error).toContain("not a regular file");
  });
});
