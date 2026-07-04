// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Coverage-hardening: `parseTaskDocument` classification + coercion boundaries.
 *
 * `resolvePromptSource` is a prompt-shape classifier (file vs asset-ref vs
 * inline vs Windows-abs) — the same "many shapes, one tested" pattern as the
 * exemplar relink bug. The existing suite tests `./file`, `agent:name`, plain
 * inline and one Windows path, but leaves the ambiguous boundaries (word:word
 * inline vs ref, `../` relative, ref-with-no-name) and the entire `timeoutMs`,
 * `readParams`, `readStringArray`, and `command`-array coercion logic untested.
 * A sign/off-by-one or misclassification in any of these silently mis-targets a
 * scheduled task.
 */

import { describe, expect, test } from "bun:test";
import { UsageError } from "../../src/core/errors";
import { parseTaskDocument } from "../../src/tasks/parser";

function parse(yaml: string, id = "t") {
  return parseTaskDocument({ yaml, filePath: `/stash/tasks/${id}.yml`, id });
}

function promptSource(yaml: string) {
  const task = parse(yaml);
  if (task.target.kind !== "prompt") throw new Error(`expected prompt target, got ${task.target.kind}`);
  return task.target.source;
}

// ── resolvePromptSource classification boundaries ─────────────────────────────

describe("parseTaskDocument — prompt source classification", () => {
  test("'../' relative path is a file (parent-relative, not just './')", () => {
    const src = promptSource('schedule: "@daily"\nprompt: ../shared/p.md');
    expect(src.kind).toBe("file");
    if (src.kind === "file") expect(src.path).toBe("../shared/p.md");
  });

  test("absolute path is a file", () => {
    const src = promptSource('schedule: "@daily"\nprompt: /abs/prompts/p.md');
    expect(src.kind).toBe("file");
  });

  test("asset ref with uppercase type still classifies as asset (case-insensitive regex)", () => {
    const src = promptSource('schedule: "@daily"\nprompt: Agent:StandupBot');
    expect(src.kind).toBe("asset");
    if (src.kind === "asset") expect(src.ref).toBe("Agent:StandupBot");
  });

  test("plain sentence with a colon after a SPACE stays inline (space breaks the ref token)", () => {
    // "Summarise this: and that" — the token before ':' contains a space, so the
    // asset-ref regex must NOT match; this is the boundary that keeps ordinary
    // English prompts from being mis-read as `type:name` refs.
    const src = promptSource('schedule: "@daily"\nprompt: "Summarise this: and that"');
    expect(src.kind).toBe("inline");
    if (src.kind === "inline") expect(src.text).toBe("Summarise this: and that");
  });

  test("a colon with NOTHING after it is inline, not an asset ref (ref needs a name char)", () => {
    // Trailing colon: `^[a-z][a-z0-9_-]*:[^\\s]` requires a non-space AFTER ':'.
    const src = promptSource('schedule: "@daily"\nprompt: "todo:"');
    expect(src.kind).toBe("inline");
  });

  test("a bare word (no colon) is inline", () => {
    const src = promptSource('schedule: "@daily"\nprompt: standup');
    expect(src.kind).toBe("inline");
  });
});

// ── timeoutMs coercion branches ───────────────────────────────────────────────

describe("parseTaskDocument — timeoutMs coercion", () => {
  const base = 'schedule: "@daily"\nprompt: agent:x';

  test("omitted timeoutMs => undefined (inherit config default)", () => {
    expect(parse(base).timeoutMs).toBeUndefined();
  });

  test("positive number => that value (override)", () => {
    expect(parse(`${base}\ntimeoutMs: 60000`).timeoutMs).toBe(60000);
  });

  test("explicit null => null (disabled, no timeout)", () => {
    expect(parse(`${base}\ntimeoutMs: null`).timeoutMs).toBeNull();
  });

  test("the string 'null' => null (disabled)", () => {
    expect(parse(`${base}\ntimeoutMs: "null"`).timeoutMs).toBeNull();
  });

  test("zero => null (disabled) — boundary at 0", () => {
    expect(parse(`${base}\ntimeoutMs: 0`).timeoutMs).toBeNull();
  });

  test("negative number => null (disabled)", () => {
    expect(parse(`${base}\ntimeoutMs: -5`).timeoutMs).toBeNull();
  });

  test("a non-numeric STRING number (e.g. '60000') is NOT honored => undefined (inherit)", () => {
    // Only real YAML numbers override; a quoted string number falls through to
    // 'inherit'. Pinning this documents the shape contract so a future 'be
    // helpful and parseInt it' change is a conscious decision.
    expect(parse(`${base}\ntimeoutMs: "60000"`).timeoutMs).toBeUndefined();
  });
});

