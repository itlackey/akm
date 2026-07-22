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
import { buildFileContext, type FileContext } from "../../../src/indexer/walk/file-context";

const FIXTURE_ROOT = path.join(import.meta.dir, "../../fixtures/bundles/okf-sample");
const BUNDLE_ID = "okf-sample";

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

  test("name <- title; description <- description; tags <- tags; updated <- timestamp", () => {
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

// ── placeNew / directoryList / looksLikeRoot ─────────────────────────────────

describe("okf adapter — placement / probe", () => {
  test("placeNew => <root>/<conceptId>.md", () => {
    expect(okfAdapter.placeNew?.(component(), "tables/new-thing")).toBe(path.join(FIXTURE_ROOT, "tables/new-thing.md"));
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

  test("a `timestamp` satisfies the freshness check — no `missing-updated` (§0.1)", async () => {
    const diags = await okfAdapter.validate(
      component(),
      [change("tables/orders.md", readFixture("tables/orders.md"))],
      makeValidateContext({ resolveRef: async () => ({ exists: true }) }),
    );
    expect(diags.some((d) => d.issue === "missing-updated")).toBe(false);
  });

  test("frontmatter present but no timestamp AND no updated => base `missing-updated` still fires", async () => {
    const diags = await okfAdapter.validate(
      component(),
      [change("notes/stale.md", "---\ntype: knowledge\ntitle: Stale\n---\n\nbody\n")],
      makeValidateContext({ resolveRef: async () => ({ exists: true }) }),
    );
    expect(diags.some((d) => d.issue === "missing-updated")).toBe(true);
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
