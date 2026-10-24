// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-A gate — the reference `okf` adapter
 * (`src/core/adapter/adapters/okf-adapter.ts`), implementing
 * `docs/architecture/specs/akm-0.9.0-bundle-adapter-spec.md` §5 / §5.1 / §9.
 *
 * Recognition is driven off a real, conformant OKF fixture bundle
 * (`tests/fixtures/bundles/okf-sample/`) via the core `buildFileContext`
 * primitive; a handful of synthetic `FileContext`s cover the fallback / edge
 * cases the fixture does not carry (no title, no frontmatter).
 */

import { describe, expect, test } from "bun:test";
import type { Stats } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { okfAdapter, resolveOkfLinks } from "../../../src/core/adapter/adapters/okf-adapter";
import type { BundleComponent, Diagnostic, ValidateContext } from "../../../src/core/adapter/types";
import type { FileChange } from "../../../src/core/file-change";
import { presentationFor } from "../../../src/core/type-presentation";
import { buildFileContext, type FileContext } from "../../../src/indexer/walk/file-context";

const FIXTURE_ROOT = path.join(import.meta.dir, "../../fixtures/bundles/okf-sample");
const GOLDENS_ROOT = path.join(import.meta.dir, "../../fixtures/format-family-goldens/okf");
const BUNDLE_ID = "okf-sample";

function loadGolden(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(GOLDENS_ROOT, `${name}.json`), "utf8"));
}

function component(overrides: Partial<BundleComponent> = {}): BundleComponent {
  return { id: BUNDLE_ID, adapter: "okf", root: FIXTURE_ROOT, writable: true, ...overrides };
}

/** A real FileContext for a fixture-relative path. */
function fc(relPath: string): FileContext {
  return buildFileContext(FIXTURE_ROOT, path.join(FIXTURE_ROOT, relPath));
}

/** A synthetic FileContext with caller-supplied content — for cases the fixture doesn't carry. */
function synthetic(relPath: string, content: string): FileContext {
  return {
    absPath: path.join(FIXTURE_ROOT, relPath),
    relPath,
    ext: path.extname(relPath).toLowerCase(),
    fileName: path.basename(relPath),
    parentDir: path.basename(path.dirname(relPath)),
    parentDirAbs: path.dirname(path.join(FIXTURE_ROOT, relPath)),
    ancestorDirs: path.dirname(relPath) === "." ? [] : path.dirname(relPath).split("/"),
    stashRoot: FIXTURE_ROOT,
    content: () => content,
    frontmatter: () => null,
    stat: () => ({}) as Stats,
  };
}

function makeValidateContext(overrides: Partial<ValidateContext> = {}): ValidateContext {
  return {
    readFile: async () => null,
    list: async () => [],
    resolveRef: async () => ({ exists: false }),
    ...overrides,
  };
}

// ── adapter metadata ─────────────────────────────────────────────────────────

describe("okf adapter — metadata", () => {
  test("id / version / extensions per §5", () => {
    expect(okfAdapter.id).toBe("okf");
    expect(okfAdapter.version).toBe("0.9.0");
    expect(okfAdapter.extensions).toEqual([".md"]);
  });
});

// ── recognize: `type` from frontmatter (§5.1 BINDING) ────────────────────────

