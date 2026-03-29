import { beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";

const DEFAULT_STASH_DIR = "/tmp/akm-default-stash";
const DEFAULT_CONFIG_PATH = "/tmp/akm-config/config.json";
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

const setupState = {
  currentConfig: {
    semanticSearch: true,
    output: { format: "json", detail: "brief" },
  } as Record<string, unknown>,
  savedConfigs: [] as Array<Record<string, unknown>>,
  initCalls: [] as Array<{ dir: string }>,
  indexCalls: [] as Array<{ stashDir: string }>,
  detectOllamaResult: { available: false, endpoint: "http://localhost:11434", models: [] as string[] },
  detectAgentPlatformsResult: [] as Array<{ name: string; path: string }>,
  checkEmbeddingResult: { available: true } as
    | { available: true }
    | { available: false; reason: "missing-package" | "model-download-failed" | "remote-unreachable"; message: string },
  transformersAvailable: true,
  indexResult: {
    totalEntries: 3,
    verification: { ok: true, message: "semantic search verified" },
  } as Record<string, unknown>,
  indexError: undefined as Error | undefined,
  vecAvailable: false,
};

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
    semanticSearch: true,
    output: { format: "json", detail: "brief" },
  };
  setupState.savedConfigs.length = 0;
  setupState.initCalls.length = 0;
  setupState.indexCalls.length = 0;
  setupState.detectOllamaResult = { available: false, endpoint: "http://localhost:11434", models: [] };
  setupState.detectAgentPlatformsResult = [];
  setupState.checkEmbeddingResult = { available: true };
  setupState.transformersAvailable = true;
  setupState.indexResult = {
    totalEntries: 3,
    verification: { ok: true, message: "semantic search verified" },
  };
  setupState.indexError = undefined;
  setupState.vecAvailable = false;
}