// ── command coercion (array form) ─────────────────────────────────────────────

describe("parseTaskDocument — command target", () => {
  test("command as a YAML array preserves argv boundaries (no whitespace re-split)", () => {
    const yaml = ['schedule: "@daily"', "command:", "  - akm", "  - improve", '  - "--limit 25"', ""].join("\n");
    const task = parse(yaml);
    expect(task.target.kind).toBe("command");
    if (task.target.kind === "command") {
      // The array element "--limit 25" must stay a single argv entry — a string
      // command would split it on whitespace, an array must not.
      expect(task.target.cmd).toEqual(["akm", "improve", "--limit 25"]);
    }
  });

  test("command as a string splits on whitespace", () => {
    const task = parse('schedule: "@daily"\ncommand: akm improve --limit 25');
    if (task.target.kind === "command") {
      expect(task.target.cmd).toEqual(["akm", "improve", "--limit", "25"]);
    } else {
      throw new Error("expected command target");
    }
  });

  test("empty command array throws", () => {
    const yaml = ['schedule: "@daily"', "command: []", ""].join("\n");
    // An empty array is falsy-count 0 targets => 'must set one of' error path,
    // OR the empty-array guard — either way it must throw, never silently pass.
    expect(() => parse(yaml)).toThrow(UsageError);
  });
});

// ── params coercion ───────────────────────────────────────────────────────────

describe("parseTaskDocument — workflow params coercion", () => {
  test("params given as a JSON string are parsed into an object", () => {
    const yaml = ['schedule: "@daily"', "workflow: workflow:wf", 'params: \'{"region":"us-east-1"}\'', ""].join("\n");
    const task = parse(yaml);
    if (task.target.kind === "workflow") {
      expect(task.target.params).toEqual({ region: "us-east-1" });
    } else {
      throw new Error("expected workflow target");
    }
  });

  test("omitted params default to an empty object", () => {
    const task = parse('schedule: "@daily"\nworkflow: workflow:wf');
    if (task.target.kind === "workflow") {
      expect(task.target.params).toEqual({});
    } else {
      throw new Error("expected workflow target");
    }
  });

  test("params as a JSON ARRAY (not a mapping) throws", () => {
    const yaml = ['schedule: "@daily"', "workflow: workflow:wf", "params: '[1,2,3]'", ""].join("\n");
    expect(() => parse(yaml)).toThrow(/must be a mapping or a JSON object/);
  });
});

// ── tags coercion (string form) ───────────────────────────────────────────────

describe("parseTaskDocument — tags coercion", () => {
  test("a comma/space-separated STRING of tags is split into an array", () => {
    const task = parse('schedule: "@daily"\nprompt: agent:x\ntags: "alpha, beta gamma"');
    expect(task.tags).toEqual(["alpha", "beta", "gamma"]);
  });

  test("a YAML array of tags is preserved", () => {
    const yaml = ['schedule: "@daily"', "prompt: agent:x", "tags: [one, two]", ""].join("\n");
    expect(parse(yaml).tags).toEqual(["one", "two"]);
  });

  test("empty tags => undefined (omitted from the document)", () => {
    const task = parse('schedule: "@daily"\nprompt: agent:x\ntags: ""');
    expect(task.tags).toBeUndefined();
  });
});

// ── target-count guardrails (exactly-one) ─────────────────────────────────────

describe("parseTaskDocument — exactly-one-target enforcement", () => {
  test("workflow + command together throws (more than one target)", () => {
    const yaml = ['schedule: "@daily"', "workflow: workflow:wf", "command: akm improve", ""].join("\n");
    expect(() => parse(yaml)).toThrow(/more than one/);
  });

  test("an empty-string target does NOT count as a set target", () => {
    // `prompt: ""` is treated as unset; with no other target this must hit the
    // 'must set one of' error, not silently produce an empty prompt target.
    const yaml = ['schedule: "@daily"', 'prompt: ""', ""].join("\n");
    expect(() => parse(yaml)).toThrow(/must set one of/);
  });
});
