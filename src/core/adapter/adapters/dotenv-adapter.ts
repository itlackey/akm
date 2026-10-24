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
 * The dangerous-key scan (`dangerous-env-key`), reusing the akm adapter's
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
import { assetPathCandidatesForName, assetPathForName, typeForStashDir } from "../../asset/asset-placement";
import { scanEnvKeyNames, toPosix } from "../../common";
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

type DotenvType = "env" | "secret";

/** Classify a component-root-relative file as env / secret, or null (abstain). */
function classify(relPath: string): DotenvType | null {
  const posix = toPosix(relPath);
  const segs = posix.split("/").filter((s) => s.length > 0);
  if (segs.length < 2) return null;
  const head = segs[0];
  const base = segs[segs.length - 1]!;
  if (head === ENV_DIR) {
    return base === ".env" || base.endsWith(".env") ? "env" : null;
  }
  if (head === SECRETS_DIR) {
    return SECRET_SKIP_SUFFIXES.some((s) => base.endsWith(s)) ? null : "secret";
  }
  return null;
}

/**
 * True when `--sensitive` marked this asset, via the sibling marker file that
 * `akm env create --sensitive` / `akm secret create --sensitive` writes:
 * `env/<name>.sensitive` for `env/<name>.env`, `secrets/<name>.sensitive` for
 * `secrets/<name>`.
 *
 * The flag documents itself as excluding the asset from BOTH `env list` output
 * and the search index. Indexing filters are adapter-owned (the walk no longer
 * pre-filters), and the akm adapter abstains on the marker — but this adapter
 * only skipped files whose OWN name ended in `.sensitive`. A dotenv bundle is a
 * legal env/secret write target, so a marked `env/prod.env` there was still
 * indexed with every KEY NAME as a hint and a marked secret still indexed by
 * name, while `env list` / `secret list` correctly hid them. The two surfaces
 * disagreed about a documented promise.
 */
function hasSensitiveMarker(absPath: string, type: DotenvType): boolean {
  const marker = type === "env" ? absPath.replace(/\.env$/i, ".sensitive") : `${absPath}.sensitive`;
  return marker !== absPath && fs.existsSync(marker);
}

function conceptIdForPath(type: DotenvType, relativePath: string): string {
  const posix = toPosix(relativePath);
  if (type === "secret") return posix;
  const stripped = posix.replace(/\.env$/i, "");
  return stripped.endsWith("/") ? `${stripped}default` : stripped;
}

function recognize(c: BundleComponent, file: FileContext): IndexDocument | null {
  const type = classify(file.relPath);
  if (type === null) return null;
  if (hasSensitiveMarker(file.absPath, type)) return null;
  const posix = toPosix(file.relPath);
  const raw = file.content();

  if (type === "env") {
    // env: strip `.env`; surface KEY NAMES only (never values/comments/content).
    const conceptId = conceptIdForPath(type, posix);
    const name = (conceptId.split("/").pop() ?? conceptId) || "default";
    const keys = scanEnvKeyNames(raw);
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
   * Closed-form owner candidates (#857): `env`/`secret` are always authored
   * directly under their own stash subdir (`classify` requires it — no
   * off-canonical loose placement exists for this adapter), so there is no
   * loose-fallback class to enumerate here, unlike `akm-adapter`.
   * `assetPathCandidatesForName` expands `env`'s `.env`/`<name>.env` duality;
   * the sensitive-marker sibling spellings are then layered on each.
   */
  readCandidates(c: BundleComponent, conceptId: string) {
    const posix = toPosix(conceptId);
    const slash = posix.indexOf("/");
    if (slash <= 0) return [];
    const head = posix.slice(0, slash);
    const rest = posix.slice(slash + 1);
    const type = typeForStashDir(head);
    if ((type !== "env" && type !== "secret") || rest.length === 0) return [];
    const primaries = assetPathCandidatesForName(type, path.join(c.root, head), rest);
    const expanded = primaries.flatMap((primary) =>
      type === "env"
        ? [primary, primary.replace(/\.env$/i, ".sensitive")]
        : [primary, `${primary}.sensitive`, `${primary}.lock`],
    );
    return expanded.map((candidatePath) => ({ path: candidatePath, conceptId: posix }));
  },

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
