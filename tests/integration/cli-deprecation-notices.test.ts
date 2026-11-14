// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { warnDeprecatedUse, warnWorkflowUse } from "../../src/cli/deprecations";
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
const allNotices = (stderr: string) => stderr.split("\n").filter((line) => line.includes("[deprecated]"));
// The sandbox points the CLI at its bundle with AKM_BUNDLE_DIR, which has a notice of its own (tested below).
const notices = (stderr: string) => allNotices(stderr).filter((line) => !line.includes("AKM_BUNDLE_DIR"));

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
  // An unknown subcommand is a usage error, not a use of the command.
  expect(notices(run(["log", "tail"]).stderr)).toHaveLength(0);
});

test("flags name their replacement; the no-ref agent form print nothing", () => {
  const messages: string[] = [];
  const argsFor = (userArgs: string[]) => {
    _resetWarnOnceForTests();
    messages.length = 0;
    _setWarnSinkForTests((_level, args) => messages.push(args.join(" ")));
    const invocation = setParsedInvocation(["bun", "akm", ...userArgs]);
    const path = userArgs.filter((a) => !a.startsWith("-"));
    warnDeprecatedUse(path.slice(0, 1), invocation, { ref: { type: "positional" } }, {});
    return messages.join("\n");
  };
  try {
    expect(argsFor(["curate", "q", "--pack", "100"])).toContain("--max-tokens");
    expect(argsFor(["show", "x", "--detail", "brief"])).toContain("--outline");
    expect(argsFor(["show", "x", "--detail", "full"])).toBe("");
    expect(argsFor(["search", "q", "--include-proposed"])).toContain("--include quality=proposed");
    expect(argsFor(["search", "--by-usage"])).toContain("akm doctor metrics assets");
  } finally {
    _setWarnSinkForTests(undefined);
    _resetParsedInvocationForTests();
  }
});

test("task history points at doctor log --task only when it names a task; the cross-task form says there is no replacement", () => {
  const messages: string[] = [];
  const noticeFor = (userArgs: string[]) => {
    _resetWarnOnceForTests();
    messages.length = 0;
    _setWarnSinkForTests((_level, args) => messages.push(args.join(" ")));
    const invocation = setParsedInvocation(["bun", "akm", ...userArgs]);
    warnDeprecatedUse(
      ["task", "history"],
      invocation,
      { task: { type: "positional" }, id: { type: "string" }, limit: { type: "string" } },
      {},
    );
    return messages.join("\n");
  };
  try {
    expect(noticeFor(["task", "history", "nightly"])).toContain("`akm doctor log --task <id>`");
    expect(noticeFor(["task", "history", "--id", "nightly"])).toContain("`akm doctor log --task <id>`");
    const bare = noticeFor(["task", "history", "--limit", "5"]);
    expect(bare).not.toContain("doctor log");
    expect(bare).toContain("no replacement");
    expect(bare).toContain("akm doctor metrics");
    expect(bare.split("\n")).toHaveLength(1);
  } finally {
    _setWarnSinkForTests(undefined);
    _resetParsedInvocationForTests();
  }
});

test("deprecated environment variables print one notice naming the replacement, once per process", () => {
  const messages: string[] = [];
  const notice = (userArgs: string[], env: NodeJS.ProcessEnv) => {
    _resetWarnOnceForTests();
    messages.length = 0;
    _setWarnSinkForTests((_level, args) => messages.push(args.join(" ")));
    const invocation = setParsedInvocation(["bun", "akm", ...userArgs]);
    warnDeprecatedUse(userArgs.slice(0, 1), invocation, {}, env);
    warnDeprecatedUse(userArgs.slice(0, 1), invocation, {}, env);
    return messages.filter((m) => m.includes("[deprecated]"));
  };
  try {
    const skip = notice(["upgrade"], { AKM_UPGRADE_SKIP_CHECKSUM: "1" });
    expect(skip).toHaveLength(1);
    expect(skip[0]).toContain("AKM_UPGRADE_SKIP_CHECKSUM");
    expect(skip[0]).toContain("akm upgrade --skip-checksum");
    expect(notice(["search"], { AKM_UPGRADE_SKIP_CHECKSUM: "1" })).toHaveLength(0);
    expect(notice(["upgrade"], { AKM_UPGRADE_SKIP_CHECKSUM: "0" })).toHaveLength(0);
    expect(notice(["search"], { AKM_SQLITE_JOURNAL_MODE: "DELETE" })[0]).toContain("no replacement");
    expect(notice(["search"], { AKM_VERBOSE: "1" })[0]).toContain("--verbose");
    expect(notice(["search"], { AKM_DEBUG: "1" })[0]).toContain("--verbose");
    expect(notice(["search"], {})).toHaveLength(0);
    expect(notice(["search"], { AKM_VERBOSE: "1", AKM_EVENT_SOURCE: "task" })).toHaveLength(0);
  } finally {
    _setWarnSinkForTests(undefined);
    _resetParsedInvocationForTests();
  }
});

