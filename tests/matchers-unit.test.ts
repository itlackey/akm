import { describe, expect, test } from "bun:test";
import type { FileContext } from "../src/indexer/file-context";
import {
  directoryMatcher,
  extensionMatcher,
  parentDirHintMatcher,
  smartMdMatcher,
  wikiMatcher,
} from "../src/indexer/matchers";

/**
 * Build a synthetic FileContext for matcher unit tests. The matchers
 * (except smartMdMatcher) are pure functions of path-derived fields, so
 * the lazy `content`/`frontmatter`/`stat` getters can return canned data
 * — no real filesystem access needed.
 */
function ctx(opts: { relPath: string; content?: string; frontmatter?: Record<string, unknown> | null }): FileContext {
  const segments = opts.relPath.split("/");
  const fileName = segments[segments.length - 1];
  const ext = (() => {
    const dot = fileName.lastIndexOf(".");
    return dot > 0 ? fileName.slice(dot).toLowerCase() : "";
  })();
  const dirSegments = segments.slice(0, -1);
  const parentDir = dirSegments.length > 0 ? dirSegments[dirSegments.length - 1] : "";
  const parentDirAbs = `/stash/${dirSegments.join("/")}`.replace(/\/+$/, "");
  return {
    absPath: `/stash/${opts.relPath}`,
    relPath: opts.relPath,
    ext,
    fileName,
    parentDir,
    parentDirAbs,
    ancestorDirs: dirSegments,
    stashRoot: "/stash",
    content: () => opts.content ?? "",
    frontmatter: () => opts.frontmatter ?? null,
    stat: () => {
      throw new Error("stat() should not be called by these matchers");
    },
  };
}

// ── extensionMatcher ────────────────────────────────────────────────────────

describe("extensionMatcher", () => {
  test("classifies SKILL.md anywhere as skill at high specificity", () => {
    const result = extensionMatcher(ctx({ relPath: "anywhere/deep/SKILL.md" }));
    expect(result).toEqual({ type: "skill", specificity: 25, renderer: "skill-md" });
  });

  test("does NOT classify SKILL.md under wikis/ as skill", () => {
    const result = extensionMatcher(ctx({ relPath: "wikis/research/SKILL.md" }));
    expect(result).toBeNull();
  });

  test("classifies known script extensions as script at low specificity", () => {
    expect(extensionMatcher(ctx({ relPath: "stuff/deploy.sh" }))?.type).toBe("script");
    expect(extensionMatcher(ctx({ relPath: "stuff/lint.ts" }))?.type).toBe("script");
    expect(extensionMatcher(ctx({ relPath: "stuff/lint.ts" }))?.specificity).toBe(3);
  });

  test("does not handle .md files (smartMdMatcher's job)", () => {
    expect(extensionMatcher(ctx({ relPath: "stuff/notes.md" }))).toBeNull();
  });

  test("returns null for unknown extensions", () => {
    expect(extensionMatcher(ctx({ relPath: "stuff/data.bin" }))).toBeNull();
  });
});

// ── directoryMatcher ────────────────────────────────────────────────────────

describe("directoryMatcher", () => {
  test("scripts/ ancestor classifies a script", () => {
    const result = directoryMatcher(ctx({ relPath: "scripts/azure/deploy.sh" }));
    expect(result).toEqual({ type: "script", specificity: 10, renderer: "script-source" });
  });

  test("first matching ancestor wins (commands/ before agents/ in path)", () => {
    const result = directoryMatcher(ctx({ relPath: "commands/agents/foo.md" }));
    expect(result?.type).toBe("command");
  });

  test("agents/foo.md classifies as agent", () => {
    expect(directoryMatcher(ctx({ relPath: "agents/foo.md" }))?.type).toBe("agent");
  });

  test("knowledge/foo.md classifies as knowledge", () => {
    expect(directoryMatcher(ctx({ relPath: "knowledge/foo.md" }))?.type).toBe("knowledge");
  });

  test("workflows/foo.md classifies as workflow", () => {
    expect(directoryMatcher(ctx({ relPath: "workflows/foo.md" }))?.type).toBe("workflow");
  });

  test("memories/foo.md classifies as memory", () => {
    expect(directoryMatcher(ctx({ relPath: "memories/foo.md" }))?.type).toBe("memory");
  });

  test("vaults/.env classifies as vault", () => {
    expect(directoryMatcher(ctx({ relPath: "vaults/.env" }))?.type).toBe("vault");
    expect(directoryMatcher(ctx({ relPath: "vaults/staging.env" }))?.type).toBe("vault");
  });

  test("unmatched directories return null", () => {
    expect(directoryMatcher(ctx({ relPath: "random/file.md" }))).toBeNull();
  });
});

