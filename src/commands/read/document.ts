// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeAkmMarkdown } from "../../core/asset/akm-markdown";
import { assetPathForName, stashDirFor } from "../../core/asset/asset-placement";
import { parseRefInput } from "../../core/asset/resolve-ref";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { resolveBundleWriteTarget } from "../../core/mutation-target";
import {
  assertAkmAssetWrite,
  assertWritePathsInsideSource,
  commitWriteTargetBoundary,
  formatRefForMessage,
  writeAssetToSource,
} from "../../core/write-source";
import { withAssetMutationLease } from "../../indexer/index-writer-lock";
import { indexWrittenAssets } from "../../indexer/index-written-assets";
import { closeDatabase, openReadonlyExistingDatabase } from "../../storage/repositories/index-connection";
import { getEntryIdByFilePath, getItemRefById } from "../../storage/repositories/index-entries-repository";
import { redactUrlsInText } from "../ui/redact";
import { writeMarkdownAsset } from "./knowledge";
import { akmShowUnified } from "./show";

/** An indexed asset file whose bundle accepts AKM writes, found the way the UI reads it. */
export async function resolveWritableIndexedAsset(ref: string) {
  const parsed = parseRefInput(ref);
  const shown = await akmShowUnified({ ref, readOnly: true });
  if (!shown.path) throw new UsageError("The document has no local source file.");
  const db = openReadonlyExistingDatabase();
  let canonical: string | undefined;
  if (db) {
    try {
      const id = getEntryIdByFilePath(db, shown.path);
      canonical = id === undefined ? undefined : (getItemRefById(db, id) ?? undefined);
    } finally {
      closeDatabase(db);
    }
  }
  if (!canonical) throw new UsageError("Only indexed documents can be edited.");
  const identity = parseRefInput(canonical);
  const target = resolveBundleWriteTarget(loadConfig(), identity.origin!);
  assertAkmAssetWrite(target.source);
  const expectedPath = assetPathForName(
    parsed.type,
    path.join(target.source.path, stashDirFor(parsed.type)!),
    identity.name,
  );
  if (path.resolve(expectedPath) !== path.resolve(shown.path))
    throw new UsageError(
      "The indexed source no longer matches the writable document target. Refresh the index before editing.",
    );
  return { canonical, target, path: shown.path };
}

/**
 * Types the UI reads and writes as one file: not a skill's support files, and not the protected
 * (`env`, `secret`) or generated (`session`) assets. A skill is its `SKILL.md`.
 */
export function isSingleFileDocumentType(type: string): boolean {
  return !["env", "secret", "session"].includes(type);
}

/** An indexed, writable, UTF-8 asset file the UI may show and rewrite, with the bytes it was read as. */
async function loadDocument(ref: string) {
  const parsed = parseRefInput(ref);
  if (!isSingleFileDocumentType(parsed.type))
    throw new UsageError("Only single-file assets support source editing in this UI.");
  const found = await resolveWritableIndexedAsset(ref);
  const raw = fs.readFileSync(found.path);
  const content = raw.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(raw))
    throw new UsageError("This source is not valid UTF-8; edit it outside the UI.");
  if (redactUrlsInText(content) !== content)
    throw new UsageError(
      "This document contains URL credentials hidden by the UI. Edit it outside the UI to preserve those values.",
    );
  return { ...found, type: parsed.type, content, revision: createHash("sha256").update(raw).digest("hex") };
}

/** Authoring reads are limited to indexed, writable AKM single-file assets, never arbitrary paths. */
export async function akmReadDocument(ref: string): Promise<{
  ref: string;
  type: string;
  content: string;
  revision: string;
}> {
  const { canonical, type, content, revision } = await loadDocument(ref);
  return { ref: canonical, type, content, revision };
}

/**
 * Save `content` over a single-file asset other than knowledge/memory (those use their Markdown writer): under the
 * asset-mutation lease, compare the live bytes with `revision`, then write through the ordinary asset writer, commit
 * the git boundary and index the file.
 */
async function saveSingleFileDocument(ref: string, content: string, revision: string) {
  const doc = await loadDocument(ref);
  const identity = parseRefInput(doc.canonical);
  const written = await withAssetMutationLease("ui-document-save", async () => {
    const live = fs.readFileSync(doc.path);
    if (createHash("sha256").update(live).digest("hex") !== revision)
      throw new UsageError(
        "The document changed or was removed after it was loaded. Reload its source before saving.",
        "ASSET_CONTENT_CHANGED",
      );
    const authored = doc.path.toLowerCase().endsWith(".md") ? normalizeAkmMarkdown(content, identity.type) : content;
    if (live.equals(Buffer.from(content, "utf8")) || live.equals(Buffer.from(authored, "utf8")))
      return { ref: doc.canonical, path: doc.path, unchanged: true as const };
    assertWritePathsInsideSource(doc.target.source, [doc.path]);
    const result = await writeAssetToSource(doc.target.source, doc.target.config, identity, content);
    commitWriteTargetBoundary(doc.target, `Update ${formatRefForMessage(identity)}`);
    return result;
  });
  if (!("unchanged" in written))
    await indexWrittenAssets(doc.target.source.path, [written.path], { bundleId: identity.origin });
  return written;
}

/**
 * Save `content` over the document at `ref` if its raw SHA-256 is still `revision`. Knowledge and memory go through the
 * Markdown writer (and record its event); every other single-file type through the ordinary asset writer.
 */
export async function akmSaveDocument(ref: string, content: string, revision: string) {
  const source = await akmReadDocument(ref);
  if (source.type !== "knowledge" && source.type !== "memory") return saveSingleFileDocument(ref, content, revision);
  const identity = parseRefInput(source.ref);
  const result = await writeMarkdownAsset({
    type: source.type,
    content,
    name: identity.name,
    fallbackPrefix: source.type,
    target: identity.origin,
    force: true,
    expectedContentHash: revision,
  });
  if (!result.unchanged)
    appendEvent({
      eventType: source.type === "knowledge" ? "import" : "remember",
      ref: result.ref,
      metadata: { source: "ui", path: result.path, force: true },
    });
  return result;
}
