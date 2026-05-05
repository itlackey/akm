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

    q.multiselects.push([]);
    q.selects.push("done");

    const result = await stepAddSources(cfg as never);
    expect(q.multiselectConfigs[0]?.initialValues).toEqual(["https://github.com/itlackey/akm-stash"]);
    expect(result).toEqual([]);
  });

  test("preserves an existing git stash that points at the legacy context-hub URL", async () => {
    const { stepAddSources } = await import("../src/setup/setup");
    const ctxHubUrl = "https://github.com/andrewyng/context-hub";
    const cfg = {
      sources: [{ type: "git", url: ctxHubUrl, name: "context-hub" }],
    };

    q.multiselects.push([ctxHubUrl]);
    q.selects.push("done");

    const result = await stepAddSources(cfg as never);
    expect(q.multiselectConfigs[0]?.initialValues).toEqual([ctxHubUrl]);
    const hub = result.find((s) => s.url === ctxHubUrl);
    expect(hub).toBeDefined();
    expect(hub?.type).toBe("git");
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