// ── parentDirHintMatcher ────────────────────────────────────────────────────

describe("parentDirHintMatcher", () => {
  test("immediate parent named scripts/ classifies a script at higher specificity", () => {
    const result = parentDirHintMatcher(ctx({ relPath: "my-project/scripts/run.sh" }));
    expect(result).toEqual({ type: "script", specificity: 15, renderer: "script-source" });
  });

  test("agents parent dir classifies an .md as agent", () => {
    expect(parentDirHintMatcher(ctx({ relPath: "anything/agents/foo.md" }))?.type).toBe("agent");
  });

  test("returns null when parent doesn't match a type", () => {
    expect(parentDirHintMatcher(ctx({ relPath: "random/blah.md" }))).toBeNull();
  });
});

// ── smartMdMatcher ─────────────────────────────────────────────────────────

describe("smartMdMatcher", () => {
  test("returns null for non-.md files", () => {
    expect(smartMdMatcher(ctx({ relPath: "stuff/run.sh", content: "" }))).toBeNull();
  });

  test("workflow signals classify as workflow at specificity 19", () => {
    const body = `# Workflow: Deploy
## Step: Validate
Step ID: validate

### Instructions
Do the thing.
`;
    const result = smartMdMatcher(ctx({ relPath: "anywhere.md", content: body }));
    expect(result).toEqual({ type: "workflow", specificity: 19, renderer: "workflow-md" });
  });

  test("toolPolicy frontmatter classifies as agent at 20 (highest)", () => {
    const result = smartMdMatcher(
      ctx({
        relPath: "blah.md",
        content: "body",
        frontmatter: { toolPolicy: "strict" },
      }),
    );
    expect(result).toEqual({ type: "agent", specificity: 20, renderer: "agent-md" });
  });

  test("tools frontmatter classifies as agent at 20", () => {
    const result = smartMdMatcher(
      ctx({
        relPath: "blah.md",
        content: "body",
        frontmatter: { tools: ["read"] },
      }),
    );
    expect(result?.type).toBe("agent");
    expect(result?.specificity).toBe(20);
  });

  test("agent-named frontmatter (OpenCode command) classifies as command at 18", () => {
    const result = smartMdMatcher(
      ctx({
        relPath: "blah.md",
        content: "body",
        frontmatter: { agent: "review" },
      }),
    );
    expect(result).toEqual({ type: "command", specificity: 18, renderer: "command-md" });
  });

  test("$ARGUMENTS placeholder classifies as command at 18", () => {
    const result = smartMdMatcher(
      ctx({
        relPath: "blah.md",
        content: "Run with $ARGUMENTS",
      }),
    );
    expect(result).toEqual({ type: "command", specificity: 18, renderer: "command-md" });
  });

  test("$1 placeholder classifies as command at 18", () => {
    const result = smartMdMatcher(
      ctx({
        relPath: "blah.md",
        content: "First arg is $1",
      }),
    );
    expect(result?.type).toBe("command");
  });

  test("model frontmatter alone is a weak agent signal (specificity 8)", () => {
    const result = smartMdMatcher(
      ctx({
        relPath: "blah.md",
        content: "body",
        frontmatter: { model: "gpt-4o" },
      }),
    );
    expect(result).toEqual({ type: "agent", specificity: 8, renderer: "agent-md" });
  });

  test("plain .md falls back to knowledge at specificity 5", () => {
    const result = smartMdMatcher(
      ctx({
        relPath: "blah.md",
        content: "Just some prose with no signals.",
      }),
    );
    expect(result).toEqual({ type: "knowledge", specificity: 5, renderer: "knowledge-md" });
  });
});

// ── wikiMatcher ─────────────────────────────────────────────────────────────

describe("wikiMatcher", () => {
  test("any .md under wikis/<name>/ classifies as wiki at specificity 20", () => {
    const result = wikiMatcher(ctx({ relPath: "wikis/research/page.md" }));
    expect(result).toEqual({ type: "wiki", specificity: 20, renderer: "wiki-md" });
  });

  test("nested wiki pages also classify as wiki", () => {
    expect(wikiMatcher(ctx({ relPath: "wikis/research/sub/deep/page.md" }))?.type).toBe("wiki");
  });

  test("non-.md files are ignored", () => {
    expect(wikiMatcher(ctx({ relPath: "wikis/research/page.txt" }))).toBeNull();
  });

  test("a stray .md at bare wikis/ root is NOT a wiki page", () => {
    expect(wikiMatcher(ctx({ relPath: "wikis/orphan.md" }))).toBeNull();
  });

  test("paths without wikis/ are ignored", () => {
    expect(wikiMatcher(ctx({ relPath: "knowledge/page.md" }))).toBeNull();
  });
});
