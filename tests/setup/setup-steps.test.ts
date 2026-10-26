// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The first three of setup's steps, driven through a scripted terminal and a
 * stand-in for the endpoint's model list: which harnesses to enable and whether
 * they take model calls, the connection (endpoint, key, one model per alias),
 * and embeddings. Flags, `--yes` defaults and the interactive questions all end
 * in the same answers.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../src/core/config/config";
import { writeCredential } from "../../src/core/config/credentials";
import { UsageError } from "../../src/core/errors";
import { _setWarnSinkForTests } from "../../src/core/warn";
import { effectiveEmbedding } from "../../src/llm/embedders/connection";
import type { InstalledHarness } from "../../src/setup/detect";
import { parseSetupFlags } from "../../src/setup/setup-flags";
import { applySetupAnswers } from "../../src/setup/setup-plan";
import { stepConnection } from "../../src/setup/steps/connection";
import { stepEmbeddings } from "../../src/setup/steps/embeddings";
import { stepHarnesses } from "../../src/setup/steps/harnesses";
import { fakeOpencodeMajor, withOpencodeOnPath } from "../_helpers/opencode-version";
import { withEnv, withMockedFetch } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";
import { type ScriptedPrompts, scriptPrompts } from "../_helpers/setup-prompts";

let prompts: ScriptedPrompts;
beforeEach(() => {
  prompts = scriptPrompts();
});

const cfg = (partial: Partial<AkmConfig> = {}): AkmConfig => ({ semanticSearchMode: "off", ...partial });
const installed = (...platforms: string[]): InstalledHarness[] =>
  platforms.map((platform) => ({ platform, bin: platform, path: `/usr/bin/${platform}` }) as InstalledHarness);

/** A stand-in endpoint: lists `models`, records each request's URL and key, or fails with `status`. */
function endpoint(models: string[], opts: { status?: number } = {}) {
  const requests: { url: string; authorization: string | null }[] = [];
  const mock = (url: string, init?: RequestInit) => {
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    return opts.status
      ? new Response("no", { status: opts.status })
      : Response.json({ object: "list", data: models.map((id) => ({ id })) });
  };
  return { requests, serve: <T>(run: () => Promise<T>) => withMockedFetch(run, mock) };
}

