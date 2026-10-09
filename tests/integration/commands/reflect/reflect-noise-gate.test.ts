/**
 * #580 — reflect noise gate: suppress empty-diff and cosmetic-only proposals.
 *
 * Two layers under test:
 *
 *   1. The pure normalizer/classifier in `src/commands/improve/reflect-noise.ts`
 *      — exercised against the four cosmetic patterns from the issue (YAML
 *      description re-folding, code-fence language hints, whitespace reflow,
 *      hard-wrap unwrapping) plus conservative must-stay-substantive cases.
 *
 *   2. The gate wired into `akmReflect` — a patch that changes nothing must
 *      NEVER reach `createProposal()`; it returns a `no_change` failure and
 *      emits `reflect_completed` with the `reflect_skipped_noop` subreason.
 *      A genuine (even small) change still creates a proposal.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { akmReflect } from "../../../../src/commands/improve/reflect";
import {
  classifyReflectChange,
  cosmeticNormalForm,
  normalizeMarkdownBody,
  normalizeTrailingWhitespace,
} from "../../../../src/commands/improve/reflect-noise";
import { listProposals } from "../../../../src/commands/proposal/repository";
import { readEvents } from "../../../../src/core/events";
import type { SpawnedSubprocess, SpawnFn } from "../../../../src/core/subprocess";
import { quietQualityGateConfig, reflectReply } from "../../../_helpers/factories";
import {
  makeStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  sandboxXdgStateHome,
} from "../../../_helpers/sandbox";

// ── Unit: normalizeTrailingWhitespace / noop detection ───────────────────────

describe("classifyReflectChange — noop (empty diff)", () => {
  test("byte-identical content → noop", () => {
    const content = "# Title\n\nSome body prose.\n";
    expect(classifyReflectChange(content, content)).toBe("noop");
  });

  test("trailing whitespace on lines only → noop", () => {
    expect(classifyReflectChange("# Title\n\nBody line.\n", "# Title  \n\nBody line.\t\n")).toBe("noop");
  });

  test("trailing newline count difference → noop", () => {
    expect(classifyReflectChange("# Title\n\nBody line.", "# Title\n\nBody line.\n\n\n")).toBe("noop");
  });

  test("CRLF vs LF line endings → noop", () => {
    expect(classifyReflectChange("# Title\n\nBody line.\n", "# Title\r\n\r\nBody line.\r\n")).toBe("noop");
  });

  test("normalizeTrailingWhitespace strips per-line trailing space/tab and final newlines", () => {
    expect(normalizeTrailingWhitespace("a \t\nb\t \n\n")).toBe("a\nb");
  });
});

// ── Unit: the four cosmetic patterns from the issue ──────────────────────────

describe("classifyReflectChange — cosmetic patterns from #580", () => {
  test("1. YAML description re-folding (folded scalar vs plain) → cosmetic", () => {
    const source = "---\ndescription: A description that was written on a single plain line.\n---\n\n# Body\n";
    const candidate =
      "---\ndescription: >-\n  A description that was written\n  on a single plain line.\n---\n\n# Body\n";
    expect(classifyReflectChange(source, candidate)).toBe("cosmetic");
  });

  test("2. code-fence language hint added → cosmetic", () => {
    const source = "# Doc\n\n```\nconst x = 1;\n```\n";
    const candidate = "# Doc\n\n```ts\nconst x = 1;\n```\n";
    expect(classifyReflectChange(source, candidate)).toBe("cosmetic");
  });

  test("3. whitespace reflow (runs of spaces collapsed) → cosmetic", () => {
    const source = "# Doc\n\nProse with  doubled   spaces between words.\n";
    const candidate = "# Doc\n\nProse with doubled spaces between words.\n";
    expect(classifyReflectChange(source, candidate)).toBe("cosmetic");
  });

  test("4. unwrapping of hard-wrapped prose lines → cosmetic", () => {
    const source = "# Doc\n\nThis paragraph was hard wrapped\nacross two lines for layout reasons.\n";
    const candidate = "# Doc\n\nThis paragraph was hard wrapped across two lines for layout reasons.\n";
    expect(classifyReflectChange(source, candidate)).toBe("cosmetic");
  });

  test("hard-wrap unwrapping of a list item continuation → cosmetic", () => {
    const source = "- a list item that wraps\n  onto a continuation line\n- second item\n";
    const candidate = "- a list item that wraps onto a continuation line\n- second item\n";
    expect(classifyReflectChange(source, candidate)).toBe("cosmetic");
  });

  test("blank-line run collapsed → cosmetic", () => {
    expect(classifyReflectChange("# A\n\n\n\nProse here.\n", "# A\n\nProse here.\n")).toBe("cosmetic");
  });

  test("frontmatter key reorder with identical values → cosmetic", () => {
    const source = "---\ndescription: d\ntags:\n  - one\n  - two\n---\n\nBody.\n";
    const candidate = "---\ntags:\n  - one\n  - two\ndescription: d\n---\n\nBody.\n";
    expect(classifyReflectChange(source, candidate)).toBe("cosmetic");
  });
});

// ── Unit: substantive changes must NOT be suppressed ─────────────────────────

describe("classifyReflectChange — substantive changes pass through", () => {
  test("single word change → substantive", () => {
    expect(classifyReflectChange("# Doc\n\nUse the old flag.\n", "# Doc\n\nUse the new flag.\n")).toBe("substantive");
  });

  test("a small prose rewrite is substantive (the low-value tier is gone, #1131)", () => {
    expect(
      classifyReflectChange(
        "---\ndescription: d\n---\n\nIt is faster and respects .gitignore by default.\n",
        "---\ndescription: d\n---\n\nIt runs faster and respects .gitignore by defaults.\n",
      ),
    ).toBe("substantive");
  });

  test("prose merged INTO a heading line → substantive (rendering changes)", () => {
    expect(classifyReflectChange("# Title\nprose after\n", "# Title prose after\n")).toBe("substantive");
  });

  test("whitespace change INSIDE a fenced code block → substantive", () => {
    const source = "```\nif (x) {\n    return;\n}\n```\n";
    const candidate = "```\nif (x) {\n  return;\n}\n```\n";
    expect(classifyReflectChange(source, candidate)).toBe("substantive");
  });

  test("list item reorder → substantive", () => {
    expect(classifyReflectChange("- one\n- two\n", "- two\n- one\n")).toBe("substantive");
  });

  test("YAML value change (not just re-folding) → substantive", () => {
    const source = "---\ndescription: original description\n---\n\nBody.\n";
    const candidate = "---\ndescription: rewritten description\n---\n\nBody.\n";
    expect(classifyReflectChange(source, candidate)).toBe("substantive");
  });

  test("literal block scalar (|) vs plain scalar with collapsed newlines → substantive", () => {
    // `|` preserves newlines — folding it away changes the parsed value.
    const source = "---\ndescription: |-\n  line one\n  line two\n---\n\nBody.\n";
    const candidate = "---\ndescription: line one line two\n---\n\nBody.\n";
    expect(classifyReflectChange(source, candidate)).toBe("substantive");
  });

  test("indented code line change → substantive", () => {
    expect(classifyReflectChange("Para.\n\n    code  here\n", "Para.\n\n    code here\n")).toBe("substantive");
  });

  test("added sentence at end of paragraph → substantive", () => {
    expect(classifyReflectChange("Prose paragraph.\n", "Prose paragraph. With a new sentence.\n")).toBe("substantive");
  });
});

// ── Unit: normalizer internals ───────────────────────────────────────────────

describe("normalizeMarkdownBody / cosmeticNormalForm", () => {
  test("strips fence language hints but keeps fenced content verbatim", () => {
    expect(normalizeMarkdownBody("```python\nx  =  1\n```\n")).toBe("```\nx  =  1\n```");
  });

  test("headings never absorb the following prose line", () => {
    const normalized = normalizeMarkdownBody("# H\nprose\n");
    expect(normalized).toBe("# H\nprose");
  });

  test("unparsable frontmatter falls back to raw text comparison", () => {
    // `[unclosed` is invalid YAML — both sides fall back to raw fm text.
    const a = "---\ndescription: [unclosed\n---\n\nBody.\n";
    expect(cosmeticNormalForm(a)).toBe(cosmeticNormalForm(a));
    const b = "---\ndescription: [unclosed-but-different\n---\n\nBody.\n";
    expect(cosmeticNormalForm(a)).not.toBe(cosmeticNormalForm(b));
  });
});

// ── Integration: akmReflect short-circuits before createProposal ─────────────

/** Per-test cleanup chain built from the sandbox helpers in beforeEach. */
let restoreSandbox: (() => void) | undefined;
const stashCleanups: Array<() => void> = [];

