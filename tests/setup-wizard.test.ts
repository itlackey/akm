/**
 * Tests for setup wizard interactive logic:
 * - onCancel: Escape on confirmation should stay, not exit
 * - stepAddSources: recommended GitHub repos multiselect, cancel returns to menu
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mock plumbing ────────────────────────────────────────────────────────────

/** Sentinel returned by mocked prompts when simulating Escape / Ctrl-C. */
const CANCEL = Symbol("clack:cancel");

/** Per-test response queues — shift one value per prompt call. */
const q = {
  confirms: [] as unknown[],
  selects: [] as unknown[],
  texts: [] as unknown[],
  multiselects: [] as unknown[],
  multiselectConfigs: [] as Array<{
    message: string;
    initialValues?: string[];
    options: Array<{ value: string; label: string }>;
  }>,
  logged: [] as string[],
};

function reset() {
  q.confirms.length = 0;
  q.selects.length = 0;
  q.texts.length = 0;
  q.multiselects.length = 0;
  q.multiselectConfigs.length = 0;
  q.logged.length = 0;
}

// Must be called **before** any module that imports @clack/prompts is loaded.
mock.module("@clack/prompts", () => ({
  isCancel: (v: unknown) => v === CANCEL,
  cancel: (msg: string) => {
    q.logged.push(`[cancel] ${msg}`);
  },
  confirm: async () => q.confirms.shift() ?? false,
  select: async () => q.selects.shift() ?? "done",
  text: async () => q.texts.shift() ?? "",
  multiselect: async (config: {
    message: string;
    initialValues?: string[];
    options: Array<{ value: string; label: string }>;
  }) => {
    q.multiselectConfigs.push({
      message: config.message,
      initialValues: config.initialValues,
      options: config.options,
    });
    return q.multiselects.shift() ?? [];
  },
  spinner: () => ({ start: () => {}, stop: () => {} }),
  log: {
    info: (msg: string) => {
      q.logged.push(msg);
    },
    success: (msg: string) => {
      q.logged.push(msg);
    },
    warn: (msg: string) => {
      q.logged.push(msg);
    },
    step: () => {},
  },
  intro: () => {},
  outro: () => {},
  note: (msg: string, title?: string) => {
    q.logged.push(`[note] ${title ?? ""} ${msg}`.trim());
  },
}));

// ── onCancel tests ───────────────────────────────────────────────────────────

describe("onCancel – escape handling", () => {
  beforeEach(reset);

  test("pressing Escape on the exit-confirmation stays in the wizard", async () => {
    const { onCancel } = await import("../src/setup/setup");
    // Simulate: user already pressed Escape in a prompt (value = CANCEL),
    // then presses Escape again on the "Exit the wizard?" confirmation.
    q.confirms.push(CANCEL);

    const stayed = await onCancel(CANCEL);
    expect(stayed).toBe(true);
  });

  test("choosing No on the exit-confirmation stays in the wizard", async () => {
    const { onCancel } = await import("../src/setup/setup");
    q.confirms.push(false);

    const stayed = await onCancel(CANCEL);
    expect(stayed).toBe(true);
  });

  test("choosing Yes on the exit-confirmation calls bail (exits)", async () => {
    const { onCancel } = await import("../src/setup/setup");
    q.confirms.push(true);

    // bail() calls process.exit — mock it so it throws instead of killing the runner
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never;

    try {
      await expect(onCancel(CANCEL)).rejects.toThrow("EXIT:0");
    } finally {
      process.exit = originalExit;
    }
  });

  test("non-cancel input is a no-op (returns false)", async () => {
    const { onCancel } = await import("../src/setup/setup");
    const stayed = await onCancel("normal-value");
    expect(stayed).toBe(false);
  });
});

// ── stepAddSources tests ───────────────────────────────────────────────────

