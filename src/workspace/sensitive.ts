// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Environment files and secrets for the owner, read and written through their bundle's adapter. Values appear in no
 * result except `readValue`'s; a write names the `revision` (sha256 of the content) the owner last saw, and the write
 * checks it with the content it then replaces. A host decides who may call `readValue`.
 */

import fs from "node:fs";
import path from "node:path";
import { deriveCanonicalAssetName } from "../core/asset/asset-placement";
import { assetRevision as digest } from "../core/assets/read";
import {
  findWriteTargetAsset,
  resolveEnvPath,
  resolveEnvWriteTarget,
  resolveSecretPath,
  resolveSecretWriteTarget,
  writeEnvSecret,
} from "../core/env-secret-ref";
import { AkmError, UsageError } from "../core/errors";
import { protectedTypeOf } from "../indexer/walk/place-rules";
import { interactive } from "./lease";

/** The file: its ref, or its bundle-relative path in a named bundle. */
export interface SensitiveSelector {
  ref?: string;
  bundle?: string;
  file?: string;
}

type Kind = "env" | "secret";
const REF = /^(?:([^/]+)\/\/)?(env|secrets)\//;

/** A host shows a value only from the real file: a file reached through a symbolic link inside its bundle is refused. */
function refuseLinked(file: string, relPath: string): void {
  const root = file.slice(0, file.length - relPath.length);
  let current = root;
  for (const part of relPath.split("/")) {
    current = path.join(current, part);
    // asset-io: host Desktop shows a value only from the real file
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new UsageError("Use the real file, not a symbolic link.");
  }
}

/** The ref akm's env/secret functions take, from a ref or a bundle-relative file in a named bundle. */
function selection(input: SensitiveSelector): { type: Kind; ref: string } {
  const match = input.ref ? REF.exec(input.ref) : null;
  const type: Kind | "" = match
    ? match[2] === "env"
      ? "env"
      : "secret"
    : input.file?.startsWith("env/")
      ? "env"
      : input.file?.startsWith("secrets/")
        ? "secret"
        : "";
  if (!type) {
    // akm's env and secret operations take only a file in the top-level env/ or secrets/ folder.
    const nested = input.file === undefined ? undefined : protectedTypeOf(input.file);
    if (nested)
      throw new UsageError(
        `This is a protected ${nested === "env" ? "environment" : "secret"} file that akm manages only at the top level of a bundle, in env/ or secrets/. Its value is not shown here.`,
      );
    throw new UsageError("Choose an environment file or secret.");
  }
  if (input.ref) return { type, ref: input.ref };
  if (!input.bundle) throw new UsageError("Choose the bundle containing this file.");
  const dir = type === "env" ? "env" : "secrets";
  const name = deriveCanonicalAssetName(type, dir, input.file as string);
  if (!name) throw new UsageError("Use an .env filename for an environment file, or a filename under secrets/.");
  return { type, ref: `${input.bundle}//${dir}/${name}` };
}

/** An existing env file or secret, found and read through its bundle's adapter. */
function locate(input: SensitiveSelector) {
  const { type, ref } = selection(input);
  const { asset } = type === "env" ? resolveEnvPath(ref) : resolveSecretPath(ref);
  const bundle = asset.bundle;
  const file = asset.entry.file;
  // A secret a manager keeps has no file, and no link to refuse.
  if (file) refuseLinked(file, asset.entry.relPath);
  return {
    bundle,
    file,
    type,
    relative: asset.entry.relPath,
    ref: ref.includes("//") ? ref : `${bundle}//${ref}`,
    content: () => asset.entry.content(),
  };
}

/** The content of a located env file or secret; an asset that cannot be read is named, with akm's own reason when it has one. */
function contentOf(found: ReturnType<typeof locate>): string {
  try {
    return found.content();
  } catch (error) {
    if (error instanceof AkmError) throw error;
    throw new UsageError("The file could not be read. Check filesystem permissions.");
  }
}

