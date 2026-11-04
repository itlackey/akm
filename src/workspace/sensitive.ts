// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Environment files and secrets for the owner. Values appear in no result except `readValue`'s; a write names the
 * `revision` (sha256 of the raw bytes) the owner last saw and is checked inside the write lease, with the bytes it
 * then replaces. A host decides who may call `readValue`.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { removeEnv, writeEnv } from "../commands/env/env";
import { removeSecret, setSecret } from "../commands/env/secret";
import { deriveCanonicalAssetName } from "../core/asset/asset-placement";
import {
  resolveEnvPath,
  resolveEnvWriteTarget,
  resolveSecretPath,
  resolveSecretWriteTarget,
  sensitiveMarkerPath,
  withEnvSecretWrite,
} from "../core/env-secret-ref";
import { UsageError } from "../core/errors";
import { interactive } from "./lease";

/** The file: its ref, or its bundle-relative path in a named bundle. */
export interface SensitiveSelector {
  ref?: string;
  bundle?: string;
  file?: string;
}

type Kind = "env" | "secret";
const REF = /^(?:([^/]+)\/\/)?(env|secrets)\//;
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const relative = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/");

/** Reading follows no link: a symbolic link, or a path that leaves the bundle, is refused. */
function safeFile(root: string, file: string) {
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("The file must stay inside its bundle.");
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error("Use the real file, not a symbolic link.");
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
  if (!type) throw new UsageError("Choose an environment file or secret.");
  if (input.ref) return { type, ref: input.ref };
  if (!input.bundle) throw new UsageError("Choose the bundle containing this file.");
  const dir = type === "env" ? "env" : "secrets";
  const name = deriveCanonicalAssetName(type, dir, input.file as string);
  if (!name) throw new UsageError("Use an .env filename for an environment file, or a filename under secrets/.");
  return { type, ref: `${input.bundle}//${dir}/${name}` };
}

/** An existing env/secret file, resolved by akm's own read-side resolvers. */
function locate(input: SensitiveSelector) {
  const { type, ref } = selection(input);
  const found = type === "env" ? resolveEnvPath(ref) : resolveSecretPath(ref);
  const root = found.source.path;
  const file = found.absPath;
  try {
    safeFile(root, file);
  } catch {
    throw new UsageError("Choose a regular env/secret file inside this bundle, not a symbolic link or outside path.");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new UsageError("This file is unavailable. Check its location and filesystem permissions.");
  }
  if (!stat.isFile()) throw new UsageError("Choose a file, not a folder.");
  const bundle = found.source.registryId ?? input.bundle ?? "";
  return {
    bundle,
    file,
    type,
    root,
    relative: relative(root, file),
    ref: ref.includes("//") ? ref : `${bundle}//${ref}`,
  };
}

export function describe(input: SensitiveSelector) {
  const found = locate(input);
  let writable = false;
  try {
    (found.type === "env" ? resolveEnvWriteTarget : resolveSecretWriteTarget)(found.ref, found.bundle);
    writable = true;
  } catch {
    /* a readable bundle akm does not write to */
  }
  const parent = path.posix.dirname(found.relative);
  return {
    ref: found.ref,
    type: found.type,
    name: path.basename(found.file),
    bundle: found.bundle,
    path: found.file,
    writable,
    revision: digest(fs.readFileSync(found.file)),
    location: { bundle: found.bundle, path: found.relative, parent },
  };
}

/** The file's text and revision. The one result that carries a value. */
export function readValue(input: SensitiveSelector) {
  const found = locate(input);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(found.file);
  } catch {
    throw new UsageError("The file could not be read. Check filesystem permissions.");
  }
  const content = bytes.toString("utf8");
  if (bytes.includes(0) || !Buffer.from(content).equals(bytes))
    throw new UsageError("This is a binary file. Open it with a suitable local application.");
  return { content, revision: digest(bytes) };
}

/** Run a write on the file's bundle. A failure after the file changed (git synchronization) is reported, not thrown. */
function write(
  selector: SensitiveSelector,
  op: "Update" | "Remove",
  paths: (file: string, marker: string) => string[],
  mutate: (file: string, type: Kind) => void,
) {
  const chosen = selection(selector);
  const {
    name,
    absPath: file,
    target,
  } = (chosen.type === "env" ? resolveEnvWriteTarget : resolveSecretWriteTarget)(chosen.ref, undefined);
  const type = chosen.type;
  const marker = sensitiveMarkerPath(file, type);
  return interactive(`${type}-${op.toLowerCase()}`, async () => {
    let changed = false;
    const warnings: string[] = [];
    try {
      withEnvSecretWrite(target, { type, name }, op, paths(file, marker), () => {
        mutate(file, type);
        changed = true;
      });
    } catch (error) {
      if (!changed) throw error;
      warnings.push("The file changed, but Git synchronization failed. Check this bundle’s Git status.");
    }
    const bundle = target.source.name;
    return {
      bundle,
      file: relative(target.source.path, file),
      ref: `${bundle}//${type === "env" ? "env/" : "secrets/"}${name}`,
      warnings,
      absolute: file,
    };
  });
}

function changedSince(file: string, revision: string) {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    throw new UsageError("This file is unavailable. Check its location and filesystem permissions.");
  }
  if (digest(bytes) !== revision)
    throw new UsageError(
      "This file changed. Reopen it before saving or deleting; your edit has not been applied.",
      "ASSET_CONTENT_CHANGED",
    );
}

/** Create the file (no `revision`; an existing file is refused) or replace it (the `revision` the owner last saw). */
export async function save(input: SensitiveSelector & { content: string; revision?: string }) {
  if (typeof input.content !== "string" || input.content.includes("\0"))
    throw new UsageError("Provide the file and its text.");
  const content = input.content;
  const { absolute, ...result } = await write(
    input,
    "Update",
    (file) => [file],
    (file, type) => {
      if (input.revision === undefined) {
        if (fs.existsSync(file))
          throw new UsageError(
            "A file already exists at this path. Choose a different name.",
            "RESOURCE_ALREADY_EXISTS",
          );
      } else changedSince(file, input.revision);
      if (type === "env") writeEnv(file, content);
      else setSecret(file, Buffer.from(content));
    },
  );
  return { ...result, revision: digest(fs.readFileSync(absolute)) };
}

/** Delete the file and its sensitive marker, if it is still the `revision` the owner last saw. */
export async function remove(input: SensitiveSelector & { revision: string }) {
  if (typeof input.revision !== "string" || !input.revision)
    throw new UsageError("Provide the file and its current revision.");
  const { revision } = input;
  const { absolute: _absolute, ...result } = await write(
    input,
    "Remove",
    (target, marker) => [target, marker],
    (target, type) => {
      const marker = fs.lstatSync(sensitiveMarkerPath(target, type), { throwIfNoEntry: false });
      if (marker && !marker.isFile())
        throw new UsageError("The sensitive marker is not a regular file. Resolve it before deleting this asset.");
      changedSince(target, revision);
      (type === "env" ? removeEnv : removeSecret)(target);
    },
  );
  return { ...result, removed: true as const };
}
