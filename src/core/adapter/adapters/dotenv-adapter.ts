// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `dotenv` adapter — akm 0.9.0 format-family work item (#46).
 *
 * A metadata-only env/secret bundle (spec §6/§7, normative §21.2). REDACTION IS
 * A HARD CONTRACT keyed on the ADAPTER, never on the open `type` value (a
 * frontmatter `type:` cannot opt out):
 *   - `env/*.env` → `type: env` — only the KEY NAMES are surfaced (on `hints`);
 *     VALUES, COMMENTS, and raw CONTENT are NEVER read into the index.
 *   - any file under `secrets/` → `type: secret` — only the FILE NAME is
 *     surfaced; the whole file is the value and is never read. A `.env` UNDER
 *     `secrets/` is a SECRET (the dir gate wins) — name-only, MORE redacted than
 *     an `env/` file even though it has KEY=VALUE lines.
 * conceptId: env strips `.env`; secret keeps its natural path (including any
 * extension). Neither branch ever writes a value onto the emitted document.
 *
 * ── validate (spec §6 env/secret validation column) ──
 *
 * The dangerous-key scan (`dangerous-vault-key`), reusing the akm adapter's
 * `dangerousEnvKeyDiagnostics` — which preserves the code-grounded narrowness:
 * it runs ONLY on `*.env`-suffixed files, so `secrets/<bare-name>` is never
 * scanned (its whole content is an opaque secret value). Reads KEY NAMES only.
 *
 * Conformance oracle (authored, DO NOT modify): fixture
 * `tests/fixtures/bundles/dotenv/` + goldens
 * `tests/fixtures/format-family-goldens/dotenv/{recognition,placement,lint,renderer}.json`.
 */

import fs from "node:fs";
import path from "node:path";
import type { FileContext } from "../../../indexer/walk/file-context";
import { assetPathForName, typeForStashDir } from "../../asset/asset-placement";
import type { FileChange } from "../../file-change";
import type { BundleAdapter } from "../bundle-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../types";
import { dangerousEnvKeyDiagnostics } from "./akm-lint";
import { hashContent } from "./shared";

/** A dotenv bundle is single-component; its one component is `main`. */
const COMPONENT_ID = "main";
/** The `env/` content subdir (KEY=VALUE files). */
const ENV_DIR = "env";
/** The `secrets/` content subdir (whole-file secrets). */
const SECRETS_DIR = "secrets";
/** Non-secret marker suffixes under `secrets/` (spec §6 secret row). */
const SECRET_SKIP_SUFFIXES = [".lock", ".sensitive"];
/** Matches a KEY=value assignment line, capturing only the key (mirrors akm-lint scanKeys). */
const ASSIGN_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

type DotenvType = "env" | "secret";

/** Classify a component-root-relative file as env / secret, or null (abstain). */
function classify(relPath: string): DotenvType | null {
  const posix = toPosix(relPath);
  const segs = posix.split("/").filter((s) => s.length > 0);
  if (segs.length < 2) return null;
  const head = segs[0];
  const base = segs[segs.length - 1];
  if (head === ENV_DIR) {
    return base === ".env" || base.endsWith(".env") ? "env" : null;
  }
  if (head === SECRETS_DIR) {
    return SECRET_SKIP_SUFFIXES.some((s) => base.endsWith(s)) ? null : "secret";
  }
  return null;
}

/** Extract KEY NAMES (never values) from an env file's raw content, first-appearance order, deduped. */
function scanKeyNames(raw: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(ASSIGN_RE);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    keys.push(m[1]);
  }
  return keys;
}

function recognize(c: BundleComponent, file: FileContext): IndexDocument | null {
  const type = classify(file.relPath);
  if (type === null) return null;
  const posix = toPosix(file.relPath);
  const raw = file.content();

  if (type === "env") {
    // env: strip `.env`; surface KEY NAMES only (never values/comments/content).
    const conceptId = posix.replace(/\.env$/i, "");
    const name = (conceptId.split("/").pop() ?? conceptId) || "default";
    const keys = scanKeyNames(raw);
    const doc: IndexDocument = {
      ref: `${c.id}//${conceptId}`,
      bundle: c.id,
      component: COMPONENT_ID,
      conceptId,
      path: file.absPath,
      hash: hashContent(raw),
      adapterId: "dotenv",
      type: "env",
      name,
    };
    if (keys.length > 0) doc.hints = keys;
    return doc;
  }

  // secret: keep the natural path; surface the FILE NAME only — never keys/content.
  const name = posix.split("/").pop() ?? posix;
  return {
    ref: `${c.id}//${posix}`,
    bundle: c.id,
    component: COMPONENT_ID,
    conceptId: posix,
    path: file.absPath,
    hash: hashContent(raw),
    adapterId: "dotenv",
    type: "secret",
    name,
  };
}

async function validate(_c: BundleComponent, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  for (const change of changes) {
    if (change.op === "delete") continue;
    const raw = change.after ?? (await ctx.readFile(change.path));
    if (typeof raw !== "string") continue;
    const type = classify(change.path);
    if (type === null) continue;
    // dangerousEnvKeyDiagnostics is `.env`-suffix-narrow: a bare secret file is never scanned.
    diagnostics.push(...dangerousEnvKeyDiagnostics(type, toPosix(change.path), raw));
  }
  return diagnostics;
}

export const dotenvAdapter: BundleAdapter = {
  id: "dotenv",
  version: "0.9.0",
  extensions: [".env"],

  recognize,
  validate,

  /**
   * env places to `env/<name>.env`, secret to `secrets/<name>` (identity join,
   * no extension logic) — reusing the shared `assetPathForName` so the env
   * default-alias / already-suffixed / nested-secret edge cases match the akm
   * placement convention exactly.
   */
  placeNew(c: BundleComponent, conceptId: string): string {
    const posix = toPosix(conceptId);
    const slash = posix.indexOf("/");
    if (slash > 0) {
      const head = posix.slice(0, slash);
      const rest = posix.slice(slash + 1);
      const type = typeForStashDir(head);
      if ((type === "env" || type === "secret") && rest.length > 0) {
        return assetPathForName(type, path.join(c.root, head), rest);
      }
    }
    return path.join(c.root, posix);
  },

  /** The dotenv bundle owns its `env/` + `secrets/` dirs. */
  directoryList(): string[] {
    return [ENV_DIR, SECRETS_DIR];
  },

  /**
   * Install-time probe (§1.2): a root whose ONLY content dirs are `env/` and/or
   * `secrets/` (at least one present). The env/secrets-ONLY requirement keeps a
   * full akm workspace — which also carries `env/` + `secrets/` alongside many
   * other stash subdirs — from being mistaken for a dotenv bundle, so the probe
   * is registered ahead of `akm` without shadowing it.
   */
  looksLikeRoot(root: string): boolean {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return false;
    }
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    if (dirs.length === 0) return false;
    if (!dirs.every((d) => d === ENV_DIR || d === SECRETS_DIR)) return false;
    return dirs.includes(ENV_DIR) || dirs.includes(SECRETS_DIR);
  },
};
