// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Single-file authoring for the owner: read a document's source, save it over the revision they read, create knowledge,
 * copy an asset, retire one. Every write checks the `revision` (the sha256 of the raw bytes) the owner last saw inside
 * the asset-mutation lease, and fails fast when another akm process holds the lease.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { akmProposalAccept } from "../commands/proposal/proposal";
import { createRetireProposal, recordGateDecision, rejectProposalDurably } from "../commands/proposal/repository";
import { writeMarkdownAsset } from "../commands/read/knowledge";
import { akmShowUnified } from "../commands/read/show";
import { akmClone, type CloneResponse } from "../commands/sources/source-clone";
import { assertFlatAssetName } from "../core/asset/asset-create";
import { assetPathForName, stashDirFor } from "../core/asset/asset-placement";
import { parseBundleRef } from "../core/asset/asset-ref";
import { resolveStashDir, toErrorMessage } from "../core/common";
import { loadConfig } from "../core/config/config";
import { UsageError } from "../core/errors";
import { appendEvent } from "../core/events";
import { warn } from "../core/warn";
import { resolveBundleWriteTarget } from "../sources/mutation-target";
import { assertAkmAssetWrite } from "../sources/write-source";
import { closeDatabase, openReadonlyExistingDatabase } from "../storage/repositories/index-connection";
import { getEntryIdByFilePath, getItemRefById } from "../storage/repositories/index-entries-repository";
import { interactive } from "./lease";
import { redactUrlsInText } from "./redact";

/** An indexed asset file whose bundle accepts AKM writes, found the way the UI reads it. */
async function resolveWritableIndexedAsset(ref: string) {
  const { fragment } = parseBundleRef(ref);
  if (fragment !== undefined) {
    throw new UsageError(
      `Export fragment "#${fragment}" is not accepted here — drop it from "${ref.trim()}".`,
      "INVALID_FLAG_VALUE",
    );
  }
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
  const target = resolveBundleWriteTarget(loadConfig(), parseBundleRef(canonical).bundle!);
  assertAkmAssetWrite(target.source);
  return { canonical, target, path: shown.path, type: shown.type, name: shown.name };
}

/** Source reads are limited to indexed, writable AKM knowledge/memory files, never arbitrary paths. */
export async function readSource(input: { ref: string }): Promise<{
  ref: string;
  type: "knowledge" | "memory";
  content: string;
  revision: string;
}> {
  const { name: _name, ...source } = await loadSource(input.ref);
  return source;
}

async function loadSource(ref: string): Promise<{
  ref: string;
  type: "knowledge" | "memory";
  name: string;
  content: string;
  revision: string;
}> {
  const found = await resolveWritableIndexedAsset(ref);
  if (found.type !== "knowledge" && found.type !== "memory")
    throw new UsageError("Only knowledge and memory support source editing in this UI.");
  // The writers place a document by its type and name, so a document sitting
  // anywhere else cannot be saved through them.
  const typeDir = stashDirFor(found.type);
  if (!typeDir) throw new UsageError("Only indexed documents can be edited.");
  const expectedPath = assetPathForName(found.type, path.join(found.target.source.path, typeDir), found.name);
  if (path.resolve(expectedPath) !== path.resolve(found.path))
    throw new UsageError(
      "The indexed source no longer matches the writable document target. Refresh the index before editing.",
    );
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
    type: found.type,
    name: found.name,
    content,
    revision: createHash("sha256").update(raw).digest("hex"),
  };
}

/**
 * Save `content` over the knowledge or memory document at `ref` if its raw SHA-256 is still `revision`, through the
 * shared Markdown writer (and record its event).
 */
async function saveLocked(ref: string, content: string, revision: string) {
  const source = await loadSource(ref);
  const result = await writeMarkdownAsset({
    type: source.type,
    content,
    name: source.name,
    fallbackPrefix: source.type,
    target: parseBundleRef(source.ref).bundle,
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

export async function save(input: { ref: string; content: string; revision: string }) {
  if (typeof input.content !== "string") throw new UsageError("Markdown content is required.");
  const ref = required(input.ref, "ref");
  const revision = required(input.revision, "revision");
  return interactive("ui-document-save", () => saveLocked(ref, input.content, revision));
}

function required(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim()) throw new UsageError(`${key} is required.`);
  return value.trim();
}

/** A new knowledge document, placed and indexed as `akm import -` does. An existing document is refused. */
export async function createKnowledge(input: { bundle: string; name: string; path?: string; content: string }) {
  if (typeof input.content !== "string" || !input.content.trim()) throw new UsageError("Document content is required.");
  const name = required(input.name, "name");
  const bundle = required(input.bundle, "bundle");
  assertFlatAssetName(name);
  return interactive("ui-knowledge-create", async () => {
    const result = await writeMarkdownAsset({
      type: "knowledge",
      content: input.content,
      name,
      fallbackPrefix: "knowledge",
      target: bundle,
      path: typeof input.path === "string" && input.path.trim() ? input.path.trim() : undefined,
    });
    appendEvent({ eventType: "import", ref: result.ref, metadata: { source: "-", path: result.path, force: false } });
    return result;
  });
}

/** Copy an asset to a bundle. Overwriting an existing asset is never done here. */
export async function copy(input: { sourceRef: string; target?: string; newName?: string }): Promise<CloneResponse> {
  return interactive("ui-asset-copy", () =>
    akmClone({
      sourceRef: required(input.sourceRef, "sourceRef"),
      target: input.target,
      newName: input.newName,
      force: false,
    }),
  );
}

/**
 * A person retires an asset: the ordinary retire proposal, minted and accepted at once the way `akm feedback`'s typed fix
 * is. The proposal captures exactly the bytes whose `revision` the person saw (checked where they are read, inside the
 * lease). Undo is reverting that proposal.
 */
export async function retire(input: { ref: string; revision: string }) {
  const ref = required(input.ref, "ref");
  const revision = required(input.revision, "revision");
  return interactive("manual-retire", async () => {
    const { canonical, target, type } = await resolveWritableIndexedAsset(ref);
    if (["skill", "env", "secret", "session"].includes(type))
      throw new UsageError("Retire supports single-file assets, not skill packages or protected files.");
    const stashDir = resolveStashDir();
    const minted = createRetireProposal(stashDir, {
      ref: canonical,
      source: "propose",
      target: { source: target.source.name, root: target.source.path },
      expectedRevision: revision,
    });
    let accepted: Awaited<ReturnType<typeof akmProposalAccept>>["proposal"];
    try {
      recordGateDecision(stashDir, minted.id, { outcome: "auto-accepted", reason: "manual-retire", gate: "workspace" });
      accepted = (await akmProposalAccept({ stashDir, id: minted.id })).proposal;
    } catch (error) {
      try {
        rejectProposalDurably(stashDir, minted.id, `manual retire not applied: ${toErrorMessage(error)}`);
      } catch (rejectError) {
        warn(`[retire] could not reject proposal ${minted.id}: ${toErrorMessage(rejectError)}`);
      }
      throw error;
    }
    return {
      proposalId: accepted.id,
      ref: canonical,
      bundle: target.source.name,
      archiveDirs: accepted.retiredArchive?.dirs ?? [],
      warnings: type === "task" ? ["Installed schedules are not changed. Run akm task sync to reconcile them."] : [],
    };
  });
}