describe("okf adapter — recognize reads `type` from frontmatter", () => {
  test("free-form OKF type is read verbatim from frontmatter", () => {
    const doc = okfAdapter.recognize(component(), fc("tables/orders.md"));
    expect(doc?.type).toBe("BigQuery Table");
  });

  test("a second free-form type (Metric) is read verbatim", () => {
    const doc = okfAdapter.recognize(component(), fc("metrics/wau.md"));
    expect(doc?.type).toBe("Metric");
  });

  test("type ABSENT from frontmatter => `knowledge` default", () => {
    const doc = okfAdapter.recognize(component(), fc("guides/onboarding.md"));
    expect(doc?.type).toBe("knowledge");
  });

  test("no frontmatter at all => `knowledge` default", () => {
    const doc = okfAdapter.recognize(component(), synthetic("notes/plain.md", "# Plain\n\nNo frontmatter here.\n"));
    expect(doc?.type).toBe("knowledge");
  });

  test("blank/whitespace `type` falls back to the `knowledge` default (non-empty string only)", () => {
    const doc = okfAdapter.recognize(component(), synthetic("notes/blank.md", '---\ntype: "  "\n---\n\nbody\n'));
    expect(doc?.type).toBe("knowledge");
  });

  test("the directory NEVER determines type (no directory gate) — a `tables/` doc with Metric type stays Metric", () => {
    const doc = okfAdapter.recognize(component(), synthetic("tables/weird.md", "---\ntype: Metric\n---\n\nbody\n"));
    expect(doc?.type).toBe("Metric");
  });
});

// ── recognize: reserved files ────────────────────────────────────────────────

describe("okf adapter — reserved files return null (§5, OKF §1.4)", () => {
  test("root index.md and log.md are excluded", () => {
    expect(okfAdapter.recognize(component(), fc("index.md"))).toBeNull();
    expect(okfAdapter.recognize(component(), fc("log.md"))).toBeNull();
  });

  test("nested index.md is excluded at any level", () => {
    expect(okfAdapter.recognize(component(), fc("tables/index.md"))).toBeNull();
  });

  test("reserved-file match is case-insensitive", () => {
    expect(okfAdapter.recognize(component(), synthetic("INDEX.MD", "# listing\n"))).toBeNull();
    expect(okfAdapter.recognize(component(), synthetic("sub/Log.md", "# log\n"))).toBeNull();
  });

  test("a non-.md file is abstained on (null)", () => {
    expect(okfAdapter.recognize(component(), synthetic("data.json", "{}"))).toBeNull();
  });
});

// ── recognize: conceptId / ref / projection ──────────────────────────────────

