/**
 * Tests for setup wizard interactive logic:
 * - onCancel: Escape on confirmation should stay, not exit
 * - stepStashSources: recommended GitHub repos multiselect, cancel returns to menu
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
  logged: [] as string[],
};

function reset() {
  q.confirms.length = 0;
  q.selects.length = 0;
  q.texts.length = 0;
  q.multiselects.length = 0;
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
  multiselect: async () => q.multiselects.shift() ?? [],
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
    const { onCancel } = await import("../src/setup");
    // Simulate: user already pressed Escape in a prompt (value = CANCEL),
    // then presses Escape again on the "Exit the wizard?" confirmation.
    q.confirms.push(CANCEL);

    const stayed = await onCancel(CANCEL);
    expect(stayed).toBe(true);
  });

  test("choosing No on the exit-confirmation stays in the wizard", async () => {
    const { onCancel } = await import("../src/setup");
    q.confirms.push(false);

    const stayed = await onCancel(CANCEL);
    expect(stayed).toBe(true);
  });

  test("choosing Yes on the exit-confirmation calls bail (exits)", async () => {
    const { onCancel } = await import("../src/setup");
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
    const { onCancel } = await import("../src/setup");
    const stayed = await onCancel("normal-value");
    expect(stayed).toBe(false);
  });
});

// ── stepStashSources tests ───────────────────────────────────────────────────

describe("stepStashSources – recommended GitHub repos", () => {
  beforeEach(reset);

  test("with no recommended repos configured, the multiselect prompt is skipped", async () => {
    const { stepStashSources } = await import("../src/setup");

    // No multiselect should be consumed because the recommended-repos array
    // is empty. Only the "Add another source?" select should be needed.
    q.selects.push("done");

    const result = await stepStashSources({ stashes: [] } as never);
    expect(result).toEqual([]);
    // multiselect queue should still be empty (nothing pushed, nothing consumed)
    expect(q.multiselects.length).toBe(0);
  });

  test("preserves an existing git stash that points at the legacy context-hub URL", async () => {
    const { stepStashSources } = await import("../src/setup");
    const ctxHubUrl = "https://github.com/andrewyng/context-hub";
    const cfg = {
      stashes: [{ type: "git", url: ctxHubUrl, name: "context-hub" }],
    };

    q.selects.push("done");

    const result = await stepStashSources(cfg as never);
    const hub = result.find((s) => s.url === ctxHubUrl);
    expect(hub).toBeDefined();
    expect(hub?.type).toBe("git");
  });
});

describe("semantic search setup", () => {
  beforeEach(reset);

  test("should list local model and sqlite-vec guidance when describing semantic search assets", async () => {
    const { describeSemanticSearchAssets } = await import("../src/setup");
    const assets = describeSemanticSearchAssets();

    expect(assets[0]).toContain("Local embedding model");
    expect(assets[0]).toContain("download");
    expect(assets[1]).toContain("sqlite-vec");
  });

  test("stepSemanticSearch returns disabled when user opts out", async () => {
    const { stepSemanticSearch } = await import("../src/setup");
    q.confirms.push(false);

    const result = await stepSemanticSearch({ semanticSearchMode: "auto" } as never);
    expect(result).toEqual({ mode: "off", prepareAssets: false });
  });

  test("stepSemanticSearch shows assets and allows asset preparation", async () => {
    const { stepSemanticSearch } = await import("../src/setup");
    q.confirms.push(true, true);

    const result = await stepSemanticSearch({ semanticSearchMode: "auto" } as never);
    expect(result).toEqual({ mode: "auto", prepareAssets: true });
    expect(q.logged.some((entry) => entry.includes("Semantic Search Assets"))).toBe(true);
  });
});

describe("stepStashSources – custom GitHub repo", () => {
  beforeEach(reset);

  test("adds a custom GitHub repo with type 'git'", async () => {
    const { stepStashSources } = await import("../src/setup");

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

    const result = await stepStashSources({ stashes: [] } as never);
    const repo = result.find((s) => s.url === "https://github.com/owner/repo");
    expect(repo).toBeDefined();
    expect(repo?.type).toBe("git");
    expect(repo?.name).toBe("my-repo");
  });
});

describe("stepStashSources – cancel within sub-actions", () => {
  beforeEach(reset);

  test("pressing Escape on a sub-action text prompt returns to menu", async () => {
    const { stepStashSources } = await import("../src/setup");

    // multiselect recommended → none
    q.multiselects.push([]);
    // select → github-repo
    q.selects.push("github-repo");
    // text: press Escape (cancel) → should return to menu, not re-prompt
    q.texts.push(CANCEL);
    // back at menu → done
    q.selects.push("done");

    const result = await stepStashSources({ stashes: [] } as never);
    // No repo was added because the user cancelled
    expect(result).toEqual([]);
  });

  test("pressing Escape on OpenViking URL returns to menu", async () => {
    const { stepStashSources } = await import("../src/setup");

    q.multiselects.push([]);
    q.selects.push("openviking");
    q.texts.push(CANCEL); // cancel the URL prompt
    q.selects.push("done");

    const result = await stepStashSources({ stashes: [] } as never);
    expect(result).toEqual([]);
  });

  test("pressing Escape on filesystem path returns to menu", async () => {
    const { stepStashSources } = await import("../src/setup");

    q.multiselects.push([]);
    q.selects.push("filesystem");
    q.texts.push(CANCEL); // cancel the path prompt
    q.selects.push("done");

    const result = await stepStashSources({ stashes: [] } as never);
    expect(result).toEqual([]);
  });

  test("pressing Escape on name prompt returns to menu without adding", async () => {
    const { stepStashSources } = await import("../src/setup");

    q.multiselects.push([]);
    q.selects.push("github-repo");
    q.texts.push("https://github.com/owner/repo"); // provide URL
    q.texts.push(CANCEL); // cancel on name prompt
    q.selects.push("done");

    const result = await stepStashSources({ stashes: [] } as never);
    // Repo was NOT added because user cancelled at the name step
    expect(result).toEqual([]);
  });
});
