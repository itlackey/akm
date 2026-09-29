// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `--format html` rendering primitives (#582).
 *
 * Templates live in `src/assets/templates/html/` (mirrored to
 * `dist/assets/templates/html/` by `scripts/copy-assets.ts`). `akm health` is
 * the only command with a bespoke `<command>.html` template (substituted here
 * via plain `%%TOKEN%%` string replacement — no template engine, by design);
 * `src/cli/shared.ts`'s `output()` calls it directly for `command === "health"`
 * and every other command falls back to `renderGenericHtml` (`./generic-render`).
 * `--format html` therefore works for every command (D7) — this module's
 * template path is just health's opt-in bespoke rendering, not a format-wide
 * gate.
 */

import fs from "node:fs";
import path from "node:path";
import healthTemplate from "../assets/templates/html/health.html" with { type: "text" };
import { getDirname } from "../runtime";
import { writeStdout } from "./stdout";

const TEMPLATES_DIR = path.join(getDirname(import.meta.url), "../assets/templates/html");

/**
 * Templates embedded at build time, keyed by command name.
 *
 * `bun build --compile` embeds only what is imported `with { type: "text" }`;
 * a plain `readFileSync` from a path relative to `import.meta.url` resolves
 * into the virtual `/$bunfs` tree and misses. `akm health --report --format
 * html` therefore crashed with ENOENT (exit 70) on the standalone binary that
 * the CLI's own install error and the CHANGELOG promote as the runtime-free
 * option. The text import works on all three runtimes: natively on Bun, via
 * scripts/node-runtime/text-import-hook.mjs on Node, and embedded in the
 * compiled binary.
 */
const EMBEDDED_TEMPLATES: Record<string, string> = {
  // bun-types declares `*.html` as an `HTMLBundle` (its HTML-bundler entrypoint
  // feature), which is not what a `type: "text"` import yields — the value is
  // the file's contents as a string on every runtime. The cast reconciles the
  // ambient declaration with the actual import attribute.
  health: healthTemplate as unknown as string,
};

/**
 * Resolve the on-disk template path for a command's bespoke `<command>.html`.
 * The command name is sanitized to a bare basename so a hostile command
 * string can never escape the templates directory.
 */
export function resolveTemplatePath(command: string): string {
  const name = path.basename(command.trim());
  return path.join(TEMPLATES_DIR, `${name}.html`);
}

/** Matches a `%%TOKEN%%` placeholder (uppercase + underscore key). */
const TOKEN_RE = /%%[A-Z_]+%%/g;

/**
 * Read a template and substitute every `%%TOKEN%%` in `replacements` in a
 * single pass. Substitution is order-independent: a value that happens to
 * contain another token's literal text is never re-processed (the pass scans
 * the original template, not the growing output). Unknown tokens in the
 * template are left in place (the health template is verified token-complete by
 * tests); replacement keys missing from the template are silently ignored,
 * matching the skill renderer's behaviour.
 */
export function renderHtml(templatePath: string, replacements: Record<string, string>): string {
  const html = readTemplate(templatePath);
  return html.replace(TOKEN_RE, (token) => replacements[token] ?? token);
}

/**
 * Read a template from disk, falling back to the embedded copy.
 *
 * Disk stays primary so an operator (or a test) editing
 * `src/assets/templates/html/<name>.html` sees the change without a rebuild.
 * The fallback covers the standalone binary, where the file does not exist on
 * any real filesystem.
 */
function readTemplate(templatePath: string): string {
  try {
    return fs.readFileSync(templatePath, "utf8");
  } catch (err) {
    const embedded = EMBEDDED_TEMPLATES[path.basename(templatePath, ".html")];
    if (embedded !== undefined) return embedded;
    throw err;
  }
}

/**
 * Minimal HTML entity escaping for text interpolated into a document — a
 * template substitution here, or a value placed into `generic-render.ts`'s
 * envelope rendering. Escapes the single quote as well as the double quote so
 * escaped values are safe in both `"…"` and `'…'` attribute contexts, not only
 * the double-quoted attributes the bundled templates use today.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Deliver a rendered document: write to `outputPath` when set (`--output`),
 * otherwise print to stdout.
 */
export function deliverRendered(content: string, outputPath: string | undefined): void {
  if (outputPath) {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(outputPath, content.endsWith("\n") ? content : `${content}\n`);
    return;
  }
  writeStdout(content);
}
