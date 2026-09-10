import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import type { IndexDocument } from "../../../src/indexer/passes/metadata";
import { MARKDOWN_CONTENT_MAX_CHARS, projectMarkdownContent } from "../../../src/indexer/passes/metadata";
import { recognizeStashEntries } from "../../../src/indexer/scan/drain-dir";
import { searchUnitsLexical } from "../../../src/indexer/search/db-search";
import { buildLexicalQueryPlan } from "../../../src/indexer/search/fts-query";
import { buildSearchText } from "../../../src/indexer/search/search-fields";
import type { Database as AkmDatabase } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { getEntryById, upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { seedUnitsForAllEntries } from "../../_helpers/seed-units";

const createdDirs: string[] = [];

afterAll(() => {
  for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeDb(): AkmDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-progressive-retrieval-"));
  createdDirs.push(dir);
  return openIndexDatabase(path.join(dir, "index.db"));
}

function insert(db: AkmDatabase, name: string, entry: IndexDocument): void {
  const conceptId = `knowledge/${name}`;
  const provenance = deriveEntryProvenance(
    { bundleId: "fixture", componentId: "fixture", adapterId: "akm" },
    entry.type,
    name,
  );
  upsertEntry(db, `/fixture/${conceptId}.md`, entry, buildSearchText(entry), provenance);
}

/** The units path's entry-level lexical equivalent of the old `searchFts`'s `.entry.name`/`.lexicalMatch` result shape. */
function searchEntryNames(db: AkmDatabase, query: string, k: number): Array<{ name: string; lexicalMatch: string }> {
  return searchUnitsLexical(db, query, k).flatMap((hit) => {
    const row = db.prepare("SELECT entry_id FROM entry_units WHERE unit_hash = ?").get(hit.unitHash) as
      | { entry_id: number }
      | undefined;
    if (!row) return [];
    const found = getEntryById(db, row.entry_id);
    return found ? [{ name: found.entry.name, lexicalMatch: hit.lexicalMatch }] : [];
  });
}

describe("progressive lexical query planning (#819)", () => {
  test("normalizes Unicode tokens, deduplicates them, and quotes operators", () => {
    const repeated = Array.from({ length: 40 }, (_, index) => `token${index}`).join(" ");
    const plan = buildLexicalQueryPlan(`CAFÉ café NEAR or ${repeated}`);

    expect(plan.tokens.slice(0, 4)).toEqual(["CAFÉ", "NEAR", "or", "token0"]);
    // 43 input words, minus the case-duplicate "café" = 43 distinct tokens.
    // This used to assert 16 — the old MAX_LEXICAL_QUERY_TOKENS cap, deleted
    // for silently truncating queries past 16 unique terms. Every token the
    // user typed now reaches FTS; the tail is no longer dropped.
    expect(plan.tokens).toHaveLength(43);
    expect(plan.tokens.at(-1)).toBe("token39");
    expect(plan.exact).toStartWith('"CAFÉ" "NEAR" "or" "token0"');
    expect(plan.relaxed).toContain('"NEAR"*');
  });

  test("does not truncate a long query — every distinct token reaches FTS", () => {
    const plan = buildLexicalQueryPlan(Array.from({ length: 500 }, (_, i) => `tok${i}`).join(" "));
    expect(plan.tokens).toHaveLength(500);
    expect(plan.exact).toContain('"tok499"');
  });

  test.each([
    { query: "code-review", tokens: ["code", "review"] },
    { query: "k8s.setup", tokens: ["k8s", "setup"] },
    { query: "deploy_prod", tokens: ["deploy", "prod"] },
    { query: 'deploy:prod "code-review"', tokens: ["deploy", "prod", "code", "review"] },
    { query: "R ai", tokens: ["R", "ai"] },
    { query: "NEAR OR and", tokens: ["NEAR", "OR", "and"] },
    { query: '"()*:^{}', tokens: [] },
  ])("is the sole safe identifier/operator planner: $query", ({ query, tokens }) => {
    const plan = buildLexicalQueryPlan(query);
    expect(plan.tokens).toEqual([...tokens]);
    expect(plan.exact).toBe(tokens.map((token) => `"${token}"`).join(" "));
    expect(plan.exact).not.toContain(":");
    expect(plan.exact).not.toContain("(");
    expect(plan.exact).not.toContain(")");
  });

  test("keeps ref-shaped identifiers conjunctive instead of widening them through OR recovery", () => {
    const plan = buildLexicalQueryPlan("memories/projecta/auth-tip");
    expect(plan.tokens).toEqual(["memories", "projecta", "auth", "tip"]);
    expect(plan.relaxed).toBeUndefined();
  });

  test("uses one strict → prefix → relaxed pipeline without changing strict top-1", () => {
    const db = makeDb();
    try {
      insert(db, "identifier", {
        type: "knowledge",
        name: "cache-pruner",
        description: "Removes expired build artifacts",
      });
      insert(db, "prefix", {
        type: "knowledge",
        name: "kubernetes-configurator",
        description: "Cluster deployment reference",
      });
      insert(db, "unicode", {
        type: "knowledge",
        name: "café-déploiement",
        description: "Orchestration naïve à Montréal",
      });
      insert(db, "structured", {
        type: "knowledge",
        name: "spectral-quokka-rotation",
        description: "Exact operator procedure",
      });
      insert(db, "body", {
        type: "knowledge",
        name: "field-notes",
        description: "Assorted operational observations",
        content: "The spectral quokka calibration nonce rotates every Thursday.",
      });
      seedUnitsForAllEntries(db);
      const cases = [
        { query: "cache-pruner", expected: "cache-pruner", execution: "exact" },
        { query: "kuber config", expected: "kubernetes-configurator", execution: "prefix" },
        { query: "CAFÉ déploiement", expected: "café-déploiement", execution: "exact" },
        {
          query: "how do I find the spectral quokka calibration nonce safely",
          expected: "field-notes",
          execution: "relaxed",
        },
      ] as const;

      for (const row of cases) {
        const results = searchEntryNames(db, row.query, 10);
        expect(
          results.some((result) => result.name === row.expected),
          row.query,
        ).toBe(true);
        expect(results[0]?.lexicalMatch, row.query).toBe(row.execution);
      }

      expect(searchEntryNames(db, "spectral quokka rotation", 10)[0]?.name).toBe("spectral-quokka-rotation");
      expect(() => searchUnitsLexical(db, 'NEAR OR and " ( ) *** the the', 3)).not.toThrow();
      expect(searchUnitsLexical(db, 'NEAR OR and " ( ) *** the the', 3).length).toBeLessThanOrEqual(3);
    } finally {
      closeDatabase(db);
    }
  });
});

describe("native Markdown content projection (#819)", () => {
  test("keeps prose and inline identifiers but drops markup, URLs, comments, and fenced code", () => {
    const projection = projectMarkdownContent(`
# Rotation guide
<!-- internal crawler note -->
Read the [operator guide](https://example.test/private?q=token) before calling \`rotateKey()\`.

\`\`\`sh
export PRIVATE_TOKEN=never-index-this
\`\`\`

The spectral quokka calibration nonce rotates every Thursday.
`);

    expect(projection).toContain("Rotation guide");
    expect(projection).toContain("operator guide");
    expect(projection).toContain("rotateKey()");
    expect(projection).toContain("spectral quokka calibration nonce");
    expect(projection).not.toContain("example.test");
    expect(projection).not.toContain("PRIVATE_TOKEN");
    expect(projection).not.toContain("crawler note");
  });

  test.each([
    {
      name: "a shorter fence does not close a longer fence",
      markdown: ["Before.", "````ts", "FOUR_FENCE_SECRET", "```", "STILL_INSIDE_LONG_FENCE", "````", "After."].join(
        "\n",
      ),
      retained: ["Before.", "After."],
      excluded: ["FOUR_FENCE_SECRET", "STILL_INSIDE_LONG_FENCE"],
    },
    {
      name: "a fence-shaped line with trailing text is not a closer",
      markdown: [
        "Before.",
        "```sh",
        "FIRST_FENCE_SECRET",
        "```not-a-closer",
        "STILL_INSIDE_TEXT_FENCE",
        "```",
        "After.",
      ].join("\n"),
      retained: ["Before.", "After."],
      excluded: ["FIRST_FENCE_SECRET", "STILL_INSIDE_TEXT_FENCE"],
    },
    {
      name: "multiline HTML comments can begin and end mid-line",
      markdown: "Visible before <!-- COMMENT_SECRET\nCOMMENT_SECRET_CONTINUED --> visible after.",
      retained: ["Visible before", "visible after."],
      excluded: ["COMMENT_SECRET", "COMMENT_SECRET_CONTINUED"],
    },
    {
      name: "balanced parentheses remain part of a link destination",
      markdown: "Read [the guide](https://example.test/path_(private)/tail) before rotation.",
      retained: ["the guide", "before rotation."],
      excluded: ["example.test", "private", "/tail"],
    },
    {
      name: "nested image labels recursively exclude their destinations",
      markdown: "Read [![operator alt](https://IMAGE_PRIVATE_SENTINEL.test/token)](https://public.test) safely.",
      retained: ["operator alt", "safely."],
      excluded: ["IMAGE_PRIVATE_SENTINEL", "public.test", "/token"],
    },
    {
      name: "quoted titles can contain escaped and unescaped parentheses",
      markdown:
        'Read [the guide](<https://public.test/path_(private)> "TITLE_PRIVATE_)_SENTINEL and \\"escaped\\"") safely.',
      retained: ["the guide", "safely."],
      excluded: ["public.test", "private", "TITLE_PRIVATE", "SENTINEL", "escaped"],
    },
    {
      name: "an apostrophe inside a bare destination is not a title delimiter",
      markdown: "Read [the label](https://SECRET_PRIVATE.test/it's-token) safely.",
      retained: ["the label", "safely."],
      excluded: ["SECRET_PRIVATE", "it's-token"],
    },
    {
      name: "a parenthesized title begins only after destination whitespace",
      markdown: "Read [the label](https://SECRET_PRIVATE.test/path (PAREN_TITLE_PRIVATE)) safely.",
      retained: ["the label", "safely."],
      excluded: ["SECRET_PRIVATE", "PAREN_TITLE_PRIVATE"],
    },
  ])("projects Markdown state correctly: $name", ({ markdown, retained, excluded }) => {
    const projection = projectMarkdownContent(markdown);
    for (const text of retained) expect(projection).toContain(text);
    for (const sentinel of excluded) expect(projection).not.toContain(sentinel);
  });

  test("has one stable Unicode-safe size bound", () => {
    const projection = projectMarkdownContent(`${"word ".repeat(MARKDOWN_CONTENT_MAX_CHARS)}😀tail`);
    expect(projection).toBeDefined();
    if (projection === undefined) throw new Error("expected a body projection");
    expect(projection.length).toBeLessThanOrEqual(MARKDOWN_CONTENT_MAX_CHARS);
    expect(new TextDecoder().decode(new TextEncoder().encode(projection))).toBe(projection);
  });

  test("reports truncation via the optional out-param instead of staying silent (#866)", () => {
    const long = { truncated: false };
    projectMarkdownContent(`${"word ".repeat(MARKDOWN_CONTENT_MAX_CHARS)}😀tail`, long);
    expect(long.truncated).toBe(true);

    const short = { truncated: false };
    projectMarkdownContent("a short body that never approaches the cap", short);
    expect(short.truncated).toBe(false);
  });

  test("native Markdown uses content for safe assets and excludes secret/env/session material", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-fts-body-"));
    createdDirs.push(root);
    const knowledge = path.join(root, "knowledge", "rotation.md");
    const session = path.join(root, "sessions", "raw.md");
    const checkpoint = path.join(root, "memories", "checkpoint.md");
    const secret = path.join(root, "secrets", "api-key.md");
    const env = path.join(root, "env", "production.env");
    fs.mkdirSync(path.dirname(knowledge), { recursive: true });
    fs.mkdirSync(path.dirname(session), { recursive: true });
    fs.mkdirSync(path.dirname(checkpoint), { recursive: true });
    fs.mkdirSync(path.dirname(secret), { recursive: true });
    fs.mkdirSync(path.dirname(env), { recursive: true });
    fs.writeFileSync(
      knowledge,
      [
        "---",
        "description: Operator notes",
        "---",
        "",
        "First paragraph.",
        "",
        "The spectral quokka calibration nonce is VioletCrane47.",
        "Read [![operator alt](https://IMAGE_PRIVATE_SENTINEL.test/token)](https://public.test) safely.",
        'Read [the guide](<https://public.test/path_(private)> "TITLE_PRIVATE_)_SENTINEL") safely.',
        "Read [the label](https://SECRET_PRIVATE.test/it's-token) safely.",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(session, "A raw transcript contains SESSION_PRIVATE_SENTINEL.\n");
    fs.writeFileSync(
      checkpoint,
      "---\ndescription: Session checkpoint\nakm_memory_kind: session_checkpoint\n---\n\nMEMORY_PRIVATE_SENTINEL\n",
    );
    fs.writeFileSync(secret, "SECRET_PRIVATE_SENTINEL\n");
    fs.writeFileSync(env, "AKM_TOKEN=ENV_PRIVATE_SENTINEL\n");

    const recognized = recognizeStashEntries(root, [knowledge, session, checkpoint, secret, env]).entries;
    const knowledgeEntry = recognized.find((entry) => entry.type === "knowledge");
    const sessionEntry = recognized.find((entry) => entry.type === "session");
    const checkpointEntry = recognized.find((entry) => entry.name === "checkpoint");
    const secretEntry = recognized.find((entry) => entry.type === "secret");
    const envEntry = recognized.find((entry) => entry.type === "env");

    if (!knowledgeEntry || !sessionEntry || !checkpointEntry || !secretEntry || !envEntry) {
      throw new Error("expected all fixture entries");
    }
    expect(knowledgeEntry?.content).toContain("spectral quokka calibration nonce");
    expect(buildSearchText(knowledgeEntry)).toContain("violetcrane47");
    expect(knowledgeEntry.content).toContain("operator alt");
    expect(knowledgeEntry.content).toContain("the guide");
    expect(buildSearchText(knowledgeEntry)).not.toContain("image_private_sentinel");
    expect(buildSearchText(knowledgeEntry)).not.toContain("title_private");
    expect(buildSearchText(knowledgeEntry)).not.toContain("secret_private");
    expect(sessionEntry?.content).toBeUndefined();
    expect(buildSearchText(sessionEntry)).not.toContain("session_private_sentinel");
    expect(checkpointEntry?.content).toBeUndefined();
    expect(buildSearchText(checkpointEntry)).not.toContain("memory_private_sentinel");
    expect(secretEntry?.content).toBeUndefined();
    expect(buildSearchText(secretEntry)).not.toContain("secret_private_sentinel");
    expect(envEntry?.content).toBeUndefined();
    expect(buildSearchText(envEntry)).not.toContain("env_private_sentinel");
  });

  test("marks entry.contentTruncated when the indexed body is cut, and leaves it unset otherwise (#866)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-fts-truncation-"));
    createdDirs.push(root);
    const long = path.join(root, "knowledge", "long.md");
    const short = path.join(root, "knowledge", "short.md");
    fs.mkdirSync(path.dirname(long), { recursive: true });
    fs.writeFileSync(long, `${"word ".repeat(MARKDOWN_CONTENT_MAX_CHARS)}tail\n`);
    fs.writeFileSync(short, "A short paragraph that never approaches the cap.\n");

    const recognized = recognizeStashEntries(root, [long, short]).entries;
    const longEntry = recognized.find((entry) => entry.name === "long");
    const shortEntry = recognized.find((entry) => entry.name === "short");
    if (!longEntry || !shortEntry) throw new Error("expected both fixture entries");

    expect(longEntry.contentTruncated).toBe(true);
    expect(longEntry.content?.length).toBeLessThanOrEqual(MARKDOWN_CONTENT_MAX_CHARS);
    expect(shortEntry.contentTruncated).toBeUndefined();
  });

  test("buildSearchText never truncates — a long document stays fully searchable and embeddable (#895)", () => {
    const messages: string[] = [];
    _setWarnSinkForTests((level, args) => {
      messages.push(`${level}:${args.map(String).join(" ")}`);
    });
    try {
      const longBody = `${"word ".repeat(4000)}tail-term-found-only-here`;
      const bigEntry: IndexDocument = { type: "knowledge", name: "big-entry", content: longBody };
      const searchText = buildSearchText(bigEntry);
      expect(searchText).toContain("tail-term-found-only-here");
      expect(searchText.length).toBeGreaterThan(20_000);
      expect(messages).toHaveLength(0);

      const smallEntry: IndexDocument = { type: "knowledge", name: "small-entry", content: "short body" };
      buildSearchText(smallEntry);
      expect(messages).toHaveLength(0);
    } finally {
      _setWarnSinkForTests(undefined);
    }
  });
});
