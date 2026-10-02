// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm improve judge`: reflect's quality judge, run on a candidate you supply.
 *
 * Integration: it serves an LLM stub on 127.0.0.1 and spawns fake harness
 * binaries, and it takes a before/after snapshot of the real state databases.
 * Nothing leaves loopback.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { buildReflectJudgePrompt } from "../../../../src/commands/improve/stage";
import { MODEL_WORK_CLAUDE_FLAGS } from "../../../../src/integrations/harnesses/claude/agent-builder";
import { runCliCapture } from "../../../_helpers/cli";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../../../_helpers/sandbox";
import { snapshotTree } from "../../../_helpers/snapshot-tree";

const REF = "lessons/rg-over-grep";
const SOURCE =
  "---\ndescription: Prefer ripgrep for repository search\n---\n\n# Prefer ripgrep\n\nUse rg for recursive repository searches.\n";
const CANDIDATE =
  "---\ndescription: Prefer ripgrep for repository search\n---\n\n# Prefer ripgrep\n\nUse rg for recursive repository searches. It skips binary files.\n";
const FEEDBACK = "[negative] it does not say that rg skips binary files\n[positive] clear example";

const verdict = (need: number, preservation: number, quality: number, reason = "stub reason"): string =>
  JSON.stringify({ scores: { need, preservation, quality }, reason });

/** What the LLM stub answers on `/<scenario>/v1/chat/completions`. */
const SCENARIOS: Record<string, string> = {
  pass: verdict(5, 4, 4),
  // The mean (4.0) clears 3.5 but one criterion is under 4: the gate's rule is every criterion >= 4.
  lowest3: verdict(3, 5, 4),
  low: verdict(2, 3, 2),
  // Neither JSON nor a verdict.
  garbage: "I think the revision is fine.",
};

interface StubRequest {
  scenario: string;
  messages: Array<{ role: string; content: string }>;
}

let stub: ReturnType<typeof Bun.serve>;
let requests: StubRequest[] = [];
let storage: IsolatedAkmStorage;
let bins: SandboxedDir;

beforeAll(() => {
  stub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const scenario = new URL(req.url).pathname.split("/")[1] ?? "";
      const body = (await req.json()) as { messages: StubRequest["messages"] };
      requests.push({ scenario, messages: body.messages });
      if (scenario === "error") return new Response("boom", { status: 500 });
      const reply = SCENARIOS[scenario] ?? SCENARIOS.pass;
      return Response.json({
        model: `${scenario}-served`,
        choices: [{ message: { content: reply } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      });
    },
  });
  bins = makeSandboxDir("akm-improve-judge-bin");
});

afterAll(() => {
  stub.stop(true);
  bins.cleanup();
});

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  fs.mkdirSync(path.join(storage.stashDir, "lessons"), { recursive: true });
  fs.writeFileSync(path.join(storage.stashDir, `${REF}.md`), SOURCE);
  fs.writeFileSync(file("candidate.md"), CANDIDATE);
});

afterEach(() => {
  storage.cleanup();
  requests = [];
  for (const entry of fs.readdirSync(bins.dir)) fs.rmSync(path.join(bins.dir, entry), { recursive: true, force: true });
});

/** A file beside the stash, in the isolated storage root. */
function file(name: string, content?: string): string {
  const target = path.join(storage.root, name);
  if (content !== undefined) fs.writeFileSync(target, content);
  return target;
}

const llm = (scenario: string): Record<string, unknown> => ({
  kind: "llm",
  endpoint: `http://127.0.0.1:${stub.port}/${scenario}/v1/chat/completions`,
  model: `${scenario}-model`,
});

/** Config with one LLM engine per scenario; `pass` is the default engine. */
function configure(extra: Record<string, unknown> = {}, engines: Record<string, unknown> = {}): void {
  writeSandboxConfig({
    semanticSearchMode: "off",
    engines: Object.fromEntries([...Object.keys(SCENARIOS), "error"].map((name) => [name, llm(name)])),
    defaults: { llmEngine: "pass", engine: "pass" },
    ...extra,
  });
  if (Object.keys(engines).length > 0) {
    const configPath = path.join(storage.configDir, "akm", "config.json");
    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    written.engines = { ...written.engines, ...engines };
    fs.writeFileSync(configPath, JSON.stringify(written));
  }
}