describe("stepAddSources – recommended GitHub repos", () => {
  beforeEach(reset);

  test("shows recommended repos and preselects the official stash for new configs", async () => {
    const { stepAddSources } = await import("../src/setup/setup");

    q.multiselects.push(["https://github.com/itlackey/akm-stash"]);
    q.selects.push("done");

    const result = await stepAddSources({ sources: [] } as never);
    expect(q.multiselectConfigs).toHaveLength(1);
    expect(q.logged.some((entry) => entry.includes("Configured stash sources"))).toBe(false);
    expect(q.multiselectConfigs[0]?.options.map((option) => option.label)).toEqual([
      "itlackey/akm-stash",
      "andrewyng/context-hub",
    ]);
    expect(q.multiselectConfigs[0]?.initialValues).toEqual(["https://github.com/itlackey/akm-stash"]);
    expect(result).toEqual([
      {
        type: "git",
        url: "https://github.com/itlackey/akm-stash",
        name: "itlackey/akm-stash",
      },
    ]);
  });

  test("allows an existing recommended source to be unchecked and removed", async () => {
    const { stepAddSources } = await import("../src/setup/setup");
    const cfg = {
      sources: [{ type: "git", url: "https://github.com/itlackey/akm-stash", name: "itlackey/akm-stash" }],
    };

    q.multiselects.push([], []);
    q.selects.push("done");

    const result = await stepAddSources(cfg as never);
    expect(q.multiselectConfigs[0]?.initialValues).toEqual(["git:https://github.com/itlackey/akm-stash"]);
    expect(result).toEqual([]);
  });

  test("preserves an existing git stash that points at the legacy context-hub URL", async () => {
    const { stepAddSources } = await import("../src/setup/setup");
    const ctxHubUrl = "https://github.com/andrewyng/context-hub";
    const cfg = {
      sources: [{ type: "git", url: ctxHubUrl, name: "context-hub" }],
    };

    q.multiselects.push([`git:${ctxHubUrl}`], [ctxHubUrl]);
    q.selects.push("done");

    const result = await stepAddSources(cfg as never);
    expect(q.multiselectConfigs[0]?.initialValues).toEqual([`git:${ctxHubUrl}`]);
    const hub = result.find((s) => s.url === ctxHubUrl);
    expect(hub).toBeDefined();
    expect(hub?.type).toBe("git");
  });

  test("shows existing configured sources as a toggle list before recommendations", async () => {
    const { stepAddSources } = await import("../src/setup/setup");
    const cfg = {
      sources: [
        { type: "git", url: "https://github.com/itlackey/akm-stash", name: "itlackey/akm-stash" },
        { type: "filesystem", path: "/tmp/custom-stash", name: "custom-stash" },
      ],
    };

    q.multiselects.push(
      ["git:https://github.com/itlackey/akm-stash", "filesystem:/tmp/custom-stash"],
      ["https://github.com/itlackey/akm-stash"],
    );
    q.selects.push("done");

    const result = await stepAddSources(cfg as never);
    expect(q.multiselectConfigs).toHaveLength(2);
    expect(q.logged.some((entry) => entry.includes("Configured stash sources"))).toBe(true);
    expect(q.multiselectConfigs[0]?.message).toContain("Configured stash sources");
    expect(q.multiselectConfigs[0]?.options.map((option) => option.label)).toEqual([
      "itlackey/akm-stash",
      "custom-stash",
    ]);
    expect(q.multiselectConfigs[0]?.initialValues).toEqual([
      "git:https://github.com/itlackey/akm-stash",
      "filesystem:/tmp/custom-stash",
    ]);
    expect(result).toEqual([
      { type: "git", url: "https://github.com/itlackey/akm-stash", name: "itlackey/akm-stash" },
      { type: "filesystem", path: "/tmp/custom-stash", name: "custom-stash" },
    ]);
  });

  test("shows installed managed stashes as preserved informational list", async () => {
    const { stepAddSources } = await import("../src/setup/setup");

    q.multiselects.push(["https://github.com/itlackey/akm-stash"]);
    q.selects.push("done");

    await stepAddSources(
      {
        sources: [],
        installed: [{ id: "github:demo/skills", source: "github", stashRoot: "/tmp/demo" }] as never,
      } as never,
    );

    expect(q.logged.some((entry) => entry.includes("Installed managed stashes"))).toBe(true);
    expect(q.logged.some((entry) => entry.includes("github:demo/skills (github)"))).toBe(true);
  });

  test("allows existing configured sources to be unchecked and removed", async () => {
    const { stepAddSources } = await import("../src/setup/setup");
    const cfg = {
      sources: [
        { type: "git", url: "https://github.com/itlackey/akm-stash", name: "itlackey/akm-stash" },
        { type: "filesystem", path: "/tmp/custom-stash", name: "custom-stash" },
      ],
    };

    q.multiselects.push(["git:https://github.com/itlackey/akm-stash"], ["https://github.com/itlackey/akm-stash"]);
    q.selects.push("done");

    const result = await stepAddSources(cfg as never);
    expect(result).toEqual([
      { type: "git", url: "https://github.com/itlackey/akm-stash", name: "itlackey/akm-stash" },
    ]);
  });
});

