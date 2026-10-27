import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { _setClackForTests } from "../src/cli/clack";
import { _setAkmInitForTests } from "../src/commands/sources/init";
import { loadUserConfig, resetConfigCache } from "../src/core/config/config";
import type { IndexResponse } from "../src/indexer/indexer";
import { _setAkmIndexForTests } from "../src/indexer/indexer";
import { _setAgentDetectForTests } from "../src/integrations/agent";
import { resolveTarget } from "../src/integrations/agent/resolution";
import { agentRuntime } from "../src/integrations/agent/runtime";
import { _setEmbedderForTests } from "../src/llm/embedder";
import { _setDetectForTests } from "../src/setup/detect";
import { _setLoadSetupStashesForTests, type SetupBundleEntry } from "../src/setup/registry-stash-loader";
import { runSetupFromConfig, runSetupWizard } from "../src/setup/setup";
import { withOpencodeOnPath } from "./_helpers/opencode-version";
import {
  type IsolatedAkmStorage,
  withIsolatedAkmStorage,
  withMockedFetch,
  writeSandboxConfig,
} from "./_helpers/sandbox";
import { overrideSeam } from "./_helpers/seams";

// Per-test sandbox (withIsolatedAkmStorage in beforeEach). The REAL
// src/core/paths module resolves every path from the sandboxed env vars
// (AKM_BUNDLE_DIR, XDG_CONFIG_HOME, XDG_CACHE_HOME, ...), so the wizard reads
// and writes the real config file at DEFAULT_CONFIG_PATH inside the sandbox.
let storage: IsolatedAkmStorage;
let DEFAULT_STASH_DIR = "";
let DEFAULT_CONFIG_PATH = "";
const DEFAULT_REGISTRY_URLS = [
  "https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json",
  "https://skills.sh",
];

// ── @clack/prompts fake (single file-local helper; src/cli/clack seam) ───────
//
// The wizard consumes answers strictly in prompt order. Every consumed prompt
// is recorded in `promptState.trace` ("[type] message -> answer"), so a
// misaligned queue fails with the full transcript instead of dying silently.
//
// To re-capture the wizard's real prompt sequence after a flow change, run:
//   SETUP_RUN_CAPTURE=1 bun test tests/integration/setup-run.test.ts
// Capture mode answers drained queues with safe defaults and prints the full
// trace instead of throwing, so one run reveals the whole sequence.
const CAPTURE = process.env.SETUP_RUN_CAPTURE === "1";

const promptState = {
  confirms: [] as unknown[],
  selects: [] as unknown[],
  multiselects: [] as unknown[],
  texts: [] as unknown[],
  passwords: [] as unknown[],
  trace: [] as string[],
  logs: [] as string[],
  notes: [] as string[],
  outros: [] as string[],
};

function takeAnswer(type: "confirm" | "select" | "multiselect" | "text" | "password", args: unknown): unknown {
  const queues = {
    confirm: promptState.confirms,
    select: promptState.selects,
    multiselect: promptState.multiselects,
    text: promptState.texts,
    password: promptState.passwords,
  } as const;
  const opts = args as { message?: string; options?: Array<{ value?: unknown }> };
  const message = String(opts?.message ?? "");
  const optionValues = Array.isArray(opts?.options)
    ? ` options=${JSON.stringify(opts.options.map((o) => o.value))}`
    : "";
  const queue = queues[type];
  if (queue.length === 0) {
    if (!CAPTURE) {
      throw new Error(
        `clack ${type} queue empty for prompt "${message}"${optionValues}\nTrace so far:\n${promptState.trace.join("\n")}`,
      );
    }
    const fallback = { confirm: false, select: "done", multiselect: [], text: "", password: "" }[type];
    promptState.trace.push(`[${type}] ${message}${optionValues} -> (capture default) ${JSON.stringify(fallback)}`);
    return fallback;
  }
  const answer = queue.shift();
  promptState.trace.push(
    `[${type}] ${message}${optionValues} -> ${type === "password" ? "(hidden)" : JSON.stringify(answer)}`,
  );
  return answer;
}

