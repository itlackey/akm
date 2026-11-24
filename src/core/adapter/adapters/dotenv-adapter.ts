// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `dotenv` adapter.
 *
 * A metadata-only env/secret bundle. REDACTION IS
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
 * ── validate ──
 *
 * The dangerous-key scan (`dangerous-env-key`), reusing the akm adapter's
 * `dangerousEnvKeyDiagnostics` — which preserves the code-grounded narrowness:
 * it runs ONLY on `*.env`-suffixed files, so `secrets/<bare-name>` is never
 * scanned (its whole content is an opaque secret value). Reads KEY NAMES only.
 *
 * Conformance oracle (authored, DO NOT modify): fixture
 * `tests/fixtures/bundles/dotenv/` + goldens
 * `tests/fixtures/format-family-goldens/dotenv/{recognition,lint,renderer}.json`.
 */

import fs from "node:fs";
import path from "node:path";
import { assetPathCandidatesForName, isSecretSidecar } from "../../asset/asset-placement";
import { isScratchPath } from "../../asset/scratch";
import { scanEnvKeyNames, toPosix } from "../../common";
import type { FileContext } from "../directory/file-context";
import type { FileChange } from "../file-change";
import type { Bundle, IndexMetadata } from "../types";
import type { FileDiagnostic, FileValidateContext } from "../validate-context";
import { AkmFormatAdapterBase } from "./akm-format";
import { dangerousEnvKeyDiagnostics } from "./akm-lint";
import { hashContent } from "./shared";

/** The `env/` content subdir (KEY=VALUE files). */
const ENV_DIR = "env";
/** The `secrets/` content subdir (whole-file secrets). */
const SECRETS_DIR = "secrets";

type DotenvType = "env" | "secret";

/** Classify a bundle-root-relative file as env / secret, or null (abstain). */
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
    return isSecretSidecar(base) ? null : "secret";
  }
  return null;
}

function conceptIdForPath(type: DotenvType, relativePath: string): string {
  const posix = toPosix(relativePath);
  if (type === "secret") return posix;
  const stripped = posix.replace(/\.env$/i, "");
  return stripped.endsWith("/") ? `${stripped}default` : stripped;
}

function describe(file: FileContext, conceptId: string): IndexMetadata {
  const type = classify(file.relPath) as DotenvType;
  const raw = file.content();

  if (type === "env") {
    // env: strip `.env`; surface KEY NAMES only (never values/comments/content).
    const name = (conceptId.split("/").pop() ?? conceptId) || "default";
    const keys = scanEnvKeyNames(raw);
    const doc: IndexMetadata = { hash: hashContent(raw), type: "env", name };
    if (keys.length > 0) doc.hints = keys;
    return doc;
  }

  // secret: keep the natural path; surface the FILE NAME only — never keys/content.
  return { hash: hashContent(raw), type: "secret", name: conceptId.split("/").pop() ?? conceptId };
}

async function validate(_c: Bundle, changes: FileChange[], ctx: FileValidateContext): Promise<FileDiagnostic[]> {
  const diagnostics: FileDiagnostic[] = [];
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

export class DotenvAdapter extends AkmFormatAdapterBase {
  readonly id = "dotenv";
  readonly version = "0.9.0";
  override readonly writes = ["env", "secret"];
  override readonly extensions = [".env"];

  protected identify(relPath: string): string | null {
    const type = classify(relPath);
    return type === null ? null : conceptIdForPath(type, relPath);
  }

  protected describe(_b: Bundle, file: FileContext, conceptId: string): IndexMetadata {
    return describe(file, conceptId);
  }

  protected override typeOf(relPath: string): string {
    const type = classify(relPath);
    if (type === null) throw new Error(`"${relPath}" is no env or secret file.`);
    return type;
  }

  protected validateFiles(b: Bundle, changes: FileChange[], ctx: FileValidateContext): Promise<FileDiagnostic[]> {
    return validate(b, changes, ctx);
  }

  /**
   * Closed-form spellings (#857): the ref is the file's path under the bundle root (`conceptIdForPath`), so it is
   * inverted for the two types this adapter holds. `assetPathCandidatesForName` expands `env`'s `.env`/`<name>.env`
   * duality; `identify` decides which spelling really holds the ref.
   */
  protected spellings(conceptId: string): string[] {
    const posix = toPosix(conceptId);
    // The type the concept's folder names comes first, so the first spelling is the file a create of it writes.
    const named = posix.startsWith(`${SECRETS_DIR}/`) ? "secret" : "env";
    const types = named === "secret" ? (["secret", "env"] as const) : (["env", "secret"] as const);
    const expanded = types.flatMap((type) => assetPathCandidatesForName(type, ".", posix));
    return [...new Set(expanded.map((candidate) => toPosix(path.normalize(candidate))))];
  }

  /** The dotenv bundle owns its `env/` + `secrets/` dirs. */
  override directoryList(): string[] {
    return [ENV_DIR, SECRETS_DIR];
  }

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
    const dirs = entries.filter((e) => e.isDirectory() && !isScratchPath(e.name)).map((e) => e.name);
    if (dirs.length === 0) return false;
    if (!dirs.every((d) => d === ENV_DIR || d === SECRETS_DIR)) return false;
    return dirs.includes(ENV_DIR) || dirs.includes(SECRETS_DIR);
  }
}

export const dotenvAdapter = new DotenvAdapter();
