import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { _setAkmInitForTests } from "../../src/commands/sources/init";
import { _setDefaultTasksForTests } from "../../src/commands/tasks/default-tasks";
import { _setSaveConfigForTests } from "../../src/core/config/config";
import type { IndexResponse } from "../../src/indexer/indexer";
import { _setAkmIndexForTests } from "../../src/indexer/indexer";
import { _setAgentDetectForTests } from "../../src/integrations/agent";
import { _setEmbedderForTests } from "../../src/llm/embedder";
import { _setDetectForTests } from "../../src/setup/detect";
import { _setLoadSetupStashesForTests, type SetupStashEntry } from "../../src/setup/registry-stash-loader";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

// Per-test sandbox (withIsolatedAkmStorage in beforeEach). The REAL
// src/core/paths module resolves every path from the sandboxed env vars
// (AKM_STASH_DIR, XDG_CONFIG_HOME, XDG_CACHE_HOME, ...), so the wizard reads
// and writes the real config file at DEFAULT_CONFIG_PATH inside the sandbox.
let storage: IsolatedAkmStorage;
let DEFAULT_STASH_DIR = "";
let DEFAULT_CONFIG_PATH = "";
const DEFAULT_REGISTRY_URLS = [
  "https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json",
  "https://skills.sh",
];

// ── @clack/prompts mock (single file-local helper; mock.module by design) ────
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

const REAL_CLACK = await import("@clack/prompts");
afterAll(() => {
  mock.module("@clack/prompts", () => REAL_CLACK);
  mock.restore();
});

const promptState = {
  confirms: [] as unknown[],
  selects: [] as unknown[],
  multiselects: [] as unknown[],
  texts: [] as unknown[],
  trace: [] as string[],
  logs: [] as string[],
  notes: [] as string[],
  outros: [] as string[],
};

function takeAnswer(type: "confirm" | "select" | "multiselect" | "text", args: unknown): unknown {
  const queues = {
    confirm: promptState.confirms,
    select: promptState.selects,
    multiselect: promptState.multiselects,
    text: promptState.texts,
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
    const fallback = { confirm: false, select: "done", multiselect: [], text: "" }[type];
    promptState.trace.push(`[${type}] ${message}${optionValues} -> (capture default) ${JSON.stringify(fallback)}`);
    return fallback;
  }
  const answer = queue.shift();
  promptState.trace.push(`[${type}] ${message}${optionValues} -> ${JSON.stringify(answer)}`);
  return answer;
}

function installClackMock(): void {
  mock.module("@clack/prompts", () => ({
    isCancel: () => false,
    cancel: (message: string) => {
      promptState.logs.push(`[cancel] ${message}`);
    },
    confirm: async (args: unknown) => takeAnswer("confirm", args),
    select: async (args: unknown) => takeAnswer("select", args),
    multiselect: async (args: unknown) => takeAnswer("multiselect", args),
    text: async (args: unknown) => takeAnswer("text", args),
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
  }));
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
    verification: {
      ok: true,
      message: "semantic search verified",
      semanticSearchEnabled: true,
      semanticSearchMode: "auto",
      semanticStatus: "ready-js",
      embeddingProvider: "local",
      entryCount: 3,
      embeddingCount: 3,
      vecAvailable: false,
    },
  };
}

const setupState = {
  initCalls: [] as Array<{ dir: string }>,
  indexCalls: [] as Array<{ stashDir: string; enrich?: boolean }>,
  detectOllamaResult: { available: false, endpoint: "http://localhost:11434", models: [] as string[] },
  detectAgentPlatformsResult: [] as Array<{ name: string; path: string }>,
  checkEmbeddingResult: { available: true } as
    | { available: true }
    | { available: false; reason: "missing-package" | "model-download-failed" | "remote-unreachable"; message: string },
  transformersAvailable: true,
  indexResult: makeIndexResult(),
  indexError: undefined as Error | undefined,
  vecAvailable: false,
  dbOpenError: undefined as Error | undefined,
};

function loadSetupModule() {
  const setupUrl = pathToFileURL(path.join(import.meta.dir, "../../src/setup/setup.ts")).href;
  return import(`${setupUrl}?t=${Date.now()}-${Math.random()}`);
}

/** Read the config the wizard actually wrote to the sandboxed config path. */
function readSavedConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, "utf8")) as Record<string, unknown>;
}

function resetPromptState(): void {
  promptState.confirms.length = 0;
  promptState.selects.length = 0;
  promptState.multiselects.length = 0;
  promptState.texts.length = 0;
  promptState.trace.length = 0;
  promptState.logs.length = 0;
  promptState.notes.length = 0;
  promptState.outros.length = 0;
}

function resetSetupState(): void {
  setupState.initCalls.length = 0;
  setupState.indexCalls.length = 0;
  setupState.detectOllamaResult = { available: false, endpoint: "http://localhost:11434", models: [] };
  setupState.detectAgentPlatformsResult = [];
  setupState.checkEmbeddingResult = { available: true };
  setupState.transformersAvailable = true;
  setupState.indexResult = makeIndexResult();
  setupState.indexError = undefined;
  setupState.vecAvailable = false;
  setupState.dbOpenError = undefined;
}