beforeEach(() => {
  resetPromptState();
  resetSetupState();
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
    mock.module("../src/config", () => ({
      DEFAULT_CONFIG: {
        semanticSearch: true,
        registries: [
          { url: DEFAULT_REGISTRY_URLS[0], name: "official" },
          { url: DEFAULT_REGISTRY_URLS[1], name: "skills.sh", provider: "skills-sh" },
        ],
        output: { format: "json", detail: "brief" },
      },
      getConfigPath: () => DEFAULT_CONFIG_PATH,
      loadConfig: () => setupState.currentConfig,
      saveConfig: (config: Record<string, unknown>) => {
        setupState.savedConfigs.push(config);
      },
    }));
    mock.module("../src/paths", () => ({
      getDefaultStashDir: () => DEFAULT_STASH_DIR,
      getConfigPath: () => DEFAULT_CONFIG_PATH,
      getConfigDir: () => path.dirname(DEFAULT_CONFIG_PATH),
    }));
    mock.module("../src/detect", () => ({
      detectOllama: async () => setupState.detectOllamaResult,
      detectAgentPlatforms: () => setupState.detectAgentPlatformsResult,
      detectOpenViking: async (url: string) => ({ available: true, url }),
    }));
    mock.module("../src/embedder", () => ({
      DEFAULT_LOCAL_MODEL: "Xenova/bge-small-en-v1.5",
      isTransformersAvailable: async () => setupState.transformersAvailable,
      checkEmbeddingAvailability: async () => setupState.checkEmbeddingResult,
    }));
    mock.module("../src/init", () => ({
      akmInit: async (options?: { dir?: string }) => {
        const dir = options?.dir ?? DEFAULT_STASH_DIR;
        setupState.initCalls.push({ dir });
        return { stashDir: dir, created: true, configPath: DEFAULT_CONFIG_PATH };
      },
    }));
    mock.module("../src/indexer", () => ({
      akmIndex: async ({ stashDir }: { stashDir: string }) => {
        setupState.indexCalls.push({ stashDir });
        if (setupState.indexError) {
          throw setupState.indexError;
        }
        return setupState.indexResult;
      },
    }));
    mock.module("../src/db", () => ({
      openDatabase: () => ({}),
      closeDatabase: () => {},
      isVecAvailable: () => setupState.vecAvailable,
    }));

    promptState.selects.push("default", "done");
    promptState.confirms.push(false, true);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], []);

    const { runSetupWizard } = await import("../src/setup");
    await runSetupWizard();

    expect(setupState.savedConfigs).toHaveLength(1);
    expect(setupState.savedConfigs[0]?.stashDir).toBe(DEFAULT_STASH_DIR);
    expect(setupState.savedConfigs[0]?.semanticSearch).toBe(false);
    expect(setupState.initCalls).toEqual([{ dir: DEFAULT_STASH_DIR }]);
    expect(setupState.indexCalls).toEqual([{ stashDir: DEFAULT_STASH_DIR }]);
    expect(promptState.outros[0]).toContain(DEFAULT_CONFIG_PATH);
  });

  test("disables semantic search in saved config when asset preparation fails", async () => {
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
    mock.module("../src/config", () => ({
      DEFAULT_CONFIG: {
        semanticSearch: true,
        registries: [
          { url: DEFAULT_REGISTRY_URLS[0], name: "official" },
          { url: DEFAULT_REGISTRY_URLS[1], name: "skills.sh", provider: "skills-sh" },
        ],
        output: { format: "json", detail: "brief" },
      },
      getConfigPath: () => DEFAULT_CONFIG_PATH,
      loadConfig: () => setupState.currentConfig,
      saveConfig: (config: Record<string, unknown>) => {
        setupState.savedConfigs.push(config);
      },
    }));
    mock.module("../src/paths", () => ({
      getDefaultStashDir: () => DEFAULT_STASH_DIR,
      getConfigPath: () => DEFAULT_CONFIG_PATH,
      getConfigDir: () => path.dirname(DEFAULT_CONFIG_PATH),
    }));
    mock.module("../src/detect", () => ({
      detectOllama: async () => setupState.detectOllamaResult,
      detectAgentPlatforms: () => setupState.detectAgentPlatformsResult,
      detectOpenViking: async (url: string) => ({ available: true, url }),
    }));
    mock.module("../src/embedder", () => ({
      DEFAULT_LOCAL_MODEL: "Xenova/bge-small-en-v1.5",
      isTransformersAvailable: async () => setupState.transformersAvailable,
      checkEmbeddingAvailability: async () => setupState.checkEmbeddingResult,
    }));
    mock.module("../src/init", () => ({
      akmInit: async (options?: { dir?: string }) => {
        const dir = options?.dir ?? DEFAULT_STASH_DIR;
        setupState.initCalls.push({ dir });
        return { stashDir: dir, created: true, configPath: DEFAULT_CONFIG_PATH };
      },
    }));
    mock.module("../src/indexer", () => ({
      akmIndex: async ({ stashDir }: { stashDir: string }) => {
        setupState.indexCalls.push({ stashDir });
        if (setupState.indexError) {
          throw setupState.indexError;
        }
        return setupState.indexResult;
      },
    }));
    mock.module("../src/db", () => ({
      openDatabase: () => ({}),
      closeDatabase: () => {},
      isVecAvailable: () => setupState.vecAvailable,
    }));

    promptState.selects.push("default", "done");
    promptState.confirms.push(true, true, true);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], []);
    setupState.checkEmbeddingResult = {
      available: false,
      reason: "model-download-failed",
      message: "download blocked",
    };

    const { runSetupWizard } = await import("../src/setup");
    await runSetupWizard();

    expect(setupState.savedConfigs).toHaveLength(2);
    expect(setupState.savedConfigs[0]?.semanticSearch).toBe(false);
    expect(setupState.savedConfigs[1]?.semanticSearch).toBe(false);
    expect(promptState.logs.some((entry) => entry.includes("Semantic search has been disabled"))).toBe(true);
    expect(setupState.indexCalls).toEqual([{ stashDir: DEFAULT_STASH_DIR }]);
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
    mock.module("../src/config", () => ({
      DEFAULT_CONFIG: {
        semanticSearch: true,
        registries: [
          { url: DEFAULT_REGISTRY_URLS[0], name: "official" },
          { url: DEFAULT_REGISTRY_URLS[1], name: "skills.sh", provider: "skills-sh" },
        ],
        output: { format: "json", detail: "brief" },
      },
      getConfigPath: () => DEFAULT_CONFIG_PATH,
      loadConfig: () => setupState.currentConfig,
      saveConfig: (config: Record<string, unknown>) => {
        setupState.savedConfigs.push(config);
      },
    }));
    mock.module("../src/paths", () => ({
      getDefaultStashDir: () => DEFAULT_STASH_DIR,
      getConfigPath: () => DEFAULT_CONFIG_PATH,
      getConfigDir: () => path.dirname(DEFAULT_CONFIG_PATH),
    }));
    mock.module("../src/detect", () => ({
      detectOllama: async () => setupState.detectOllamaResult,
      detectAgentPlatforms: () => setupState.detectAgentPlatformsResult,
      detectOpenViking: async (url: string) => ({ available: true, url }),
    }));
    mock.module("../src/embedder", () => ({
      DEFAULT_LOCAL_MODEL: "Xenova/bge-small-en-v1.5",
      isTransformersAvailable: async () => setupState.transformersAvailable,
      checkEmbeddingAvailability: async () => setupState.checkEmbeddingResult,
    }));
    mock.module("../src/init", () => ({
      akmInit: async (options?: { dir?: string }) => {
        const dir = options?.dir ?? DEFAULT_STASH_DIR;
        setupState.initCalls.push({ dir });
        return { stashDir: dir, created: true, configPath: DEFAULT_CONFIG_PATH };
      },
    }));
    mock.module("../src/indexer", () => ({
      akmIndex: async ({ stashDir }: { stashDir: string }) => {
        setupState.indexCalls.push({ stashDir });
        if (setupState.indexError) {
          throw setupState.indexError;
        }
        return setupState.indexResult;
      },
    }));
    mock.module("../src/db", () => ({
      openDatabase: () => ({}),
      closeDatabase: () => {},
      isVecAvailable: () => setupState.vecAvailable,
    }));

    promptState.selects.push("default", "done");
    promptState.confirms.push(false, true);
    promptState.multiselects.push([...DEFAULT_REGISTRY_URLS], []);
    setupState.indexError = new Error("index exploded");

    const { runSetupWizard } = await import("../src/setup");
    await runSetupWizard();

    expect(setupState.savedConfigs).toHaveLength(1);
    expect(setupState.initCalls).toEqual([{ dir: DEFAULT_STASH_DIR }]);
    expect(setupState.indexCalls).toEqual([{ stashDir: DEFAULT_STASH_DIR }]);
    expect(promptState.logs.some((entry) => entry.includes("index exploded"))).toBe(true);
    expect(promptState.outros).toHaveLength(1);
  });
});
