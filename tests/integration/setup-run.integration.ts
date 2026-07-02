import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { _setAkmInitForTests } from "../../src/commands/sources/init";
import type { IndexResponse } from "../../src/indexer/indexer";
import { _setAkmIndexForTests } from "../../src/indexer/indexer";
import { _setAgentDetectForTests } from "../../src/integrations/agent";
import { _setEmbedderForTests } from "../../src/llm/embedder";
import { _setDetectForTests } from "../../src/setup/detect";
import { overrideSeam } from "../_helpers/seams";

const DEFAULT_STASH_DIR = "/tmp/akm-default-stash";
const DEFAULT_CONFIG_PATH = "/tmp/akm-config/config.json";
const DEFAULT_CACHE_DIR = "/tmp/akm-cache";
const DEFAULT_REGISTRY_URLS = [
  "https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json",
  "https://skills.sh",
];

const promptState = {
  confirms: [] as unknown[],
  selects: [] as unknown[],
  multiselects: [] as unknown[],
  texts: [] as unknown[],
  logs: [] as string[],
  notes: [] as string[],
  outros: [] as string[],
};

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
  currentConfig: {
    semanticSearchMode: "auto",
    output: { format: "json", detail: "brief" },
  } as Record<string, unknown>,
  savedConfigs: [] as Array<Record<string, unknown>>,
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
};

function loadSetupModule() {
  const setupUrl = pathToFileURL(path.join(import.meta.dir, "../../src/setup/setup.ts")).href;
  return import(`${setupUrl}?t=${Date.now()}-${Math.random()}`);
}

function loadUserConfigMock(): Record<string, unknown> {
  return setupState.currentConfig;
}

function getSourcesMock(config: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(config.sources) ? (config.sources as Array<Record<string, unknown>>) : [];
}

function resetPromptState(): void {
  promptState.confirms.length = 0;
  promptState.selects.length = 0;
  promptState.multiselects.length = 0;
  promptState.texts.length = 0;
  promptState.logs.length = 0;
  promptState.notes.length = 0;
  promptState.outros.length = 0;
}

function resetSetupState(): void {
  setupState.currentConfig = {
    semanticSearchMode: "auto",
    output: { format: "json", detail: "brief" },
  };
  setupState.savedConfigs.length = 0;
  setupState.initCalls.length = 0;
  setupState.indexCalls.length = 0;
  setupState.detectOllamaResult = { available: false, endpoint: "http://localhost:11434", models: [] };
  setupState.detectAgentPlatformsResult = [];
  setupState.checkEmbeddingResult = { available: true };
  setupState.transformersAvailable = true;
  setupState.indexResult = makeIndexResult();
  setupState.indexError = undefined;
  setupState.vecAvailable = false;
}

function installAgentIntegrationMock(): void {
  overrideSeam(_setAgentDetectForTests, {
    detectAgentCliProfiles: () => [],
    pickDefaultAgentProfile: () => undefined,
  });
}

function installIndexerSeam(): void {
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
}

function installIndexerNeverRunsSeam(): void {
  overrideSeam(_setAkmIndexForTests, async () => {
    throw new Error("index should not run");
  });
}

function installDefaultTasksMock(): void {
  mock.module("../../src/commands/tasks/default-tasks", () => ({
    detectServerDefault: () => false,
    isCiEnvironment: () => false,
    registerDefaultTasks: async () => ({ skipped: false, created: [], existing: [], toggled: [] }),
  }));
}

beforeEach(() => {
  resetPromptState();
  resetSetupState();
  mock.restore();
  installDefaultTasksMock();
});

afterEach(() => {
  mock.restore();
});