function makeSandboxedStash(): string {
  const { dir, cleanup } = makeStashDir();
  stashCleanups.push(cleanup);
  return dir;
}

function asReadableStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function fakeSpawn(stdout: string): SpawnFn {
  return () => {
    const proc: SpawnedSubprocess = {
      exitCode: 0,
      exited: Promise.resolve(0),
      stdout: asReadableStream(stdout),
      stderr: asReadableStream(""),
      stdin: null,
      kill: () => undefined,
    };
    return proc;
  };
}

beforeEach(() => {
  // Repoint every XDG base dir at per-test sandboxes so the events DB and any
  // config/cache reads stay isolated. The helpers chain their own restores.
  const cache = sandboxXdgCacheHome();
  const config = sandboxXdgConfigHome(cache.cleanup);
  const data = sandboxXdgDataHome(config.cleanup);
  const state = sandboxXdgStateHome(data.cleanup);
  restoreSandbox = state.cleanup;
});

afterEach(() => {
  restoreSandbox?.();
  restoreSandbox = undefined;
  for (const cleanup of stashCleanups.splice(0)) {
    cleanup();
  }
});

const SOURCE_ASSET = [
  "# Sample knowledge",
  "",
  "A paragraph that explains the topic in enough detail to be useful.",
  "",
  "- first point",
  "- second point",
  "",
].join("\n");

