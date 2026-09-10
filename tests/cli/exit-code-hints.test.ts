import { describe, expect, test } from "bun:test";
import { retiredCommandHint, retiredFlagHint } from "../../src/cli/retired-commands";
import { EMBEDDED_HINTS, EMBEDDED_HINTS_FULL } from "../../src/output/cli-hints";

describe("embedded exit-code hints", () => {
  for (const [name, hints] of [
    ["brief", EMBEDDED_HINTS],
    ["full", EMBEDDED_HINTS_FULL],
  ] as const) {
    test(`${name} pins health/internal codes and command failure semantics`, () => {
      expect(hints).toContain("| 4 | Health warning (`akm health` only) |");
      expect(hints).toContain("| 70 | Internal / unclassified error |");
      expect(hints).toContain("Not found or command-reported failure");
      expect(hints).toContain("`env run`, `secret run`, and `migrate`");
      expect(hints).toContain("`task run`");
      expect(hints).toContain("`agent`");
    });
  }

  test("full hints scope the two-signal guarantee to envelope surfaces", () => {
    expect(EMBEDDED_HINTS_FULL).toContain("On result-envelope surfaces, both signals are always set consistently.");
    expect(EMBEDDED_HINTS_FULL).toContain("Passthrough surfaces");
  });

  test("shipped task and show guidance uses the 0.9 contracts", () => {
    expect(EMBEDDED_HINTS).toContain("`task run` preserves configuration failures as exit 78");
    expect(EMBEDDED_HINTS_FULL).toContain("other failures exit 1");
    expect(EMBEDDED_HINTS_FULL).toContain("local index and materialized bundle files only");
    expect(EMBEDDED_HINTS_FULL).toContain("selected engine invocation timeout");
    expect(EMBEDDED_HINTS_FULL).toContain("--negative --reason");
  });

  test("every retired top-level proposal and renamed verb has an explicit replacement", () => {
    const expected: Record<string, string> = {
      proposals: "akm proposal list",
      accept: "akm proposal accept <id>",
      reject: "akm proposal reject <id>",
      diff: "akm proposal diff <id>",
      revert: "akm proposal revert <id>",
      save: "akm sync",
      events: "akm log",
      reflect: "akm improve <ref>",
      distill: "akm improve <ref>",
    };
    for (const [command, replacement] of Object.entries(expected)) {
      expect(retiredCommandHint([], command)).toContain(replacement);
    }
    expect(retiredCommandHint(["task"], "enable")).toContain("enabled: true");
    expect(retiredCommandHint(["task"], "disable")).toContain("enabled: false");
    expect(retiredCommandHint(["workflow"], "start")).toContain("workflow run");
    expect(retiredCommandHint(["workflow"], "next")).toContain("workflow status");
    // `complete` must point at a command that EXISTS: the external-driver
    // protocol it used to redirect to was removed, so brief/report are
    // themselves retired verbs now.
    expect(retiredCommandHint(["workflow"], "complete")).toContain("workflow run");
    expect(retiredCommandHint(["workflow"], "brief")).toContain("workflow run");
    expect(retiredCommandHint(["workflow"], "report")).toContain("workflow run");
  });

  // 0.9.0 release notes headline the removal of the whole `akm vault ...`
  // family; `task show` is also named as a removed subcommand but previously
  // had no hint entry. (`improve canary` is deliberately NOT here — `improve`
  // is a leaf command, not a group, so it never reaches this table; it has
  // its own more specific self-diagnosis in improve-cli.ts.)
  test("the retired vault family and task show have explicit replacements", () => {
    expect(retiredCommandHint([], "vault")).toContain("akm env list");
    expect(retiredCommandHint([], "vault")).toContain("akm secret set");
    expect(retiredCommandHint(["task"], "show")).toContain("akm show");
  });

  // `task list` is now a real subcommand (alias for `search --type task`), so
  // it must NOT surface the old retired-command hint anymore.
  test("task list is a real subcommand and no longer produces a retired-command hint", () => {
    expect(retiredCommandHint(["task"], "list")).toBeUndefined();
  });

  test("retired flags (as opposed to commands) hint their replacement procedure", () => {
    expect(retiredFlagHint(["index"], "--background")).toContain("--quiet");
    expect(retiredFlagHint(["setup"], "--detect-only")).toContain("akm setup");
    expect(retiredFlagHint(["setup"], "--reset-recommended")).toContain("recommended defaults");
    expect(retiredFlagHint(["proposal", "extract"], "--watch")).toContain("proposal extract --auto");
    expect(retiredFlagHint(["proposal", "extract"], "--debounce-ms")).toContain("proposal extract --auto");
    // Unretired flag / unrelated path: no hint.
    expect(retiredFlagHint(["search"], "--background")).toBeUndefined();
    expect(retiredFlagHint(["index"], "--full")).toBeUndefined();
  });
});
