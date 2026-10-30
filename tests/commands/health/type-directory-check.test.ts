// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #831: the `type-directory-disagreement` health advisory must flag every
 * indexed asset whose resolved type disagrees with the type its directory
 * declares, while naming which classifier signal won so a deliberate
 * override (the two contracts asserted in
 * tests/integration/commands/show.test.ts) reads differently from an
 * unexplained one. Never a hard failure — always `status: "warn"`, never
 * `"fail"`.
 */

import { describe, expect, test } from "bun:test";
import {
  buildTypeDirectoryAdvisory,
  collectTypeDirectoryDisagreements,
  type TypeDirectoryEntry,
} from "../../../src/commands/health/type-directory-check";

/** An indexed entry of the `akm` adapter living under the synthetic `/stash` component root. */
function entry(rel: string, type: string, adapterId = "akm"): TypeDirectoryEntry {
  return { filePath: `/stash/${rel}`, type, root: "/stash", adapterId };
}

describe("collectTypeDirectoryDisagreements (#831)", () => {
  test("reports nothing when every entry's type matches its directory", () => {
    const entries: TypeDirectoryEntry[] = [
      entry("memories/note.md", "memory"),
      entry("knowledge/guide.md", "knowledge"),
      entry("commands/deploy.md", "command"),
    ];
    expect(collectTypeDirectoryDisagreements(entries, () => "")).toEqual([]);
  });

  test("does not check entries outside a DIR_TYPE_MAP directory", () => {
    const entries: TypeDirectoryEntry[] = [entry("skills/my-skill/SKILL.md", "skill")];
    expect(collectTypeDirectoryDisagreements(entries, () => "")).toEqual([]);
  });

  test("real defect shape: a memories/ note resolved as command is reported even without the old regex bug", () => {
    // #826 fixed the numeric-placeholder regex so this can no longer happen via
    // the old bug — construct the disagreement directly (mismatched type on the
    // entry) instead of relying on a body that would trip the old heuristic.
    const entries: TypeDirectoryEntry[] = [entry("memories/910ed479-3-f4f94df3.md", "command")];
    const readFile = () => "Ordering fee is $2,000 due at signing.";
    const result = collectTypeDirectoryDisagreements(entries, readFile);
    expect(result).toEqual([
      {
        path: "/stash/memories/910ed479-3-f4f94df3.md",
        resolved: "command",
        expected: "memory",
        winner: "unknown",
        knownGoodOverride: false,
      },
    ]);
  });

  test("legitimate override: knowledge/ file containing $ARGUMENTS is named, not silently accepted or mislabeled", () => {
    const entries: TypeDirectoryEntry[] = [entry("knowledge/deploy-cmd.md", "command")];
    const readFile = () => "Usage: /deploy $ARGUMENTS\n";
    const result = collectTypeDirectoryDisagreements(entries, readFile);
    expect(result).toEqual([
      {
        path: "/stash/knowledge/deploy-cmd.md",
        resolved: "command",
        expected: "knowledge",
        winner: "smart-md:$ARGUMENTS",
        knownGoodOverride: true,
      },
    ]);
  });

  test("legitimate override: agents/ file with `agent:` frontmatter is named, not silently accepted or mislabeled", () => {
    const entries: TypeDirectoryEntry[] = [entry("agents/reviewer.md", "command")];
    const readFile = () => "---\nagent: reviewer\n---\nBody.\n";
    const result = collectTypeDirectoryDisagreements(entries, readFile);
    expect(result).toEqual([
      {
        path: "/stash/agents/reviewer.md",
        resolved: "command",
        expected: "agent",
        winner: "smart-md:agent-frontmatter",
        knownGoodOverride: true,
      },
    ]);
  });

  test("unreadable file still reports the disagreement with an unknown reason", () => {
    const entries: TypeDirectoryEntry[] = [entry("memories/gone.md", "command")];
    const result = collectTypeDirectoryDisagreements(entries, () => undefined);
    expect(result).toEqual([
      {
        path: "/stash/memories/gone.md",
        resolved: "command",
        expected: "memory",
        winner: "unknown",
        knownGoodOverride: false,
      },
    ]);
  });

  test("sorts disagreements by path", () => {
    const entries: TypeDirectoryEntry[] = [entry("memories/z.md", "command"), entry("memories/a.md", "command")];
    const result = collectTypeDirectoryDisagreements(entries, () => "");
    expect(result.map((d) => d.path)).toEqual(["/stash/memories/a.md", "/stash/memories/z.md"]);
  });
});

