// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assetPathForName, stashDirFor } from "../../core/asset/asset-placement";
import { parseRefInput } from "../../core/asset/resolve-ref";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { resolveBundleWriteTarget } from "../../core/mutation-target";
import { assertAkmAssetWrite } from "../../core/write-source";
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
 * Types retire can act on as one file: not a skill's support files, and not the protected
 * (`env`, `secret`) or generated (`session`) assets. A skill is its `SKILL.md`.
 */
export function isSingleFileDocumentType(type: string): boolean {
  return !["env", "secret", "session"].includes(type);
}

/** Authoring reads are limited to indexed, writable AKM knowledge/memory files, never arbitrary paths. */
export async function akmReadDocument(ref: string): Promise<{
  ref: string;
  type: "knowledge" | "memory";
  content: string;
  revision: string;
}> {
  const parsed = parseRefInput(ref);
  if (parsed.type !== "knowledge" && parsed.type !== "memory")
    throw new UsageError("Only knowledge and memory support source editing in this UI.");
  const found = await resolveWritableIndexedAsset(ref);
  const raw = fs.readFileSync(found.path);
  const content = raw.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(raw))
    throw new UsageError("This source is not valid UTF-8; edit it outside the UI.");
  if (redactUrlsInText(content) !== content)
    throw new UsageError(
      "This document contains URL credentials hidden by the UI. Edit it outside the UI to preserve those values.",
    );
  return {
    ref: found.canonical,
    type: parsed.type,
    content,
    revision: createHash("sha256").update(raw).digest("hex"),
  };
}

/**
 * Save `content` over the knowledge or memory document at `ref` if its raw SHA-256 is still `revision`, through the
 * shared Markdown writer (and record its event).
 */
export async function akmSaveDocument(ref: string, content: string, revision: string) {
  const source = await akmReadDocument(ref);
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