/** The result fields these tests read. */
interface JudgeJson {
  ok?: boolean;
  engine?: string;
  model?: string;
  scores?: Record<string, number>;
  reason?: string;
  passes?: boolean;
  durationMs?: number;
  error?: string;
  usage?: { calls: number; promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

async function judge(...args: string[]): Promise<{ code: number; json: JudgeJson; stderr: string }> {
  const result = await runCliCapture(["improve", "judge", REF, "--candidate", file("candidate.md"), ...args]);
  return { code: result.code, json: result.stdout.trim() ? JSON.parse(result.stdout) : {}, stderr: result.stderr };
}

describe("akm improve judge: the verdict", () => {
  test("the scores are parsed and the result carries the judge's engine, model, usage and timing", async () => {
    configure();
    const { code, json } = await judge();
    expect(code).toBe(0);
    expect(json).toMatchObject({
      ok: true,
      engine: "pass",
      model: "pass-served",
      scores: { need: 5, preservation: 4, quality: 4 },
      reason: "stub reason",
      passes: true,
      usage: { calls: 1, promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    });
    expect(json.durationMs).toBeGreaterThanOrEqual(0);
    expect(requests.map((request) => request.scenario)).toEqual(["pass"]);
  });

  test.each([
    ["pass", true],
    // Mean 4.0 would pass a mean rule; the quality gate wants every criterion at 4 or more.
    ["lowest3", false],
    ["low", false],
  ])("passes follows the gate's rule: %s -> %p", async (scenario, passes) => {
    configure();
    const { code, json } = await judge("--engine", scenario);
    expect(code).toBe(0);
    expect(json.ok).toBe(true);
    expect(json.passes).toBe(passes);
  });

  test("a judge that gives no verdict is a clear failure with its reason, not a rejection", async () => {
    configure();
    const unreadable = await judge("--engine", "garbage");
    expect(unreadable.code).toBe(1);
    expect(unreadable.json).toMatchObject({
      ok: false,
      engine: "garbage",
      reason: "judge parse failed — routed to review",
      error: "reply: I think the revision is fine.",
    });
    expect(unreadable.json.passes).toBeUndefined();
    expect(unreadable.json.scores).toBeUndefined();
    // The structured call's one corrective retry shows in the usage.
    expect(unreadable.json.usage?.calls).toBe(2);

    const failing = await judge("--engine", "error");
    expect(failing.code).toBe(1);
    expect(failing.json).toMatchObject({
      ok: false,
      engine: "error",
      reason: "judge timeout/error — routed to review",
    });
    expect(failing.json.error).toContain("500");
  });
});

describe("akm improve judge: the prompt is reflect's", () => {
  test("the judge is sent reflect's prompt for the source, the candidate and the feedback", async () => {
    configure();
    await judge(
      "--source",
      file("source.md", `${SOURCE}\nA line only the --source file has.\n`),
      "--feedback",
      FEEDBACK,
    );

    const sent = requests.at(-1)?.messages ?? [];
    expect(sent.map((message) => message.role)).toEqual(["system", "user"]);
    expect(sent[0]?.content).toBe("Return only valid JSON. No prose.");
    expect(sent[1]?.content).toBe(
      buildReflectJudgePrompt(CANDIDATE, `${SOURCE}\nA line only the --source file has.\n`, FEEDBACK.split("\n")),
    );
  });

  test("the source defaults to the asset in the stash, and a feedback file reads like --feedback", async () => {
    configure();
    await judge("--feedback-file", file("feedback.txt", `\n${FEEDBACK}\n\n`));

    expect(requests.at(-1)?.messages.at(-1)?.content).toBe(
      buildReflectJudgePrompt(CANDIDATE, SOURCE, FEEDBACK.split("\n")),
    );
  });

  test("no feedback is the prompt's own 'No explicit feedback supplied.'", async () => {
    configure();
    await judge();
    expect(requests.at(-1)?.messages.at(-1)?.content).toContain("```\nNo explicit feedback supplied.\n```");
  });
});

describe("akm improve judge: which engine judges", () => {
  test("with no --engine it is the one reflect's quality gate would pick", async () => {
    // The gate names `low`; the default engine is `pass`.
    configure({
      improve: {
        strategies: { default: { processes: { reflect: { qualityGate: { enabled: true, engine: "low" } } } } },
      },
    });
    const { json } = await judge();
    expect(json).toMatchObject({ engine: "low", passes: false });
    expect(requests.map((request) => request.scenario)).toEqual(["low"]);
  });

  test("a gate that names no judge leaves it to the reflect engine, when that is an LLM", async () => {
    // The strategy's reflect process names `lowest3`; the cascade's default is `pass`.
    configure({ improve: { strategies: { default: { processes: { reflect: { engine: "lowest3" } } } } } });
    const { json } = await judge();
    expect(json).toMatchObject({ engine: "lowest3" });
    expect(requests.map((request) => request.scenario)).toEqual(["lowest3"]);
  });

  test("it judges even when the strategy turns the gate off, with the engine reflect would fall back to", async () => {
    configure({
      improve: {
        strategies: { default: { processes: { reflect: { qualityGate: { enabled: false, engine: "low" } } } } },
      },
    });
    const { json } = await judge();
    expect(json).toMatchObject({ ok: true, engine: "pass", passes: true });
  });

  test("--engine overrides the judge engine, the gate's included, and --strategy picks the strategy", async () => {
    configure({
      improve: {
        strategies: {
          default: { processes: { reflect: { qualityGate: { enabled: true, engine: "low" } } } },
          other: { processes: { reflect: { qualityGate: { enabled: true, engine: "lowest3" } } } },
        },
      },
    });
    expect((await judge("--engine", "pass")).json).toMatchObject({ engine: "pass", passes: true });
    expect((await judge("--strategy", "other")).json).toMatchObject({ engine: "lowest3", passes: false });
    expect((await judge("--strategy", "other", "--engine", "pass")).json).toMatchObject({ engine: "pass" });
    expect(requests.map((request) => request.scenario)).toEqual(["pass", "lowest3", "pass"]);
  });

  test("an unknown engine or strategy is a config error naming it", async () => {
    configure();
    const engine = await runCliCapture([
      "improve",
      "judge",
      REF,
      "--candidate",
      file("candidate.md"),
      "--engine",
      "nope",
    ]);
    expect(engine.code).toBe(78);
    expect(engine.stderr).toContain("nope");
    const strategy = await runCliCapture([
      "improve",
      "judge",
      REF,
      "--candidate",
      file("candidate.md"),
      "--strategy",
      "nope",
    ]);
    expect(strategy.code).toBe(78);
    expect(JSON.parse(strategy.stderr).code).toBe("UNKNOWN_IMPROVE_STRATEGY");
    expect(requests).toEqual([]);
  });

  test("with no engine configured it says what to set, and sends nothing", async () => {
    writeSandboxConfig({ semanticSearchMode: "off" });
    const result = await runCliCapture(["improve", "judge", REF, "--candidate", file("candidate.md")]);
    expect(result.code).toBe(78);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: "LLM_NOT_CONFIGURED" });
    expect(requests).toEqual([]);
  });
});

describe("akm improve judge: it writes nothing", () => {
  test("no proposal, ledger row, event or usage record is left, and the stash is untouched", async () => {
    configure();
    // The judge reads feedback events; give it a state database to write to, if it would.
    await runCliCapture(["feedback", REF, "--negative", "--reason", "does not mention binary files"]);
    const before = snapshotTree(storage.root);

    for (const args of [[], ["--engine", "low"], ["--engine", "error"], ["--feedback", FEEDBACK]]) await judge(...args);

    expect(requests.length).toBeGreaterThan(0);
    expect(snapshotTree(storage.root)).toEqual(before);
  });

  test("it refuses a secret and a ref reflect cannot revise, without reading either", async () => {
    configure();
    for (const ref of ["secrets/deploy-key", "scripts/run.sh"]) {
      const result = await runCliCapture(["improve", "judge", ref, "--candidate", file("candidate.md")]);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stderr).error).toContain("not supported by reflect");
    }
    expect(requests).toEqual([]);
  });
});