describe("stepHarnesses", () => {
  const input = (over: Partial<Parameters<typeof stepHarnesses>[0]> = {}) => ({
    current: cfg(),
    installed: installed("claude", "gemini"),
    flags: {},
    interactive: true,
    ...over,
  });

  test("interactive: offers what is installed, preselected, each saying whether model calls run read-only", async () => {
    prompts.answers.multiselect.push(["claude"]);
    prompts.answers.confirm.push(true);

    const result = await stepHarnesses(input());

    const [asked] = prompts.of("multiselect");
    expect(asked?.options.map((o) => o.value)).toEqual(["claude", "gemini"]);
    expect(asked?.initialValues).toEqual(["claude", "gemini"]);
    expect(asked?.options[0]?.hint).toContain("model calls run read-only");
    expect(asked?.options[1]?.hint).toContain("cannot be restricted to read-only");
    expect(result).toEqual({
      answer: { platforms: ["claude"], default: "claude" },
      modelCallsOnHarness: true,
      modelWork: true,
    });
  });

  test("interactive: the model-calls question names the harness and says what the note says, and No means a connection", async () => {
    prompts.answers.multiselect.push(["gemini"]);
    prompts.answers.confirm.push(false);

    const result = await stepHarnesses(input());

    const [question] = prompts.of("confirm");
    expect(question?.message).toContain("Use gemini for akm's own model calls too");
    expect(question?.message).toContain(
      "Model work on gemini cannot be restricted: it can edit files and run commands.",
    );
    expect(question?.initialValue).toBe(true);
    expect(result.modelCallsOnHarness).toBe(false);
    expect(result.modelWork).toBe(false);
  });

  test("interactive: choosing a harness that cannot be restricted for model calls says so again, beside the answer; a restricted one does not", async () => {
    const warned = (): string[] => prompts.output.filter((line) => line.includes("cannot be restricted: it can edit"));
    prompts.answers.multiselect.push(["gemini"]);
    prompts.answers.confirm.push(true);
    expect((await stepHarnesses(input())).modelCallsOnHarness).toBe(true);
    expect(warned()).toEqual(["Model work on gemini cannot be restricted: it can edit files and run commands."]);

    prompts.answers.multiselect.push(["claude"]);
    prompts.answers.confirm.push(true);
    const before = warned().length;
    await stepHarnesses(input());
    expect(warned()).toHaveLength(before);
    expect(prompts.of("confirm")[1]?.message).toContain("Model calls run read-only.");
  });

  test("OpenCode 1 cannot be restricted, whatever the platform table says: the hint, the question, the note beside the answer and --yes all say so", async () => {
    await withOpencodeOnPath(1, async () => {
      prompts.answers.multiselect.push(["opencode"]);
      prompts.answers.confirm.push(true);

      const result = await stepHarnesses(input({ installed: installed("opencode") }));

      expect(prompts.of("multiselect")[0]?.options[0]?.hint).toContain("cannot be restricted to read-only");
      expect(prompts.of("confirm")[0]?.message).toContain(
        "Model work on opencode cannot be restricted: it can edit files and run commands.",
      );
      expect(prompts.of("confirm")[0]?.message).not.toContain("Model calls run read-only.");
      expect(prompts.output).toContain(
        "Model work on opencode cannot be restricted: it can edit files and run commands.",
      );
      expect(result).toEqual({
        answer: { platforms: ["opencode"], default: "opencode" },
        modelCallsOnHarness: true,
        modelWork: true,
      });

      // --yes does not hand model calls to it.
      const yes = await stepHarnesses(input({ interactive: false, installed: installed("opencode") }));
      expect(yes).toEqual({
        answer: { platforms: ["opencode"], default: "opencode" },
        modelCallsOnHarness: false,
        modelWork: false,
      });
    });
  });

  test("OpenCode 2 can: the hint and the question say read-only, no note is added, and --yes hands it model calls", async () => {
    await withOpencodeOnPath(2, async () => {
      prompts.answers.multiselect.push(["opencode"]);
      prompts.answers.confirm.push(true);

      const result = await stepHarnesses(input({ installed: installed("opencode") }));

      expect(prompts.of("multiselect")[0]?.options[0]?.hint).toContain("model calls run read-only");
      expect(prompts.of("confirm")[0]?.message).toContain("Model calls run read-only.");
      expect(prompts.output.filter((line) => line.includes("cannot be restricted"))).toEqual([]);
      expect(result.modelWork).toBe(true);

      const yes = await stepHarnesses(input({ interactive: false, installed: installed("opencode") }));
      expect(yes).toEqual({
        answer: { platforms: ["opencode"], default: "opencode" },
        modelCallsOnHarness: true,
        modelWork: true,
      });
    });
  });

  // The configured `bin` is OpenCode `configured`, the `opencode` on PATH is the other major.
  const opencodeBin = (configured: 1 | 2) =>
    fakeOpencodeMajor((bin) => {
      const major = bin === "/opt/opencode-configured" ? configured : configured === 1 ? 2 : 1;
      return major === 1 ? "1.19.4" : "opencode v2.1.4";
    });
  const configuredOpencode = () => cfg({ harnesses: { opencode: { bin: "/opt/opencode-configured" } } });

  test("the configured bin is the one judged: OpenCode 1 there, 2 on PATH: --yes does not hand it model calls", async () => {
    opencodeBin(1);

    const yes = await stepHarnesses(
      input({ interactive: false, current: configuredOpencode(), installed: installed("opencode") }),
    );

    expect(yes).toEqual({ modelCallsOnHarness: false, modelWork: false });
  });

  test("the configured bin is the one judged: OpenCode 2 there, 1 on PATH: --yes hands it model calls", async () => {
    opencodeBin(2);

    const yes = await stepHarnesses(
      input({ interactive: false, current: configuredOpencode(), installed: installed("opencode") }),
    );

    expect(yes).toEqual({ modelCallsOnHarness: true, modelWork: true });
  });

  test("the configured bin is the one judged, interactively: the hint, the question and the note follow it, whichever major PATH has", async () => {
    for (const [configured, restricted] of [
      [1, false],
      [2, true],
    ] as const) {
      opencodeBin(configured);
      prompts.answers.multiselect.push(["opencode"]);
      prompts.answers.confirm.push(true);

      const result = await stepHarnesses(input({ current: configuredOpencode(), installed: installed("opencode") }));

      const hint = prompts.of("multiselect").at(-1)?.options[0]?.hint;
      const question = prompts.of("confirm").at(-1)?.message;
      expect(hint).toContain(restricted ? "model calls run read-only" : "cannot be restricted to read-only");
      expect(question).toContain(
        restricted ? "Model calls run read-only." : "Model work on opencode cannot be restricted",
      );
      expect(result).toEqual({
        answer: { platforms: ["opencode"], default: "opencode" },
        modelCallsOnHarness: true,
        modelWork: true,
      });
    }
  });

  test("the bin an enabled entry sets is judged when an answer makes it the default among several", async () => {
    opencodeBin(1);
    prompts.answers.multiselect.push(["claude", "opencode"]);
    prompts.answers.select.push("opencode");
    prompts.answers.confirm.push(true);

    await stepHarnesses(
      input({
        current: cfg({ harnesses: { claude: {}, opencode: { bin: "/opt/opencode-configured" } } }),
        installed: installed("claude", "opencode"),
      }),
    );

    expect(prompts.of("confirm")[0]?.message).toContain("Model work on opencode cannot be restricted");
  });

  test("a saved modelWork: false is not a default to reset: --yes keeps it, and the question starts at No", async () => {
    fakeOpencodeMajor(2);
    const current = cfg({ harnesses: { opencode: { modelWork: false } } });

    const yes = await stepHarnesses(input({ interactive: false, current, installed: installed("opencode") }));
    expect(yes).toEqual({ modelCallsOnHarness: false, modelWork: false });
    expect(applySetupAnswers(current, { harnessModelWork: yes.modelWork }).patch).toEqual({});

    prompts.answers.multiselect.push(["opencode"]);
    prompts.answers.confirm.push(false);
    const kept = await stepHarnesses(input({ current, installed: installed("opencode") }));
    expect(prompts.of("confirm")[0]?.initialValue).toBe(false);
    expect(kept).toEqual({
      answer: { platforms: ["opencode"], default: "opencode" },
      modelCallsOnHarness: false,
      modelWork: false,
    });
    expect(
      applySetupAnswers(current, { harnesses: kept.answer, harnessModelWork: kept.modelWork }).patch.harnesses,
    ).toEqual({
      opencode: { modelWork: false },
    });
  });

  test("an explicit Yes to the question clears a saved modelWork: false", async () => {
    fakeOpencodeMajor(2);
    const current = cfg({ harnesses: { opencode: { modelWork: false } } });
    prompts.answers.multiselect.push(["opencode"]);
    prompts.answers.confirm.push(true);

    const result = await stepHarnesses(input({ current, installed: installed("opencode") }));

    expect(result.modelWork).toBe(true);
    expect(applySetupAnswers(current, { harnessModelWork: result.modelWork }).patch.harnesses).toEqual({
      opencode: {},
    });
  });

  test("a harness the answer makes the default is judged by its own saved choice, not the previous default's", async () => {
    const current = cfg({ harnesses: { opencode: { modelWork: false } } });

    const yes = await stepHarnesses(
      input({
        interactive: false,
        current,
        installed: installed("claude"),
        flags: parseSetupFlags({ harness: "claude" }),
      }),
    );

    expect(yes).toMatchObject({ modelCallsOnHarness: true, modelWork: true });
  });

  test("interactive: with several selected, asks which one is the default", async () => {
    prompts.answers.multiselect.push(["claude", "gemini"]);
    prompts.answers.select.push("gemini");
    prompts.answers.confirm.push(true);

    const result = await stepHarnesses(input());

    expect(prompts.of("select")[0]?.initialValue).toBe("claude");
    expect(result.answer).toEqual({ platforms: ["claude", "gemini"], default: "gemini" });
    expect(prompts.of("confirm")[0]?.message).toContain("Use gemini");
  });

  test("a rerun is prefilled from the config: its harnesses selected and its default preselected", async () => {
    prompts.answers.multiselect.push(["gemini", "claude"]);
    prompts.answers.select.push("gemini");
    prompts.answers.confirm.push(true);
    const current = cfg({ harnesses: { default: { platform: "gemini" }, claude: {} } });

    await stepHarnesses(input({ current }));

    expect(prompts.of("multiselect")[0]?.initialValues).toEqual(["gemini", "claude"]);
    expect(prompts.of("select")[0]?.initialValue).toBe("gemini");
  });

  test("a harness that is configured but no longer on PATH is still listed, so it can be kept or dropped", async () => {
    prompts.answers.multiselect.push([]);
    const current = cfg({ harnesses: { aider: {} } });

    const result = await stepHarnesses(input({ current, installed: [] }));

    const [asked] = prompts.of("multiselect");
    expect(asked?.options.map((o) => [o.value, o.hint?.startsWith("not found on PATH")])).toEqual([["aider", true]]);
    expect(result.answer).toEqual({ platforms: [] });
    expect(prompts.of("confirm")).toHaveLength(0);
  });

  test("model calls are not asked about when a connection exists or is being added", async () => {
    prompts.answers.multiselect.push(["claude"], ["claude"]);
    const withConnection = cfg({ connections: { default: { endpoint: "http://localhost:11434/v1" } } });

    expect((await stepHarnesses(input({ current: withConnection }))).modelCallsOnHarness).toBe(false);
    expect((await stepHarnesses(input({ flags: { endpoint: "http://x/v1" } }))).modelCallsOnHarness).toBe(false);
    expect(prompts.of("confirm")).toHaveLength(0);
  });

  test("nothing installed and nothing configured: says so and asks nothing", async () => {
    const result = await stepHarnesses(input({ installed: [] }));
    expect(result).toEqual({ modelCallsOnHarness: false });
    expect(prompts.asked).toHaveLength(0);
    expect(prompts.output.join("\n")).toContain("No agent programs found on PATH");
  });

  test("--yes: every detected harness, the first the default, used for model calls only when it can run read-only", async () => {
    const readOnly = await stepHarnesses(input({ interactive: false }));
    expect(readOnly).toEqual({
      answer: { platforms: ["claude", "gemini"], default: "claude" },
      modelCallsOnHarness: true,
      modelWork: true,
    });

    const notReadOnly = await stepHarnesses(input({ interactive: false, installed: installed("gemini", "claude") }));
    expect(notReadOnly.answer?.default).toBe("gemini");
    expect(notReadOnly.modelCallsOnHarness).toBe(false);
    expect(notReadOnly.modelWork).toBe(false);
    expect(prompts.asked).toHaveLength(0);
  });

  test("--yes leaves harnesses the config already has alone", async () => {
    const current = cfg({ harnesses: { aider: {} } });
    const result = await stepHarnesses(input({ interactive: false, current }));
    expect(result.answer).toBeUndefined();
  });

  test("--harness enables the named platforms in addition to the configured ones, the first being the default", async () => {
    fakeOpencodeMajor(2);
    const current = cfg({ harnesses: { aider: {} } });
    const result = await stepHarnesses(
      input({ interactive: false, current, flags: parseSetupFlags({ harness: "opencode,claude" }) }),
    );
    expect(result.answer).toEqual({ platforms: ["aider", "opencode", "claude"], default: "opencode" });
  });
});