test("a deprecated variable's notice reaches stderr, and --quiet silences it", () => {
  sandbox();
  const lines = notices(run(["info"], { AKM_VERBOSE: "1" }).stderr);
  expect(lines.filter((l) => l.includes("AKM_VERBOSE"))).toHaveLength(1);
  expect(notices(run(["info", "--quiet"], { AKM_VERBOSE: "1" }).stderr)).toHaveLength(0);
});

test("extract: --sessions matches --type; --type prints a notice naming --sessions; both is a usage error", () => {
  sandbox();
  const empty = path.join(process.env.XDG_CACHE_HOME ?? process.env.HOME ?? ".", "no-sessions");
  const base = ["proposal", "extract", "--location", empty, "--dry-run", "--format", "json"];
  const withType = run([...base, "--type", "claude"]);
  const withSessions = run([...base, "--sessions", "claude"]);
  expect(withSessions.status).toBe(withType.status);
  expect(withSessions.stdout).toBe(withType.stdout);
  expect(notices(withSessions.stderr)).toHaveLength(0);
  const lines = notices(withType.stderr);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("--type");
  expect(lines[0]).toContain("--sessions");
  expect(notices(run([...base, "--type", "claude", "--quiet"]).stderr)).toHaveLength(0);

  const both = run([...base, "--type", "claude", "--sessions", "claude"]);
  expect(both.status).not.toBe(0);
  expect(both.stderr + both.stdout).toContain("--sessions and --type");
});

test("improve --require-feedback-signal names the strategy setting; remember --auto, --enrich and --show-similar say there is no replacement", () => {
  const messages: string[] = [];
  const argsFor = (userArgs: string[]) => {
    _resetWarnOnceForTests();
    messages.length = 0;
    _setWarnSinkForTests((_level, args) => messages.push(args.join(" ")));
    const invocation = setParsedInvocation(["bun", "akm", ...userArgs]);
    const path = userArgs.filter((a) => !a.startsWith("-"));
    warnDeprecatedUse(path.slice(0, 1), invocation, { ref: { type: "positional" } }, {});
    return messages.join("\n");
  };
  try {
    expect(argsFor(["improve", "--require-feedback-signal"])).toContain(
      "processes.proactiveMaintenance.enabled: false",
    );
    expect(argsFor(["improve"])).toBe("");
    for (const flag of ["--auto", "--enrich", "--show-similar"]) {
      const text = argsFor(["remember", "note", flag]);
      expect(text).toContain(flag);
      expect(text).toContain("removed in 0.11");
      expect(text).toContain("no replacement flag");
    }
    expect(argsFor(["remember", "note"])).toBe("");
  } finally {
    _setWarnSinkForTests(undefined);
    _resetParsedInvocationForTests();
  }
});

test("a config that sets extends prints one notice per process, and --quiet silences it", () => {
  sandbox();
  const configPath = process.env.AKM_CONFIG_FILE ?? path.join(process.env.XDG_CONFIG_HOME ?? "", "akm", "config.json");
  const base = path.join(path.dirname(configPath), "base.json");
  fs.writeFileSync(base, JSON.stringify({ configVersion: "0.9.0" }));
  fs.writeFileSync(configPath, JSON.stringify({ configVersion: "0.9.0", semanticSearchMode: "off", extends: base }));
  const extendsNotices = (stderr: string) => stderr.split("\n").filter((l) => l.includes("`extends` is Deprecated"));
  expect(extendsNotices(run(["config", "list"]).stderr)).toHaveLength(1);
  expect(extendsNotices(run(["config", "list", "--quiet"]).stderr)).toHaveLength(0);
});