describe("agent and output setup steps", () => {
  beforeEach(reset);

  test("stepAgentSelection lets the user choose a detected default agent", async () => {
    const { stepAgentSelection } = await import("../src/setup/setup");
    q.selects.push("codex");

    const result = await stepAgentSelection(
      { semanticSearchMode: "auto", agent: { default: "claude" } } as never,
      [
        { name: "claude", bin: "claude", available: true, resolvedPath: "/usr/bin/claude" },
        { name: "codex", bin: "codex", available: true, resolvedPath: "/usr/bin/codex" },
      ],
    );

    expect(result).toEqual({ default: "codex" });
  });

  test("stepAgentSelection allows disabling the default agent", async () => {
    const { stepAgentSelection } = await import("../src/setup/setup");
    q.selects.push("disabled");

    const result = await stepAgentSelection(
      { semanticSearchMode: "auto", agent: { default: "claude" } } as never,
      [
        { name: "claude", bin: "claude", available: true, resolvedPath: "/usr/bin/claude" },
        { name: "opencode", bin: "opencode", available: true, resolvedPath: "/usr/bin/opencode" },
      ],
    );

    expect(result).toBeUndefined();
  });

  test("stepLlm keep current preserves the existing endpoint", async () => {
    const { stepLlm } = await import("../src/setup/setup");
    q.selects.push("keep");

    const current = {
      semanticSearchMode: "auto",
      llm: {
        provider: "lmstudio",
        endpoint: "http://localhost:7200/v1/chat/completions",
        model: "qwen/qwen3.5-9b",
        capabilities: { structuredOutput: true },
      },
    };

    const result = await stepLlm(current as never, "http://localhost:11434", ["llama3.2"]);

    expect(result).toEqual(current.llm);
    expect(result).not.toBe(current.llm);
  });

  test("stepOutputConfig prompts for format and detail", async () => {
    const { stepOutputConfig } = await import("../src/setup/setup");
    q.selects.push("text", "full");

    const result = await stepOutputConfig({ semanticSearchMode: "auto", output: { format: "json", detail: "brief" } } as never);

    expect(result).toEqual({ format: "text", detail: "full" });
  });
});

describe("semantic search setup", () => {
  beforeEach(reset);

  test("should list local model and sqlite-vec guidance when describing semantic search assets", async () => {
    const { describeSemanticSearchAssets } = await import("../src/setup/setup");
    const assets = describeSemanticSearchAssets();

    expect(assets[0]).toContain("Local embedding model");
    expect(assets[0]).toContain("download");
    expect(assets[1]).toContain("sqlite-vec");
  });

  test("stepSemanticSearch returns disabled when user opts out", async () => {
    const { stepSemanticSearch } = await import("../src/setup/setup");
    q.confirms.push(false);

    const result = await stepSemanticSearch({ semanticSearchMode: "auto" } as never);
    expect(result).toEqual({ mode: "off", prepareAssets: false });
  });

  test("stepSemanticSearch shows assets and allows asset preparation", async () => {
    const { stepSemanticSearch } = await import("../src/setup/setup");
    q.confirms.push(true, true);

    const result = await stepSemanticSearch({ semanticSearchMode: "auto" } as never);
    expect(result).toEqual({ mode: "auto", prepareAssets: true });
    expect(q.logged.some((entry) => entry.includes("Semantic Search Assets"))).toBe(true);
  });
});

