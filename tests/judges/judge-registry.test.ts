/**
 * The judge registry (#1306). Each registered judge's prompt is byte-identical to the one the
 * pipeline sent before the judges moved behind the registry (`goldens.json`, captured from that
 * code); a timeout or an unreadable reply is an outcome, never a verdict; and a judge registered
 * with no change to the command runs through it.
 */

import { describe, expect, test } from "bun:test";
import { pairJudge } from "../../src/commands/improve/consolidate/pair-pass";
import { lessonQualityJudge, reflectQualityJudge } from "../../src/commands/improve/stage";
import { judgmentJudge } from "../../src/commands/proposal/drain";
import type { AkmConfig } from "../../src/core/config/config";
import { UsageError } from "../../src/core/errors";
import type { RunnerSpec } from "../../src/integrations/agent/runner";
import { type Judge, listJudges, registerJudge, runJudge } from "../../src/judges/registry";
import { runCliStatus } from "../_helpers/cli";
import { harnessCalls, promptOf, writeFakeHarness } from "../_helpers/engine-stubs";
import { makeSandboxDir } from "../_helpers/sandbox";
import * as C from "../fixtures/judge-prompts/cases";
import goldens from "../fixtures/judge-prompts/goldens.json";

const connection: RunnerSpec = {
  kind: "connection",
  name: "c",
  endpoint: "http://127.0.0.1:1/v1/chat/completions",
  model: "m",
  request: {},
  timeoutMs: null,
};

type Chat = NonNullable<Parameters<typeof reflectQualityJudge.run>[1]["chat"]>;

/** The messages a judge sends to a connection for `input`. */
async function sent(judge: Judge, input: unknown): Promise<unknown> {
  let messages: unknown;
  const chat: Chat = async (_connection, sentMessages) => {
    messages ??= sentMessages;
    return "{}";
  };
  await judge.run(input, { runner: connection, chat });
  return messages;
}

describe("a judge's prompt is the one the pipeline sent before the registry", () => {
  const cases: Array<[string, Judge, unknown, unknown]> = [
    ["reflect.quality, negative feedback", reflectQualityJudge, C.REFLECT_NEGATIVE, goldens.reflectNegative],
    ["reflect.quality, maintenance", reflectQualityJudge, C.REFLECT_MAINTENANCE, goldens.reflectMaintenance],
    ["distill.lesson, new lesson", lessonQualityJudge, C.LESSON_NEW, goldens.lessonNew],
    ["distill.lesson, update", lessonQualityJudge, C.LESSON_UPDATE, goldens.lessonUpdate],
    ["distill.lesson, bare", lessonQualityJudge, { lesson: "lesson", source: "source" }, goldens.lessonBare],
    ["consolidate.pair, dated", pairJudge, C.PAIR_DATED, goldens.pairDated],
    ["consolidate.pair, equal dates", pairJudge, C.PAIR_TIED, goldens.pairTied],
    ["proposal.judgment, promotion", judgmentJudge, C.JUDGMENT_PROMOTION, goldens.judgmentPromotion],
    ["proposal.judgment, update", judgmentJudge, C.JUDGMENT_UPDATE, goldens.judgmentUpdate],
  ];
  for (const [name, judge, input, golden] of cases) {
    test(name, async () => {
      expect(await sent(judge, input)).toEqual(golden);
    });
  }

  describe("reflect.quality on a harness adds the tool rules", () => {
    test("claude: `akm show <ref>`, with and without a ref", async () => {
      const bin = writeFakeHarness(makeSandboxDir("akm-judge").dir, "claude", ["{}"]);
      const runner: RunnerSpec = { kind: "harness", name: "h", platform: "claude", bin, args: [], timeoutMs: null };
      await reflectQualityJudge.run(C.REFLECT_NEGATIVE, { runner });
      await reflectQualityJudge.run(C.REFLECT_MAINTENANCE, { runner });
      const calls = harnessCalls(bin).map(promptOf);
      expect(calls.some((prompt) => prompt.includes(goldens.reflectClaude))).toBe(true);
      expect(calls.some((prompt) => prompt.includes(goldens.reflectClaudeNoRef))).toBe(true);
    });

    test("opencode: akm_show", async () => {
      const bin = writeFakeHarness(makeSandboxDir("akm-judge").dir, "opencode", ["{}"]);
      const runner: RunnerSpec = { kind: "harness", name: "oc", platform: "opencode", bin, args: [], timeoutMs: null };
      await reflectQualityJudge.run(C.REFLECT_NEGATIVE, { runner });
      expect(harnessCalls(bin).some((call) => promptOf(call).includes(goldens.reflectOpencode))).toBe(true);
    });
  });
});

