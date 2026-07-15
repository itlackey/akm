// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolveOutputMode } from "../../src/output/context";
import {
  DEFAULT_TEMPLATE,
  deliverRendered,
  escapeHtml,
  renderHtml,
  resolveTemplatePath,
} from "../../src/output/html-render";
import { makeSandboxDir, type SandboxedDir } from "../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

function makeTempDir(): string {
  const d = makeSandboxDir("akm-html-render-");
  disposers.push(d);
  return d.dir;
}

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

describe("resolveTemplatePath", () => {
  test("returns the bespoke template for a command that ships one", () => {
    const p = resolveTemplatePath("health");
    expect(p.endsWith(`${path.sep}health.html`)).toBe(true);
    expect(fs.existsSync(p)).toBe(true);
  });

  test("falls back to default.html for a command without a template", () => {
    const p = resolveTemplatePath("proposal-list");
    expect(p.endsWith(`${path.sep}${DEFAULT_TEMPLATE}.html`)).toBe(true);
    expect(fs.existsSync(p)).toBe(true);
  });

  test("sanitizes path-traversal command names to the default template", () => {
    const p = resolveTemplatePath("../../../etc/passwd");
    expect(p.endsWith(`${path.sep}${DEFAULT_TEMPLATE}.html`)).toBe(true);
  });
});

describe("renderHtml", () => {
  test("replaces every occurrence of each token", () => {
    const dir = makeTempDir();
    const tmpl = path.join(dir, "t.html");
    fs.writeFileSync(tmpl, "<title>%%A%%</title><h1>%%A%%</h1><p>%%B%%</p>");
    const html = renderHtml(tmpl, { "%%A%%": "alpha", "%%B%%": "beta" });
    expect(html).toBe("<title>alpha</title><h1>alpha</h1><p>beta</p>");
  });

  test("leaves tokens absent from the replacement map intact", () => {
    const dir = makeTempDir();
    const tmpl = path.join(dir, "t.html");
    fs.writeFileSync(tmpl, "%%KNOWN%% %%UNKNOWN%%");
    expect(renderHtml(tmpl, { "%%KNOWN%%": "x" })).toBe("x %%UNKNOWN%%");
  });

  test("substitution is single-pass: a value containing another token is not re-processed", () => {
    const dir = makeTempDir();
    const tmpl = path.join(dir, "t.html");
    fs.writeFileSync(tmpl, "%%A%%|%%B%%");
    // %%A%%'s value embeds the literal %%B%% token; it must survive verbatim
    // regardless of key iteration order.
    expect(renderHtml(tmpl, { "%%A%%": "raw %%B%%", "%%B%%": "beta" })).toBe("raw %%B%%|beta");
  });

  test("the default template renders COMMAND / CONTENT_JSON / GENERATED_AT", () => {
    const html = renderHtml(resolveTemplatePath(DEFAULT_TEMPLATE), {
      "%%COMMAND%%": "proposal-list",
      "%%CONTENT_JSON%%": escapeHtml(JSON.stringify({ totalCount: 0 })),
      "%%GENERATED_AT%%": "2026-06-11T00:00:00.000Z",
    });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("proposal-list");
    expect(html).toContain("{&quot;totalCount&quot;:0}");
    expect(html).toContain("Generated 2026-06-11T00:00:00.000Z");
    expect(html).not.toMatch(/%%[A-Z_]+%%/);
  });
});

describe("escapeHtml", () => {
  test("escapes the five HTML metacharacters (incl. single quote)", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });
});

describe("deliverRendered", () => {
  test("writes to the output path (creating parent dirs) with a trailing newline", () => {
    const dir = makeTempDir();
    const out = path.join(dir, "nested", "report.html");
    deliverRendered("<html></html>", out);
    expect(fs.readFileSync(out, "utf8")).toBe("<html></html>\n");
  });

  test("does not duplicate an existing trailing newline", () => {
    const dir = makeTempDir();
    const out = path.join(dir, "report.html");
    deliverRendered("<html></html>\n", out);
    expect(fs.readFileSync(out, "utf8")).toBe("<html></html>\n");
  });
});

describe("output-mode html/--output parsing", () => {
  test('"html" is a valid --format value', () => {
    expect(resolveOutputMode(["--format", "html"]).format).toBe("html");
  });

  test("--output <path> and --output=<path> populate outputPath", () => {
    expect(resolveOutputMode(["--output", "/tmp/x.html"]).outputPath).toBe("/tmp/x.html");
    expect(resolveOutputMode(["--output=/tmp/y.html"]).outputPath).toBe("/tmp/y.html");
  });

  test("outputPath is absent when --output is not passed", () => {
    expect(resolveOutputMode([]).outputPath).toBeUndefined();
  });
});
