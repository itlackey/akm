// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Conformance gate for the `dotenv` adapter (#46) — the REDACTION oracle.
 *
 * Drives the adapter over `tests/fixtures/bundles/dotenv/` and asserts the four
 * authored goldens under `tests/fixtures/format-family-goldens/dotenv/`. The
 * load-bearing property (normative §21.2): env surfaces KEY NAMES only, secret
 * surfaces the FILE NAME only — VALUES / COMMENTS / raw CONTENT never appear on
 * the emitted document, and the redaction is keyed on the ADAPTER, not on the
 * open `type` value (a `secrets/*.env` is name-only even though it has KEY=VALUE
 * lines).
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { dotenvAdapter } from "../../../src/core/adapter/adapters/dotenv-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../../../src/core/adapter/types";
import type { FileChange } from "../../../src/core/file-change";
import { presentationFor } from "../../../src/core/type-presentation";
import { buildFileContext } from "../../../src/indexer/walk/file-context";

const FIXTURE_ROOT = path.join(import.meta.dir, "../../fixtures/bundles/dotenv");
const GOLDENS_ROOT = path.join(import.meta.dir, "../../fixtures/format-family-goldens/dotenv");
const BUNDLE_ID = "sample-dotenv";

function loadGolden(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(GOLDENS_ROOT, `${name}.json`), "utf8"));
}

function component(): BundleComponent {
  return { id: BUNDLE_ID, adapter: "dotenv", root: FIXTURE_ROOT, writable: true };
}

function recognizeRel(relPath: string): IndexDocument | null {
  return dotenvAdapter.recognize(component(), buildFileContext(FIXTURE_ROOT, path.join(FIXTURE_ROOT, relPath)));
}

