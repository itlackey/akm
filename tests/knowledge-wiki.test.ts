import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LlmConnectionConfig } from "../src/config";
import {
  bootstrapKnowledgeWiki,
  deriveQueryFromSource,
  ingestSource,
  lintWiki,
  slugifyForWiki,
} from "../src/knowledge-wiki";
import { ingestKnowledgeSource, lintKnowledge, probeLlmCapabilities } from "../src/llm";

// ── Test scaffolding ────────────────────────────────────────────────────────

interface MockServerHandle {
  url: string;
  server: ReturnType<typeof Bun.serve>;
  requests: Array<Record<string, unknown>>;
}

function createMockLlmServer(responseBody: string, statusCode = 200): MockServerHandle {
  const requests: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { content: responseBody } }] }), {
        status: statusCode,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return { url: `http://localhost:${server.port}`, server, requests };
}

function makeStash(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-wiki-"));
  fs.mkdirSync(path.join(dir, "knowledge"), { recursive: true });
  return dir;
}

// ── slug + query helpers ────────────────────────────────────────────────────

describe("slugifyForWiki", () => {
  test("normalizes punctuation, spaces, and case", () => {
    expect(slugifyForWiki("Hello, World!")).toBe("hello-world");
    expect(slugifyForWiki("# Auth Design (v2)")).toBe("auth-design-v2");
  });

  test("falls back to a timestamp slug when input has nothing to slugify", () => {
    const slug = slugifyForWiki("@@@");
    expect(slug.startsWith("note-")).toBe(true);
  });
});

describe("deriveQueryFromSource", () => {
  test("uses the first non-empty heading and caps to a few terms", () => {
    const source = "---\ntitle: Foo\n---\n\n# Postgres Connection Pooling Strategies for High-QPS Workloads\n\nbody";
    const query = deriveQueryFromSource(source);
    expect(query.startsWith("Postgres Connection Pooling")).toBe(true);
    expect(query.split(/\s+/).length).toBeLessThanOrEqual(8);
  });

  test("returns empty for empty input", () => {
    expect(deriveQueryFromSource("")).toBe("");
  });
});

// ── bootstrap ───────────────────────────────────────────────────────────────

describe("bootstrapKnowledgeWiki", () => {
  let stashDir: string;

  beforeEach(() => {
    stashDir = makeStash();
  });

  afterEach(() => {
    fs.rmSync(stashDir, { recursive: true, force: true });
  });

  test("writes schema, index, log, and three skill files when none exist", () => {
    const result = bootstrapKnowledgeWiki(stashDir);
    expect(result.created.length).toBe(6);
    expect(result.skipped).toEqual([]);
    expect(fs.existsSync(path.join(stashDir, "knowledge", "schema.md"))).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "knowledge", "index.md"))).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "knowledge", "log.md"))).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "skills", "knowledge-ingest", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "skills", "knowledge-query", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "skills", "knowledge-lint", "SKILL.md"))).toBe(true);
  });

  test("is idempotent and never overwrites existing files", () => {
    fs.writeFileSync(path.join(stashDir, "knowledge", "schema.md"), "MY SCHEMA", "utf8");
    bootstrapKnowledgeWiki(stashDir);
    expect(fs.readFileSync(path.join(stashDir, "knowledge", "schema.md"), "utf8")).toBe("MY SCHEMA");

    const second = bootstrapKnowledgeWiki(stashDir);
    expect(second.created).toEqual([]);
    expect(second.skipped.length).toBe(6);
  });
});

// ── ingest (LLM round-trip) ─────────────────────────────────────────────────

