// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #953 — a field run reported `akm index`'s embedding
 * requests reaching the provider with no `Authorization` header at all, even
 * though `embedding.apiKey` was set to a `secret://` reference. The
 * reproduction in tests/integration/index-embedding-secret-credential.test.ts
 * did not reproduce the gap against the code as it stands (every candidate
 * path — plain `akm index`, the CLI child process, and an `extends`-inherited
 * apiKey with mid-run adapter persistence — already threads the credential
 * through correctly). This contract test guards the one seam identified as
 * the actual risk (#953): every `new RemoteEmbedder(...)` construction site
 * in `src/` must pass its config straight through by reference — a bare
 * identifier, never a hand-rebuilt object literal — so a future edit cannot
 * silently drop `apiKey` (or any other field) while threading a config from
 * `loadConfig()`'s effective view down to the HTTP client.
 *
 * Grep-based, like `tests/contracts/canonical-index-generation-boundary.test.ts`
 * and `scripts/lint-secret-resolver-boundary.ts`: comments and string/template
 * literals are stripped before matching so prose mentioning `RemoteEmbedder`
 * cannot trip it, and the class's own declaration (`export class RemoteEmbedder`)
 * is not a construction site.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const SRC_ROOT = path.resolve(import.meta.dir, "../../src");

function productionTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) files.push(absolute);
    }
  }
  return files.sort();
}

/**
 * Strip line/block comments and string/template literal contents, replacing
 * them with spaces so line offsets survive. Mirrors
 * `scripts/lint-secret-resolver-boundary.ts`'s stripper so a doc comment or
 * string mentioning `new RemoteEmbedder(` is never mistaken for a real call.
 */
function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  type State = "code" | "line" | "block" | "sq" | "dq" | "tpl";
  let state: State = "code";
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === "code") {
      if (c === "/" && c2 === "/") {
        state = "line";
        out += "  ";
        i += 2;
      } else if (c === "/" && c2 === "*") {
        state = "block";
        out += "  ";
        i += 2;
      } else if (c === "'") {
        state = "sq";
        out += " ";
        i += 1;
      } else if (c === '"') {
        state = "dq";
        out += " ";
        i += 1;
      } else if (c === "`") {
        state = "tpl";
        out += " ";
        i += 1;
      } else {
        out += c === "\n" ? "\n" : c;
        i += 1;
      }
    } else if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += "\n";
      } else {
        out += " ";
      }
      i += 1;
    } else if (state === "block") {
      if (c === "*" && c2 === "/") {
        state = "code";
        out += "  ";
        i += 2;
      } else {
        out += c === "\n" ? "\n" : " ";
        i += 1;
      }
    } else if (state === "sq" || state === "dq") {
      const quote = state === "sq" ? "'" : '"';
      if (c === "\\") {
        out += "  ";
        i += 2;
      } else if (c === quote) {
        state = "code";
        out += " ";
        i += 1;
      } else {
        out += c === "\n" ? "\n" : " ";
        i += 1;
      }
    } else {
      // template literal — does not track ${...} interpolation specially;
      // good enough for this grep-level check.
      if (c === "\\") {
        out += "  ";
        i += 2;
      } else if (c === "`") {
        state = "code";
        out += " ";
        i += 1;
      } else {
        out += c === "\n" ? "\n" : " ";
        i += 1;
      }
    }
  }
  return out;
}

/** A bare identifier — the only shape a construction-site argument is allowed to take. */
const BARE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

describe("RemoteEmbedder credential boundary (#953)", () => {
  test("every `new RemoteEmbedder(...)` construction site passes its config by bare reference, never a rebuilt object literal", () => {
    const violations: string[] = [];
    let constructionSitesFound = 0;

    for (const file of productionTypeScriptFiles(SRC_ROOT)) {
      const raw = fs.readFileSync(file, "utf8");
      const stripped = stripCommentsAndStrings(raw);
      const relative = path.relative(SRC_ROOT, file);

      const constructorPattern = /\bnew\s+RemoteEmbedder\s*\(([^)]*)\)/g;
      let match: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec-loop idiom, matches the sibling lint scripts' style.
      while ((match = constructorPattern.exec(stripped)) !== null) {
        constructionSitesFound++;
        const rawArg = (match[1] ?? "").trim();
        // A trailing `.foo`/`?.foo` member chain still counts as "passed by
        // reference" (e.g. a future `config.embedding` shorthand) — only the
        // leading identifier needs to be bare; strip a member-access suffix
        // before checking, but reject anything that looks like an object
        // literal, a spread, or a call expression outright.
        const looksRebuilt = rawArg.startsWith("{") || rawArg.includes("...") || /^[A-Za-z_$][\w$]*\s*\(/.test(rawArg);
        const isBare = BARE_IDENTIFIER.test(rawArg) || /^[A-Za-z_$][\w$]*(\??\.[A-Za-z_$][\w$]*)*$/.test(rawArg);
        if (looksRebuilt || !isBare) {
          const line = stripped.slice(0, match.index).split("\n").length;
          violations.push(
            `${relative}:${line}: new RemoteEmbedder(${rawArg}) does not pass its config by bare reference — ` +
              "a hand-rebuilt object literal here risks silently dropping apiKey (or another field) before it " +
              "reaches the HTTP client (#953). Pass the EmbeddingConnectionConfig parameter straight through.",
          );
        }
      }
    }

    // A construction site vanishing entirely (e.g. RemoteEmbedder renamed or
    // routed through a different seam) would make this test vacuously pass
    // forever — fail loudly instead so the check is updated alongside it.
    expect(constructionSitesFound).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