async function runReflect(stash: string, agentStdout: string, assetContent: string | null = SOURCE_ASSET) {
  return akmReflect({
    ref: "knowledge/sample",
    stashDir: stash,
    target: { source: "local", root: stash },
    ...(assetContent !== null ? { assetContent } : {}),
    config: quietQualityGateConfig(),
    runAgentOptions: { spawn: fakeSpawn(agentStdout) },
  });
}

/** The run ended in `no_change` with the `reflect_skipped_noop` event, and queued nothing. */
function expectNoChange(result: Awaited<ReturnType<typeof runReflect>>, stash: string) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected suppression");
  expect(result.reason).toBe("no_change");
  expect(result.error).toContain("identical");
  expect(listProposals(stash).length).toBe(0);

  const events = readEvents({ type: "reflect_completed" }).events;
  expect(events.length).toBe(1);
  const meta = events[0]?.metadata as Record<string, unknown>;
  expect(meta.ok).toBe(false);
  expect(meta.reason).toBe("no_change");
  expect(meta.subreason).toBe("reflect_skipped_noop");
  expect(meta.changeKind).toBe("noop");
  expect(events[0]?.ref).toBe("knowledge/sample");
}

describe("akm reflect — noise gate (#580)", () => {
  test("a patch with every field null → no proposal + reflect_skipped_noop event", async () => {
    const stash = makeSandboxedStash();
    expectNoChange(await runReflect(stash, reflectReply()), stash);
  });

  test("a patch equal to the source's own fields → the same empty diff", async () => {
    const stash = makeSandboxedStash();
    const source = "---\ndescription: Diagnose the stack\nwhen_to_use: When the stack degrades\n---\n\nBody prose.\n";
    const patch = { description: "Diagnose the stack", when_to_use: "When the stack degrades" };
    expectNoChange(await runReflect(stash, reflectReply(patch), source), stash);
  });

  test("a title for a body that already has a level-1 heading is ignored → the same empty diff", async () => {
    const stash = makeSandboxedStash();
    expectNoChange(await runReflect(stash, reflectReply({ title: "Another title" })), stash);
  });

  test("genuine small change → proposal created", async () => {
    const stash = makeSandboxedStash();
    const source = "---\ndescription: Diagnose the stack\n---\n\nBody prose for the skill.\n";
    const result = await runReflect(stash, reflectReply({ description: "Diagnose the stack and its proxies" }), source);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected proposal, got ${result.reason}: ${result.error}`);
    const proposals = listProposals(stash);
    expect(proposals.length).toBe(1);
    expect(proposals[0]?.payload.content).toContain("description: Diagnose the stack and its proxies");

    const events = readEvents({ type: "reflect_completed" }).events;
    expect(events.length).toBe(1);
    const meta = events[0]?.metadata as Record<string, unknown>;
    expect(meta.proposalId).toBe(result.proposal.id);
  });

  test("a title for a body with no level-1 heading is added: the proposal is the source with the heading", async () => {
    const stash = makeSandboxedStash();
    const source = "---\ndescription: Diagnose the stack\n---\n\nBody prose for the skill.\n";
    const result = await runReflect(stash, reflectReply({ title: "Stack diagnostics" }), source);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected proposal, got ${result.reason}: ${result.error}`);
    expect(listProposals(stash)[0]?.payload.content).toEndWith(
      "\n\n# Stack diagnostics\n\nBody prose for the skill.\n",
    );
  });

  test("no source asset: there is nothing to patch → no proposal", async () => {
    const stash = makeSandboxedStash();
    // No assetContent seam and no indexed asset.
    const result = await runReflect(stash, reflectReply({ description: "Diagnose the stack" }), null);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected suppression");
    expect(result.reason).toBe("no_change");
    expect(listProposals(stash).length).toBe(0);
  });
});