describe("ingestSource", () => {
  let stashDir: string;

  beforeEach(() => {
    stashDir = makeStash();
  });

  afterEach(() => {
    fs.rmSync(stashDir, { recursive: true, force: true });
  });

  test("dry-run copies raw and returns the LLM plan without writing pages", async () => {
    const planBody = JSON.stringify({
      summary: "Adds passkey rollout notes",
      newPages: [
        {
          name: "passkey-rollout-2026",
          pageKind: "concept",
          body: "# Passkey rollout 2026\n\nDetails go here.",
          xrefs: ["knowledge:auth-design"], // present in candidates
        },
      ],
      edits: [],
      note: "no related pages yet",
    });
    const handle = createMockLlmServer(planBody);
    try {
      const llm: LlmConnectionConfig = { endpoint: handle.url, model: "test-model" };
      const result = await ingestSource({
        content: "# Passkey rollout 2026\n\nWe shipped X.",
        stashDir,
        llm,
        candidates: [{ ref: "knowledge:auth-design", name: "auth-design" }],
      });
      // raw is always written, even on dry-run
      expect(fs.existsSync(result.rawPath)).toBe(true);
      // plan is returned but no pages were applied
      expect(result.plan?.newPages[0].name).toBe("passkey-rollout-2026");
      expect(result.applied).toBeUndefined();
      // The dry-run did NOT create the actual page
      expect(fs.existsSync(path.join(stashDir, "knowledge", "passkey-rollout-2026.md"))).toBe(false);
    } finally {
      handle.server.stop();
    }
  });

  test("apply mode writes new pages, appends edits, and logs the run", async () => {
    // Pre-existing page that the LLM will append to.
    fs.writeFileSync(
      path.join(stashDir, "knowledge", "auth-design.md"),
      "---\ndescription: auth design\npageKind: concept\n---\n\n# Auth design\n\nExisting body.\n",
      "utf8",
    );
    fs.writeFileSync(path.join(stashDir, "knowledge", "log.md"), "# Log\n", "utf8");

    const planBody = JSON.stringify({
      summary: "Adds passkey rollout notes",
      newPages: [
        {
          name: "passkey-rollout-2026",
          pageKind: "concept",
          body: "# Passkey rollout 2026\n\nDetails.",
          xrefs: ["knowledge:auth-design"],
        },
      ],
      edits: [
        {
          ref: "knowledge:auth-design",
          patch: "## Passkey notes\n\nLink to passkey rollout.",
          reason: "captures rollout angle",
        },
      ],
    });
    const handle = createMockLlmServer(planBody);
    try {
      const llm: LlmConnectionConfig = { endpoint: handle.url, model: "test-model" };
      const result = await ingestSource({
        content: "# Passkey rollout 2026\n\nWe shipped X.",
        stashDir,
        llm,
        apply: true,
        candidates: [{ ref: "knowledge:auth-design", name: "auth-design" }],
      });

      expect(result.applied).toBeDefined();
      expect(result.applied?.pagesCreated.length).toBe(1);
      expect(result.applied?.pagesEdited.length).toBe(1);

      const newPage = fs.readFileSync(path.join(stashDir, "knowledge", "passkey-rollout-2026.md"), "utf8");
      expect(newPage).toContain("pageKind: concept");
      expect(newPage).toContain("knowledge:auth-design");
      expect(newPage).toContain("# Passkey rollout 2026");

      const editedPage = fs.readFileSync(path.join(stashDir, "knowledge", "auth-design.md"), "utf8");
      expect(editedPage).toContain("Passkey notes");
      expect(editedPage).toContain("Existing body.");

      const log = fs.readFileSync(path.join(stashDir, "knowledge", "log.md"), "utf8");
      expect(log).toContain("ingest raw/");
      expect(log).toContain("Adds passkey rollout notes");
    } finally {
      handle.server.stop();
    }
  });

  test("xrefs not in the candidate set are silently dropped", async () => {
    const planBody = JSON.stringify({
      summary: "x",
      newPages: [
        {
          name: "page-a",
          pageKind: "note",
          body: "# A",
          xrefs: ["knowledge:made-up-page"],
        },
      ],
      edits: [{ ref: "knowledge:also-made-up", patch: "x", reason: "y" }],
    });
    const handle = createMockLlmServer(planBody);
    try {
      const llm: LlmConnectionConfig = { endpoint: handle.url, model: "test-model" };
      const plan = await ingestKnowledgeSource(llm, {
        sourceName: "src",
        sourceContent: "body",
        candidates: [],
      });
      expect(plan?.newPages[0].xrefs).toBeUndefined();
      expect(plan?.edits).toEqual([]);
    } finally {
      handle.server.stop();
    }
  });
});

// ── lint ────────────────────────────────────────────────────────────────────

