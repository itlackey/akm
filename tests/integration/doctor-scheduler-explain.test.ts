// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm doctor scheduler sync`, `akm doctor explain` and the scheduler checks of
 * bare `akm doctor` give the same result as the commands they replace
 * (`task sync`/`task prune`, `task explain`/`workflow plan`, `task doctor`), and
 * the old commands keep their output and print one deprecation notice.
 *
 * The CLI runs as a subprocess with a fake `crontab` first on PATH, so no real
 * scheduler is read or written.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

const CLI = path.resolve(import.meta.dir, "../../src/cli.ts");
let storage: IsolatedAkmStorage;
let fakeBin = "";

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "akm-fake-crontab-"));
  const store = path.join(fakeBin, "crontab.store");
  fs.writeFileSync(
    path.join(fakeBin, "crontab"),
    `#!/bin/sh\nif [ "$1" = "-l" ]; then [ -f "${store}" ] && cat "${store}" && exit 0; echo "no crontab" >&2; exit 1; fi\ncat > "${store}"\n`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  storage.cleanup();
  fs.rmSync(fakeBin, { recursive: true, force: true });
});

function run(args: string[]) {
  return spawnSync("bun", [CLI, ...args, "--format", "json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      NO_COLOR: "1",
      FORCE_COLOR: undefined,
      BUN_TEST: undefined,
      AKM_EVENT_SOURCE: undefined,
    },
    timeout: 60000,
  });
}
const notices = (stderr: string) => stderr.split("\n").filter((line) => line.includes("[deprecated]"));

function write(relative: string, content: string): void {
  const file = path.join(storage.stashDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

describe.skipIf(process.platform !== "linux")("doctor scheduler and explain", () => {
  test("doctor scheduler sync is task sync; task sync prints the notice", () => {
    for (const flags of [["--dry-run"], []]) {
      const old = run(["task", "sync", ...flags]);
      const replacement = run(["doctor", "scheduler", "sync", ...flags]);
      expect(replacement.stdout).toBe(old.stdout);
      expect(replacement.status).toBe(old.status);
      expect(notices(replacement.stderr)).toHaveLength(0);
      const lines = notices(old.stderr);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("akm doctor scheduler sync");
    }
    // --rebind is the same handler too.
    expect(run(["doctor", "scheduler", "sync", "--rebind", "--dry-run"]).stdout).toBe(
      run(["task", "sync", "--rebind", "--dry-run"]).stdout,
    );
  });

  test("doctor scheduler sync --prune is task prune; task prune prints the notice", () => {
    const old = run(["task", "prune"]);
    const replacement = run(["doctor", "scheduler", "sync", "--prune"]);
    expect(replacement.stdout).toBe(old.stdout);
    expect(replacement.status).toBe(old.status);
    expect(notices(replacement.stderr)).toHaveLength(0);
    expect(notices(old.stderr)).toHaveLength(1);
    expect(notices(old.stderr)[0]).toContain("akm doctor scheduler sync --prune");
  });

  test("bare doctor carries the task doctor report; task doctor prints the notice", () => {
    const old = run(["task", "doctor"]);
    const replacement = run(["doctor", "--read-only", "--no-probe"]);
    expect(old.status).toBe(0);
    expect(notices(replacement.stderr)).toHaveLength(0);
    expect(notices(old.stderr)).toHaveLength(1);
    expect(notices(old.stderr)[0]).toContain("`akm doctor`");
    const { scheduler } = JSON.parse(replacement.stdout);
    expect(scheduler).toBeDefined();
    const doctor = JSON.parse(old.stdout);
    for (const key of ["backend", "akm", "caller", "bindings", "logDir", "scheduleSubset"]) {
      expect(scheduler[key]).toEqual(doctor[key]);
    }
    // `akm health` keeps its output: no scheduler field.
    expect(JSON.parse(run(["health", "--read-only", "--no-probe"]).stdout).scheduler).toBeUndefined();
  });

  test("doctor explain <task> is task explain, with input flags", () => {
    write(
      "tasks/demo.yml",
      [
        "version: 4",
        "name: Demo",
        "inputs:",
        "  scope:",
        "    type: string",
        "    default: a",
        "uses: commands/note",
        "",
      ].join("\n"),
    );
    write("commands/note.md", "Say hi.\n");
    const old = run(["task", "explain", "demo", "--scope", "b"]);
    const replacement = run(["doctor", "explain", "demo", "--scope", "b"]);
    expect(old.status).toBe(0);
    expect(replacement.stdout).toBe(old.stdout);
    expect(notices(replacement.stderr)).toHaveLength(0);
    expect(notices(old.stderr)).toHaveLength(1);
    expect(notices(old.stderr)[0]).toContain("akm doctor explain");
    // A ref nothing owns fails the same way.
    expect(run(["doctor", "explain", "missing"]).status).toBe(run(["task", "explain", "missing"]).status);
  });

  test("doctor explain <workflow> is workflow plan, and writes nothing", () => {
    write(
      "workflows/flow.md",
      [
        "---",
        "type: workflow",
        "description: Flow",
        "steps:",
        "  - id: only",
        "---",
        "",
        "## only",
        "",
        "Do it.",
        "",
      ].join("\n"),
    );
    const old = run(["workflow", "plan", "workflows/flow"]);
    const replacement = run(["doctor", "explain", "workflows/flow"]);
    expect(old.status).toBe(0);
    expect(JSON.parse(replacement.stdout).published).toBe(false);
    expect(replacement.stdout).toBe(old.stdout);
    expect(notices(replacement.stderr)).toHaveLength(0);
    expect(notices(old.stderr)).toHaveLength(1);
    expect(notices(old.stderr)[0]).toContain("akm doctor explain");
  });
});
