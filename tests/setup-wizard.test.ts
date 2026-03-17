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
  note: () => {},
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

const CTX_HUB_URL = "https://github.com/andrewyng/context-hub";

describe("stepStashSources – recommended GitHub repos", () => {
  beforeEach(reset);

  test("selecting a recommended repo adds it with type 'github'", async () => {
    const { stepStashSources } = await import("../src/setup");

    // multiselect recommended repos → select context-hub
    q.multiselects.push([CTX_HUB_URL]);
    // select "Add another source?" → "done"
    q.selects.push("done");

    const result = await stepStashSources({ stashes: [] } as never);
    const hub = result.find((s) => s.url === CTX_HUB_URL);
    expect(hub).toBeDefined();
    expect(hub?.type).toBe("github");
    expect(hub?.name).toBe("context-hub");
  });

  test("deselecting a previously added recommended repo removes it", async () => {
    const { stepStashSources } = await import("../src/setup");
    const cfg = {
      stashes: [{ type: "github", url: CTX_HUB_URL, name: "context-hub" }],
    };

    // multiselect recommended repos → deselect all (empty array)
    q.multiselects.push([]);
    // select "Add another source?" → "done"
    q.selects.push("done");

    const result = await stepStashSources(cfg as never);
    const hub = result.find((s) => s.url === CTX_HUB_URL);
    expect(hub).toBeUndefined();
  });

  test("keeping a recommended repo that is already configured", async () => {
    const { stepStashSources } = await import("../src/setup");
    const cfg = {
      stashes: [{ type: "github", url: CTX_HUB_URL, name: "context-hub" }],
    };

    // multiselect → keep it selected
    q.multiselects.push([CTX_HUB_URL]);
    // select → done
    q.selects.push("done");

    const result = await stepStashSources(cfg as never);
    const hub = result.find((s) => s.url === CTX_HUB_URL);
    expect(hub).toBeDefined();
  });

  test("selecting no recommended repos is fine", async () => {
    const { stepStashSources } = await import("../src/setup");

    // multiselect → select nothing
    q.multiselects.push([]);
    // select → done
    q.selects.push("done");

    const result = await stepStashSources({ stashes: [] } as never);
    expect(result).toEqual([]);
  });
});

describe("stepStashSources – custom GitHub repo", () => {
  beforeEach(reset);

  test("adds a custom GitHub repo with type 'github'", async () => {
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
    expect(repo?.type).toBe("github");
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
