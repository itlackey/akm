// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `--format html` rendering primitives (#582).
 *
 * Templates live in `src/assets/templates/html/` (mirrored to
 * `dist/assets/templates/html/` by `scripts/copy-assets.ts`). A command with a
 * bespoke template ships `<command>.html`; every other command falls back to
 * `default.html`, which renders the command's JSON envelope in a `<pre>`
 * block. Substitution is plain `%%TOKEN%%` string replacement — no template
 * engine, by design.
 */

import fs from "node:fs";
import path from "node:path";
import { getDirname } from "../runtime";

const TEMPLATES_DIR = path.join(getDirname(import.meta.url), "../assets/templates/html");

/** Template used by every command without a bespoke `<command>.html`. */
export const DEFAULT_TEMPLATE = "default";

/**
 * Resolve the on-disk template path for a command. `<command>.html` when the
 * command ships a bespoke template (today: `health`), otherwise
 * `default.html`. Command names are sanitized to a bare basename so a hostile
 * command string can never escape the templates directory.
 */
export function resolveTemplatePath(command: string): string {
  const name = path.basename(command.trim());
  const candidate = path.join(TEMPLATES_DIR, `${name}.html`);
  if (name !== DEFAULT_TEMPLATE && fs.existsSync(candidate)) return candidate;
  return path.join(TEMPLATES_DIR, `${DEFAULT_TEMPLATE}.html`);
}

/**
 * Read a template and substitute every `%%TOKEN%%` in `replacements`.
 * Unknown tokens in the template are left in place (the health template is
 * verified token-complete by tests); replacement keys missing from the
 * template are silently ignored, matching the skill renderer's behaviour.
 */
export function renderHtml(templatePath: string, replacements: Record<string, string>): string {
  let html = fs.readFileSync(templatePath, "utf8");
  for (const [token, value] of Object.entries(replacements)) {
    html = html.replaceAll(token, value);
  }
  return html;
}

/** Minimal HTML entity escaping for text interpolated into templates. */
export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
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
  console.log(content);
}
