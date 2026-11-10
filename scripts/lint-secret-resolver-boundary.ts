// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * lint-secret-resolver-boundary.ts
 *
 * Enforces the secret-resolver injection boundary: every MATERIALIZING call to
 * `ensureSourceCaches` must supply a `secrets` resolver, and any direct call to
 * `ensureWebsiteMirror` must supply `resolveSecret`.
 *
 * The `secrets?: SecretResolver` option is deliberately optional — an absent
 * resolver means "environment variables only", the documented read
 * path. But a caller that MATERIALIZES sources (clones/pulls/re-fetches, i.e.
 * does not pass `materialize: false`) and omits `secrets` silently reverts a
 * website source's X fetcher to `X_BEARER_TOKEN`-only — the exact
 * `sync()`/bundle-update gap P4 closed. That gap was invisible for months
 * because nothing failed loudly; this guard makes a regression fail the build.
 *
 * What is flagged:
 *   - an `ensureSourceCaches(` call whose argument object does not contain
 *     `materialize: false` AND does not contain `secrets`; or
 *   - a direct `ensureWebsiteMirror(` call without `resolveSecret`; or
 *   - a provider `.sync(` call that supplies `ensureWebsiteMirror` without
 *     also supplying `secrets`.
 *
 * What is NOT flagged: read-only callers (`materialize: false`), and the
 * function's own definition / re-export / dynamic-import destructuring lines.
 *
 * Comments and string literals are stripped before matching so prose that
 * merely mentions the call does not trip the guard.
 *
 * Exit codes:
 *   0 — no violations
 *   1 — violations found (or internal error)
 *
 * Usage:
 *   bun scripts/lint-secret-resolver-boundary.ts
 */

import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const srcDir = path.join(repoRoot, "src");

/** Recursively collect non-declaration .ts files under a directory. */
function collectTs(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "schemas") continue;
      results.push(...collectTs(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Strip line/block comments and string/template literal contents, replacing
 * them with spaces so line/column offsets are preserved. Only real code
 * remains, so a doc comment mentioning `ensureSourceCaches(` is not matched.
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
        out += c;
        i += 1;
      }
    } else if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      } else {
        out += c === "\t" ? "\t" : " ";
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
    } else {
      // Inside a string/template: emit whitespace until the closing delimiter.
      const closing = state === "sq" ? "'" : state === "dq" ? '"' : "`";
      if (c === "\\") {
        out += "  ";
        i += 2;
      } else if (c === closing) {
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

/** Return the balanced-paren argument text starting at the `(` index. */
function readCallArgs(code: string, openParen: number): { args: string; end: number } | null {
  let depth = 0;
  for (let i = openParen; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { args: code.slice(openParen + 1, i), end: i };
    }
  }
  return null;
}

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i += 1) if (src[i] === "\n") line += 1;
  return line;
}

const violations: string[] = [];

for (const file of collectTs(srcDir)) {
  const rel = path.relative(repoRoot, file).split(path.sep).join("/");
  const raw = fs.readFileSync(file, "utf8");
  const code = stripCommentsAndStrings(raw);

  const callPattern = /ensureSourceCaches\s*\(/g;
  for (const match of code.matchAll(callPattern)) {
    const at = match.index ?? 0;
    // Skip the definition, re-exports, and dynamic-import destructuring —
    // these are not call sites that materialize.
    const before = code.slice(Math.max(0, at - 40), at);
    if (/function\s+$/.test(before) || /\bimport\s*\(/.test(before) || /[{,]\s*$/.test(before)) continue;

    const openParen = at + match[0].length - 1;
    const call = readCallArgs(code, openParen);
    if (!call) continue;
    const args = call.args;

    // Read-only callers do not materialize and need no resolver.
    if (/\bmaterialize\s*:\s*false\b/.test(args)) continue;
    if (/\bsecrets\b/.test(args)) continue;

    violations.push(
      `${rel}:${lineOf(code, at)}  ensureSourceCaches(...) materializes but does not pass \`secrets\` — ` +
        `inject a SecretResolver (e.g. storeSecretResolver) or pass \`materialize: false\` for a read-only call.`,
    );
  }

  const websiteMirrorPattern = /ensureWebsiteMirror\s*\(/g;
  for (const match of code.matchAll(websiteMirrorPattern)) {
    const at = match.index ?? 0;
    const before = code.slice(Math.max(0, at - 40), at);
    // Skip the function declaration; imported/destructured references do not
    // include an opening parenthesis and therefore never match this pattern.
    if (/function\s+$/.test(before)) continue;

    const openParen = at + match[0].length - 1;
    const call = readCallArgs(code, openParen);
    if (!call || /\bresolveSecret\b/.test(call.args)) continue;

    violations.push(
      `${rel}:${lineOf(code, at)}  ensureWebsiteMirror(...) materializes but does not pass \`resolveSecret\` — ` +
        "inject the store-backed resolver at this composition boundary or refresh through SourceProvider.sync(...).",
    );
  }

  // A website refresh may also be composed directly through the provider
  // seam. Key the rule to the mirror capability rather than a filename or
  // variable name: git/npm sync calls legitimately have no secret resolver,
  // while any sync call carrying ensureWebsiteMirror is necessarily the
  // website composition and must carry the resolver beside it.
  const providerSyncPattern = /\.sync\s*(?:\?\.)?\s*\(/g;
  for (const match of code.matchAll(providerSyncPattern)) {
    const at = match.index ?? 0;
    const openParen = at + match[0].length - 1;
    const call = readCallArgs(code, openParen);
    if (!call || !/\bensureWebsiteMirror\b/.test(call.args) || /\bsecrets\b/.test(call.args)) continue;

    violations.push(
      `${rel}:${lineOf(code, at)}  provider.sync(...) supplies \`ensureWebsiteMirror\` without \`secrets\` — ` +
        "inject a SecretResolver alongside the website mirror capability.",
    );
  }
}

if (violations.length > 0) {
  console.error("lint-secret-resolver-boundary: secret-resolver injection boundary violated:");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log("lint-secret-resolver-boundary: OK - every materializing source refresh injects a SecretResolver.");