test("proposal reject --yes and -y say reject no longer asks; a plain reject prints nothing", () => {
  const messages: string[] = [];
  const noticeFor = (userArgs: string[]) => {
    _resetWarnOnceForTests();
    messages.length = 0;
    _setWarnSinkForTests((_level, args) => messages.push(args.join(" ")));
    const invocation = setParsedInvocation(["bun", "akm", "proposal", "reject", ...userArgs]);
    warnDeprecatedUse(["proposal", "reject"], invocation, { id: { type: "positional" } }, {});
    return messages.join("\n");
  };
  try {
    for (const flag of ["--yes", "-y"]) {
      const text = noticeFor(["abc", "--reason", "r", flag]);
      expect(text).toContain(`[deprecated] ${flag} is deprecated`);
      expect(text).toContain("reject no longer asks for confirmation");
    }
    expect(noticeFor(["abc", "--reason", "r"])).toBe("");
  } finally {
    _setWarnSinkForTests(undefined);
    _resetParsedInvocationForTests();
  }
});

test("every akm workflow command, a workflow ref run through akm run, and a task that runs a workflow say workflows go in 0.11", () => {
  const messages: string[] = [];
  const capture = (fn: () => void) => {
    _resetWarnOnceForTests();
    messages.length = 0;
    _setWarnSinkForTests((_level, args) => messages.push(args.join(" ")));
    fn();
    return messages.join("\n");
  };
  try {
    for (const sub of ["run", "plan", "status", "list", "create", "resume", "abandon"]) {
      const text = capture(() => {
        const invocation = setParsedInvocation(["bun", "akm", "workflow", sub, "x"]);
        warnDeprecatedUse(["workflow", sub], invocation, { target: { type: "positional" } }, {});
      });
      expect(text).toContain(`[deprecated] akm workflow ${sub} is deprecated and is removed in 0.11`);
      expect(text).toContain("tasks take over their ordered steps");
    }
    setParsedInvocation(["bun", "akm", "run", "workflows/release"]);
    expect(capture(() => warnWorkflowUse("running workflow workflows/release", {}))).toContain(
      "[deprecated] running workflow workflows/release is deprecated and is removed in 0.11: workflows go in 0.11",
    );
    // Not for akm's own runs or a scheduled one.
    expect(capture(() => warnWorkflowUse("running workflow workflows/release", { AKM_EVENT_SOURCE: "task" }))).toBe("");
    setParsedInvocation(["bun", "akm", "task", "run", "nightly", "--scheduled"]);
    expect(capture(() => warnWorkflowUse("task nightly, which runs workflow workflows/release,", {}))).toBe("");
  } finally {
    _setWarnSinkForTests(undefined);
    _resetParsedInvocationForTests();
  }
});

// ── 0.10.261122: forms that 0.11 removes and that had no notice ─────────────────────────────────

const formNotices = notices;

const FORMS: { args: string[]; mentions: string[] }[] = [
  { args: ["lint", "--auto-fix"], mentions: ["--auto-fix", "use `--fix`"] },
  { args: ["migrate", "apply", "--dry-run"], mentions: ["--dry-run", "`akm migrate status`"] },
  { args: ["show", "skills/x", "--lead", "--max-chars", "50"], mentions: ["--max-chars", "`--max-tokens`"] },
  { args: ["config", "list", "--format", "yaml"], mentions: ["--format yaml", "`--format json`"] },
  { args: ["hints", "--detail", "full"], mentions: ["--detail full", "`akm hints`", "`akm help <command>`"] },
  { args: ["search", "zzz", "--detail", "agent"], mentions: ["--detail agent", "`--detail normal`"] },
  { args: ["curate", "zzz", "--detail=agent"], mentions: ["--detail agent", "`--detail normal`"] },
  { args: ["bundle", "update", "--yes"], mentions: ["--yes", "no effect"] },
  { args: ["bundle", "add", "--allow-dangerous-env-keys"], mentions: ["--allow-dangerous-env-keys", "no effect"] },
  { args: ["env", "run", "--allow-dangerous-env-keys"], mentions: ["--allow-dangerous-env-keys", "no effect"] },
  {
    args: ["registry", "add", "http://x.example/i.json", "--options", "{}"],
    mentions: ["--options", "nothing reads it"],
  },
  { args: ["task", "add", "--rebind"], mentions: ["--rebind", "`akm doctor scheduler sync --rebind`"] },
];

test("each form 0.11 removes prints one notice naming its replacement; --quiet silences it and nothing else changes", () => {
  sandbox();
  for (const { args, mentions } of FORMS) {
    const loud = run(args);
    const lines = formNotices(loud.stderr);
    expect(lines, args.join(" ")).toHaveLength(1);
    for (const text of mentions) expect(lines[0], args.join(" ")).toContain(text);
    expect(lines[0]).toContain("removed in 0.11");
    const quiet = run([...args, "--quiet"]);
    expect(formNotices(quiet.stderr), args.join(" ")).toHaveLength(0);
    expect(quiet.stdout, args.join(" ")).toBe(loud.stdout);
    expect(quiet.status, args.join(" ")).toBe(loud.status);
  }
}, 120000);

