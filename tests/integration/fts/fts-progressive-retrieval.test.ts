import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import type { IndexDocument } from "../../../src/indexer/passes/metadata";
import { MARKDOWN_CONTENT_MAX_CHARS, projectMarkdownContent } from "../../../src/indexer/passes/metadata";
import { recognizeStashEntries } from "../../../src/indexer/scan/drain-dir";
import { buildSearchFields, buildSearchText } from "../../../src/indexer/search/search-fields";
import type { Database as AkmDatabase } from "../../../src/storage/database";
import { searchFts } from "../../../src/storage/repositories/index-fts-repository";

const createdDirs: string[] = [];

afterAll(() => {
  for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeDb(): AkmDatabase {
  const db = new Database(":memory:") as unknown as AkmDatabase;
  db.exec(`
    CREATE TABLE entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      item_ref TEXT NOT NULL UNIQUE,
      bundle_id TEXT NOT NULL,
      component_id TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      document_json TEXT NOT NULL,
      search_text TEXT NOT NULL,
      content_hash TEXT,
      derived_from TEXT
    );
    CREATE VIRTUAL TABLE entries_fts USING fts5(
      entry_id UNINDEXED,
      name,
      description,
      tags,
      hints,
      content,
      tokenize='porter unicode61'
    );
  `);
  return db;
}

function insert(db: AkmDatabase, name: string, entry: IndexDocument): void {
  const conceptId = `knowledge/${name}`;
  const inserted = db
    .prepare<{ id: number }>(`
      INSERT INTO entries (
        file_path, type, item_ref, bundle_id, component_id, concept_id,
        adapter_id, document_json, search_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `)
    .get(
      `/fixture/${conceptId}.md`,
      entry.type,
      `fixture//${conceptId}`,
      "fixture",
      "fixture",
      conceptId,
      "akm",
      JSON.stringify(entry),
      buildSearchText(entry),
    );
  if (!inserted) throw new Error("expected inserted retrieval fixture");
  const fields = buildSearchFields(entry);
  db.prepare(
    "INSERT INTO entries_fts (entry_id, name, description, tags, hints, content) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(inserted.id, fields.name, fields.description, fields.tags, fields.hints, fields.content);
}

describe("whole-document BM25 over any query word", () => {
  function fixtureDb(): AkmDatabase {
    const db = makeDb();
    insert(db, "identifier", {
      type: "knowledge",
      name: "cache-pruner",
      description: "Removes expired build artifacts",
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
    return db;
  }

  test("a document matching any non-stopword token is a candidate, best BM25 first", () => {
    const db = fixtureDb();
    try {
      const refs = (query: string) => searchFts(db, query, 10).map((hit) => hit.itemRef);
      expect(refs("cache-pruner")[0]).toBe("fixture//knowledge/identifier");
      expect(refs("CAFÉ déploiement")[0]).toBe("fixture//knowledge/unicode");
      // Requiring every word would find nothing here; any word finds both
      // quokka documents, the one matching more words first.
      expect(refs("how do I find the spectral quokka calibration nonce safely")).toEqual([
        "fixture//knowledge/body",
        "fixture//knowledge/structured",
      ]);
    } finally {
      db.close();
    }
  });

  test("stopwords match nothing unless the query is only stopwords", () => {
    const db = fixtureDb();
    try {
      // "the" and "every" appear in the body document, but "the" is a stopword
      // and is dropped while a content word remains.
      expect(searchFts(db, "the rotation", 10).map((hit) => hit.itemRef)).toEqual([
        "fixture//knowledge/structured",
        "fixture//knowledge/body",
      ]);
      expect(searchFts(db, "the", 10).map((hit) => hit.itemRef)).toEqual(["fixture//knowledge/body"]);
    } finally {
      db.close();
    }
  });

  test("equal BM25 scores are ordered by item_ref, and operators are plain words", () => {
    const db = makeDb();
    try {
      insert(db, "zeta", { type: "knowledge", name: "zeta", description: "twinmarker" });
      insert(db, "alpha", { type: "knowledge", name: "alpha", description: "twinmarker" });
      expect(searchFts(db, "twinmarker", 10).map((hit) => hit.itemRef)).toEqual([
        "fixture//knowledge/alpha",
        "fixture//knowledge/zeta",
      ]);
      expect(() => searchFts(db, 'NEAR OR and " ( ) *** the the', 3)).not.toThrow();
      expect(searchFts(db, '"()*:^{}', 3)).toEqual([]);
    } finally {
      db.close();
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
    expect(buildSearchText(knowledgeEntry)).toContain("VioletCrane47");
    expect(knowledgeEntry.content).toContain("operator alt");
    expect(knowledgeEntry.content).toContain("the guide");
    // Search text keeps its case, so the leak checks use the fixtures' own spelling.
    expect(buildSearchText(knowledgeEntry)).not.toContain("IMAGE_PRIVATE_SENTINEL");
    expect(buildSearchText(knowledgeEntry)).not.toContain("TITLE_PRIVATE");
    expect(buildSearchText(knowledgeEntry)).not.toContain("SECRET_PRIVATE");
    expect(sessionEntry?.content).toBeUndefined();
    expect(buildSearchText(sessionEntry)).not.toContain("SESSION_PRIVATE_SENTINEL");
    expect(checkpointEntry?.content).toBeUndefined();
    expect(buildSearchText(checkpointEntry)).not.toContain("MEMORY_PRIVATE_SENTINEL");
    expect(secretEntry?.content).toBeUndefined();
    expect(buildSearchText(secretEntry)).not.toContain("SECRET_PRIVATE_SENTINEL");
    expect(envEntry?.content).toBeUndefined();
    expect(buildSearchText(envEntry)).not.toContain("ENV_PRIVATE_SENTINEL");
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