describe("stepConnection", () => {
  const input = (over: Partial<Parameters<typeof stepConnection>[0]> = {}) => ({
    current: cfg(),
    flags: {},
    interactive: true,
    probe: true,
    modelCallsOnHarness: false,
    localServers: [],
    ...over,
  });
  const MODELS = ["qwen3-8b", "nomic-embed-text", "qwen3-32b"];

  test("interactive: URL, masked key, then the endpoint's own models, one pick per alias", async () => {
    const server = endpoint(MODELS);
    prompts.answers.text.push("http://localhost:11434");
    prompts.answers.password.push("sk-typed-secret");
    prompts.answers.select.push("qwen3-8b", "qwen3-32b", "qwen3-32b");

    const result = await server.serve(() => stepConnection(input()));

    expect(result.answer).toEqual({
      name: "default",
      endpoint: "http://localhost:11434/v1",
      key: { pasted: "sk-typed-secret" },
      picks: { fast: "qwen3-8b", balanced: "qwen3-32b", reasoning: "qwen3-32b" },
    });
    expect(result.listed).toEqual(MODELS);
    expect(server.requests).toEqual([
      { url: "http://localhost:11434/v1/models", authorization: "Bearer sk-typed-secret" },
    ]);
    // The embedding model is not offered as a chat model.
    expect(prompts.of("select")[0]?.options.map((o) => o.value)).toEqual(["qwen3-8b", "qwen3-32b"]);
    expect(prompts.of("password")[0]?.message).toBe("API key (blank for none)");
    // The key appears in the answer and the request, never in anything shown.
    expect(prompts.transcript()).not.toContain("sk-typed-secret");
  });

  test("interactive: a rerun is prefilled; a blank key keeps the current one; picks are preselected", async () => {
    const server = endpoint(MODELS);
    const current = cfg({
      connections: {
        default: {
          endpoint: "http://localhost:11434/v1",
          apiKey: "$LAB_KEY",
          models: { fast: "qwen3-8b", balanced: "qwen3-32b", reasoning: { model: "qwen3-32b", top_p: 0.9 } },
        },
      },
    });
    prompts.answers.text.push("http://localhost:11434/v1");
    prompts.answers.password.push("");
    prompts.answers.select.push("qwen3-8b", "qwen3-32b", "qwen3-8b");

    const result = await withEnv({ LAB_KEY: "env-key" }, () => server.serve(() => stepConnection(input({ current }))));

    expect(prompts.of("text")[0]?.initialValue).toBe("http://localhost:11434/v1");
    expect(prompts.of("password")[0]?.message).toBe("API key (blank keeps the current one)");
    expect(prompts.of("select").map((r) => r.initialValue)).toEqual(["qwen3-8b", "qwen3-32b", "qwen3-32b"]);
    expect(result.answer?.key).toBeUndefined();
    expect(result.answer?.picks.reasoning).toBe("qwen3-8b");
    // The connection's own key is what lists its models.
    expect(server.requests[0]?.authorization).toBe("Bearer env-key");
  });

  test("the key of a connection is not sent to a different endpoint", async () => {
    const server = endpoint(MODELS);
    const current = cfg({ connections: { default: { endpoint: "https://old.example.test/v1", apiKey: "$LAB_KEY" } } });
    prompts.answers.text.push("http://other.example.test/v1");
    prompts.answers.password.push("");
    prompts.answers.select.push("qwen3-8b", "qwen3-8b", "qwen3-8b");

    await withEnv({ LAB_KEY: "env-key" }, () => server.serve(() => stepConnection(input({ current }))));

    expect(server.requests[0]?.authorization).toBeNull();
  });

  test("a new endpoint with no key given does not carry the old one: a $VAR or a stored key, the user is told, and the prompt does not offer it", async () => {
    const warnings: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    const server = endpoint(MODELS);
    const flags = parseSetupFlags({ endpoint: "https://new.example.test/v1" });
    for (const held of [{ apiKey: "$LAB_KEY" }, {}]) {
      warnings.length = 0;
      if (!("apiKey" in held))
        writeCredential({ connection: "default" }, "stored-old-key", "https://old.example.test/v1");
      const current = cfg({ connections: { default: { endpoint: "https://old.example.test/v1", ...held } } });

      const result = await withEnv({ LAB_KEY: "env-key" }, () =>
        server.serve(() => stepConnection(input({ current, flags, interactive: false }))),
      );

      expect(result.answer?.key).toBeUndefined();
      expect(
        warnings.filter((w) => w.includes("its current key is not used with https://new.example.test/v1")),
      ).toHaveLength(1);
      expect(warnings.join("\n")).not.toContain("env-key");
      expect(warnings.join("\n")).not.toContain("stored-old-key");
    }
    expect(server.requests.every((request) => request.authorization === null)).toBe(true);
  });

  test("interactive: a new endpoint's key prompt does not offer to keep the current one", async () => {
    const server = endpoint(MODELS);
    const current = cfg({ connections: { default: { endpoint: "https://old.example.test/v1", apiKey: "$LAB_KEY" } } });
    prompts.answers.text.push("https://new.example.test/v1");
    prompts.answers.password.push("");
    prompts.answers.select.push("qwen3-8b", "qwen3-8b", "qwen3-8b");

    await withEnv({ LAB_KEY: "env-key" }, () => server.serve(() => stepConnection(input({ current }))));

    expect(prompts.of("password")[0]?.message).toBe("API key (blank for none)");
  });

  test("interactive: when the endpoint cannot list its models, say so and take one name for every alias", async () => {
    const server = endpoint([], { status: 401 });
    prompts.answers.text.push("https://api.example.test/v1", "my-model");
    prompts.answers.password.push("");

    const result = await server.serve(() => stepConnection(input()));

    expect(prompts.output.join("\n")).toContain("Could not list models from https://api.example.test/v1 (HTTP 401)");
    expect(result.answer?.picks).toEqual({ fast: "my-model", balanced: "my-model", reasoning: "my-model" });
    expect(result.listed).toEqual([]);
  });

  test("--no-probe: the endpoint is not contacted, and a name is typed instead", async () => {
    const server = endpoint(MODELS);
    prompts.answers.text.push("http://localhost:11434", "typed-model");
    prompts.answers.password.push("");

    const result = await server.serve(() => stepConnection(input({ probe: false })));

    expect(server.requests).toEqual([]);
    expect(result.answer?.picks.fast).toBe("typed-model");
  });

  test("a blank URL means no connection", async () => {
    prompts.answers.text.push("");
    expect(await stepConnection(input())).toEqual({ listed: [], addedDefault: false });
    expect(prompts.of("password")).toHaveLength(0);
  });

  test("interactive: not asked at all when a harness takes the model calls", async () => {
    expect(await stepConnection(input({ modelCallsOnHarness: true }))).toEqual({ listed: [], addedDefault: false });
    expect(prompts.asked).toHaveLength(0);
  });

  test("the URL is prefilled with a local server that answered", async () => {
    const server = endpoint(MODELS);
    prompts.answers.text.push("http://localhost:1234/v1");
    prompts.answers.password.push("");
    prompts.answers.select.push("qwen3-8b", "qwen3-8b", "qwen3-8b");
    const localServers = [{ baseUrl: "http://localhost:1234", label: "LM Studio", available: true, models: MODELS }];

    await server.serve(() => stepConnection(input({ localServers })));

    expect(prompts.of("text")[0]?.initialValue).toBe("http://localhost:1234/v1");
  });

  test("--endpoint with --api-key-env: asks nothing but the picks (none under --yes), the key stays a $VAR", async () => {
    const server = endpoint(MODELS);
    const flags = parseSetupFlags({ endpoint: "https://api.example.test", apiKeyEnv: "EXAMPLE_KEY" });

    const result = await withEnv({ EXAMPLE_KEY: "from-env" }, () =>
      server.serve(() => stepConnection(input({ flags, interactive: false }))),
    );

    expect(result.answer).toEqual({
      name: "default",
      endpoint: "https://api.example.test/v1",
      key: { env: "EXAMPLE_KEY" },
      picks: { fast: "qwen3-8b", balanced: "qwen3-8b", reasoning: "qwen3-8b" },
    });
    expect(server.requests[0]?.authorization).toBe("Bearer from-env");
    expect(prompts.asked).toHaveLength(0);
  });

  test("--yes keeps the connection's current picks and picks the first model for the rest", async () => {
    const server = endpoint(MODELS);
    const current = cfg({
      connections: {
        default: { endpoint: "http://localhost:11434/v1", models: { balanced: { model: "qwen3-32b", top_p: 1 } } },
      },
    });
    const flags = parseSetupFlags({ endpoint: "http://localhost:11434/v1" });

    const result = await server.serve(() => stepConnection(input({ current, flags, interactive: false })));

    expect(result.answer?.picks).toEqual({ fast: "qwen3-8b", balanced: "qwen3-32b", reasoning: "qwen3-8b" });
  });

  test("a pick the endpoint no longer lists is kept, with one warning naming it", async () => {
    const warnings: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    const server = endpoint(MODELS);
    const current = cfg({
      connections: {
        default: {
          endpoint: "http://localhost:11434/v1",
          models: { fast: "gone", balanced: "gone", reasoning: { model: "qwen3-32b", top_p: 1 } },
        },
      },
    });
    const flags = parseSetupFlags({ endpoint: "http://localhost:11434/v1" });

    const result = await server.serve(() => stepConnection(input({ current, flags, interactive: false })));

    expect(result.answer?.picks).toEqual({ fast: "gone", balanced: "gone", reasoning: "qwen3-32b" });
    const unlisted = warnings.filter((line) => line.includes("does not list"));
    expect(unlisted).toHaveLength(1);
    expect(unlisted[0]).toContain('Keeping "gone"');
    expect(unlisted[0]).toContain("akm models set");
  });

  test("--name adds a further connection and leaves the default alone", async () => {
    const server = endpoint(MODELS);
    const current = cfg({ connections: { default: { endpoint: "http://localhost:11434/v1" } } });
    const flags = parseSetupFlags({ endpoint: "https://cloud.example.test/v1", name: "cloud" });

    const result = await server.serve(() => stepConnection(input({ current, flags, interactive: false })));

    expect(result.answer?.name).toBe("cloud");
  });

  test("--yes takes a detected local server when there is no connection and no harness for model calls", async () => {
    const server = endpoint(MODELS);
    const localServers = [
      { baseUrl: "http://localhost:11434", label: "Ollama", available: false, models: [] },
      { baseUrl: "http://localhost:1234", label: "LM Studio", available: true, models: MODELS },
    ];

    const result = await server.serve(() => stepConnection(input({ interactive: false, localServers })));

    expect(result.answer?.endpoint).toBe("http://localhost:1234/v1");
    expect(result.answer?.name).toBe("default");
  });

  test("--yes leaves a configured connection alone, and does nothing when a harness takes model calls", async () => {
    const server = endpoint(MODELS);
    const localServers = [{ baseUrl: "http://localhost:1234", label: "LM Studio", available: true, models: MODELS }];
    const configured = cfg({ connections: { default: { endpoint: "http://elsewhere/v1" } } });

    await server.serve(async () => {
      expect(await stepConnection(input({ interactive: false, localServers, current: configured }))).toEqual({
        listed: [],
        addedDefault: false,
      });
      expect(await stepConnection(input({ interactive: false, localServers, modelCallsOnHarness: true }))).toEqual({
        listed: [],
        addedDefault: false,
      });
    });
    expect(server.requests).toEqual([]);
  });

  test("--yes with no flag and nothing detected configures no connection", async () => {
    expect(await stepConnection(input({ interactive: false }))).toEqual({ listed: [], addedDefault: false });
  });

  test("--api-key-env with no connection to update is a usage error", async () => {
    const flags = parseSetupFlags({ apiKeyEnv: "EXAMPLE_KEY" });
    await expect(stepConnection(input({ flags, interactive: false }))).rejects.toBeInstanceOf(UsageError);
  });

  test("only a new connection that is, or becomes, the default counts as added", async () => {
    const server = endpoint(MODELS);
    const existing = cfg({ connections: { default: { endpoint: "http://localhost:11434/v1" } } });
    const added = async (current: AkmConfig, raw: { endpoint: string; name?: string }) =>
      (await server.serve(() => stepConnection(input({ current, flags: parseSetupFlags(raw), interactive: false }))))
        .addedDefault;

    expect(await added(cfg(), { endpoint: "http://x/v1" })).toBe(true);
    expect(await added(cfg(), { endpoint: "http://x/v1", name: "lab" })).toBe(true);
    expect(
      await added(cfg({ connections: { other: { endpoint: "http://o/v1" } } }), {
        endpoint: "http://x/v1",
        name: "default",
      }),
    ).toBe(true);
    // The connection already there, updated; or a further one beside it.
    expect(await added(existing, { endpoint: "http://x/v1" })).toBe(false);
    expect(await added(existing, { endpoint: "http://x/v1", name: "second" })).toBe(false);
    expect(
      await added(cfg({ connections: { other: { endpoint: "http://o/v1" } } }), {
        endpoint: "http://x/v1",
        name: "second",
      }),
    ).toBe(false);
  });

  test("--yes with --no-probe writes the endpoint and keeps whatever picks the connection had", async () => {
    const flags = parseSetupFlags({ endpoint: "http://localhost:11434" });
    const result = await stepConnection(input({ flags, interactive: false, probe: false }));
    expect(result.answer).toEqual({ name: "default", endpoint: "http://localhost:11434/v1", picks: {} });
  });
});

