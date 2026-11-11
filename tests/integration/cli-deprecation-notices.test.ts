// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { warnDeprecatedUse } from "../../src/cli/deprecations";
import { _resetParsedInvocationForTests, setParsedInvocation } from "../../src/cli/invocation";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

const CLI = path.resolve(import.meta.dir, "../../src/cli.ts");
let cleanup = () => {};
afterEach(() => cleanup());
function sandbox() {
  const storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
  writeSandboxConfig({ semanticSearchMode: "off" });
}
function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: undefined, AKM_EVENT_SOURCE: undefined, ...env },
    timeout: 30000,
  });
}
const notices = (stderr: string) => stderr.split("\n").filter((line) => line.includes("[deprecated]"));

test("a deprecated command prints one stderr line naming the replacement, and leaves stdout and the exit code alone", () => {
  sandbox();
  const old = run(["health", "--read-only", "--no-probe", "--format", "json"]);
  const lines = notices(old.stderr);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("akm doctor");
  const replacement = run(["doctor", "--read-only", "--no-probe", "--format", "json"]);
  expect(notices(replacement.stderr)).toHaveLength(0);
  expect(old.status).toBe(replacement.status);
  expect(JSON.parse(old.stdout).status).toBe(JSON.parse(replacement.stdout).status);
});

test("--quiet silences it; --help and internal invocations do not print it", () => {
  sandbox();
  expect(notices(run(["info", "--quiet"]).stderr)).toHaveLength(0);
  expect(notices(run(["info", "--help"]).stderr)).toHaveLength(0);
  expect(notices(run(["info"], { AKM_EVENT_SOURCE: "task" }).stderr)).toHaveLength(0);
  expect(notices(run(["info"]).stderr)).toHaveLength(1);
});

test("flags name their replacement; a replacement not built yet and the no-ref agent form print nothing", () => {
  const messages: string[] = [];
  const argsFor = (userArgs: string[]) => {
    _resetWarnOnceForTests();
    messages.length = 0;
    _setWarnSinkForTests((_level, args) => messages.push(args.join(" ")));
    const invocation = setParsedInvocation(["bun", "akm", ...userArgs]);
    const path = userArgs.filter((a) => !a.startsWith("-"));
    warnDeprecatedUse(path.slice(0, 1), invocation, undefined, {});
    return messages.join("\n");
  };
  try {
    expect(argsFor(["curate", "q", "--pack", "100"])).toContain("--max-tokens");
    expect(argsFor(["show", "x", "--detail", "brief"])).toContain("--outline");
    expect(argsFor(["show", "x", "--detail", "full"])).toBe("");
    expect(argsFor(["search", "q", "--include-proposed"])).toContain("--include quality=proposed");
    expect(argsFor(["task", "history"])).toBe("");
  } finally {
    _setWarnSinkForTests(undefined);
    _resetParsedInvocationForTests();
  }
});