describe("lintWiki", () => {
  let stashDir: string;

  beforeEach(() => {
    stashDir = makeStash();
  });

  afterEach(() => {
    fs.rmSync(stashDir, { recursive: true, force: true });
  });

  test("reports findings and applies missing-xref fixes when --fix is set", async () => {
    fs.writeFileSync(
      path.join(stashDir, "knowledge", "page-a.md"),
      "---\ndescription: page A\npageKind: note\n---\n\n# Page A\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(stashDir, "knowledge", "page-b.md"),
      "---\ndescription: page B\npageKind: note\n---\n\n# Page B\n",
      "utf8",
    );
    fs.writeFileSync(path.join(stashDir, "knowledge", "log.md"), "# Log\n", "utf8");

    const findings = JSON.stringify({
      summary: "1 missing xref",
      findings: [
        {
          kind: "missing-xref",
          refs: ["knowledge:page-a"],
          message: "page A should link to page B",
          suggestedFix: "See also: knowledge:page-b",
        },
      ],
    });
    const handle = createMockLlmServer(findings);
    try {
      const llm: LlmConnectionConfig = { endpoint: handle.url, model: "test-model" };
      const result = await lintWiki({ stashDir, llm, fix: true });
      expect(result.report?.findings.length).toBe(1);
      expect(result.applied?.fixesApplied).toBe(1);
      expect(fs.readFileSync(path.join(stashDir, "knowledge", "page-a.md"), "utf8")).toContain(
        "See also: knowledge:page-b",
      );
      // log entry was appended
      expect(fs.readFileSync(path.join(stashDir, "knowledge", "log.md"), "utf8")).toContain("lint");
    } finally {
      handle.server.stop();
    }
  });

  test("ignores raw/ and the special schema/index/log files", async () => {
    fs.mkdirSync(path.join(stashDir, "knowledge", "raw"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "knowledge", "raw", "src.md"), "raw\n", "utf8");
    fs.writeFileSync(path.join(stashDir, "knowledge", "schema.md"), "schema\n", "utf8");
    fs.writeFileSync(path.join(stashDir, "knowledge", "page.md"), "---\ndescription: real\n---\n\nbody\n", "utf8");

    const handle = createMockLlmServer(JSON.stringify({ findings: [] }));
    try {
      const llm: LlmConnectionConfig = { endpoint: handle.url, model: "test-model" };
      await lintWiki({ stashDir, llm });
      // Inspect the request that was sent — only "page" should appear.
      const lastBody = handle.requests.at(-1);
      const userPrompt = ((lastBody?.messages as Array<{ content: string }>) ?? []).find((m) =>
        m.content?.includes("Pages in the wiki"),
      );
      expect(userPrompt?.content).toContain("knowledge:page");
      expect(userPrompt?.content).not.toContain("knowledge:raw/");
      expect(userPrompt?.content).not.toContain("knowledge:schema");
    } finally {
      handle.server.stop();
    }
  });
});

// ── llm helpers (probe + parsing) ───────────────────────────────────────────

describe("probeLlmCapabilities", () => {
  test("returns structuredOutput=true on valid JSON", async () => {
    const handle = createMockLlmServer(JSON.stringify({ ok: true, ingest: true, lint: true }));
    try {
      const result = await probeLlmCapabilities({ endpoint: handle.url, model: "x" });
      expect(result.reachable).toBe(true);
      expect(result.structuredOutput).toBe(true);
    } finally {
      handle.server.stop();
    }
  });

  test("returns structuredOutput=false when response is loose prose", async () => {
    const handle = createMockLlmServer("yes I am ok here you go");
    try {
      const result = await probeLlmCapabilities({ endpoint: handle.url, model: "x" });
      expect(result.reachable).toBe(true);
      expect(result.structuredOutput).toBe(false);
    } finally {
      handle.server.stop();
    }
  });

  test("returns reachable=false when the endpoint is unreachable", async () => {
    const result = await probeLlmCapabilities({
      endpoint: "http://127.0.0.1:1/v1/chat/completions",
      model: "x",
    });
    expect(result.reachable).toBe(false);
  });
});

describe("lintKnowledge response parsing", () => {
  test("returns undefined for unparseable LLM output", async () => {
    const handle = createMockLlmServer("not json");
    try {
      const llm: LlmConnectionConfig = { endpoint: handle.url, model: "x" };
      const report = await lintKnowledge(llm, { pages: [] });
      expect(report).toBeUndefined();
    } finally {
      handle.server.stop();
    }
  });
});