describe("akm improve judge: flags", () => {
  test("the ref, --candidate and the files they name are checked before any judge call", async () => {
    configure();
    const run = (...args: string[]) => runCliCapture(["improve", "judge", ...args]);
    const cases: Array<[string[], number, string]> = [
      [[], 2, "requires an asset ref"],
      [[REF], 2, "--candidate"],
      [[REF, "extra", "--candidate", file("candidate.md")], 2, "takes one ref"],
      [[REF, "--candidate", file("missing.md")], 1, "missing.md"],
      [[REF, "--candidate", file("candidate.md"), "--source", file("missing.md")], 1, "missing.md"],
      [
        [REF, "--candidate", file("candidate.md"), "--feedback", "x", "--feedback-file", file("candidate.md")],
        2,
        "not both",
      ],
      [["lessons/not-in-the-stash", "--candidate", file("candidate.md")], 2, "Pass --source"],
    ];
    for (const [args, code, message] of cases) {
      const result = await run(...args);
      expect([args, result.code]).toEqual([args, code]);
      expect(result.stderr).toContain(message);
    }
    expect(requests).toEqual([]);
  });

  test("a judge-only flag on a plain improve run is refused, not ignored", async () => {
    configure();
    for (const flag of ["--candidate", "--source", "--feedback", "--feedback-file", "--engine"]) {
      const result = await runCliCapture(["improve", "--dry-run", flag, "x"]);
      expect([flag, result.code]).toEqual([flag, 2]);
      expect(result.stderr).toContain("only applies to `akm improve judge`");
    }
  });
});