/** Assert none of the value/secret tokens leak into the serialized document. */
function assertNoLeak(doc: IndexDocument, forbidden: string[]): void {
  const serialized = JSON.stringify(doc);
  for (const token of forbidden) {
    expect(serialized.includes(token), `must NOT leak "${token}"`).toBe(false);
  }
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

describe("dotenv adapter — metadata", () => {
  test("id / version", () => {
    expect(dotenvAdapter.id).toBe("dotenv");
    expect(dotenvAdapter.version).toBe("0.9.0");
  });
});

describe("dotenv adapter — recognition golden (env keys only / secret name only)", () => {
  const byRelPath = loadGolden("recognition").byRelPath as Record<string, Record<string, unknown>>;

  for (const [relPath, expected] of Object.entries(byRelPath)) {
    test(`recognize(${relPath})`, () => {
      const doc = recognizeRel(relPath);
      expect(doc, `${relPath} must be recognized`).not.toBeNull();
      if (!doc) throw new Error("unreachable");
      expect(doc.adapterId).toBe(expected.adapterId as string);
      expect(doc.component).toBe(expected.component as string);
      expect(doc.type).toBe(expected.type as string);
      expect(doc.conceptId).toBe(expected.conceptId as string);
      expect(doc.ref).toBe(expected.ref as string);
      expect(doc.name).toBe(expected.name as string);

      const surface = expected.indexedSurface as { keys: string[] | null; valuesIndexed: boolean };
      if (surface.keys === null) {
        // secret: no key surface, no content.
        expect(doc.hints ?? []).toEqual([]);
        expect(doc.content).toBeUndefined();
      } else {
        // env: KEY NAMES surfaced on `hints`, nothing else.
        expect(doc.hints ?? []).toEqual(surface.keys);
        expect(doc.content).toBeUndefined();
      }
    });
  }

  test("no env/secret VALUE ever leaks onto the emitted document", () => {
    assertNoLeak(recognizeRel("env/app.env") as IndexDocument, ["hello-from-dotenv"]);
    assertNoLeak(recognizeRel("env/dangerous.env") as IndexDocument, [
      "/tmp/evil",
      "--require",
      "placeholder-not-real",
    ]);
    // secret: name only — neither key names NOR values appear.
    assertNoLeak(recognizeRel("secrets/deploy-key") as IndexDocument, ["fixture-secret-value-not-real"]);
    assertNoLeak(recognizeRel("secrets/ci.env") as IndexDocument, [
      "CI_DEPLOY_TOKEN",
      "REGISTRY_USER",
      "placeholder-not-real",
    ]);
  });
});

describe("dotenv adapter — placement golden", () => {
  const golden = loadGolden("placement");
  const byType = golden.byType as Record<string, { conceptId: string; assetPath: string }>;
  const edge = golden.edgeCases as Record<string, { conceptId: string; assetPath: string }>;

  function relFromRoot(abs: string): string {
    return path.relative(FIXTURE_ROOT, abs).split(path.sep).join("/");
  }

  for (const [typeKey, expected] of Object.entries(byType)) {
    test(`placeNew(${typeKey}) → ${expected.assetPath}`, () => {
      const abs = dotenvAdapter.placeNew?.(component(), expected.conceptId);
      expect(relFromRoot(abs as string)).toBe(expected.assetPath);
    });
  }

  for (const [name, expected] of Object.entries(edge)) {
    test(`edge: ${name} → ${expected.assetPath}`, () => {
      const abs = dotenvAdapter.placeNew?.(component(), expected.conceptId);
      expect(relFromRoot(abs as string)).toBe(expected.assetPath);
    });
  }
});

describe("dotenv adapter — renderer golden (field-omission redaction)", () => {
  const byRelPath = loadGolden("renderer").byRelPath as Record<string, Record<string, unknown>>;

  for (const [relPath, expected] of Object.entries(byRelPath)) {
    test(`presentationFor(${relPath}) + redaction`, () => {
      const doc = recognizeRel(relPath) as IndexDocument;
      expect(doc.type).toBe(expected.type as string);
      const p = presentationFor(doc.type);
      expect(p.label).toBe(expected.label as string);
      // env → env-file renderer; secret → secret-file renderer (keyed on the type).
      expect(p.renderer).toBe(expected.renderer as string);

      const redaction = expected.redaction as { keys: string[] | null };
      if (redaction.keys === null) {
        expect(doc.hints ?? []).toEqual([]); // secret: not even key names
      } else {
        expect(doc.hints ?? []).toEqual(redaction.keys); // env: key names only
      }
      expect(doc.content).toBeUndefined(); // no raw content on either
    });
  }
});

describe("dotenv adapter — lint golden (dangerous-vault-key, .env-suffix-narrow)", () => {
  const perType = loadGolden("lint").perType as Record<string, { relPath: string; issues: Diagnostic[] }>;

  test("each file validates to exactly the golden's issue codes", async () => {
    const changes: FileChange[] = Object.values(perType).map((e) => ({
      path: e.relPath,
      op: "update" as const,
      after: fs.readFileSync(path.join(FIXTURE_ROOT, e.relPath), "utf8"),
    }));
    const diags = await dotenvAdapter.validate(component(), changes, ctx);
    const byFile = new Map<string, string[]>();
    for (const d of diags) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d.issue]);
    for (const entry of Object.values(perType)) {
      expect(byFile.get(entry.relPath) ?? [], entry.relPath).toEqual((entry.issues ?? []).map((i) => i.issue));
    }
  });

  test("env/dangerous.env fires two dangerous-vault-key findings (PATH, NODE_OPTIONS); the bare secret is not scanned", async () => {
    const mk = (rel: string): FileChange => ({
      path: rel,
      op: "update",
      after: fs.readFileSync(path.join(FIXTURE_ROOT, rel), "utf8"),
    });
    const dangerous = await dotenvAdapter.validate(component(), [mk("env/dangerous.env")], ctx);
    expect(dangerous.map((d) => d.issue)).toEqual(["dangerous-vault-key", "dangerous-vault-key"]);
    const bareSecret = await dotenvAdapter.validate(component(), [mk("secrets/deploy-key")], ctx);
    expect(bareSecret).toEqual([]);
  });
});