export function describe(input: SensitiveSelector) {
  const found = locate(input);
  // What may be done to the file: allowed when akm would write it, else the sentence its write path refuses with.
  let verdict: { allowed: true } | { allowed: false; reason: string } = { allowed: true };
  try {
    (found.type === "env" ? resolveEnvWriteTarget : resolveSecretWriteTarget)(found.ref, found.bundle);
  } catch (error) {
    verdict = { allowed: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const parent = path.posix.dirname(found.relative);
  return {
    ref: found.ref,
    type: found.type,
    name: path.basename(found.relative),
    bundle: found.bundle,
    // A secret a manager keeps has no file: no path.
    path: found.file ?? null,
    actions: { edit: verdict, delete: verdict },
    revision: digest(contentOf(found)),
    location: { bundle: found.bundle, path: found.relative, parent },
  };
}

/** The file's text and revision. The one result that carries a value. */
export function readValue(input: SensitiveSelector) {
  const content = contentOf(locate(input));
  if (content.includes("\0") || content.includes("\uFFFD"))
    throw new UsageError("This is a binary file. Open it with a suitable local application.");
  return { content, revision: digest(content) };
}

type Resolution = ReturnType<typeof resolveEnvWriteTarget>;

/**
 * Run a write on the bundle that keeps the file or secret. A failure after the write landed (`landed` says whether it
 * did; git synchronization fails after it) is reported, not thrown.
 */
function write(
  selector: SensitiveSelector,
  run: (resolution: Resolution) => void,
  landed: (resolution: Resolution) => boolean,
) {
  const chosen = selection(selector);
  const resolution = (chosen.type === "env" ? resolveEnvWriteTarget : resolveSecretWriteTarget)(chosen.ref, undefined);
  const { type, name, target } = resolution;
  return interactive(`${type}-update`, async () => {
    const warnings: string[] = [];
    try {
      run(resolution);
    } catch (error) {
      if (!landed(resolution)) throw error;
      warnings.push("The file changed, but Git synchronization failed. Check this bundle’s Git status.");
    }
    const bundle = target.source.name;
    const conceptId = `${type === "env" ? "env/" : "secrets/"}${name}`;
    const found = findWriteTargetAsset(resolution);
    return {
      bundle,
      file: found ? found.entry.relPath : conceptId,
      ref: `${bundle}//${conceptId}`,
      warnings,
      resolution,
    };
  });
}

/** The revision of the asset a resolution names now, or undefined when it has none. */
function currentRevision(resolution: Resolution): string | undefined {
  const found = findWriteTargetAsset(resolution);
  return found && digest(found.entry.content());
}

/** Create the file (no `revision`; an existing file is refused) or replace it (the `revision` the owner last saw). */
export async function save(input: SensitiveSelector & { content: string; revision?: string }) {
  if (typeof input.content !== "string" || input.content.includes("\0"))
    throw new UsageError("Provide the file and its text.");
  const { content, revision } = input;
  const { resolution, ...result } = await write(
    input,
    (target) => {
      try {
        if (revision === undefined) writeEnvSecret(target, { op: "create", content, exclusive: true });
        else writeEnvSecret(target, { op: "update", content, revision });
      } catch (error) {
        throw sensitiveWriteError(error);
      }
    },
    (target) => currentRevision(target) === digest(content),
  );
  return { ...result, revision: currentRevision(resolution) ?? digest(content) };
}

/** Delete the file, if it is still the `revision` the owner last saw. */
export async function remove(input: SensitiveSelector & { revision: string }) {
  if (typeof input.revision !== "string" || !input.revision)
    throw new UsageError("Provide the file and its current revision.");
  const { revision } = input;
  const { resolution: _resolution, ...result } = await write(
    input,
    (target) => {
      try {
        writeEnvSecret(target, { op: "delete", revision });
      } catch (error) {
        throw sensitiveWriteError(error);
      }
    },
    (target) => findWriteTargetAsset(target) === undefined,
  );
  return { ...result, removed: true as const };
}

/** The workspace's own wording for the two refusals an owner acts on. */
function sensitiveWriteError(error: unknown): unknown {
  if (!(error instanceof UsageError)) return error;
  if (error.code === "RESOURCE_ALREADY_EXISTS")
    return new UsageError("A file already exists at this path. Choose a different name.", "RESOURCE_ALREADY_EXISTS");
  if (error.code === "ASSET_CONTENT_CHANGED")
    return new UsageError(
      "This file changed. Reopen it before saving or deleting; your edit has not been applied.",
      "ASSET_CONTENT_CHANGED",
    );
  return error;
}