function installIndexerNeverRunsSeam(): void {
  overrideSeam(_setAkmIndexForTests, async () => {
    throw new Error("index should not run");
  });
}

function installDefaultTasksSeam(): void {
  overrideSeam(_setDefaultTasksForTests, {
    detectServerDefault: () => false,
    isCiEnvironment: () => false,
    registerDefaultTasks: async () => ({ skipped: false, created: [], existing: [], toggled: [] }),
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
    detectOllama: async () => setupState.detectOllamaResult,
    detectAgentPlatforms: () => setupState.detectAgentPlatformsResult,
  });
  overrideSeam(_setEmbedderForTests, {
    isTransformersAvailable: () => setupState.transformersAvailable,
    checkEmbeddingAvailability: async () => setupState.checkEmbeddingResult,
  });
  overrideSeam(_setAkmInitForTests, async (options?: { dir?: string }) => {
    const dir = options?.dir ?? DEFAULT_STASH_DIR;
    setupState.initCalls.push({ dir });
    return { stashDir: dir, created: true, configPath: DEFAULT_CONFIG_PATH, defaultStashUpdated: true };
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
  // The wizard's vec probe imports openIndexDatabase/isVecAvailable/
  // closeDatabase from the db module (setup.ts:41); steer it via setupState.
  mock.module("../../src/indexer/db/db", () => ({
    openIndexDatabase: () => {
      if (setupState.dbOpenError) throw setupState.dbOpenError;
      return {};
    },
    closeDatabase: () => {},
    isVecAvailable: () => setupState.vecAvailable,
  }));
  overrideSeam(_setAgentDetectForTests, {
    detectAgentCliProfiles: () => [],
    pickDefaultAgentProfile: () => undefined,
  });
  // Deterministic registry stash list — the real loader fetches the live
  // registry index over the network (options would drift with its content).
  overrideSeam(
    _setLoadSetupStashesForTests,
    async (): Promise<SetupStashEntry[]> => [
      {
        id: "itlackey/akm-stash",
        name: "itlackey/akm-stash",
        description: "Official AKM onboarding stash",
        url: "https://github.com/itlackey/akm-stash",
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
  mock.restore();
  installDefaultTasksSeam();
});

afterEach(() => {
  process.exit = realProcessExit;
  if (CAPTURE) {
    console.error(`[SETUP_RUN_CAPTURE] prompt trace:\n${promptState.trace.join("\n")}`);
  }
  mock.restore();
  storage.cleanup();
});

describe("runSetupWizard", () => {
  test("saves config, initializes stash, and indexes on the default happy path", async () => {
    installSetupSeams();

    // Real wizard prompt order (see SETUP_RUN_CAPTURE): stash dir -> LLM
    // provider -> semantic search -> registries -> registry stashes ->
    // add-another-source loop -> output format/detail -> server install ->
    // scheduled tasks -> small-model provider -> agent connection -> save.
    promptState.selects.push("default", "none", "done", "json", "brief", "skip", "none");
    promptState.confirms.push(false, false, false, true);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], [], []);

    const { runSetupWizard } = await loadSetupModule();
    await runSetupWizard();

    const saved = readSavedConfig();
    expect(saved.stashDir).toBe(DEFAULT_STASH_DIR);
    expect(saved.semanticSearchMode).toBe("off");
    expect(setupState.initCalls).toEqual([{ dir: DEFAULT_STASH_DIR }]);
    expect(setupState.indexCalls).toEqual([{ stashDir: DEFAULT_STASH_DIR, enrich: undefined }]);
    expect(promptState.outros[0]).toContain(DEFAULT_CONFIG_PATH);
  });

  test("keeps semantic search in auto mode when asset preparation fails", async () => {
    installSetupSeams();

    promptState.selects.push("default", "none", "done", "json", "brief", "skip", "none");
    promptState.confirms.push(false, true, true, false, true);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], [], []);
    setupState.checkEmbeddingResult = {
      available: false,
      reason: "model-download-failed",
      message: "download blocked",
    };

    const { runSetupWizard } = await loadSetupModule();
    await runSetupWizard();

    expect(readSavedConfig().semanticSearchMode).toBe("auto");
    expect(promptState.logs.some((entry) => entry.includes("remains set to auto, but is currently blocked"))).toBe(
      true,
    );
    expect(setupState.indexCalls).toEqual([{ stashDir: DEFAULT_STASH_DIR, enrich: undefined }]);
  });

  test("warns and completes when indexing fails after saving config", async () => {
    installSetupSeams();

    promptState.selects.push("default", "none", "done", "json", "brief", "skip", "none");
    promptState.confirms.push(false, false, false, true);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], [], []);
    setupState.indexError = new Error("index exploded");

    const { runSetupWizard } = await loadSetupModule();
    await runSetupWizard();

    expect(fs.existsSync(DEFAULT_CONFIG_PATH)).toBe(true);
    expect(setupState.initCalls).toEqual([{ dir: DEFAULT_STASH_DIR }]);
    expect(setupState.indexCalls).toEqual([{ stashDir: DEFAULT_STASH_DIR, enrich: undefined }]);
    expect(promptState.logs.some((entry) => entry.includes("index exploded"))).toBe(true);
    expect(promptState.outros).toHaveLength(1);
  });

  test("warns specifically when remote embedding endpoint is unreachable", async () => {
    installSetupSeams();
    setupState.detectOllamaResult = {
      available: true,
      endpoint: "http://localhost:11434",
      models: ["nomic-embed-text", "llama3.2"],
    };
    setupState.checkEmbeddingResult = {
      available: false,
      reason: "remote-unreachable",
      message: "connection refused",
    };

    // With Ollama detected: embedding provider select + dimension text come
    // before the LLM step, and picking "ollama" there asks for a chat model.
    promptState.selects.push(
      "default",
      "nomic-embed-text",
      "ollama",
      "llama3.2",
      "done",
      "json",
      "brief",
      "skip",
      "none",
    );
    promptState.confirms.push(false, true, true, false, true);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], [], []);
    promptState.texts.push("384");

    const { runSetupWizard } = await loadSetupModule();
    await runSetupWizard();

    expect(promptState.logs.some((entry) => entry.includes("remote embedding endpoint is not reachable"))).toBe(true);
    expect(readSavedConfig().semanticSearchMode).toBe("auto");
  });

  test("warns specifically when transformers package is missing during setup prep", async () => {
    installSetupSeams();
    // transformersAvailable stays true so the wizard skips the `bun add`
    // auto-install attempt (the install path is environment-dependent and
    // makes the test flaky). The faked checkEmbeddingAvailability still
    // reports missing-package, which exercises the "warn and report" path.
    setupState.checkEmbeddingResult = {
      available: false,
      reason: "missing-package",
      message: "@huggingface/transformers is not installed.",
    };

    promptState.selects.push("default", "none", "done", "json", "brief", "skip", "none");
    promptState.confirms.push(false, true, true, false, true);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], [], []);

    const { runSetupWizard } = await loadSetupModule();
    await runSetupWizard();

    expect(promptState.logs.some((entry) => entry.includes("Install it with: bun add @huggingface/transformers"))).toBe(
      true,
    );
    expect(readSavedConfig().semanticSearchMode).toBe("auto");
  });

  test("keeps semantic search enabled and warns when sqlite-vec/db check fails", async () => {
    installSetupSeams();
    setupState.dbOpenError = new Error("db locked");

    promptState.selects.push("default", "none", "done", "json", "brief", "skip", "none");
    promptState.confirms.push(false, true, true, false, true);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], [], []);

    const { runSetupWizard } = await loadSetupModule();
    await runSetupWizard();

    expect(readSavedConfig().semanticSearchMode).toBe("auto");
    expect(promptState.logs.some((entry) => entry.includes("Semantic search will use the JS fallback"))).toBe(true);
  });

  test("keeps semantic search enabled when asset preparation is skipped", async () => {
    installSetupSeams();

    promptState.selects.push("default", "none", "done", "json", "brief", "skip", "none");
    promptState.confirms.push(false, true, false, false, true);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], [], []);

    const { runSetupWizard } = await loadSetupModule();
    await runSetupWizard();

    expect(readSavedConfig().semanticSearchMode).toBe("auto");
    expect(promptState.logs.some((entry) => entry.includes("asset preparation was skipped"))).toBe(true);
  });

  test("surfaces config save failure after bootstrap init", async () => {
    installSetupSeams();
    installIndexerNeverRunsSeam();
    let saveCalls = 0;
    overrideSeam(_setSaveConfigForTests, () => {
      saveCalls += 1;
      throw new Error("EACCES config.json");
    });

    promptState.selects.push("default", "none", "done", "json", "brief", "skip", "none");
    promptState.confirms.push(false, false, false, true);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], [], []);

    const { runSetupWizard } = await loadSetupModule();
    await expect(runSetupWizard()).rejects.toThrow("EACCES config.json");
    expect(saveCalls).toBe(1);
    expect(setupState.initCalls).toEqual([{ dir: DEFAULT_STASH_DIR }]);
    expect(setupState.indexCalls).toHaveLength(0);
  });

  test("surfaces bootstrap init failure before saving config", async () => {
    installSetupSeams();
    installIndexerNeverRunsSeam();
    overrideSeam(_setAkmInitForTests, async () => {
      throw new Error("EACCES stash init");
    });

    // akmInit throws before the wizard asks anything — no prompt queue needed
    // (the strict clack mock will fail loudly if a prompt is ever reached).

    const { runSetupWizard } = await loadSetupModule();
    await expect(runSetupWizard()).rejects.toThrow("EACCES stash init");
    expect(fs.existsSync(DEFAULT_CONFIG_PATH)).toBe(false);
    expect(setupState.indexCalls).toHaveLength(0);
  });
});