describe("runSetupWizard", () => {
  test("saves config, initializes stash, and indexes on the default happy path", async () => {
    mock.module("@clack/prompts", () => ({
      isCancel: () => false,
      cancel: (message: string) => {
        promptState.logs.push(`[cancel] ${message}`);
      },
      confirm: async () => promptState.confirms.shift() ?? false,
      select: async () => promptState.selects.shift() ?? "done",
      multiselect: async () => promptState.multiselects.shift() ?? [],
      text: async () => promptState.texts.shift() ?? "",
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
    mock.module("../../src/core/config/config", () => ({
      DEFAULT_CONFIG: {
        semanticSearchMode: "auto",
        registries: [
          { url: DEFAULT_REGISTRY_URLS[0], name: "akm-registry" },
          { url: DEFAULT_REGISTRY_URLS[1], name: "skills.sh", provider: "skills-sh", enabled: false },
        ],
        output: { format: "json", detail: "brief" },
      },
      getConfigPath: () => DEFAULT_CONFIG_PATH,
      getSources: getSourcesMock,
      loadUserConfig: loadUserConfigMock,
      loadConfig: () => setupState.currentConfig,
      saveConfig: (config: Record<string, unknown>) => {
        setupState.savedConfigs.push(config);
      },
    }));
    mock.module("../../src/core/paths", () => ({
      getDefaultStashDir: () => DEFAULT_STASH_DIR,
      getConfigPath: () => DEFAULT_CONFIG_PATH,
      getConfigDir: () => path.dirname(DEFAULT_CONFIG_PATH),
      getCacheDir: () => DEFAULT_CACHE_DIR,
      getSemanticStatusPath: () => path.join(DEFAULT_CACHE_DIR, "semantic-status.json"),
    }));
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
    installIndexerSeam();
    mock.module("../../src/indexer/db/db", () => ({
      openDatabase: () => ({}),
      closeDatabase: () => {},
      isVecAvailable: () => setupState.vecAvailable,
    }));
    installAgentIntegrationMock();

    promptState.selects.push("default", "done", "json", "brief");
    promptState.confirms.push(false, true);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], []);

    const { runSetupWizard } = await loadSetupModule();
    await runSetupWizard();

    expect(setupState.savedConfigs).toHaveLength(1);
    expect(setupState.savedConfigs[0]?.stashDir).toBe(DEFAULT_STASH_DIR);
    expect(setupState.savedConfigs[0]?.semanticSearchMode).toBe("off");
    expect(setupState.initCalls).toEqual([{ dir: DEFAULT_STASH_DIR }]);
    expect(setupState.indexCalls).toEqual([{ stashDir: DEFAULT_STASH_DIR, enrich: undefined }]);
    expect(promptState.outros[0]).toContain(DEFAULT_CONFIG_PATH);
  });

  test("keeps semantic search in auto mode when asset preparation fails", async () => {
    mock.module("@clack/prompts", () => ({
      isCancel: () => false,
      cancel: (message: string) => {
        promptState.logs.push(`[cancel] ${message}`);
      },
      confirm: async () => promptState.confirms.shift() ?? false,
      select: async () => promptState.selects.shift() ?? "done",
      multiselect: async () => promptState.multiselects.shift() ?? [],
      text: async () => promptState.texts.shift() ?? "",
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
    mock.module("../../src/core/config/config", () => ({
      DEFAULT_CONFIG: {
        semanticSearchMode: "auto",
        registries: [
          { url: DEFAULT_REGISTRY_URLS[0], name: "akm-registry" },
          { url: DEFAULT_REGISTRY_URLS[1], name: "skills.sh", provider: "skills-sh", enabled: false },
        ],
        output: { format: "json", detail: "brief" },
      },
      getConfigPath: () => DEFAULT_CONFIG_PATH,
      getSources: getSourcesMock,
      loadUserConfig: loadUserConfigMock,
      loadConfig: () => setupState.currentConfig,
      saveConfig: (config: Record<string, unknown>) => {
        setupState.savedConfigs.push(config);
      },
    }));
    mock.module("../../src/core/paths", () => ({
      getDefaultStashDir: () => DEFAULT_STASH_DIR,
      getConfigPath: () => DEFAULT_CONFIG_PATH,
      getConfigDir: () => path.dirname(DEFAULT_CONFIG_PATH),
      getCacheDir: () => DEFAULT_CACHE_DIR,
      getSemanticStatusPath: () => path.join(DEFAULT_CACHE_DIR, "semantic-status.json"),
    }));
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
    installIndexerSeam();
    mock.module("../../src/indexer/db/db", () => ({
      openDatabase: () => ({}),
      closeDatabase: () => {},
      isVecAvailable: () => setupState.vecAvailable,
    }));
    installAgentIntegrationMock();

    promptState.selects.push("default", "done", "json", "brief");
    promptState.confirms.push(true, true, true);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], []);
    setupState.checkEmbeddingResult = {
      available: false,
      reason: "model-download-failed",
      message: "download blocked",
    };

    const { runSetupWizard } = await loadSetupModule();
    await runSetupWizard();

    expect(setupState.savedConfigs).toHaveLength(1);
    expect(setupState.savedConfigs[0]?.semanticSearchMode).toBe("auto");
    expect(promptState.logs.some((entry) => entry.includes("remains set to auto, but is currently blocked"))).toBe(
      true,
    );
    expect(setupState.indexCalls).toEqual([{ stashDir: DEFAULT_STASH_DIR, enrich: undefined }]);
  });

  test("warns and completes when indexing fails after saving config", async () => {
    mock.module("@clack/prompts", () => ({
      isCancel: () => false,
      cancel: (message: string) => {
        promptState.logs.push(`[cancel] ${message}`);
      },
      confirm: async () => promptState.confirms.shift() ?? false,
      select: async () => promptState.selects.shift() ?? "done",
      multiselect: async () => promptState.multiselects.shift() ?? [],
      text: async () => promptState.texts.shift() ?? "",
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
    mock.module("../../src/core/config/config", () => ({
      DEFAULT_CONFIG: {
        semanticSearchMode: "auto",
        registries: [
          { url: DEFAULT_REGISTRY_URLS[0], name: "akm-registry" },
          { url: DEFAULT_REGISTRY_URLS[1], name: "skills.sh", provider: "skills-sh", enabled: false },
        ],
        output: { format: "json", detail: "brief" },
      },
      getConfigPath: () => DEFAULT_CONFIG_PATH,
      getSources: getSourcesMock,
      loadUserConfig: loadUserConfigMock,
      loadConfig: () => setupState.currentConfig,
      saveConfig: (config: Record<string, unknown>) => {
        setupState.savedConfigs.push(config);
      },
    }));
    mock.module("../../src/core/paths", () => ({
      getDefaultStashDir: () => DEFAULT_STASH_DIR,
      getConfigPath: () => DEFAULT_CONFIG_PATH,
      getConfigDir: () => path.dirname(DEFAULT_CONFIG_PATH),
      getCacheDir: () => DEFAULT_CACHE_DIR,
      getSemanticStatusPath: () => path.join(DEFAULT_CACHE_DIR, "semantic-status.json"),
    }));
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
    installIndexerSeam();
    mock.module("../../src/indexer/db/db", () => ({
      openDatabase: () => ({}),
      closeDatabase: () => {},
      isVecAvailable: () => setupState.vecAvailable,
    }));
    installAgentIntegrationMock();

    promptState.selects.push("default", "done", "json", "brief");
    promptState.confirms.push(false, true);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], []);
    setupState.indexError = new Error("index exploded");

    const { runSetupWizard } = await loadSetupModule();
    await runSetupWizard();

    expect(setupState.savedConfigs).toHaveLength(1);
    expect(setupState.initCalls).toEqual([{ dir: DEFAULT_STASH_DIR }]);
    expect(setupState.indexCalls).toEqual([{ stashDir: DEFAULT_STASH_DIR, enrich: undefined }]);
    expect(promptState.logs.some((entry) => entry.includes("index exploded"))).toBe(true);
    expect(promptState.outros).toHaveLength(1);
  });

  test("warns specifically when remote embedding endpoint is unreachable", async () => {
    mock.module("@clack/prompts", () => ({
      isCancel: () => false,
      cancel: (message: string) => {
        promptState.logs.push(`[cancel] ${message}`);
      },
      confirm: async () => promptState.confirms.shift() ?? false,
      select: async () => promptState.selects.shift() ?? "done",
      multiselect: async () => promptState.multiselects.shift() ?? [],
      text: async () => promptState.texts.shift() ?? "",
      spinner: () => ({ start: () => {}, stop: () => {} }),
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
      intro: () => {},
      outro: () => {},
      note: () => {},
    }));
    mock.module("../../src/core/config/config", () => ({
      DEFAULT_CONFIG: {
        semanticSearchMode: "auto",
        registries: [
          { url: DEFAULT_REGISTRY_URLS[0], name: "akm-registry" },
          { url: DEFAULT_REGISTRY_URLS[1], name: "skills.sh", provider: "skills-sh", enabled: false },
        ],
        output: { format: "json", detail: "brief" },
      },
      getConfigPath: () => DEFAULT_CONFIG_PATH,
      getSources: getSourcesMock,
      loadUserConfig: loadUserConfigMock,
      loadConfig: () => setupState.currentConfig,
      saveConfig: (config: Record<string, unknown>) => {
        setupState.savedConfigs.push(config);
      },
    }));
    mock.module("../../src/core/paths", () => ({
      getDefaultStashDir: () => DEFAULT_STASH_DIR,
      getConfigPath: () => DEFAULT_CONFIG_PATH,
      getConfigDir: () => path.dirname(DEFAULT_CONFIG_PATH),
      getCacheDir: () => DEFAULT_CACHE_DIR,
      getSemanticStatusPath: () => path.join(DEFAULT_CACHE_DIR, "semantic-status.json"),
    }));
    overrideSeam(_setDetectForTests, {
      detectOllama: async () => ({
        available: true,
        endpoint: "http://localhost:11434",
        models: ["nomic-embed-text", "llama3.2"],
      }),
      detectAgentPlatforms: () => [],
    });
    overrideSeam(_setEmbedderForTests, {
      isTransformersAvailable: () => true,
      checkEmbeddingAvailability: async () => ({
        available: false,
        reason: "remote-unreachable",
        message: "connection refused",
      }),
    });
    overrideSeam(_setAkmInitForTests, async (options?: { dir?: string }) => {
      const dir = options?.dir ?? DEFAULT_STASH_DIR;
      setupState.initCalls.push({ dir });
      return { stashDir: dir, created: true, configPath: DEFAULT_CONFIG_PATH, defaultStashUpdated: true };
    });
    installIndexerSeam();
    mock.module("../../src/indexer/db/db", () => ({
      openDatabase: () => ({}),
      closeDatabase: () => {},
      isVecAvailable: () => false,
    }));
    installAgentIntegrationMock();

    promptState.selects.push("default", "nomic-embed-text", "llama3.2", "done", "json", "brief");
    promptState.confirms.push(true, true, true);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], []);
    promptState.texts.push("384");

    const { runSetupWizard } = await loadSetupModule();
    await runSetupWizard();

    expect(promptState.logs.some((entry) => entry.includes("remote embedding endpoint is not reachable"))).toBe(true);
    expect(setupState.savedConfigs.at(-1)?.semanticSearchMode).toBe("auto");
  });

  test("warns specifically when transformers package is missing during setup prep", async () => {
    mock.module("@clack/prompts", () => ({
      isCancel: () => false,
      cancel: () => {},
      confirm: async () => promptState.confirms.shift() ?? false,
      select: async () => promptState.selects.shift() ?? "done",
      multiselect: async () => promptState.multiselects.shift() ?? [],
      text: async () => promptState.texts.shift() ?? "",
      spinner: () => ({ start: () => {}, stop: () => {} }),
      log: {
        step: () => {},
        info: (message: string) => {
          promptState.logs.push(`[info] ${message}`);
        },
        warn: (message: string) => {
          promptState.logs.push(`[warn] ${message}`);
        },
        success: () => {},
      },
      intro: () => {},
      outro: () => {},
      note: () => {},
    }));
    mock.module("../../src/core/config/config", () => ({
      DEFAULT_CONFIG: {
        semanticSearchMode: "auto",
        registries: [
          { url: DEFAULT_REGISTRY_URLS[0], name: "akm-registry" },
          { url: DEFAULT_REGISTRY_URLS[1], name: "skills.sh", provider: "skills-sh", enabled: false },
        ],
        output: { format: "json", detail: "brief" },
      },
      getConfigPath: () => DEFAULT_CONFIG_PATH,
      getSources: getSourcesMock,
      loadUserConfig: loadUserConfigMock,
      loadConfig: () => setupState.currentConfig,
      saveConfig: (config: Record<string, unknown>) => {
        setupState.savedConfigs.push(config);
      },
    }));
    mock.module("../../src/core/paths", () => ({
      getDefaultStashDir: () => DEFAULT_STASH_DIR,
      getConfigPath: () => DEFAULT_CONFIG_PATH,
      getConfigDir: () => path.dirname(DEFAULT_CONFIG_PATH),
      getCacheDir: () => DEFAULT_CACHE_DIR,
      getSemanticStatusPath: () => path.join(DEFAULT_CACHE_DIR, "semantic-status.json"),
    }));
    overrideSeam(_setDetectForTests, {
      detectOllama: async () => ({ available: false, endpoint: "http://localhost:11434", models: [] }),
      detectAgentPlatforms: () => [],
    });
    overrideSeam(_setEmbedderForTests, {
      // Return true so the wizard skips the `bun add` auto-install attempt
      // (the install path is environment-dependent and makes the test flaky).
      // The faked checkEmbeddingAvailability still reports missing-package,
      // which exercises the "warn and report" code path we want to test.
      isTransformersAvailable: () => true,
      checkEmbeddingAvailability: async () => ({
        available: false,
        reason: "missing-package",
        message: "@huggingface/transformers is not installed.",
      }),
    });
    overrideSeam(_setAkmInitForTests, async (options?: { dir?: string }) => {
      const dir = options?.dir ?? DEFAULT_STASH_DIR;
      setupState.initCalls.push({ dir });
      return { stashDir: dir, created: true, configPath: DEFAULT_CONFIG_PATH, defaultStashUpdated: true };
    });
    installIndexerSeam();
    mock.module("../../src/indexer/db/db", () => ({
      openDatabase: () => ({}),
      closeDatabase: () => {},
      isVecAvailable: () => false,
    }));
    installAgentIntegrationMock();

    promptState.selects.push("default", "done", "json", "brief");
    promptState.confirms.push(true, true, true);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], []);

    const { runSetupWizard } = await loadSetupModule();
    await runSetupWizard();

    expect(promptState.logs.some((entry) => entry.includes("Install it with: bun add @huggingface/transformers"))).toBe(
      true,
    );
    expect(setupState.savedConfigs.at(-1)?.semanticSearchMode).toBe("auto");
  });

  test("keeps semantic search enabled and warns when sqlite-vec/db check fails", async () => {
    mock.module("@clack/prompts", () => ({
      isCancel: () => false,
      cancel: () => {},
      confirm: async () => promptState.confirms.shift() ?? false,
      select: async () => promptState.selects.shift() ?? "done",
      multiselect: async () => promptState.multiselects.shift() ?? [],
      text: async () => promptState.texts.shift() ?? "",
      spinner: () => ({ start: () => {}, stop: () => {} }),
      log: {
        step: () => {},
        info: (message: string) => {
          promptState.logs.push(`[info] ${message}`);
        },
        warn: (message: string) => {
          promptState.logs.push(`[warn] ${message}`);
        },
        success: () => {},
      },
      intro: () => {},
      outro: () => {},
      note: () => {},
    }));
    mock.module("../../src/core/config/config", () => ({
      DEFAULT_CONFIG: {
        semanticSearchMode: "auto",
        registries: [
          { url: DEFAULT_REGISTRY_URLS[0], name: "akm-registry" },
          { url: DEFAULT_REGISTRY_URLS[1], name: "skills.sh", provider: "skills-sh", enabled: false },
        ],
        output: { format: "json", detail: "brief" },
      },
      getConfigPath: () => DEFAULT_CONFIG_PATH,
      getSources: getSourcesMock,
      loadUserConfig: loadUserConfigMock,
      loadConfig: () => setupState.currentConfig,
      saveConfig: (config: Record<string, unknown>) => {
        setupState.savedConfigs.push(config);
      },
    }));
    mock.module("../../src/core/paths", () => ({
      getDefaultStashDir: () => DEFAULT_STASH_DIR,
      getConfigPath: () => DEFAULT_CONFIG_PATH,
      getConfigDir: () => path.dirname(DEFAULT_CONFIG_PATH),
      getCacheDir: () => DEFAULT_CACHE_DIR,
      getSemanticStatusPath: () => path.join(DEFAULT_CACHE_DIR, "semantic-status.json"),
    }));
    overrideSeam(_setDetectForTests, {
      detectOllama: async () => ({ available: false, endpoint: "http://localhost:11434", models: [] }),
      detectAgentPlatforms: () => [],
    });
    overrideSeam(_setEmbedderForTests, {
      isTransformersAvailable: () => true,
      checkEmbeddingAvailability: async () => ({ available: true }),
    });
    overrideSeam(_setAkmInitForTests, async (options?: { dir?: string }) => {
      const dir = options?.dir ?? DEFAULT_STASH_DIR;
      setupState.initCalls.push({ dir });
      return { stashDir: dir, created: true, configPath: DEFAULT_CONFIG_PATH, defaultStashUpdated: true };
    });
    installIndexerSeam();
    mock.module("../../src/indexer/db/db", () => ({
      openDatabase: () => {
        throw new Error("db locked");
      },
      closeDatabase: () => {},
      isVecAvailable: () => false,
    }));
    installAgentIntegrationMock();

    promptState.selects.push("default", "done", "json", "brief");
    promptState.confirms.push(true, true, true);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], []);

    const { runSetupWizard } = await loadSetupModule();
    await runSetupWizard();

    expect(setupState.savedConfigs).toHaveLength(1);
    expect(setupState.savedConfigs[0]?.semanticSearchMode).toBe("auto");
    expect(promptState.logs.some((entry) => entry.includes("Semantic search will use the JS fallback"))).toBe(true);
  });

  test("keeps semantic search enabled when asset preparation is skipped", async () => {
    mock.module("@clack/prompts", () => ({
      isCancel: () => false,
      cancel: () => {},
      confirm: async () => promptState.confirms.shift() ?? false,
      select: async () => promptState.selects.shift() ?? "done",
      multiselect: async () => promptState.multiselects.shift() ?? [],
      text: async () => promptState.texts.shift() ?? "",
      spinner: () => ({ start: () => {}, stop: () => {} }),
      log: {
        step: () => {},
        info: (message: string) => {
          promptState.logs.push(`[info] ${message}`);
        },
        warn: () => {},
        success: () => {},
      },
      intro: () => {},
      outro: () => {},
      note: () => {},
    }));
    mock.module("../../src/core/config/config", () => ({
      DEFAULT_CONFIG: {
        semanticSearchMode: "auto",
        registries: [
          { url: DEFAULT_REGISTRY_URLS[0], name: "akm-registry" },
          { url: DEFAULT_REGISTRY_URLS[1], name: "skills.sh", provider: "skills-sh", enabled: false },
        ],
        output: { format: "json", detail: "brief" },
      },
      getConfigPath: () => DEFAULT_CONFIG_PATH,
      getSources: getSourcesMock,
      loadUserConfig: loadUserConfigMock,
      loadConfig: () => setupState.currentConfig,
      saveConfig: (config: Record<string, unknown>) => {
        setupState.savedConfigs.push(config);
      },
    }));
    mock.module("../../src/core/paths", () => ({
      getDefaultStashDir: () => DEFAULT_STASH_DIR,
      getConfigPath: () => DEFAULT_CONFIG_PATH,
      getConfigDir: () => path.dirname(DEFAULT_CONFIG_PATH),
      getCacheDir: () => DEFAULT_CACHE_DIR,
      getSemanticStatusPath: () => path.join(DEFAULT_CACHE_DIR, "semantic-status.json"),
    }));
    overrideSeam(_setDetectForTests, {
      detectOllama: async () => ({ available: false, endpoint: "http://localhost:11434", models: [] }),
      detectAgentPlatforms: () => [],
    });
    overrideSeam(_setEmbedderForTests, {
      isTransformersAvailable: () => true,
      checkEmbeddingAvailability: async () => ({ available: true }),
    });
    overrideSeam(_setAkmInitForTests, async (options?: { dir?: string }) => {
      const dir = options?.dir ?? DEFAULT_STASH_DIR;
      setupState.initCalls.push({ dir });
      return { stashDir: dir, created: true, configPath: DEFAULT_CONFIG_PATH, defaultStashUpdated: true };
    });
    installIndexerSeam();
    mock.module("../../src/indexer/db/db", () => ({
      openDatabase: () => ({}),
      closeDatabase: () => {},
      isVecAvailable: () => false,
    }));
    installAgentIntegrationMock();

    promptState.selects.push("default", "done", "json", "brief");
    promptState.confirms.push(true, false, true);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], []);

    const { runSetupWizard } = await loadSetupModule();
    await runSetupWizard();

    expect(setupState.savedConfigs).toHaveLength(1);
    expect(setupState.savedConfigs[0]?.semanticSearchMode).toBe("auto");
    expect(promptState.logs.some((entry) => entry.includes("asset preparation was skipped"))).toBe(true);
  });

  test("surfaces config save failure after bootstrap init", async () => {
    mock.module("@clack/prompts", () => ({
      isCancel: () => false,
      cancel: () => {},
      confirm: async () => promptState.confirms.shift() ?? false,
      select: async () => promptState.selects.shift() ?? "done",
      multiselect: async () => promptState.multiselects.shift() ?? [],
      text: async () => promptState.texts.shift() ?? "",
      spinner: () => ({ start: () => {}, stop: () => {} }),
      log: { step: () => {}, info: () => {}, warn: () => {}, success: () => {} },
      intro: () => {},
      outro: () => {},
      note: () => {},
    }));
    let saveCalls = 0;
    mock.module("../../src/core/config/config", () => ({
      DEFAULT_CONFIG: {
        semanticSearchMode: "auto",
        registries: [
          { url: DEFAULT_REGISTRY_URLS[0], name: "akm-registry" },
          { url: DEFAULT_REGISTRY_URLS[1], name: "skills.sh", provider: "skills-sh", enabled: false },
        ],
        output: { format: "json", detail: "brief" },
      },
      getConfigPath: () => DEFAULT_CONFIG_PATH,
      getSources: getSourcesMock,
      loadUserConfig: loadUserConfigMock,
      loadConfig: () => setupState.currentConfig,
      saveConfig: () => {
        saveCalls += 1;
        throw new Error("EACCES config.json");
      },
    }));
    mock.module("../../src/core/paths", () => ({
      getDefaultStashDir: () => DEFAULT_STASH_DIR,
      getConfigPath: () => DEFAULT_CONFIG_PATH,
      getConfigDir: () => path.dirname(DEFAULT_CONFIG_PATH),
      getCacheDir: () => DEFAULT_CACHE_DIR,
      getSemanticStatusPath: () => path.join(DEFAULT_CACHE_DIR, "semantic-status.json"),
    }));
    overrideSeam(_setDetectForTests, {
      detectOllama: async () => ({ available: false, endpoint: "http://localhost:11434", models: [] }),
      detectAgentPlatforms: () => [],
    });
    overrideSeam(_setEmbedderForTests, {
      isTransformersAvailable: () => true,
      checkEmbeddingAvailability: async () => ({ available: true }),
    });
    overrideSeam(_setAkmInitForTests, async (options?: { dir?: string }) => {
      const dir = options?.dir ?? DEFAULT_STASH_DIR;
      setupState.initCalls.push({ dir });
      return { stashDir: dir, created: true, configPath: DEFAULT_CONFIG_PATH, defaultStashUpdated: true };
    });
    installIndexerNeverRunsSeam();
    mock.module("../../src/indexer/db/db", () => ({
      openDatabase: () => ({}),
      closeDatabase: () => {},
      isVecAvailable: () => false,
    }));
    installAgentIntegrationMock();

    promptState.selects.push("default", "done", "json", "brief");
    promptState.confirms.push(false, true);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], []);

    const { runSetupWizard } = await loadSetupModule();
    await expect(runSetupWizard()).rejects.toThrow("EACCES config.json");
    expect(saveCalls).toBe(1);
    expect(setupState.initCalls).toEqual([{ dir: DEFAULT_STASH_DIR }]);
    expect(setupState.indexCalls).toHaveLength(0);
  });

  test("surfaces bootstrap init failure before saving config", async () => {
    mock.module("@clack/prompts", () => ({
      isCancel: () => false,
      cancel: () => {},
      confirm: async () => promptState.confirms.shift() ?? false,
      select: async () => promptState.selects.shift() ?? "done",
      multiselect: async () => promptState.multiselects.shift() ?? [],
      text: async () => promptState.texts.shift() ?? "",
      spinner: () => ({ start: () => {}, stop: () => {} }),
      log: { step: () => {}, info: () => {}, warn: () => {}, success: () => {} },
      intro: () => {},
      outro: () => {},
      note: () => {},
    }));
    mock.module("../../src/core/config/config", () => ({
      DEFAULT_CONFIG: {
        semanticSearchMode: "auto",
        registries: [
          { url: DEFAULT_REGISTRY_URLS[0], name: "akm-registry" },
          { url: DEFAULT_REGISTRY_URLS[1], name: "skills.sh", provider: "skills-sh", enabled: false },
        ],
        output: { format: "json", detail: "brief" },
      },
      getConfigPath: () => DEFAULT_CONFIG_PATH,
      getSources: getSourcesMock,
      loadUserConfig: loadUserConfigMock,
      loadConfig: () => setupState.currentConfig,
      saveConfig: (config: Record<string, unknown>) => {
        setupState.savedConfigs.push(config);
      },
    }));
    mock.module("../../src/core/paths", () => ({
      getDefaultStashDir: () => DEFAULT_STASH_DIR,
      getConfigPath: () => DEFAULT_CONFIG_PATH,
      getConfigDir: () => path.dirname(DEFAULT_CONFIG_PATH),
      getCacheDir: () => DEFAULT_CACHE_DIR,
      getSemanticStatusPath: () => path.join(DEFAULT_CACHE_DIR, "semantic-status.json"),
    }));
    overrideSeam(_setDetectForTests, {
      detectOllama: async () => ({ available: false, endpoint: "http://localhost:11434", models: [] }),
      detectAgentPlatforms: () => [],
    });
    overrideSeam(_setEmbedderForTests, {
      isTransformersAvailable: () => true,
      checkEmbeddingAvailability: async () => ({ available: true }),
    });
    overrideSeam(_setAkmInitForTests, async () => {
      throw new Error("EACCES stash init");
    });
    installIndexerNeverRunsSeam();
    mock.module("../../src/indexer/db/db", () => ({
      openDatabase: () => ({}),
      closeDatabase: () => {},
      isVecAvailable: () => false,
    }));
    installAgentIntegrationMock();

    promptState.selects.push("default", "done", "json", "brief");
    promptState.confirms.push(false, true);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], []);

    const { runSetupWizard } = await loadSetupModule();
    await expect(runSetupWizard()).rejects.toThrow("EACCES stash init");
    expect(setupState.savedConfigs).toHaveLength(0);
    expect(setupState.indexCalls).toHaveLength(0);
  });
});