describe("reflect.quality on a revision that only adds a missing field", () => {
  const input = {
    source: "---\nname: a\n---\nBody\n",
    candidate: "---\nname: a\ndescription: Does a.\n---\nBody\n",
  };
  const reply = (quality: number) => async () => JSON.stringify({ scores: { quality }, reason: "r" });

  test("is scored on QUALITY alone: 5 passes", async () => {
    const result = await reflectQualityJudge.run(input, { runner: connection, chat: reply(5) });
    expect(result).toMatchObject({
      outcome: "verdict",
      verdict: { pass: true, criteria: { need: 5, preservation: 5, quality: 5 } },
    });
  });

  // akm scores NEED and PRESERVATION 5, so routing is the same as on a judge that scored all three:
  // QUALITY 4 or 5 passes, and 1 to 3 averages to 3.67 or more, which reflect sends to review.
  test("QUALITY 4 or 5 passes, 1 to 3 goes to review", async () => {
    for (const quality of [5, 4, 3, 2, 1]) {
      const result = await reflectQualityJudge.run(input, { runner: connection, chat: reply(quality) });
      const criteria = { need: 5, preservation: 5, quality };
      expect(result).toMatchObject({
        outcome: "verdict",
        verdict: quality >= 4 ? { pass: true, criteria } : { pass: false, reviewNeeded: true, criteria },
      });
      if (quality < 4) expect((result as { verdict: { score: number } }).verdict.score).toBeGreaterThanOrEqual(3.5);
    }
  });
});

describe("a failure is not a verdict", () => {
  const judges: Array<[Judge, unknown]> = [
    [reflectQualityJudge, C.REFLECT_MAINTENANCE],
    [lessonQualityJudge, C.LESSON_UPDATE],
    [pairJudge, C.PAIR_DATED],
    [judgmentJudge, C.JUDGMENT_UPDATE],
  ];
  for (const [judge, input] of judges) {
    test(`${judge.name}: a provider error is "error", an unreadable reply "unparseable"`, async () => {
      const failing = await judge.run(input, {
        runner: connection,
        chat: async () => {
          throw new Error("upstream boom");
        },
      });
      expect(failing.outcome).toBe("error");
      expect(failing).not.toHaveProperty("verdict");
      const unreadable = await judge.run(input, { runner: connection, chat: async () => "not json at all" });
      expect(unreadable.outcome).toBe("unparseable");
      expect(unreadable).not.toHaveProperty("verdict");
    });
  }

  test("consolidate.pair refuses a pair whose `a` is the newer note", async () => {
    await expect(
      pairJudge.run({ a: C.PAIR_DATED.b, b: C.PAIR_DATED.a }, { runner: connection, chat: async () => "{}" }),
    ).rejects.toThrow(UsageError);
  });
});

describe("the registry", () => {
  test("registers the four judges, each with schemas and a version", () => {
    const names = listJudges().map((judge) => judge.name);
    expect(names).toEqual(
      expect.arrayContaining(["reflect.quality", "distill.lesson", "consolidate.pair", "proposal.judgment"]),
    );
    for (const judge of listJudges()) {
      expect(judge.schemaVersion).toBeGreaterThanOrEqual(1);
      expect(judge.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(judge.outputSchema).toMatchObject({ type: "object" });
    }
  });

  test("a judge registered later runs through the same call, and its input is checked", async () => {
    const fake: Judge<{ text: string }, { echoed: string }> = {
      name: "fake.echo",
      description: "Echoes.",
      schemaVersion: 7,
      inputSchema: {
        type: "object",
        required: ["text"],
        additionalProperties: false,
        properties: { text: { type: "string" } },
      },
      outputSchema: { type: "object" },
      harnessReads: "Nothing.",
      defaultRunner: (_config, run) =>
        run?.connection === "x" ? { ...connection, name: "x", model: "xm" } : undefined,
      run: async (input) => ({ outcome: "verdict", verdict: { echoed: input.text } }),
    };
    registerJudge(fake);
    expect(listJudges().map((judge) => judge.name)).toContain("fake.echo");
    // Through the command, with no change to it.
    const listed = JSON.parse((await runCliStatus(["judge", "--list", "--format", "json"])).stdout);
    expect(listed.judges).toContainEqual({ name: "fake.echo", description: "Echoes.", schemaVersion: 7 });
    const schema = JSON.parse((await runCliStatus(["judge", "fake.echo", "--schema", "--format", "json"])).stdout);
    expect(schema).toMatchObject({ judge: "fake.echo", schemaVersion: 7, inputSchema: fake.inputSchema });
    const config = {} as AkmConfig;

    expect(await runJudge("fake.echo", { text: "hi" }, config, { connection: "x" })).toEqual({
      judge: "fake.echo",
      schemaVersion: 7,
      runner: { kind: "connection", name: "x", model: "xm" },
      outcome: "verdict",
      verdict: { echoed: "hi" },
    });
    await expect(runJudge("fake.echo", { text: "hi", extra: 1 }, config, { connection: "x" })).rejects.toThrow("extra");
    await expect(runJudge("fake.echo", { text: "hi" }, config, {})).rejects.toThrow("no connection or harness");
    await expect(runJudge("fake.missing", {}, config, {})).rejects.toThrow("Unknown judge");
  });
});

describe("distill.lesson strips the memory's frontmatter", () => {
  test("a source with frontmatter is judged as its body", async () => {
    const body = "The build got slower after the runner image changed.";
    const withFrontmatter = await sent(lessonQualityJudge, {
      lesson: "L",
      source: `---\ndescription: d\n---\n\n${body}\n`,
    });
    expect(withFrontmatter).toEqual(await sent(lessonQualityJudge, { lesson: "L", source: body }));
  });
});
