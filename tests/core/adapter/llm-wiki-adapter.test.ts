// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Conformance gate for the first-class `llm-wiki` adapter (chunk-4, DEV-7).
 *
 * Drives the adapter over the authored SPECIFICATION fixture
 * `tests/fixtures/bundles/llm-wiki/` and asserts the four authored goldens
 * (`tests/fixtures/format-family-goldens/llm-wiki/{recognition,placement,renderer,lint}.json`).
 * The goldens are the oracle — the adapter is built to match them, not vice
 * versa. Each golden entry carries descriptive annotations (`derivation`,
 * `reason`, `citedBy`, `note`) that are NOT `IndexDocument` fields; the
 * assertions read only the golden fields that map onto the adapter's output.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { llmWikiAdapter } from "../../../src/core/adapter/adapters/llm-wiki-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../../../src/core/adapter/types";
import type { FileChange } from "../../../src/core/file-change";
import { presentationFor } from "../../../src/core/type-presentation";
import { buildFileContext } from "../../../src/indexer/walk/file-context";

const FIXTURE_ROOT = path.join(import.meta.dir, "../../fixtures/bundles/llm-wiki");
const GOLDENS_ROOT = path.join(import.meta.dir, "../../fixtures/format-family-goldens/llm-wiki");
/** The wiki's name = bundle id = the ref prefix the recognition golden pins (`sample-wiki//...`). */
const BUNDLE_ID = "sample-wiki";

function loadGolden(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(GOLDENS_ROOT, `${name}.json`), "utf8"));
}

function component(): BundleComponent {
  return { id: BUNDLE_ID, adapter: "llm-wiki", root: FIXTURE_ROOT, writable: true };
}

function recognizeRel(relPath: string): IndexDocument | null {
  return llmWikiAdapter.recognize(component(), buildFileContext(FIXTURE_ROOT, path.join(FIXTURE_ROOT, relPath)));
}

function docSources(doc: IndexDocument): string[] {
  const extras = doc.documentJson as { sources?: unknown } | undefined;
  return Array.isArray(extras?.sources) ? (extras.sources as string[]) : [];
}

// ── metadata ─────────────────────────────────────────────────────────────────

describe("llm-wiki adapter — metadata", () => {
  test("id / version / extensions", () => {
    expect(llmWikiAdapter.id).toBe("llm-wiki");
    expect(llmWikiAdapter.version).toBe("0.9.0");
    expect(llmWikiAdapter.extensions).toEqual([".md"]);
  });
});

// ── recognition golden ─────────────────────────────────────────────────────────

describe("llm-wiki adapter — recognition golden", () => {
  const golden = loadGolden("recognition");
  const byRelPath = golden.byRelPath as Record<string, Record<string, unknown>>;

  for (const [relPath, expected] of Object.entries(byRelPath)) {
    test(`recognize(${relPath}) matches the golden`, () => {
      const doc = recognizeRel(relPath);

      if (expected.recognized === false) {
        expect(doc, `${relPath} must be reserved (not indexed)`).toBeNull();
        return;
      }

      expect(doc, `${relPath} must be recognized`).not.toBeNull();
      if (!doc) throw new Error("unreachable");
      expect(doc.adapterId).toBe(expected.adapterId as string);
      expect(doc.component).toBe(expected.component as string);
      expect(doc.bundle).toBe(BUNDLE_ID);
      expect(doc.type).toBe(expected.type as string);
      expect(doc.conceptId).toBe(expected.conceptId as string);
      expect(doc.ref).toBe(expected.ref as string);
      expect(doc.name).toBe(expected.name as string);
      if (expected.description !== undefined) expect(doc.description).toBe(expected.description as string);
      if (expected.links !== undefined) expect(doc.links ?? []).toEqual(expected.links as string[]);
      if (expected.sources !== undefined) expect(docSources(doc)).toEqual(expected.sources as string[]);
    });
  }

  test("reciprocal xref + body link dedupe to a single target (http-caching ↔ varnish)", () => {
    const httpCaching = recognizeRel("pages/http-caching.md");
    const varnish = recognizeRel("pages/entities/varnish.md");
    expect(httpCaching?.links).toEqual(["pages/entities/varnish"]);
    expect(varnish?.links).toEqual(["pages/http-caching"]);
  });

  test("a broken xref still resolves to a (nonexistent) target conceptId on links", () => {
    const orphan = recognizeRel("pages/orphan.md");
    expect(orphan?.links).toEqual(["pages/does-not-exist"]);
  });
});

// ── placement golden ────────────────────────────────────────────────────────────

