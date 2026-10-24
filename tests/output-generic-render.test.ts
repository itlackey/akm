// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * D7 — generic `md` / `html` rendering of a shaped output envelope.
 *
 * These are the fallbacks that make all six `--format` values work on every
 * command: before D7, `md` silently emitted the JSON envelope everywhere
 * except `akm health` and `html` threw everywhere except `akm health`. A
 * command with no registered renderer must now still produce a real rendering
 * of its own envelope — not JSON wearing a `.md` extension, and not a throw.
 *
 * The bar these pin is deliberately behavioural rather than cosmetic: every
 * RESULT value present in the envelope must be present in the output, arrays
 * of uniform objects must render as a table rather than as an opaque blob,
 * and the HTML must escape rather than interpolate. The one narrowing: root
 * `shape`/`schemaVersion` are envelope transport metadata, not a result, and
 * are dropped — see `ENVELOPE_META_KEYS` in `src/output/generic-render.ts`.
 * That filter is root-only, so a per-entry `schemaVersion` one level down
 * (e.g. each event in `log list`'s `events[]`) still must survive.
 */

import { describe, expect, test } from "bun:test";
import { renderGenericHtml, renderGenericMarkdown } from "../src/output/generic-render";

describe("renderGenericMarkdown", () => {
  test("renders scalar fields as a definition list under a command heading", () => {
    const md = renderGenericMarkdown("remember", { ok: true, ref: "memories/note", count: 3 });

    expect(md).toContain("# remember");
    expect(md).toContain("ok");
    expect(md).toContain("true");
    expect(md).toContain("memories/note");
    expect(md).toContain("3");
  });

  test("renders an array of uniform objects as a table with a column per key", () => {
    const md = renderGenericMarkdown("search", {
      hits: [
        { ref: "memories/a", score: 2 },
        { ref: "memories/b", score: 1 },
      ],
    });

    // A table, not a dump: header cells for both keys and a separator row.
    expect(md).toContain("| ref | score |");
    expect(md).toMatch(/\|\s*---\s*\|/);
    expect(md).toContain("memories/a");
    expect(md).toContain("memories/b");
  });

  test("renders an array of scalars as a list", () => {
    const md = renderGenericMarkdown("config-list", { keys: ["engines", "bundles"] });

    expect(md).toContain("- engines");
    expect(md).toContain("- bundles");
  });

  test("renders nested objects rather than dropping them", () => {
    const md = renderGenericMarkdown("info", { workspace: { stashDir: "/tmp/stash", bundles: 2 } });

    expect(md).toContain("/tmp/stash");
    expect(md).toContain("2");
  });

  test("never returns an empty document, even for an empty envelope", () => {
    expect(renderGenericMarkdown("noop", {}).trim().length).toBeGreaterThan(0);
    expect(renderGenericMarkdown("noop", null).trim().length).toBeGreaterThan(0);
  });

  test("escapes pipes in cell values so a table row cannot be broken", () => {
    const md = renderGenericMarkdown("search", { hits: [{ ref: "a|b", score: 1 }] });

    const rowLine = md.split("\n").find((line) => line.includes("a")) ?? "";
    expect(rowLine).not.toContain("a|b");
    expect(md).toContain("a\\|b");
  });

  test("drops root-level shape/schemaVersion envelope metadata as sections (F3)", () => {
    const md = renderGenericMarkdown("secret-list", {
      shape: "sentinel-shape-value",
      schemaVersion: 424242,
      items: ["a"],
    });

    expect(md).not.toContain("## shape");
    expect(md).not.toContain("## schemaVersion");
    expect(md).not.toContain("sentinel-shape-value");
    expect(md).not.toContain("424242");
    expect(md).toContain("## items");
    expect(md).toContain("- a");
  });

  test("keeps a per-entry schemaVersion one level down (e.g. log list's events[])", () => {
    const md = renderGenericMarkdown("log-list", {
      shape: "log-list",
      schemaVersion: 1,
      events: [{ id: "evt-1", schemaVersion: 2 }],
    });

    expect(md).not.toContain("## shape");
    expect(md).toContain("## events");
    // The nested `schemaVersion` is per-entry content (a table column here,
    // since `events` is a uniform-object array), not envelope metadata — the
    // root-only filter must not eat it.
    expect(md).toContain("| id | schemaVersion |");
    expect(md).toContain("| evt-1 | 2 |");
  });
});

describe("renderGenericHtml", () => {
  test("produces a self-contained document carrying the envelope's values", () => {
    const html = renderGenericHtml("show", { ref: "knowledge/guide", type: "knowledge" });

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("</html>");
    expect(html).toContain("knowledge/guide");
    expect(html).toContain("knowledge");
  });

  test("renders an array of uniform objects as a real table element", () => {
    const html = renderGenericHtml("search", {
      hits: [
        { ref: "memories/a", score: 2 },
        { ref: "memories/b", score: 1 },
      ],
    });

    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain("memories/a");
    // Not the retired JSON-in-<pre> fallback wearing an HTML wrapper.
    expect(html).not.toMatch(/<pre>\s*\{/);
  });

  test("escapes markup in values instead of interpolating it", () => {
    const html = renderGenericHtml("show", { ref: "<script>alert(1)</script>" });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("never returns an empty document, even for an empty envelope", () => {
    expect(renderGenericHtml("noop", {}).trim().length).toBeGreaterThan(0);
    expect(renderGenericHtml("noop", null).trim().length).toBeGreaterThan(0);
  });

  test("drops root-level shape/schemaVersion envelope metadata as sections (F3)", () => {
    const html = renderGenericHtml("secret-list", {
      shape: "sentinel-shape-value",
      schemaVersion: 424242,
      items: ["a"],
    });

    expect(html).not.toContain("<h2>shape</h2>");
    expect(html).not.toContain("<h2>schemaVersion</h2>");
    expect(html).not.toContain("sentinel-shape-value");
    expect(html).not.toContain("424242");
    expect(html).toContain("<h2>items</h2>");
  });

  test("keeps a per-entry schemaVersion one level down (e.g. log list's events[])", () => {
    const html = renderGenericHtml("log-list", {
      shape: "log-list",
      schemaVersion: 1,
      events: [{ id: "evt-1", schemaVersion: 2 }],
    });

    expect(html).not.toContain("<h2>shape</h2>");
    expect(html).toContain("<h2>events</h2>");
    // Nested `schemaVersion` is per-entry content (a table column, since
    // `events` is a uniform-object array) — the root-only filter must not
    // eat it.
    expect(html).toContain('<th scope="col">schemaVersion</th>');
    expect(html).toContain("<td>evt-1</td>");
    expect(html).toContain("<td>2</td>");
  });
});