test("--output <file> says to redirect stdout, and still writes the file", () => {
  sandbox();
  const file = path.join(process.env.XDG_CACHE_HOME ?? ".", "out.json");
  const loud = run(["config", "list", "--output", file]);
  const lines = formNotices(loud.stderr);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("--output is deprecated");
  expect(lines[0]).toContain("redirect stdout");
  const written = fs.readFileSync(file, "utf8");
  const quiet = run(["config", "list", "--output", file, "--quiet"]);
  expect(formNotices(quiet.stderr)).toHaveLength(0);
  expect(fs.readFileSync(file, "utf8")).toBe(written);
  expect(quiet.status).toBe(loud.status);
});

test("the forms print nothing when they are not used: --format json, hints --detail brief, search --detail normal", () => {
  const messages: string[] = [];
  const argsFor = (userArgs: string[], commandPath: string[]) => {
    _resetWarnOnceForTests();
    messages.length = 0;
    _setWarnSinkForTests((_level, args) => messages.push(args.join(" ")));
    const invocation = setParsedInvocation(["bun", "akm", ...userArgs]);
    warnDeprecatedUse(commandPath, invocation, { q: { type: "positional" } }, {});
    return messages.join("\n");
  };
  try {
    expect(argsFor(["search", "q", "--format=yaml"], ["search"])).toContain("--format yaml");
    expect(argsFor(["search", "q", "--format", "json"], ["search"])).toBe("");
    expect(argsFor(["hints", "--detail", "brief"], ["hints"])).toBe("");
    expect(argsFor(["search", "q", "--detail", "normal"], ["search"])).toBe("");
    expect(argsFor(["info", "--detail", "agent"], ["info"])).not.toContain("--detail agent");
    expect(argsFor(["task", "add", "x"], ["task", "add"])).toContain("akm import <file> --type task");
    expect(argsFor(["task", "add", "x", "--rebind"], ["task", "add"])).not.toContain("akm import");
  } finally {
    _setWarnSinkForTests(undefined);
    _resetParsedInvocationForTests();
  }
});

test("AKM_BUNDLE_DIR and AKM_REGISTRY_URL print one notice when set and read, and nothing for akm's own or scheduled runs", () => {
  const messages: string[] = [];
  const notice = (userArgs: string[], commandPath: string[], env: NodeJS.ProcessEnv) => {
    _resetWarnOnceForTests();
    messages.length = 0;
    _setWarnSinkForTests((_level, args) => messages.push(args.join(" ")));
    const invocation = setParsedInvocation(["bun", "akm", ...userArgs]);
    warnDeprecatedUse(commandPath, invocation, { q: { type: "positional" } }, env);
    warnDeprecatedUse(commandPath, invocation, { q: { type: "positional" } }, env);
    return messages.filter((m) => m.includes("[deprecated]"));
  };
  try {
    const bundle = notice(["search", "q"], ["search"], { AKM_BUNDLE_DIR: "/x" });
    expect(bundle).toHaveLength(1);
    expect(bundle[0]).toContain("AKM_BUNDLE_DIR");
    expect(bundle[0]).toContain("`defaultBundle`");
    expect(notice(["search", "q"], ["search"], { AKM_BUNDLE_DIR: " " })).toHaveLength(0);
    expect(notice(["hints"], ["hints"], { AKM_BUNDLE_DIR: "/x" })).toHaveLength(0);
    // The scheduler's rows set AKM_BUNDLE_DIR inline and run `task run --scheduled`; akm's own runs stamp AKM_EVENT_SOURCE.
    expect(notice(["task", "run", "nightly", "--scheduled"], ["task", "run"], { AKM_BUNDLE_DIR: "/x" })).toHaveLength(
      0,
    );
    for (const source of ["task", "improve", "audit"]) {
      expect(notice(["search", "q"], ["search"], { AKM_BUNDLE_DIR: "/x", AKM_EVENT_SOURCE: source })).toHaveLength(0);
    }

    const registry = notice(["search", "q", "--from", "registry"], ["search"], {
      AKM_REGISTRY_URL: "https://r.example/i.json",
    });
    expect(registry).toHaveLength(1);
    expect(registry[0]).toContain("AKM_REGISTRY_URL");
    expect(registry[0]).toContain("config `registries`");
    expect(
      notice(["search", "q", "--from=all"], ["search"], { AKM_REGISTRY_URL: "https://r.example/i.json" }),
    ).toHaveLength(1);
    // Not read by a local search or another command, so no notice.
    expect(notice(["search", "q"], ["search"], { AKM_REGISTRY_URL: "https://r.example/i.json" })).toHaveLength(0);
    expect(
      notice(["info"], ["info"], { AKM_REGISTRY_URL: "https://r.example/i.json" }).filter((m) =>
        m.includes("AKM_REGISTRY_URL"),
      ),
    ).toHaveLength(0);
    expect(notice(["search", "q", "--from", "registry"], ["search"], { AKM_REGISTRY_URL: "" })).toHaveLength(0);
  } finally {
    _setWarnSinkForTests(undefined);
    _resetParsedInvocationForTests();
  }
});