/**
 * A fake agent binary. It records its argv, working directory and opencode
 * config beside itself, then answers with a verdict: as claude's result
 * envelope when `--output-format json` is passed and `claude` is the framing,
 * as plain text otherwise.
 */
function fakeAgent(name: string, reply: string, framing: "claude" | "plain"): string {
  const bin = path.join(bins.dir, name);
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(`${bin}.call`)}, JSON.stringify({ argv, cwd: process.cwd(), opencodeConfig: process.env.OPENCODE_CONFIG_CONTENT ?? null }));
const format = argv.indexOf("--output-format");
const envelope = ${JSON.stringify(framing)} === "claude" && format >= 0 && argv[format + 1] === "json";
const text = ${JSON.stringify(reply)};
process.stdout.write((envelope ? JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, session_id: "fake" }) : text) + "\\n");
`,
    { mode: 0o755 },
  );
  return bin;
}

const calledWith = (bin: string): { argv: string[]; cwd: string; opencodeConfig: string | null } =>
  JSON.parse(fs.readFileSync(`${bin}.call`, "utf8"));

describe("akm improve judge: an agent engine runs under the model-work tool policy", () => {
  test("claude gets the policy's flags, a scratch working directory, and the judge prompt", async () => {
    const bin = fakeAgent("claude-judge", verdict(5, 5, 5, "agent verdict"), "claude");
    configure({}, { agent: { kind: "agent", platform: "claude", bin, model: "claude-test" } });

    const { code, json } = await judge("--engine", "agent");

    expect(code).toBe(0);
    expect(json).toMatchObject({ ok: true, engine: "agent", passes: true, reason: "agent verdict" });
    expect(json.model).toBe("claude-test");
    expect(requests).toEqual([]);

    const call = calledWith(bin);
    // The policy's flags lead the argv, in place of anything the engine would add.
    expect(call.argv.slice(0, MODEL_WORK_CLAUDE_FLAGS.length)).toEqual([...MODEL_WORK_CLAUDE_FLAGS]);
    // It ran in a scratch directory akm made for the call and removed after it.
    expect(path.basename(call.cwd)).toMatch(/^akm-model-work-/);
    expect(call.cwd.startsWith(storage.root)).toBe(false);
    expect(fs.existsSync(call.cwd)).toBe(false);
    // The prompt is reflect's own, with the schema instruction the lowering adds for an agent.
    const prompt = call.argv.at(-1) ?? "";
    expect(prompt).toContain(buildReflectJudgePrompt(CANDIDATE, SOURCE, []));
    expect(prompt).toContain("Respond with ONLY a JSON value matching this JSON Schema");
  });

  test("opencode gets its confined akm-model-work agent, which has no bash", async () => {
    const bin = fakeAgent("opencode-judge", verdict(4, 4, 4, "opencode verdict"), "plain");
    configure({}, { agent: { kind: "agent", platform: "opencode", bin } });

    const { code, json } = await judge("--engine", "agent");

    expect(code).toBe(0);
    expect(json).toMatchObject({ ok: true, engine: "agent", passes: true, reason: "opencode verdict" });
    const call = calledWith(bin);
    expect(call.argv.slice(0, 3)).toEqual(["run", "--agent", "akm-model-work"]);
    const config = JSON.parse(call.opencodeConfig ?? "{}") as {
      agent: Record<string, { permission: Record<string, string> }>;
    };
    expect(config.agent["akm-model-work"]?.permission).toMatchObject({ bash: "deny", edit: "allow", read: "allow" });
    expect(path.basename(call.cwd)).toMatch(/^akm-model-work-/);
  });

  test("an engine that cannot confine the policy is refused before anything runs", async () => {
    const bin = fakeAgent("aider-judge", verdict(5, 5, 5), "plain");
    configure({}, { agent: { kind: "agent", platform: "aider", bin } });

    const result = await runCliCapture([
      "improve",
      "judge",
      REF,
      "--candidate",
      file("candidate.md"),
      "--engine",
      "agent",
    ]);

    expect(result.code).toBe(78);
    expect(result.stderr).toContain("cannot enforce the model-work tool policy");
    expect(fs.existsSync(`${bin}.call`)).toBe(false);
  });
});
