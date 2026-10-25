// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration: spawns a program for each harness.
//
// Setup tells the user which harnesses can have model work restricted, and the
// dispatcher runs model work on those with the restriction applied. This is the
// check that the claim is true: for every harness the registry advertises as
// `confinable`, model work that tries to change a file outside its scratch
// directory changes nothing, whatever the harness's authored args say. A stub
// program stands for each CLI and does what the real one does with the flags it
// is handed: it edits outside its working directory unless the harness's own
// restriction is on its command line. The same stub, run as agent work, does edit,
// so a pass is the restriction and not a stub that never writes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildExecution, resolveExecution } from "../../src/integrations/agent/execution";
import type { HarnessRunner } from "../../src/integrations/agent/runner";
import { runExecution } from "../../src/integrations/agent/runner-dispatch";
import { HARNESS_REGISTRY } from "../../src/integrations/harnesses";
import { fakeOpencodeMajor } from "../_helpers/opencode-version";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-confinement-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** What a CLI harness's restriction looks like on its command line, as the shell `case` pattern the stub tests. */
const RESTRICTION: Record<string, string> = {
  claude: '*" --restricted "*" --tools Read,Bash "*" --permission-mode dontAsk "*',
  codex: '*" --sandbox read-only "*',
  opencode: '*" --agent akm-model-work "*',
};

/** Arguments a user could author on the harness that would widen what it may do. */
const WIDENING_ARGS: Record<string, readonly string[]> = {
  claude: ["--add-dir", "/", "--allowedTools", "Edit", "--permission-mode", "bypassPermissions"],
  codex: ["--sandbox", "danger-full-access"],
  opencode: ["run", "--agent", "build", "--attach", "http://elsewhere"],
};

interface Stub {
  readonly runner: HarnessRunner;
  /** A file outside the working directory that the stub edits when nothing restricts it. */
  readonly outside: string;
  /** The working directory the stub ran in. */
  readonly cwd: () => string;
}

function stubFor(platform: string): Stub {
  // OpenCode's builder asks the binary its major; the stub answers 2, the one that can be confined.
  if (platform === "opencode") fakeOpencodeMajor(2);
  const dir = path.join(root, platform);
  fs.mkdirSync(dir);
  const outside = path.join(dir, "outside.txt");
  const where = path.join(dir, "cwd");
  const bin = path.join(dir, platform);
  fs.writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `pwd > '${where}'`,
      'args=" $* "',
      'case "$args" in',
      `  ${RESTRICTION[platform]}) ;;`,
      `  *) echo changed > '${outside}' ;;`,
      "esac",
      "echo done",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    runner: {
      kind: "harness",
      name: `${platform}-stub`,
      platform: platform as HarnessRunner["platform"],
      bin,
      args: [...(WIDENING_ARGS[platform] ?? [])],
      timeoutMs: 20_000,
    },
    outside,
    cwd: () => fs.readFileSync(where, "utf8").trim(),
  };
}

async function run(runner: HarnessRunner, modelWork: boolean) {
  const resolved = resolveExecution({ content: "look something up", runner, modelWork });
  return runExecution(buildExecution(resolved.request, resolved.runner));
}

const stubbed = Object.keys(RESTRICTION);

describe("model work on a CLI harness advertised as confinable", () => {
  for (const platform of stubbed) {
    describe(platform, () => {
      test("changes nothing outside its scratch directory, whatever its authored args say", async () => {
        const stub = stubFor(platform);
        const result = await run(stub.runner, true);
        expect(result.ok).toBe(true);
        expect(fs.existsSync(stub.outside)).toBe(false);
        const cwd = fs.realpathSync(path.dirname(stub.cwd()));
        expect(cwd).toBe(fs.realpathSync(os.tmpdir()));
        expect(path.basename(stub.cwd())).toStartWith("akm-model-work-");
        expect(fs.existsSync(stub.cwd())).toBe(false);
      });

      test("the same program, run as agent work, does edit (the check is not vacuous)", async () => {
        const stub = stubFor(platform);
        const result = await run({ ...stub.runner, args: [] }, false);
        expect(result.ok).toBe(true);
        expect(fs.existsSync(stub.outside)).toBe(true);
      });
    });
  }

  test("every harness the registry advertises as confinable is covered above", () => {
    const advertised = HARNESS_REGISTRY.filter((harness) => harness.confinable)
      .map((harness) => harness.id)
      .sort();
    expect(advertised).toEqual([...stubbed].sort());
  });
});