test("AKM_BUNDLE_DIR reaches stderr once, and --quiet and a scheduled run print nothing", () => {
  sandbox();
  const own = (stderr: string) => allNotices(stderr).filter((line) => line.includes("AKM_BUNDLE_DIR"));
  expect(own(run(["config", "list"]).stderr)).toHaveLength(1);
  expect(own(run(["config", "list", "--quiet"]).stderr)).toHaveLength(0);
  expect(own(run(["config", "list"], { AKM_EVENT_SOURCE: "task" }).stderr)).toHaveLength(0);
  expect(own(run(["task", "run", "no-such-task", "--scheduled"]).stderr)).toHaveLength(0);
});

function writeConfig(extra: Record<string, unknown>) {
  const configPath = process.env.AKM_CONFIG_FILE ?? path.join(process.env.XDG_CONFIG_HOME ?? "", "akm", "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ configVersion: "0.9.0", semanticSearchMode: "off", ...extra }));
}
const configNotices = (stderr: string) => stderr.split("\n").filter((l) => l.includes("Deprecated and"));

test("config keys improve.strategies, improve.qualityGate and a strategy limit print one notice each, once per process", () => {
  sandbox();
  writeConfig({ improve: { strategies: { mine: { limit: 3 } }, qualityGate: {} } });
  const loud = run(["config", "list"]);
  const lines = configNotices(loud.stderr);
  expect(lines).toHaveLength(2);
  const keys = lines.find((l) => l.includes("`improve.strategies` and `improve.qualityGate`")) ?? "";
  expect(keys).toContain("`experimental.learning.strategies` and `experimental.learning.qualityGate`");
  const limit = lines.find((l) => l.includes(".limit`")) ?? "";
  expect(limit).toContain("`improve.strategies.mine.limit`");
  expect(limit).toContain("`--limit` or `processes.reflect.limit`");
  const quiet = run(["config", "list", "--quiet"]);
  expect(configNotices(quiet.stderr)).toHaveLength(0);
  expect(quiet.stdout).toBe(loud.stdout);
  expect(quiet.status).toBe(loud.status);
  // akm's own runs and --help print nothing.
  expect(configNotices(run(["config", "list"], { AKM_EVENT_SOURCE: "improve" }).stderr)).toHaveLength(0);
  expect(configNotices(run(["config", "list", "--help"]).stderr)).toHaveLength(0);
});

test("config keys improve.stateGc.collect and a consolidate limit, removed in 0.11 with nothing to switch to, print a notice", () => {
  sandbox();
  writeConfig({
    improve: { stateGc: { collect: true } },
    experimental: { learning: { strategies: { mine: { processes: { consolidate: { limit: 5 } } } } } },
  });
  const loud = run(["config", "list"]);
  const lines = configNotices(loud.stderr);
  expect(lines).toHaveLength(2);
  expect(lines.find((l) => l.includes("`improve.stateGc.collect`"))).toContain("with no replacement");
  expect(lines.find((l) => l.includes("consolidate.limit`"))).toContain(
    "`experimental.learning.strategies.mine.processes.consolidate.limit`",
  );
  const quiet = run(["config", "list", "--quiet"]);
  expect(configNotices(quiet.stderr)).toHaveLength(0);
  expect(quiet.stdout).toBe(loud.stdout);
});

test("a config that uses only experimental.learning.* prints no config notice", () => {
  sandbox();
  writeConfig({ experimental: { learning: { strategies: { mine: { description: "d" } }, qualityGate: {} } } });
  const result = run(["config", "list"]);
  expect(result.status).toBe(0);
  expect(configNotices(result.stderr)).toHaveLength(0);
  expect(result.stderr).not.toContain("experimental.learning.strategies` and");
});