describe("okf adapter — conceptId + OKF field projection (§0.1/§3)", () => {
  test("conceptId = path within component root minus `.md`; ref = `<c.id>//<conceptId>`", () => {
    const doc = okfAdapter.recognize(component(), fc("tables/orders.md"));
    expect(doc?.conceptId).toBe("tables/orders");
    expect(doc?.ref).toBe("okf-sample//tables/orders");
    expect(doc?.bundle).toBe(BUNDLE_ID);
    expect(doc?.component).toBe(BUNDLE_ID);
    expect(doc?.adapterId).toBe("okf");
  });

  test("name <- title; description <- description; tags <- tags; updated <- legacy timestamp fallback (v0.1 fixture carries no `generated`)", () => {
    const doc = okfAdapter.recognize(component(), fc("tables/orders.md"));
    expect(doc?.name).toBe("Orders");
    expect(doc?.description).toBe("One row per completed customer order.");
    expect(doc?.tags).toEqual(["sales", "revenue"]);
    expect(doc?.updated).toBe("2026-05-28T14:30:00Z");
  });

  test("name falls back to the last path segment when `title` is absent", () => {
    const doc = okfAdapter.recognize(component(), synthetic("tables/no_title.md", "---\ntype: Metric\n---\n\nbody\n"));
    expect(doc?.name).toBe("no_title");
  });

  test("content is the body; hash is a sha256 hex digest", () => {
    const doc = okfAdapter.recognize(component(), fc("metrics/wau.md"));
    expect(doc?.content).toContain("WAU counts distinct");
    expect(doc?.content).not.toContain("type: Metric"); // frontmatter excluded from content
    expect(doc?.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── recognize: v0.2 `updated` precedence (generated.at over legacy timestamp) ─

describe("okf adapter — v0.2 `updated` precedence: generated.at over legacy timestamp fallback", () => {
  test("generated.at WINS when both generated.at and legacy timestamp are present (v0.2 breaking change)", () => {
    const doc = okfAdapter.recognize(
      component(),
      synthetic(
        "reports/both.md",
        "---\ntype: Report\ngenerated:\n  by: human:jdoe\n  at: 2026-06-20T22:53:05Z\ntimestamp: 2020-01-01T00:00:00Z\n---\n\nbody\n",
      ),
    );
    expect(doc?.updated).toBe("2026-06-20T22:53:05Z");
  });

  test("generated.at is used when legacy timestamp is absent entirely", () => {
    const doc = okfAdapter.recognize(
      component(),
      synthetic(
        "reports/generated-only.md",
        "---\ntype: Report\ngenerated:\n  by: human:jdoe\n  at: 2026-06-21T00:00:00Z\n---\n\nbody\n",
      ),
    );
    expect(doc?.updated).toBe("2026-06-21T00:00:00Z");
  });

  test("legacy timestamp is used as the fallback when generated (or generated.at) is absent — the v0.2-permitted fallback", () => {
    const doc = okfAdapter.recognize(
      component(),
      synthetic("reports/timestamp-only.md", "---\ntype: Report\ntimestamp: 2020-01-01T00:00:00Z\n---\n\nbody\n"),
    );
    expect(doc?.updated).toBe("2020-01-01T00:00:00Z");
  });

  test("a `generated` mapping missing `at` still falls back to legacy timestamp (tolerant of a malformed generated block)", () => {
    const doc = okfAdapter.recognize(
      component(),
      synthetic(
        "reports/generated-no-at.md",
        "---\ntype: Report\ngenerated:\n  by: human:jdoe\ntimestamp: 2020-01-01T00:00:00Z\n---\n\nbody\n",
      ),
    );
    expect(doc?.updated).toBe("2020-01-01T00:00:00Z");
  });

  test("neither generated.at nor timestamp present => `updated` stays undefined (both remain optional)", () => {
    const doc = okfAdapter.recognize(component(), synthetic("reports/neither.md", "---\ntype: Report\n---\n\nbody\n"));
    expect(doc?.updated).toBeUndefined();
  });
});

// ── recognize: v0.2 trust/provenance/lifecycle families (§0.1, okf-support.md v0.2 note) ─

describe("okf adapter — v0.2 provenance family: generated/verified/sources land under the NAMESPACED `provenance` field (D1.3 collision avoidance)", () => {
  test("generated {by, at} populates provenance.generatedBy / provenance.generatedAt", () => {
    const doc = okfAdapter.recognize(
      component(),
      synthetic(
        "reports/gen.md",
        "---\ntype: Report\ngenerated:\n  by: reference_agent/gemini-2.5-pro\n  at: 2026-06-20T22:53:05Z\n---\n\nbody\n",
      ),
    );
    expect(doc?.provenance?.generatedBy).toBe("reference_agent/gemini-2.5-pro");
    expect(doc?.provenance?.generatedAt).toBe("2026-06-20T22:53:05Z");
  });

  test("verified LIST form (multiple entries) populates provenance.verified", () => {
    const doc = okfAdapter.recognize(
      component(),
      synthetic(
        "reports/verified-list.md",
        "---\ntype: Report\nverified:\n  - by: human:ahormati\n    at: 2026-06-25T09:00:00Z\n  - by: process:finance-nightly\n    at: 2026-06-26T03:00:00Z\n---\n\nbody\n",
      ),
    );
    expect(doc?.provenance?.verified).toEqual([
      { by: "human:ahormati", at: "2026-06-25T09:00:00Z" },
      { by: "process:finance-nightly", at: "2026-06-26T03:00:00Z" },
    ]);
  });

  test("verified SINGLE-MAPPING form (no list dash, v0.2 §-permitted shorthand) normalizes to a one-element array", () => {
    const doc = okfAdapter.recognize(
      component(),
      synthetic(
        "reports/verified-single.md",
        "---\ntype: Report\nverified:\n  by: human:ahormati\n  at: 2026-06-18T00:05:00Z\n---\n\nbody\n",
      ),
    );
    expect(doc?.provenance?.verified).toEqual([{ by: "human:ahormati", at: "2026-06-18T00:05:00Z" }]);
  });

  test("a verified entry missing `at` is still recorded with just `by`", () => {
    const doc = okfAdapter.recognize(
      component(),
      synthetic("reports/verified-no-at.md", "---\ntype: Report\nverified:\n  by: human:ahormati\n---\n\nbody\n"),
    );
    expect(doc?.provenance?.verified).toEqual([{ by: "human:ahormati" }]);
  });

  test("a verified entry missing `by` is dropped (tolerant — never rejects the document)", () => {
    const doc = okfAdapter.recognize(
      component(),
      synthetic("reports/verified-no-by.md", "---\ntype: Report\nverified:\n  at: 2026-06-18T00:05:00Z\n---\n\nbody\n"),
    );
    expect(doc).not.toBeNull();
    expect(doc?.provenance).toBeUndefined();
  });

  test("v0.2 OBJECT-LIST `sources` survive INTACT under provenance.sources — today they would be dropped if folded onto the bare native `sources` string field", () => {
    const doc = okfAdapter.recognize(
      component(),
      synthetic(
        "reports/sources.md",
        [
          "---",
          "type: Report",
          "sources:",
          "  - resource: https://example.com/data/q3-export.csv",
          "    id: main-dataset",
          "    title: Q3 sales export",
          "    author: human:jdoe",
          "    usage_count: 42",
          '    last_modified: "2026-06-01"',
          "  - resource: gs://acme-bucket/q3/events.parquet",
          "---",
          "",
          "body",
          "",
        ].join("\n"),
      ),
    );
    expect(doc?.provenance?.sources).toEqual([
      {
        resource: "https://example.com/data/q3-export.csv",
        id: "main-dataset",
        title: "Q3 sales export",
        author: "human:jdoe",
        usage_count: 42,
        last_modified: "2026-06-01",
      },
      { resource: "gs://acme-bucket/q3/events.parquet" },
    ]);
    // The PRE-EXISTING AKM-native `sources: string[]` field (wiki citations, D1.3
    // collision) must NEVER be populated by the okf adapter — it is a completely
    // different field from `provenance.sources`.
    expect(doc?.sources).toBeUndefined();
  });

  test("a `sources` entry missing `resource` is dropped (tolerant); an empty/all-dropped list leaves provenance.sources unset", () => {
    const doc = okfAdapter.recognize(
      component(),
      synthetic(
        "reports/sources-malformed.md",
        "---\ntype: Report\nsources:\n  - title: No resource here\n---\n\nbody\n",
      ),
    );
    expect(doc?.provenance).toBeUndefined();
  });

  test("status is read into lifecycleStatus for each of draft/stable/deprecated", () => {
    for (const status of ["draft", "stable", "deprecated"] as const) {
      const doc = okfAdapter.recognize(
        component(),
        synthetic(`reports/status-${status}.md`, `---\ntype: Report\nstatus: ${status}\n---\n\nbody\n`),
      );
      expect(doc?.lifecycleStatus).toBe(status);
    }
  });

  test("an unrecognized status value is ignored (never rejects; lifecycleStatus stays unset)", () => {
    const doc = okfAdapter.recognize(
      component(),
      synthetic("reports/status-bogus.md", "---\ntype: Report\nstatus: not-a-real-status\n---\n\nbody\n"),
    );
    expect(doc?.lifecycleStatus).toBeUndefined();
  });

  test("stale_after is read verbatim into staleAfter", () => {
    const doc = okfAdapter.recognize(
      component(),
      synthetic("reports/stale.md", '---\ntype: Report\nstale_after: "2026-12-31"\n---\n\nbody\n'),
    );
    expect(doc?.staleAfter).toBe("2026-12-31");
  });

  test("okf_version is read into okfVersion best-effort (Rule 9) even on a non-root concept", () => {
    const doc = okfAdapter.recognize(
      component(),
      synthetic("reports/versioned.md", '---\ntype: Report\nokf_version: "0.2"\n---\n\nbody\n'),
    );
    expect(doc?.okfVersion).toBe("0.2");
  });

  test("a concept with none of the v0.2 families sets no v0.2 fields (fully optional, never defaulted)", () => {
    const doc = okfAdapter.recognize(component(), synthetic("reports/none.md", "---\ntype: Report\n---\n\nbody\n"));
    expect(doc?.provenance).toBeUndefined();
    expect(doc?.lifecycleStatus).toBeUndefined();
    expect(doc?.staleAfter).toBeUndefined();
    expect(doc?.okfVersion).toBeUndefined();
  });

  test("generated/verified/sources/status/stale_after/okf_version never leak into documentJson (no duplication with the first-class fields)", () => {
    const doc = okfAdapter.recognize(
      component(),
      synthetic(
        "reports/all-families.md",
        [
          "---",
          "type: Report",
          "generated:",
          "  by: human:jdoe",
          "  at: 2026-06-20T22:53:05Z",
          "verified:",
          "  by: human:jdoe",
          "  at: 2026-06-20T23:00:00Z",
          "sources:",
          "  - resource: https://example.com/a.csv",
          "status: stable",
          'stale_after: "2026-12-31"',
          'okf_version: "0.2"',
          "vendor_extra: keep-me",
          "---",
          "",
          "body",
          "",
        ].join("\n"),
      ),
    );
    expect(doc?.documentJson).toEqual({ vendor_extra: "keep-me" });
  });

  test("wildly malformed v0.2 fields (wrong shapes) never throw and never reject the document", () => {
    expect(() =>
      okfAdapter.recognize(
        component(),
        synthetic(
          "reports/garbage.md",
          [
            "---",
            "type: Report",
            "generated: not-a-mapping",
            "verified: 12345",
            "sources: { not: an-array }",
            "status: [draft]",
            "stale_after:",
            "  nested: object",
            "okf_version: 2",
            "---",
            "",
            "body",
            "",
          ].join("\n"),
        ),
      ),
    ).not.toThrow();
    const doc = okfAdapter.recognize(
      component(),
      synthetic(
        "reports/garbage.md",
        [
          "---",
          "type: Report",
          "generated: not-a-mapping",
          "verified: 12345",
          "sources: { not: an-array }",
          "status: [draft]",
          "stale_after:",
          "  nested: object",
          "okf_version: 2",
          "---",
          "",
          "body",
          "",
        ].join("\n"),
      ),
    );
    expect(doc?.type).toBe("Report");
    expect(doc?.provenance).toBeUndefined();
    expect(doc?.lifecycleStatus).toBeUndefined();
    expect(doc?.staleAfter).toBeUndefined();
    expect(doc?.okfVersion).toBeUndefined();
  });
});

// ── links: both OKF forms (§9) ───────────────────────────────────────────────

describe("okf adapter — OKF link resolution, both forms (§9)", () => {
  test("`/`-rooted and relative links both resolve to component-root-relative conceptIds", () => {
    const doc = okfAdapter.recognize(component(), fc("tables/orders.md"));
    // `/tables/customers.md` (dedup of two occurrences) + `../metrics/wau.md`
    expect(doc?.links).toEqual(["tables/customers", "metrics/wau"]);
  });

  test("standard relative same-dir link resolves", () => {
    const doc = okfAdapter.recognize(component(), fc("tables/customers.md"));
    expect(doc?.links).toEqual(["tables/orders"]); // ./orders.md
  });

  test("resolveOkfLinks handles `/`-rooted, `./`, and `../` forms directly", () => {
    const body = [
      "[a](/tables/customers.md)",
      "[b](./sibling.md)",
      "[c](../metrics/wau.md)",
      "[ext](https://example.com/x.md)", // external scheme dropped
      "[anchor](#section)", // no .md dropped
      "[img](/logo.png)", // non-.md dropped
    ].join("\n\n");
    expect(resolveOkfLinks(body, "tables/orders.md")).toEqual(["tables/customers", "tables/sibling", "metrics/wau"]);
  });

  test("a relative link that escapes the component root is dropped (tolerant)", () => {
    expect(resolveOkfLinks("[out](../../outside.md)", "tables/orders.md")).toEqual([]);
  });

  test("a concept with no links has no `links` field", () => {
    const doc = okfAdapter.recognize(component(), synthetic("notes/plain.md", "# Plain\n\nNo links.\n"));
    expect(doc?.links).toBeUndefined();
  });
});

// ── authoring / directoryList / looksLikeRoot ────────────────────────────────

describe("okf adapter — placement / probe", () => {
  test("is consumer-only (no adapter-owned placement/authoring)", () => {
    expect(okfAdapter.placeNew).toBeUndefined();
  });

  test("directoryList => ['.']", () => {
    expect(okfAdapter.directoryList?.(component())).toEqual(["."]);
  });

  test("looksLikeRoot fires on a root WITH index.md", () => {
    expect(okfAdapter.looksLikeRoot?.(FIXTURE_ROOT)).toBe(true);
  });

  test("looksLikeRoot does NOT fire on a root lacking index.md", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "akm-okf-noindex-"));
    try {
      expect(okfAdapter.looksLikeRoot?.(empty)).toBe(false);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test("looksLikeRoot recognizes a conformant index-less OKF bundle", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-okf-noindex-"));
    try {
      fs.writeFileSync(path.join(root, "vendor.md"), "---\ntype: Vendor Type\n---\n\nBody.\n");
      expect(okfAdapter.looksLikeRoot?.(root)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── validate: LENIENT (§5) ───────────────────────────────────────────────────

function change(relPath: string, after: string): FileChange {
  return { path: relPath, op: "update", after };
}

function readFixture(relPath: string): string {
  return fs.readFileSync(path.join(FIXTURE_ROOT, relPath), "utf8");
}

describe("okf adapter — validate is LENIENT (§5)", () => {
  test("missing `type` => an INFO diagnostic (issue `missing-type`), never an error", async () => {
    const diags = await okfAdapter.validate(
      component(),
      [change("guides/onboarding.md", readFixture("guides/onboarding.md"))],
      makeValidateContext({ resolveRef: async () => ({ exists: true }) }),
    );
    const missingType = diags.find((d) => d.issue === "missing-type");
    expect(missingType).toBeDefined();
    expect(missingType?.detail).toContain("info:");
    expect(missingType?.detail.toLowerCase()).toContain("non-blocking");
    expect(missingType?.fixed).toBe(false);
  });

  test("a concept WITH a `type` does not get a missing-type diagnostic", async () => {
    const diags = await okfAdapter.validate(
      component(),
      [change("tables/orders.md", readFixture("tables/orders.md"))],
      makeValidateContext({ resolveRef: async () => ({ exists: true }) }),
    );
    expect(diags.some((d) => d.issue === "missing-type")).toBe(false);
  });

  test("a broken OKF link => a non-blocking WARNING (issue `missing-ref`)", async () => {
    const diags = await okfAdapter.validate(
      component(),
      [change("tables/orders.md", readFixture("tables/orders.md"))],
      makeValidateContext({ resolveRef: async () => ({ exists: false }) }),
    );
    const missingRefs = diags.filter((d) => d.issue === "missing-ref");
    expect(missingRefs.length).toBeGreaterThan(0);
    for (const d of missingRefs) {
      expect(d.detail.toLowerCase()).toContain("warning");
      expect(d.detail.toLowerCase()).toContain("non-blocking");
      expect(d.fixed).toBe(false);
    }
  });

  test("resolvable OKF links produce no missing-ref diagnostics", async () => {
    const diags = await okfAdapter.validate(
      component(),
      [change("tables/orders.md", readFixture("tables/orders.md"))],
      makeValidateContext({ resolveRef: async () => ({ exists: true }) }),
    );
    expect(diags.some((d) => d.issue === "missing-ref")).toBe(false);
  });

  test("a `timestamp` satisfies the freshness check — no `missing-updated` (§0.1, legacy v0.1 fallback)", async () => {
    const diags = await okfAdapter.validate(
      component(),
      [change("tables/orders.md", readFixture("tables/orders.md"))],
      makeValidateContext({ resolveRef: async () => ({ exists: true }) }),
    );
    expect(diags.some((d) => d.issue === "missing-updated")).toBe(false);
  });

  test("a v0.2 `generated.at` (no legacy timestamp) ALSO satisfies the freshness check — no `missing-updated`", async () => {
    const diags = await okfAdapter.validate(
      component(),
      [
        change(
          "reports/generated-only.md",
          "---\ntype: Report\ngenerated:\n  by: human:jdoe\n  at: 2026-06-20T22:53:05Z\n---\n\nbody\n",
        ),
      ],
      makeValidateContext({ resolveRef: async () => ({ exists: true }) }),
    );
    expect(diags.some((d) => d.issue === "missing-updated")).toBe(false);
  });

  test("missing optional timestamp never produces AKM's `missing-updated` diagnostic", async () => {
    const diags = await okfAdapter.validate(
      component(),
      [change("notes/stale.md", "---\ntype: knowledge\ntitle: Stale\n---\n\nbody\n")],
      makeValidateContext({ resolveRef: async () => ({ exists: true }) }),
    );
    expect(diags.some((d) => d.issue === "missing-updated")).toBe(false);
  });

  test("neither timestamp nor generated present — still no `missing-updated` (both remain fully optional under v0.2)", async () => {
    const diags = await okfAdapter.validate(
      component(),
      [change("reports/neither.md", "---\ntype: Report\n---\n\nbody\n")],
      makeValidateContext({ resolveRef: async () => ({ exists: true }) }),
    );
    expect(diags.some((d) => d.issue === "missing-updated")).toBe(false);
  });

  test("unknown frontmatter keys never fail; delete changes are skipped; validate does not throw", async () => {
    const diags = await okfAdapter.validate(
      component(),
      [
        change("notes/extra.md", "---\ntype: knowledge\ntimestamp: 2026-01-01\nproducerKey: anything\n---\n\nbody\n"),
        { path: "gone.md", op: "delete" },
      ],
      makeValidateContext({ resolveRef: async () => ({ exists: true }) }),
    );
    // No diagnostic keyed on the unknown `producerKey`; nothing thrown.
    expect(diags.every((d: Diagnostic) => !d.detail.includes("producerKey"))).toBe(true);
  });

  test("reserved index.md is not treated as a concept (no missing-type)", async () => {
    const diags = await okfAdapter.validate(
      component(),
      [change("index.md", readFixture("index.md"))],
      makeValidateContext({ resolveRef: async () => ({ exists: false }) }),
    );
    expect(diags.some((d) => d.issue === "missing-type")).toBe(false);
  });
});

// ── Format-family goldens (#730 D3.3) ───────────────────────────────────────
//
// OKF was the only BUILTIN_ADAPTERS entry without a
// tests/fixtures/format-family-goldens/<family>/ directory (scripts/lint-
// goldens-presence.ts triage). Mirrors the shape the other nine families use
// (recognition/placement/renderer/lint.json), driven off the SAME frozen
// tests/fixtures/bundles/okf-sample/ fixture the tests above already use —
// unlike those nine (authored ahead of their adapters as spec-authored
// targets), this golden captures the OKF adapter's REAL, already-shipped
// output (`specificationGolden: false`, a real `capturedAtHead`).

describe("okf adapter — recognition golden", () => {
  const golden = loadGolden("recognition");
  const byRelPath = golden.byRelPath as Record<string, Record<string, unknown>>;

  for (const [relPath, expected] of Object.entries(byRelPath)) {
    test(`recognize(${relPath})`, () => {
      const doc = okfAdapter.recognize(component(), fc(relPath));
      if (expected.recognized === false) {
        expect(doc, `${relPath} must NOT be recognized (reserved)`).toBeNull();
        return;
      }
      expect(doc, `${relPath} must be recognized`).not.toBeNull();
      if (!doc) throw new Error("unreachable");
      expect(doc.adapterId).toBe(expected.adapterId as string);
      expect(doc.component).toBe(expected.component as string);
      expect(doc.type).toBe(expected.type as string);
      expect(doc.conceptId).toBe(expected.conceptId as string);
      expect(doc.ref).toBe(expected.ref as string);
      expect(doc.name).toBe(expected.name as string);
      expect(doc.description).toBe(expected.description as string | undefined);
      expect(doc.tags).toEqual(expected.tags as string[] | undefined);
      expect(doc.updated).toBe(expected.updated as string | undefined);
      expect(doc.links).toEqual(expected.links as string[] | undefined);
    });
  }
});

describe("okf adapter — placement golden (consumer-only, no placeNew)", () => {
  test("placeNew is undefined for every type — the adapter never places a new concept", () => {
    const golden = loadGolden("placement");
    const byType = golden.byType as Record<string, { readOnly: boolean; placeNew: null }>;
    expect(byType["*"]?.readOnly).toBe(true);
    expect(byType["*"]?.placeNew).toBeNull();
    expect(okfAdapter.placeNew).toBeUndefined();
  });
});

describe("okf adapter — renderer golden (presentationFor is adapter-agnostic, keyed on the open type string)", () => {
  const golden = loadGolden("renderer");
  const byType = golden.byType as Record<string, { label: string; renderer: string | null }>;

  for (const [type, expected] of Object.entries(byType)) {
    test(`presentationFor(${JSON.stringify(type)})`, () => {
      const p = presentationFor(type);
      expect(p.label).toBe(expected.label);
      expect(p.renderer ?? null).toBe(expected.renderer);
    });
  }

  test("every type recognized in the golden fixture is covered above", () => {
    const seen = new Set<string>();
    for (const relPath of Object.keys((loadGolden("recognition").byRelPath as Record<string, unknown>) ?? {})) {
      const doc = okfAdapter.recognize(component(), fc(relPath));
      if (doc) seen.add(doc.type);
    }
    expect([...seen].sort()).toEqual(Object.keys(byType).sort());
  });
});

describe("okf adapter — lint golden", () => {
  const golden = loadGolden("lint");
  const perType = golden.perType as Record<string, { relPath: string; issues: Diagnostic[] }>;

  test("each fixture file validates to exactly the golden's issue list", async () => {
    const changes: FileChange[] = Object.values(perType).map((e) => ({
      path: e.relPath,
      op: "update" as const,
      after: readFixture(e.relPath),
    }));
    const diags = await okfAdapter.validate(
      component(),
      changes,
      makeValidateContext({
        resolveRef: async (ref) => ({ exists: fs.existsSync(path.join(FIXTURE_ROOT, `${ref}.md`)) }),
      }),
    );
    const byFile = new Map<string, Diagnostic[]>();
    for (const d of diags) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d]);
    for (const entry of Object.values(perType)) {
      expect(byFile.get(entry.relPath) ?? [], entry.relPath).toEqual(entry.issues ?? []);
    }
  });
});