describe("collectTypeDirectoryDisagreements classifier parity (#1288)", () => {
  test("README documentation under typed directories is not an incorrectly typed asset", () => {
    const entries = [
      entry("scripts/README.md", "knowledge"),
      entry("agents/README.md", "knowledge"),
      entry("workflows/README.md", "knowledge"),
    ];
    expect(collectTypeDirectoryDisagreements(entries, () => "# supporting documentation")).toEqual([]);
  });

  test("a recognized script extension under knowledge/ is not warned", () => {
    expect(collectTypeDirectoryDisagreements([entry("knowledge/example.sh", "script")], () => "")).toEqual([]);
  });

  test("skill supporting resources keep their intended treatment", () => {
    const entries = [
      entry("skills/demo/scripts/helper.sh", "script"),
      entry("skills/demo/notes/guide.md", "knowledge"),
    ];
    expect(collectTypeDirectoryDisagreements(entries, () => "")).toEqual([]);
  });

  test("the extension predicate applies at ancestor depth too", () => {
    expect(collectTypeDirectoryDisagreements([entry("knowledge/deep/tool.py", "script")], () => "")).toEqual([]);
  });

  test("an ordinary memories/ note indexed as command without an override still warns", () => {
    const result = collectTypeDirectoryDisagreements([entry("memories/note.md", "command")], () => "Plain note.");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ expected: "memory", resolved: "command", winner: "unknown" });
  });

  test("a non-akm adapter is evaluated by its own semantics, not stash directory names", () => {
    const entries = [entry("memories/concept.md", "concept", "okf"), entry("scripts/readme-like.md", "topic", "okf")];
    expect(collectTypeDirectoryDisagreements(entries, () => "")).toEqual([]);
  });

  test("ancestor directories outside the component root do not establish type intent", () => {
    const outside: TypeDirectoryEntry = {
      filePath: "/stash/memories/vendor/pkg/doc.md",
      type: "knowledge",
      root: "/stash/memories/vendor/pkg",
      adapterId: "akm",
    };
    expect(collectTypeDirectoryDisagreements([outside], () => "")).toEqual([]);
    const unrelated: TypeDirectoryEntry = { ...outside, root: "/elsewhere" };
    expect(collectTypeDirectoryDisagreements([unrelated], () => "")).toEqual([]);
  });

  test("an entry with no resolvable component root establishes no type intent", () => {
    const rootless: TypeDirectoryEntry = {
      filePath: `${process.cwd()}/memories/note.md`,
      type: "command",
      root: "",
      adapterId: "akm",
    };
    expect(collectTypeDirectoryDisagreements([rootless], () => "")).toEqual([]);
  });
});

describe("buildTypeDirectoryAdvisory (#831)", () => {
  test("returns undefined when nothing disagrees", () => {
    const entries: TypeDirectoryEntry[] = [entry("memories/note.md", "memory")];
    expect(buildTypeDirectoryAdvisory(entries, () => "")).toBeUndefined();
  });

  test("is always a warning, never a hard failure, even for an accidental-looking disagreement", () => {
    const entries: TypeDirectoryEntry[] = [entry("memories/910ed479-3-f4f94df3.md", "command")];
    const advisory = buildTypeDirectoryAdvisory(entries, () => "$2,000 due at signing.");
    expect(advisory?.name).toBe("type-directory-disagreement");
    expect(advisory?.status).toBe("warn");
    expect(advisory?.status).not.toBe("fail");
    expect(advisory?.message).toContain("winner=unknown");
    expect(advisory?.evidence?.disagreements).toEqual([
      {
        path: "/stash/memories/910ed479-3-f4f94df3.md",
        resolved: "command",
        expected: "memory",
        winner: "unknown",
        knownGoodOverride: false,
      },
    ]);
  });

  test("marks a known-good override in the message so it reads differently from an accident", () => {
    const entries: TypeDirectoryEntry[] = [entry("knowledge/deploy-cmd.md", "command")];
    const advisory = buildTypeDirectoryAdvisory(entries, () => "Usage: /deploy $ARGUMENTS\n");
    expect(advisory?.status).toBe("warn");
    expect(advisory?.message).toContain("winner=smart-md:$ARGUMENTS (known-good override)");
  });

  test("uses the displayPath projection for both message and evidence", () => {
    const entries: TypeDirectoryEntry[] = [entry("memories/note.md", "command")];
    const advisory = buildTypeDirectoryAdvisory(
      entries,
      () => "",
      (p) => p.replace("/stash/", ""),
    );
    expect(advisory?.message).toContain("memories/note.md");
    expect(advisory?.message).not.toContain("/stash/");
    expect((advisory?.evidence?.disagreements as Array<{ path: string }>)[0]?.path).toBe("memories/note.md");
  });
});