describe("llm-wiki adapter — placement golden", () => {
  const golden = loadGolden("placement");
  const byType = golden.byType as Record<string, { conceptId: string; assetPath: string; name: string }>;

  function relFromRoot(abs: string): string {
    return path.relative(FIXTURE_ROOT, abs).split(path.sep).join("/");
  }

  for (const [typeKey, expected] of Object.entries(byType)) {
    test(`placeNew(${typeKey}) → ${expected.assetPath}`, () => {
      const abs = llmWikiAdapter.placeNew?.(component(), expected.conceptId);
      expect(abs).toBeDefined();
      expect(relFromRoot(abs as string)).toBe(expected.assetPath);
      // name = the conceptId's last path segment (placement golden `name`).
      expect(expected.conceptId.split("/").pop()).toBe(expected.name);
    });
  }

  test("directoryList + looksLikeRoot are wired", () => {
    expect(llmWikiAdapter.directoryList?.(component())).toEqual(["."]);
    expect(llmWikiAdapter.looksLikeRoot?.(FIXTURE_ROOT)).toBe(true);
  });
});

// ── renderer golden ──────────────────────────────────────────────────────────────

describe("llm-wiki adapter — renderer golden (generic fallback, reading A)", () => {
  const golden = loadGolden("renderer");
  const byRelPath = golden.byRelPath as Record<string, Record<string, unknown>>;

  for (const [relPath, expected] of Object.entries(byRelPath)) {
    test(`presentationFor(${relPath}) → generic (${expected.label})`, () => {
      const doc = recognizeRel(relPath);
      expect(doc, `${relPath} must be recognized`).not.toBeNull();
      if (!doc) throw new Error("unreachable");
      expect(doc.type).toBe(expected.type as string);
      const presentation = presentationFor(doc.type);
      // The wiki page kinds + wiki-source are NOT in KNOWN_TYPES → generic.
      expect(presentation.label).toBe(expected.label as string);
      expect(presentation.renderer ?? null).toBe((expected.renderer as string | null) ?? null);
      const action = presentation.action ? presentation.action(doc.ref ?? "") : `akm show ${doc.ref}`;
      expect(action).toBe(expected.action as string);
    });
  }
});

// ── lint golden ────────────────────────────────────────────────────────────────

describe("llm-wiki adapter — lint golden (native wiki validation)", () => {
  const golden = loadGolden("lint");
  const perType = golden.perType as Record<string, { relPath?: string; relPaths?: string[]; issues: Diagnostic[] }>;

  /** The whole-wiki change set validate() cross-references (all non-fixture-doc files). */
  const ALL_FILES = [
    "schema.md",
    "index.md",
    "log.md",
    "raw/2026-07-http-rfc.md",
    "pages/http-caching.md",
    "pages/entities/varnish.md",
    "pages/orphan.md",
  ];

  function makeChanges(): FileChange[] {
    return ALL_FILES.map((rel) => ({
      path: rel,
      op: "update" as const,
      after: fs.readFileSync(path.join(FIXTURE_ROOT, rel), "utf8"),
    }));
  }

  const ctx: ValidateContext = {
    readFile: async (p) => {
      try {
        return fs.readFileSync(path.join(FIXTURE_ROOT, p), "utf8");
      } catch {
        return null;
      }
    },
    list: async () => [],
    resolveRef: async () => ({ exists: false }),
  };

  test("the whole-wiki validate produces exactly the golden's one broken-xref finding", async () => {
    const diags = await llmWikiAdapter.validate(component(), makeChanges(), ctx);
    // Only pages/orphan.md's broken xref surfaces; everything else is clean.
    expect(diags).toEqual([
      {
        file: "pages/orphan.md",
        issue: "broken-xref",
        detail:
          "warning: cross-reference target not found: pages/does-not-exist " +
          "(non-blocking; cross-references must point at pages that actually exist — wiki schema hard rule).",
        fixed: false,
      },
    ]);
  });

  test("per-type golden issue codes match", async () => {
    const diags = await llmWikiAdapter.validate(component(), makeChanges(), ctx);
    const byFile = new Map<string, Diagnostic[]>();
    for (const d of diags) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d]);

    for (const entry of Object.values(perType)) {
      const relPaths = entry.relPaths ?? (entry.relPath ? [entry.relPath] : []);
      for (const rel of relPaths) {
        const got = byFile.get(rel) ?? [];
        const expectedCodes = (entry.issues ?? []).map((i) => i.issue);
        expect(
          got.map((d) => d.issue),
          rel,
        ).toEqual(expectedCodes);
      }
    }
  });

  test("reserved files (schema/index/log) get no page checks", async () => {
    const diags = await llmWikiAdapter.validate(
      component(),
      [{ path: "schema.md", op: "update", after: fs.readFileSync(path.join(FIXTURE_ROOT, "schema.md"), "utf8") }],
      ctx,
    );
    expect(diags).toEqual([]);
  });
});