function installClackMock(): void {
  overrideSeam(_setClackForTests, {
    isCancel: () => false,
    cancel: (message: string) => {
      promptState.logs.push(`[cancel] ${message}`);
    },
    confirm: async (args: unknown) => takeAnswer("confirm", args),
    select: async (args: unknown) => takeAnswer("select", args),
    multiselect: async (args: unknown) => takeAnswer("multiselect", args),
    text: async (args: unknown) => takeAnswer("text", args),
    password: async (args: unknown) => takeAnswer("password", args),
    spinner: () => ({
      start: (message: string) => {
        promptState.logs.push(`[spinner:start] ${message}`);
      },
      stop: (message: string) => {
        promptState.logs.push(`[spinner:stop] ${message}`);
      },
    }),
    log: {
      step: (message: string) => {
        promptState.logs.push(`[step] ${message}`);
      },
      info: (message: string) => {
        promptState.logs.push(`[info] ${message}`);
      },
      warn: (message: string) => {
        promptState.logs.push(`[warn] ${message}`);
      },
      success: (message: string) => {
        promptState.logs.push(`[success] ${message}`);
      },
    },
    intro: (message: string) => {
      promptState.logs.push(`[intro] ${message}`);
    },
    outro: (message: string) => {
      promptState.outros.push(message);
    },
    note: (message: string, title?: string) => {
      promptState.notes.push(`${title ?? ""}\n${message}`.trim());
    },
  });
}

function makeIndexResult(): IndexResponse {
  return {
    stashDir: DEFAULT_STASH_DIR,
    totalEntries: 3,
    generatedMetadata: 0,
    indexPath: path.join(DEFAULT_STASH_DIR, "index.db"),
    mode: "full",
    directoriesScanned: 1,
    directoriesSkipped: 0,
    scanComplete: true,
    verification: {
      ok: true,
      message: "semantic search verified",
      semanticSearchEnabled: true,
      semanticSearchMode: "auto",
      semanticStatus: "ready-js",
      embeddingProvider: "local",
      entryCount: 3,
      embeddingCount: 3,
    },
  };
}

const setupState = {
  initCalls: [] as Array<{ dir: string }>,
  indexCalls: [] as Array<{ stashDir: string; enrich?: boolean }>,
  detectAgentPlatformsResult: [] as Array<{ name: string; path: string }>,
  checkEmbeddingResult: { available: true } as
    | { available: true }
    | {
        available: false;
        reason: "runtime-unavailable" | "model-download-failed" | "remote-unreachable";
        message: string;
      },
  indexResult: makeIndexResult(),
  indexError: undefined as Error | undefined,
};

/** Read the config the wizard actually wrote to the sandboxed config path. */
function readSavedConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, "utf8")) as Record<string, unknown>;
}

function resetPromptState(): void {
  promptState.confirms.length = 0;
  promptState.selects.length = 0;
  promptState.multiselects.length = 0;
  promptState.texts.length = 0;
  promptState.passwords.length = 0;
  promptState.trace.length = 0;
  promptState.logs.length = 0;
  promptState.notes.length = 0;
  promptState.outros.length = 0;
}

function resetSetupState(): void {
  setupState.initCalls.length = 0;
  setupState.indexCalls.length = 0;
  setupState.detectAgentPlatformsResult = [];
  setupState.checkEmbeddingResult = { available: true };
  setupState.indexResult = makeIndexResult();
  setupState.indexError = undefined;
}

function installIndexerNeverRunsSeam(): void {
  overrideSeam(_setAkmIndexForTests, async () => {
    throw new Error("index should not run");
  });
}

/**
 * Install the standard seam/mock stanza every test needs. Behavior is
 * steered per-test through `setupState` (and, where a test needs a bespoke
 * fake, by calling `overrideSeam` again after this — the later call wins).
 */
function installSetupSeams(): void {
  installClackMock();
  overrideSeam(_setDetectForTests, {
    detectAgentPlatforms: () => setupState.detectAgentPlatformsResult,
  });
  overrideSeam(_setEmbedderForTests, {
    checkEmbeddingAvailability: async () => setupState.checkEmbeddingResult,
  });
  overrideSeam(_setAkmInitForTests, async (options?: { dir?: string }) => {
    const dir = options?.dir ?? DEFAULT_STASH_DIR;
    setupState.initCalls.push({ dir });
    return { bundleDir: dir, created: true, configPath: DEFAULT_CONFIG_PATH, defaultBundleUpdated: true };
  });
  overrideSeam(_setAkmIndexForTests, async (options) => {
    setupState.indexCalls.push({
      stashDir: options?.stashDir ?? "",
      enrich: (options as { enrich?: boolean } | undefined)?.enrich,
    });
    if (setupState.indexError) {
      throw setupState.indexError;
    }
    return setupState.indexResult;
  });
  overrideSeam(_setAgentDetectForTests, { detectAgentCliProfiles: () => [] });
  // Deterministic registry stash list — the real loader fetches the live
  // registry index over the network (options would drift with its content).
  overrideSeam(
    _setLoadSetupStashesForTests,
    async (): Promise<SetupBundleEntry[]> => [
      {
        id: "itlackey/akm-stash",
        name: "itlackey/akm-stash",
        description: "Official AKM onboarding stash",
        url: "https://github.com/itlackey/akm-stash",
        installType: "git",
        source: "registry",
        defaultSelected: false,
      },
    ],
  );
}