describe("stepEmbeddings", () => {
  const input = (over: Partial<Parameters<typeof stepEmbeddings>[0]> = {}) => ({
    current: cfg(),
    flags: {},
    interactive: true,
    probe: true,
    listed: [] as string[],
    addedDefaultConnection: false,
    ...over,
  });
  const connection = { name: "default", endpoint: "http://localhost:11434/v1", picks: {} };
  const withConnection = (over: Partial<Parameters<typeof stepEmbeddings>[0]> = {}) =>
    input({ connection, listed: ["qwen3-8b", "nomic-embed-text"], addedDefaultConnection: true, ...over });

  test("interactive: offers the connection's embedding models, the built-in embedder, another endpoint and off; ON is preselected", async () => {
    prompts.answers.select.push("model:nomic-embed-text");
    prompts.answers.confirm.push(true);

    const result = await stepEmbeddings(withConnection());

    const [asked] = prompts.of("select");
    expect(asked?.options.map((o) => o.value)).toEqual(["model:nomic-embed-text", "local", "endpoint", "off"]);
    expect(asked?.initialValue).toBe("model:nomic-embed-text");
    expect(result).toEqual({
      answer: { kind: "connection", model: "nomic-embed-text" },
      semantic: { mode: "auto", prepareAssets: true },
    });
  });

  test("interactive: with no embedding model listed the preselected source is the built-in embedder, and the note warns of the download", async () => {
    prompts.answers.select.push("local");
    prompts.answers.confirm.push(false);

    const result = await stepEmbeddings(input());

    expect(prompts.of("select")[0]?.initialValue).toBe("local");
    expect(prompts.output.join("\n")).toContain("download");
    expect(prompts.of("confirm")[0]?.message).toContain("Download and verify semantic-search assets now?");
    expect(result).toEqual({ answer: { kind: "local" }, semantic: { mode: "auto", prepareAssets: false } });
  });

  test("interactive: off turns semantic search off and asks nothing more", async () => {
    prompts.answers.select.push("off");
    const result = await stepEmbeddings(withConnection());
    expect(result).toEqual({ answer: { kind: "off" }, semantic: { mode: "off", prepareAssets: false } });
    expect(prompts.of("confirm")).toHaveLength(0);
  });

  test("interactive: a model served by the connection says no local download, and asks to check the endpoint", async () => {
    prompts.answers.select.push("model:nomic-embed-text");
    prompts.answers.confirm.push(true);
    await stepEmbeddings(withConnection());
    expect(prompts.output.join("\n")).toContain("no local model download");
    expect(prompts.of("confirm")[0]?.message).toContain("Check the embedding endpoint");
  });

  test("interactive: another endpoint takes a URL, a masked key, and a model from its own list", async () => {
    const server = endpoint(["chat-model", "e5-embed"]);
    prompts.answers.select.push("endpoint", "e5-embed");
    prompts.answers.text.push("https://emb.example.test");
    prompts.answers.password.push("sk-embedding-secret");
    prompts.answers.confirm.push(false);

    const result = await server.serve(() => stepEmbeddings(withConnection()));

    expect(result.answer).toEqual({
      kind: "endpoint",
      endpoint: "https://emb.example.test/v1",
      model: "e5-embed",
      key: { pasted: "sk-embedding-secret" },
    });
    expect(server.requests[0]).toEqual({
      url: "https://emb.example.test/v1/models",
      authorization: "Bearer sk-embedding-secret",
    });
    expect(prompts.of("select")[1]?.options.map((o) => o.value)).toEqual(["e5-embed"]);
    expect(prompts.transcript()).not.toContain("sk-embedding-secret");
  });

  test("a rerun preselects what the config has", async () => {
    prompts.answers.select.push("endpoint");
    prompts.answers.text.push("https://emb.example.test/v1");
    prompts.answers.password.push("");
    prompts.answers.text.push("e5");
    prompts.answers.confirm.push(false);
    const current = cfg({ embedding: { endpoint: "https://emb.example.test/v1", model: "e5" } });

    await endpoint([]).serve(() => stepEmbeddings(input({ current })));

    expect(prompts.of("select")[0]?.initialValue).toBe("endpoint");
    expect(prompts.of("text")[0]?.initialValue).toBe("https://emb.example.test/v1");
    expect(prompts.of("password")[0]?.message).toContain("Embedding API key");
  });

  test("a held embedding key is sent only to the endpoint it belongs to", async () => {
    const current = cfg({
      embedding: { endpoint: "https://emb.example.test/v1", model: "e5-embed", apiKey: "$EMB_KEY" },
    });
    const same = endpoint(["e5-embed"]);
    prompts.answers.select.push("endpoint", "e5-embed");
    prompts.answers.text.push("https://emb.example.test/v1");
    prompts.answers.password.push("");
    prompts.answers.confirm.push(false);
    await withEnv({ EMB_KEY: "held-key" }, () => same.serve(() => stepEmbeddings(input({ current }))));
    expect(same.requests[0]?.authorization).toBe("Bearer held-key");

    const other = endpoint(["e5-embed"]);
    prompts.answers.select.push("endpoint", "e5-embed");
    prompts.answers.text.push("https://other.example.test/v1");
    prompts.answers.password.push("");
    prompts.answers.confirm.push(false);
    await withEnv({ EMB_KEY: "held-key" }, () => other.serve(() => stepEmbeddings(input({ current }))));
    expect(other.requests[0]?.authorization).toBeNull();
  });

  test("a new embedding endpoint with no key given does not carry the old one, and the user is told", async () => {
    const warnings: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    const current = cfg({
      embedding: { endpoint: "https://emb.example.test/v1", model: "e5", apiKey: "$EMB_KEY" },
    });
    const flags = parseSetupFlags({ embedding: "e5", embeddingEndpoint: "https://other.example.test/v1" });

    const result = await stepEmbeddings(input({ current, flags, interactive: false }));

    expect(result.answer).toEqual({ kind: "endpoint", endpoint: "https://other.example.test/v1", model: "e5" });
    expect(warnings.filter((w) => w.includes("embedding endpoint changed"))).toHaveLength(1);
    // The same endpoint is not a change.
    warnings.length = 0;
    await stepEmbeddings(
      input({
        current,
        flags: parseSetupFlags({ embedding: "e5", embeddingEndpoint: "https://emb.example.test/v1" }),
        interactive: false,
      }),
    );
    expect(warnings).toEqual([]);
  });

  describe("the connection that serves an embedding model is the default of the config as it will be", () => {
    const other = { name: "other", endpoint: "http://other.example.test/v1", picks: {} };
    const flags = parseSetupFlags({ embedding: "embed-new" });

    test("a further connection that is not the default does not serve it: its models are not offered, and the default's endpoint is the one used", async () => {
      const current = cfg({ connections: { default: { endpoint: "http://main.example.test/v1" } } });
      prompts.answers.select.push("local");
      prompts.answers.confirm.push(false);
      await stepEmbeddings(input({ current, connection: other, listed: ["embed-from-other"] }));
      expect(prompts.of("select")[0]?.options.map((option) => option.value)).toEqual(["local", "endpoint", "off"]);

      const flagged = await stepEmbeddings(
        input({ current, connection: other, listed: ["embed-from-other"], flags, interactive: false }),
      );
      expect(flagged.answer).toEqual({ kind: "connection", model: "embed-new" });
      // Saved, the embedding runs on the endpoint the default connection has.
      const saved = {
        ...current,
        ...applySetupAnswers(current, { connection: other, embedding: flagged.answer }).patch,
      };
      expect(effectiveEmbedding(saved as AkmConfig)).toMatchObject({
        model: "embed-new",
        endpoint: "http://main.example.test/v1",
      });
    });

    test("with several connections and none called default there is nothing to serve it, and the user is told how to fix that", async () => {
      const current = cfg({
        connections: {
          first: { endpoint: "http://a.example.test/v1" },
          second: { endpoint: "http://b.example.test/v1" },
        },
      });
      const failure = await stepEmbeddings(
        input({ current, connection: other, listed: ["embed-new"], flags, interactive: false }),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(UsageError);
      expect((failure as UsageError).message).toContain('none of the connections is called "default"');
      expect((failure as UsageError).message).toContain("akm setup --name default");
    });

    test("a connection that becomes the default serves it, and its own models are offered", async () => {
      const current = cfg({ connections: { first: { endpoint: "http://a.example.test/v1" } } });
      const named = { name: "default", endpoint: "http://main.example.test/v1", picks: {} };
      prompts.answers.select.push("model:embed-main");
      prompts.answers.confirm.push(false);
      const result = await stepEmbeddings(input({ current, connection: named, listed: ["embed-main"] }));
      expect(prompts.of("select")[0]?.options.map((option) => option.value)).toContain("model:embed-main");
      expect(result.answer).toEqual({ kind: "connection", model: "embed-main" });
    });
  });

  test("--embedding off, local, or a model on the connection, with no question asked", async () => {
    expect(await stepEmbeddings(withConnection({ flags: parseSetupFlags({ embedding: "off" }) }))).toEqual({
      answer: { kind: "off" },
      semantic: { mode: "off", prepareAssets: false },
    });
    expect(await stepEmbeddings(withConnection({ flags: parseSetupFlags({ embedding: "local" }) }))).toEqual({
      answer: { kind: "local" },
      semantic: { mode: "auto", prepareAssets: false },
    });
    const model = await stepEmbeddings(
      withConnection({ flags: parseSetupFlags({ embedding: "text-embedding-3-small" }) }),
    );
    expect(model.answer).toEqual({ kind: "connection", model: "text-embedding-3-small" });
    expect(prompts.asked).toHaveLength(0);
  });

  test("--embedding with --embedding-endpoint and --embedding-api-key-env names another endpoint and its key variable", async () => {
    const flags = parseSetupFlags({
      embedding: "e5",
      embeddingEndpoint: "https://emb.example.test",
      embeddingApiKeyEnv: "EMB_KEY",
    });
    const result = await stepEmbeddings(input({ flags, interactive: false }));
    expect(result.answer).toEqual({
      kind: "endpoint",
      endpoint: "https://emb.example.test/v1",
      model: "e5",
      key: { env: "EMB_KEY" },
    });
  });

  test("--embedding <model> with no connection to serve it is a usage error", async () => {
    const flags = parseSetupFlags({ embedding: "nomic-embed-text" });
    await expect(stepEmbeddings(input({ flags, interactive: false }))).rejects.toBeInstanceOf(UsageError);
  });

  test("--yes turns embeddings on only when the connection lists an embedding model", async () => {
    const listed = await stepEmbeddings(withConnection({ interactive: false }));
    expect(listed).toEqual({
      answer: { kind: "connection", model: "nomic-embed-text" },
      semantic: { mode: "auto", prepareAssets: false },
    });

    const none = await stepEmbeddings(
      input({ interactive: false, connection, listed: ["qwen3-8b"], current: cfg({ semanticSearchMode: "auto" }) }),
    );
    expect(none).toEqual({ semantic: { mode: "auto", prepareAssets: false } });
    expect((await stepEmbeddings(input({ interactive: false }))).semantic.mode).toBe("off");
    expect(prompts.asked).toHaveLength(0);
  });

  test("--yes leaves embeddings alone unless this run added the default connection and there is no embedding block", async () => {
    const unchanged = (mode: "off" | "auto") => ({ semantic: { mode, prepareAssets: false } });
    const run = (over: Partial<Parameters<typeof stepEmbeddings>[0]>) =>
      stepEmbeddings(input({ interactive: false, connection, listed: ["qwen3-8b", "nomic-embed-text"], ...over }));

    // A connection that was already there, or a further one: not the default this run added.
    expect(await run({ addedDefaultConnection: false })).toEqual(unchanged("off"));
    // An embedding block is the user's earlier choice, endpoint and dimension included.
    const own = cfg({ embedding: { endpoint: "http://e/v1", model: "own", dimension: 768 } });
    expect(await run({ addedDefaultConnection: true, current: own })).toEqual(unchanged("off"));
    // The default connection was added and nothing is chosen yet: a model it serves.
    expect((await run({ addedDefaultConnection: true })).answer).toEqual({
      kind: "connection",
      model: "nomic-embed-text",
    });
  });
});