describe("stepRegistries", () => {
  beforeEach(reset);

  test("preselects akm-registry but not skills.sh by default", async () => {
    const { stepRegistries } = await import("../src/setup/setup");

    q.multiselects.push(["https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json"]);

    const result = await stepRegistries({ registries: undefined } as never);
    expect(q.multiselectConfigs[0]?.initialValues).toEqual([
      "https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json",
    ]);
    expect(q.multiselectConfigs[0]?.options.map((option) => option.label)).toEqual(["akm-registry", "skills.sh"]);
    expect(result).toEqual([
      {
        url: "https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json",
        name: "akm-registry",
        enabled: true,
      },
      { url: "https://skills.sh", name: "skills.sh", provider: "skills-sh", enabled: false },
    ]);
  });

  test("lets existing built-in registries be unchecked", async () => {
    const { stepRegistries } = await import("../src/setup/setup");
    const current = {
      registries: [
        { url: "https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json", name: "akm-registry" },
        { url: "https://skills.sh", name: "skills.sh", provider: "skills-sh", enabled: true },
      ],
    };

    q.multiselects.push(["https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json"]);

    const result = await stepRegistries(current as never);
    expect(q.multiselectConfigs[0]?.initialValues).toEqual([
      "https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json",
      "https://skills.sh",
    ]);
    expect(result).toEqual([
      {
        url: "https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json",
        name: "akm-registry",
        enabled: true,
      },
      { url: "https://skills.sh", name: "skills.sh", provider: "skills-sh", enabled: false },
    ]);
  });
});

describe("stepAddSources – custom GitHub repo", () => {
  beforeEach(reset);

  test("adds a custom GitHub repo with type 'git'", async () => {
    const { stepAddSources } = await import("../src/setup/setup");

    // multiselect recommended repos → none
    q.multiselects.push([]);
    // select "Add another source?" → "github-repo"
    q.selects.push("github-repo");
    // text: GitHub URL
    q.texts.push("https://github.com/owner/repo");
    // text: name
    q.texts.push("my-repo");
    // select → done
    q.selects.push("done");

    const result = await stepAddSources({ sources: [] } as never);
    const repo = result.find((s) => s.url === "https://github.com/owner/repo");
    expect(repo).toBeDefined();
    expect(repo?.type).toBe("git");
    expect(repo?.name).toBe("my-repo");
  });
});

describe("stepAddSources – cancel within sub-actions", () => {
  beforeEach(reset);

  test("pressing Escape on a sub-action text prompt returns to menu", async () => {
    const { stepAddSources } = await import("../src/setup/setup");

    // multiselect recommended → none
    q.multiselects.push([]);
    // select → github-repo
    q.selects.push("github-repo");
    // text: press Escape (cancel) → should return to menu, not re-prompt
    q.texts.push(CANCEL);
    // back at menu → done
    q.selects.push("done");

    const result = await stepAddSources({ sources: [] } as never);
    // No repo was added because the user cancelled
    expect(result).toEqual([]);
  });

  test("pressing Escape on filesystem path returns to menu", async () => {
    const { stepAddSources } = await import("../src/setup/setup");

    q.multiselects.push([]);
    q.selects.push("filesystem");
    q.texts.push(CANCEL); // cancel the path prompt
    q.selects.push("done");

    const result = await stepAddSources({ sources: [] } as never);
    expect(result).toEqual([]);
  });

  test("pressing Escape on name prompt returns to menu without adding", async () => {
    const { stepAddSources } = await import("../src/setup/setup");

    q.multiselects.push([]);
    q.selects.push("github-repo");
    q.texts.push("https://github.com/owner/repo"); // provide URL
    q.texts.push(CANCEL); // cancel on name prompt
    q.selects.push("done");

    const result = await stepAddSources({ sources: [] } as never);
    // Repo was NOT added because user cancelled at the name step
    expect(result).toEqual([]);
  });
});

describe("stepAddSources – deferred additional prompt", () => {
  beforeEach(reset);

  test("can skip the additional-source menu when requested", async () => {
    const { stepAddSources } = await import("../src/setup/setup");

    q.multiselects.push([]);

    const result = await stepAddSources({ sources: [] } as never, { promptForAdditional: false });

    expect(result).toEqual([]);
    expect(q.selects).toHaveLength(0);
  });
});