// ── LOUD exit guard ──────────────────────────────────────────────────────────
// The wizard's bail() calls process.exit(0), which would silently kill the
// bun test process with a green exit code. Any process.exit during a test is
// a bug (usually a misaligned prompt queue) and must fail loudly.
const realProcessExit = process.exit;

beforeEach(() => {
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code}) during setup wizard test — prompt queue misaligned`);
  }) as typeof process.exit;
  resetPromptState();
  storage = withIsolatedAkmStorage();
  DEFAULT_STASH_DIR = storage.stashDir;
  DEFAULT_CONFIG_PATH = path.join(storage.configDir, "akm", "config.json");
  resetSetupState();
});

afterEach(() => {
  process.exit = realProcessExit;
  if (CAPTURE) {
    console.error(`[SETUP_RUN_CAPTURE] prompt trace:\n${promptState.trace.join("\n")}`);
  }
  storage.cleanup();
});

/** A stand-in for an OpenAI-compatible endpoint at `base`: lists `models`; every other URL is unreachable. */
function withEndpoint<T>(base: string, models: string[], run: () => Promise<T>): Promise<T> {
  return withMockedFetch(run, (url) => {
    if (url === `${base}/models`) return Response.json({ data: models.map((id) => ({ id })) });
    throw new Error("unreachable");
  });
}

/** Make `claude` the one agent program found on PATH. */
function installClaude(): void {
  installHarness("claude");
}

/** Make `name` the one agent program found on PATH. */
function installHarness(name: string): void {
  overrideSeam(_setAgentDetectForTests, {
    detectAgentCliProfiles: () => [{ name, bin: name, available: true, resolvedPath: `/usr/local/bin/${name}` }],
  });
}

describe("runSetupWizard", () => {
  test("saves config, initializes stash, and indexes on the default happy path", async () => {
    installSetupSeams();

    // Prompt order (see SETUP_RUN_CAPTURE): stash dir -> [no harness found] ->
    // connection URL (blank) -> embedding source -> registries -> registry
    // stashes -> add-another-source loop -> output format/detail -> save ->
    // scheduled tasks. The task step runs after the save confirm and config persist.
    promptState.selects.push("default", "off", "done", "json", "brief");
    promptState.texts.push("");
    promptState.confirms.push(true, false);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], [], []);

    await runSetupWizard();

    const saved = readSavedConfig();
    // 0.9.0 (spec §10.1): the primary stash is the defaultBundle's path.
    const savedBundles = saved.bundles as Record<string, { path?: string }> | undefined;
    expect(savedBundles?.[saved.defaultBundle as string]?.path).toBe(DEFAULT_STASH_DIR);
    expect("stashDir" in saved).toBe(false);
    expect("sources" in saved).toBe(false);
    expect("installed" in saved).toBe(false);
    expect(saved.semanticSearchMode).toBe("off");
    expect("connections" in saved).toBe(false);
    expect("harnesses" in saved).toBe(false);
    expect(setupState.initCalls).toEqual([{ dir: DEFAULT_STASH_DIR }]);
    expect(setupState.indexCalls).toEqual([{ stashDir: DEFAULT_STASH_DIR, enrich: undefined }]);
    expect(promptState.outros[0]).toContain(DEFAULT_CONFIG_PATH);
  });

  test("saying no to model calls on a harness with no connection to take them is saved: the call goes nowhere and the summary says so", async () => {
    installSetupSeams();
    installHarness("gemini");

    promptState.multiselects.push(["gemini"], [...DEFAULT_REGISTRY_URLS], [], []);
    promptState.confirms.push(false, true, false);
    promptState.texts.push("");
    promptState.selects.push("default", "off", "done", "json", "brief");

    await runSetupWizard();

    expect(readSavedConfig().harnesses).toEqual({ gemini: { modelWork: false } });
    expect("connections" in readSavedConfig()).toBe(false);
    const summary = promptState.notes.find((note) => note.startsWith("Configuration Summary")) ?? "";
    expect(summary).toContain(
      'Model calls:      off: no connection is configured, and harness "gemini" is set not to take model calls.',
    );
    expect(summary).toContain("akm setup --endpoint URL");
    expect(summary).toContain('Agent work:       harness "gemini"');

    resetConfigCache();
    const config = loadUserConfig();
    expect(() => resolveTarget({ config, modelWork: true, layers: [] })).toThrow(/set not to run akm's model calls/);
    expect(resolveTarget({ config, modelWork: false, layers: [] })).toMatchObject({ kind: "harness", name: "gemini" });
  });

  test("saying yes keeps the harness for model calls, and a rerun that says yes clears an earlier no", async () => {
    installSetupSeams();
    installHarness("gemini");
    writeSandboxConfig({ semanticSearchMode: "off", harnesses: { gemini: { modelWork: false } } });
    resetConfigCache();

    promptState.multiselects.push(["gemini"], [...DEFAULT_REGISTRY_URLS], [], []);
    promptState.confirms.push(true, true, false);
    promptState.texts.push("");
    promptState.selects.push("default", "off", "done", "json", "brief");

    await runSetupWizard();

    expect(readSavedConfig().harnesses).toEqual({ gemini: {} });
    resetConfigCache();
    expect(resolveTarget({ config: loadUserConfig(), modelWork: true, layers: [] })).toMatchObject({
      kind: "harness",
      name: "gemini",
    });
  });

  test("OpenCode 1 asked about model calls: the question says it cannot be restricted, and the summary repeats it for a yes", async () => {
    installSetupSeams();
    installHarness("opencode");

    promptState.multiselects.push(["opencode"], [...DEFAULT_REGISTRY_URLS], [], []);
    promptState.confirms.push(true, true, false);
    promptState.texts.push("");
    promptState.selects.push("default", "off", "done", "json", "brief");

    await withOpencodeOnPath(1, () => runSetupWizard());

    expect(promptState.trace.find((line) => line.startsWith("[confirm] Use opencode"))).toContain(
      "Model work on opencode cannot be restricted: it can edit files and run commands.",
    );
    expect(readSavedConfig().harnesses).toEqual({ opencode: {} });
    const summary = promptState.notes.find((note) => note.startsWith("Configuration Summary")) ?? "";
    expect(summary).toContain(
      'Model calls:      harness "opencode". Model work on "opencode" cannot be restricted: it can edit files and run commands.',
    );
  });

  test("OpenCode 1 asked about model calls, answered no: saved as off, and no connection follows", async () => {
    installSetupSeams();
    installHarness("opencode");

    promptState.multiselects.push(["opencode"], [...DEFAULT_REGISTRY_URLS], [], []);
    promptState.confirms.push(false, true, false);
    promptState.texts.push("");
    promptState.selects.push("default", "off", "done", "json", "brief");

    await withOpencodeOnPath(1, () => runSetupWizard());

    expect(readSavedConfig().harnesses).toEqual({ opencode: { modelWork: false } });
  });

  test("OpenCode 2 asked about model calls: the question and the summary say its tools are limited to reading and searching", async () => {
    installSetupSeams();
    installHarness("opencode");

    promptState.multiselects.push(["opencode"], [...DEFAULT_REGISTRY_URLS], [], []);
    promptState.confirms.push(true, true, false);
    promptState.texts.push("");
    promptState.selects.push("default", "off", "done", "json", "brief");

    await withOpencodeOnPath(2, () => runSetupWizard());

    const question = promptState.trace.find((line) => line.startsWith("[confirm] Use opencode")) ?? "";
    expect(question).toContain("Model calls are limited to reading and searching.");
    expect(question).not.toContain("cannot be restricted");
    expect(readSavedConfig().harnesses).toEqual({ opencode: {} });
    const summary = promptState.notes.find((note) => note.startsWith("Configuration Summary")) ?? "";
    expect(summary).toContain('Model calls:      harness "opencode", limited to reading and searching');
  });

  test("a harness and a connection with a typed key: the key lands in credentials.json and nowhere else", async () => {
    installSetupSeams();
    installClaude();
    const secret = "sk-typed-into-the-masked-prompt";

    promptState.multiselects.push(["claude"], [...DEFAULT_REGISTRY_URLS], [], []);
    promptState.confirms.push(false, true, false);
    promptState.texts.push("https://api.example.test");
    promptState.passwords.push(secret);
    promptState.selects.push("default", "small", "mid", "big", "off", "done", "json", "brief");

    await withEndpoint("https://api.example.test/v1", ["small", "mid", "big"], () => runSetupWizard());

    const saved = readSavedConfig();
    expect(saved.harnesses).toEqual({ claude: {} });
    expect(saved.connections).toEqual({
      default: {
        endpoint: "https://api.example.test/v1",
        models: { fast: "small", balanced: "mid", reasoning: "big" },
      },
    });
    const credentialsPath = path.join(path.dirname(DEFAULT_CONFIG_PATH), "credentials.json");
    expect(JSON.parse(fs.readFileSync(credentialsPath, "utf8"))).toEqual({
      connections: { default: { key: secret, endpoint: "https://api.example.test/v1" } },
    });
    expect(fs.statSync(credentialsPath).mode & 0o777).toBe(0o600);

    expect(fs.readFileSync(DEFAULT_CONFIG_PATH, "utf8")).not.toContain(secret);
    const shown = [...promptState.logs, ...promptState.notes, ...promptState.outros, ...promptState.trace].join("\n");
    expect(shown).not.toContain(secret);
    // The summary says what runs where.
    const summary = promptState.notes.find((note) => note.startsWith("Configuration Summary")) ?? "";
    expect(summary).toContain('Model calls:      connection "default" (small)');
    expect(summary).toContain('Agent work:       harness "claude"');
  });

  test("a harness that takes the model calls needs no connection", async () => {
    installSetupSeams();
    installClaude();

    promptState.multiselects.push(["claude"], [...DEFAULT_REGISTRY_URLS], [], []);
    promptState.confirms.push(true, true, false);
    promptState.selects.push("default", "off", "done", "json", "brief");

    await runSetupWizard();

    const saved = readSavedConfig();
    expect(saved.harnesses).toEqual({ claude: {} });
    expect("connections" in saved).toBe(false);
    expect(promptState.trace.some((line) => line.includes("Endpoint URL"))).toBe(false);
    const summary = promptState.notes.find((note) => note.startsWith("Configuration Summary")) ?? "";
    expect(summary).toMatch(/Model calls: +harness "claude" \(.*\), limited to reading and searching/);
  });

  test("a rerun with the same answers keeps the alias picks the connection already has", async () => {
    installSetupSeams();
    fs.mkdirSync(path.dirname(DEFAULT_CONFIG_PATH), { recursive: true });
    const connection = {
      endpoint: "https://api.example.test/v1",
      timeoutMs: 900000,
      models: { fast: "small", balanced: { model: "mid", top_p: 0.9 }, reasoning: "big", coder: "qwen3-coder" },
    };
    fs.writeFileSync(
      DEFAULT_CONFIG_PATH,
      `${JSON.stringify({ configVersion: "0.9.0", semanticSearchMode: "off", connections: { default: connection } })}\n`,
    );

    promptState.selects.push("default", "small", "mid", "big", "off", "done", "json", "brief");
    promptState.texts.push("https://api.example.test/v1");
    promptState.passwords.push("");
    // Save, no schedules, and not now to fetching akm's own agent runtime.
    promptState.confirms.push(true, false, false);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], [], []);

    await withEndpoint("https://api.example.test/v1", ["small", "mid", "big"], () => runSetupWizard());

    expect(readSavedConfig().connections).toEqual({ default: connection });
    // Each pick was offered preselected.
    expect(promptState.trace.filter((line) => line.startsWith('[select] Model for "'))).toHaveLength(3);
  });

  test("with agent work on akm's own runtime, the wizard offers to fetch it now; yes fetches it, no leaves it to the first run", async () => {
    for (const answer of [true, false]) {
      installSetupSeams();
      resetPromptState();
      let fetched = 0;
      spyOn(agentRuntime, "fetch").mockImplementation(async () => {
        fetched++;
      });
      promptState.selects.push("default", "small", "small", "small", "off", "done", "json", "brief");
      promptState.texts.push("https://api.example.test/v1");
      promptState.passwords.push("");
      promptState.confirms.push(true, false, answer);
      promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], [], []);

      await withEndpoint("https://api.example.test/v1", ["small"], () => runSetupWizard());

      expect(promptState.trace.at(-1)).toContain("Fetch OpenCode 2.1.4 (about 114 MB, once) for it now");
      expect(fetched).toBe(answer ? 1 : 0);
    }
  });

  test("an offline run (--no-probe) offers no fetch of akm's own runtime", async () => {
    installSetupSeams();
    promptState.selects.push("default", "off", "done", "json", "brief");
    promptState.texts.push("https://api.example.test/v1", "small", "small", "small");
    promptState.passwords.push("");
    promptState.confirms.push(true, false);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], [], []);

    await runSetupWizard({ noProbe: true });

    expect(promptState.trace.some((line) => line.includes("Fetch OpenCode"))).toBe(false);
  });

  test("a harness the user deselects on a rerun is removed from the config, and the one kept is left as it was", async () => {
    installSetupSeams();
    installClaude();
    fs.mkdirSync(path.dirname(DEFAULT_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      DEFAULT_CONFIG_PATH,
      `${JSON.stringify({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        harnesses: { claude: { args: ["--keep"] }, codex: { bin: "/opt/codex" } },
        connections: { default: { endpoint: "https://api.example.test/v1", models: { fast: "m" } } },
      })}\n`,
    );

    // The harness question lists claude (installed) and codex (configured, not on PATH); codex is unchecked.
    promptState.multiselects.push(["claude"], [...DEFAULT_REGISTRY_URLS], [], []);
    promptState.confirms.push(true, false);
    promptState.texts.push("https://api.example.test/v1");
    promptState.passwords.push("");
    promptState.selects.push("default", "m", "m", "m", "off", "done", "json", "brief");

    await withEndpoint("https://api.example.test/v1", ["m"], () => runSetupWizard());

    expect(readSavedConfig().harnesses).toEqual({ claude: { args: ["--keep"] } });
  });

  test("keeps semantic search in auto mode when asset preparation fails", async () => {
    installSetupSeams();

    promptState.selects.push("default", "local", "done", "json", "brief");
    promptState.texts.push("");
    promptState.confirms.push(true, true, false);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], [], []);
    setupState.checkEmbeddingResult = {
      available: false,
      reason: "model-download-failed",
      message: "download blocked",
    };

    await runSetupWizard();

    expect(readSavedConfig().semanticSearchMode).toBe("auto");
    expect(promptState.logs.some((entry) => entry.includes("remains set to auto, but is currently blocked"))).toBe(
      true,
    );
    expect(setupState.indexCalls).toEqual([{ stashDir: DEFAULT_STASH_DIR, enrich: undefined }]);
  });

  test("preserves selected canonical bundle entries and removes deselected ones", async () => {
    installSetupSeams();
    fs.mkdirSync(path.dirname(DEFAULT_CONFIG_PATH), { recursive: true });
    const keptBundle = {
      git: "https://example.test/keep.git",
      writable: false,
      components: { keep: { root: ".", adapter: "akm", writable: false } },
      customMetadata: "preserved",
    };
    fs.writeFileSync(
      DEFAULT_CONFIG_PATH,
      `${JSON.stringify({
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        bundles: {
          stash: { path: DEFAULT_STASH_DIR, writable: true },
          keep: keptBundle,
          drop: { path: "/home/tester/drop" },
        },
        defaultBundle: "stash",
      })}\n`,
    );

    promptState.selects.push("default", "off", "done", "json", "brief");
    promptState.texts.push("");
    promptState.confirms.push(true, false);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], ["git:https://example.test/keep.git"], [], []);

    await runSetupWizard();

    const bundles = readSavedConfig().bundles as Record<string, unknown>;
    expect(bundles.keep).toEqual(keptBundle);
    expect(bundles.drop).toBeUndefined();
  });

  test("does not duplicate an existing no-.git bundle when the live registry returns .git", async () => {
    installSetupSeams();
    const historicalUrl = "https://github.com/itlackey/akm-stash";
    const liveUrl = `${historicalUrl}.git`;
    overrideSeam(_setLoadSetupStashesForTests, async () => [
      {
        id: "itlackey/akm-stash",
        name: "itlackey/akm-stash",
        description: "Official AKM onboarding stash",
        url: liveUrl,
        installType: "git",
        source: "registry",
        defaultSelected: true,
      },
    ]);
    fs.mkdirSync(path.dirname(DEFAULT_CONFIG_PATH), { recursive: true });
    const existingBundle = {
      git: historicalUrl,
      writable: false,
      components: { keep: { root: ".", adapter: "akm", writable: false } },
    };
    fs.writeFileSync(
      DEFAULT_CONFIG_PATH,
      `${JSON.stringify({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        bundles: {
          stash: { path: DEFAULT_STASH_DIR, writable: true },
          "itlackey-akm-stash": existingBundle,
        },
        defaultBundle: "stash",
      })}\n`,
    );

    promptState.selects.push("default", "off", "done", "json", "brief");
    promptState.texts.push("");
    promptState.confirms.push(true, false);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], [`git:${historicalUrl}`], [historicalUrl], []);

    await runSetupWizard();

    const bundles = readSavedConfig().bundles as Record<string, unknown>;
    expect(bundles["itlackey-akm-stash"]).toEqual(existingBundle);
    expect(Object.keys(bundles).sort()).toEqual(["itlackey-akm-stash", "stash"]);
  });

  test("warns and completes when indexing fails after saving config", async () => {
    installSetupSeams();

    promptState.selects.push("default", "off", "done", "json", "brief");
    promptState.texts.push("");
    promptState.confirms.push(true, false);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], [], []);
    setupState.indexError = new Error("index exploded");

    await runSetupWizard();

    expect(fs.existsSync(DEFAULT_CONFIG_PATH)).toBe(true);
    expect(setupState.initCalls).toEqual([{ dir: DEFAULT_STASH_DIR }]);
    expect(setupState.indexCalls).toEqual([{ stashDir: DEFAULT_STASH_DIR, enrich: undefined }]);
    expect(promptState.logs.some((entry) => entry.includes("index exploded"))).toBe(true);
    expect(promptState.outros).toHaveLength(1);
  });

  test("warns specifically when a model served by the connection is chosen and its endpoint is unreachable", async () => {
    installSetupSeams();
    setupState.checkEmbeddingResult = {
      available: false,
      reason: "remote-unreachable",
      message: "connection refused",
    };

    // The connection lists a chat model and an embedding model; the embedding
    // model is picked as the embedding source.
    promptState.selects.push(
      "default",
      "llama3.2",
      "llama3.2",
      "llama3.2",
      "model:nomic-embed-text",
      "done",
      "json",
      "brief",
    );
    promptState.texts.push("http://localhost:11434");
    promptState.passwords.push("");
    promptState.confirms.push(true, true, false, false);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], [], []);

    await withEndpoint("http://localhost:11434/v1", ["llama3.2", "nomic-embed-text"], () => runSetupWizard());

    expect(promptState.logs.some((entry) => entry.includes("remote embedding endpoint is not reachable"))).toBe(true);
    const saved = readSavedConfig();
    expect(saved.semanticSearchMode).toBe("auto");
    expect(saved.embedding).toEqual({ model: "nomic-embed-text" });
  });

  test("warns specifically when the embedding runtime cannot be fetched or load during setup prep", async () => {
    installSetupSeams();
    // The faked availability result exercises the warn-and-report path.
    setupState.checkEmbeddingResult = {
      available: false,
      reason: "runtime-unavailable",
      message: "Failed to load the embedding runtime (onnxruntime-node): Could not fetch ONNX Runtime 1.24.3.",
    };

    promptState.selects.push("default", "local", "done", "json", "brief");
    promptState.texts.push("");
    promptState.confirms.push(true, true, false);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], [], []);

    await runSetupWizard();

    expect(promptState.logs.some((entry) => entry.includes("Could not fetch ONNX Runtime"))).toBe(true);
    expect(readSavedConfig().semanticSearchMode).toBe("auto");
  });

  test("keeps semantic search enabled when asset preparation is skipped", async () => {
    installSetupSeams();

    promptState.selects.push("default", "local", "done", "json", "brief");
    promptState.texts.push("");
    promptState.confirms.push(false, true, false);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], [], []);

    await runSetupWizard();

    expect(readSavedConfig().semanticSearchMode).toBe("auto");
    expect(promptState.logs.some((entry) => entry.includes("asset preparation was skipped"))).toBe(true);
  });

  test("surfaces config preflight failure before bootstrap init", async () => {
    installSetupSeams();
    installIndexerNeverRunsSeam();
    fs.mkdirSync(DEFAULT_CONFIG_PATH, { recursive: true });

    promptState.selects.push("default", "off", "done", "json", "brief");
    promptState.texts.push("");
    promptState.confirms.push(true);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], [], []);

    await expect(runSetupWizard()).rejects.toThrow(/EISDIR|directory|Could not read config/);
    expect(setupState.initCalls).toEqual([]);
    expect(setupState.indexCalls).toHaveLength(0);
  });

  test("does not commit config when bootstrap init fails", async () => {
    installSetupSeams();
    installIndexerNeverRunsSeam();
    overrideSeam(_setAkmInitForTests, async () => {
      throw new Error("EACCES stash init");
    });

    promptState.selects.push("default", "off", "done", "json", "brief");
    promptState.texts.push("");
    promptState.confirms.push(true, false);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], [], []);

    await expect(runSetupWizard()).rejects.toThrow("EACCES stash init");
    expect(fs.existsSync(DEFAULT_CONFIG_PATH)).toBe(false);
    expect(setupState.indexCalls).toHaveLength(0);
  });

  test("cancelling at the final confirm persists nothing and never touches the scheduler", async () => {
    installSetupSeams();
    installIndexerNeverRunsSeam();

    // Answer through to the "Save this configuration?" confirm, then decline it.
    // The task review and activation confirmation run only after that save.
    promptState.selects.push("default", "off", "done", "json", "brief");
    promptState.texts.push("");
    promptState.confirms.push(false); // SAVE=false
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], []);

    // bail() calls process.exit(0), which the harness turns into a throw.
    await expect(runSetupWizard()).rejects.toThrow(/process\.exit\(0\)/);

    expect(fs.existsSync(DEFAULT_CONFIG_PATH)).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(DEFAULT_CONFIG_PATH), "credentials.json"))).toBe(false);
    expect(setupState.initCalls).toEqual([]);
    expect(setupState.indexCalls).toHaveLength(0);
    expect(promptState.trace.some((line) => line.includes("core task definitions"))).toBe(false);
    expect(promptState.trace.some((line) => line.includes("Activate these schedules"))).toBe(false);
  });

  test("a typed key is not stored when the final confirm is declined", async () => {
    installSetupSeams();
    installIndexerNeverRunsSeam();

    promptState.selects.push("default", "small", "small", "small", "off", "done", "json", "brief");
    promptState.texts.push("https://api.example.test");
    promptState.passwords.push("sk-never-stored");
    promptState.confirms.push(false);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], []);

    await expect(withEndpoint("https://api.example.test/v1", ["small"], () => runSetupWizard())).rejects.toThrow(
      /process\.exit\(0\)/,
    );

    expect(fs.existsSync(path.join(path.dirname(DEFAULT_CONFIG_PATH), "credentials.json"))).toBe(false);
  });
});

describe("runSetupFromConfig", () => {
  test("persists canonical bundle input without rebuilding it through draft aliases", async () => {
    installSetupSeams();
    const primaryPath = "/home/tester/current-bundle";
    const bundles = {
      workspace: {
        path: primaryPath,
        writable: false,
        components: { workspace: { root: ".", adapter: "akm", writable: false } },
        customMetadata: "preserved",
      },
      docs: { website: { url: "https://example.test/docs", maxPages: 5 } },
    };

    await runSetupFromConfig({
      configJson: JSON.stringify({ bundles, defaultBundle: "workspace", semanticSearchMode: "off" }),
      noInit: true,
    });

    const saved = readSavedConfig();
    expect(saved.bundles).toEqual(bundles);
    expect(saved.defaultBundle).toBe("workspace");
    expect("stashDir" in saved).toBe(false);
    expect("sources" in saved).toBe(false);
    expect("installed" in saved).toBe(false);
  });

  test("rejects retired source config fields instead of translating them", async () => {
    installSetupSeams();
    for (const key of ["stashDir", "sources", "installed"]) {
      await expect(
        runSetupFromConfig({ configJson: JSON.stringify({ [key]: key === "stashDir" ? "/home/tester/old" : [] }) }),
      ).rejects.toThrow(`${key} is not supported`);
    }
    expect(fs.existsSync(DEFAULT_CONFIG_PATH)).toBe(false);
    expect(setupState.initCalls).toEqual([]);
  });
});
