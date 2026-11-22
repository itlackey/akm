// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Environment files and secrets for the owner. Values appear in no result except `readValue`'s; a write names the
 * `revision` (sha256 of the raw bytes) the owner last saw and is checked inside the write lease, with the bytes it
 * then replaces. A host decides who may call `readValue`.
 *
 * A secret is a file of a directory bundle or an entry of a secret store bundle. Both are addressed alike
 * (`secrets/<name>`) and every operation here works on both.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { removeEnv, writeEnv } from "../commands/env/env";
import { removeSecret, setSecret } from "../commands/env/secret";
import type { SecretStore } from "../core/adapter/secret-store";
import { deriveCanonicalAssetName } from "../core/asset/asset-placement";
import {
  resolveEnvPath,
  resolveEnvWriteTarget,
  resolveSecretPath,
  resolveSecretWriteTarget,
  sensitiveMarkerPath,
  withEnvSecretWrite,
} from "../core/env-secret-ref";
import { AkmError, NotFoundError, UsageError } from "../core/errors";
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

/**
 * One env file or secret as a write uses it: its bytes, wherever they are kept. A file of a directory bundle, or an
 * entry of a secret store.
 */
interface Kept {
  exists(): boolean;
  /** Its bytes. Throws when they cannot be had. */
  read(): Buffer;
  write(content: string): void;
  remove(): void;
}

function keptAsFile(file: string, type: Kind): Kept {
  return {
    exists: () => fs.existsSync(file),
    read: () => fs.readFileSync(file),
    write: (content) => (type === "env" ? writeEnv(file, content) : setSecret(file, Buffer.from(content))),
    remove() {
      const marker = fs.lstatSync(sensitiveMarkerPath(file, type), { throwIfNoEntry: false });
      if (marker && !marker.isFile())
        throw new UsageError("The sensitive marker is not a regular file. Resolve it before deleting this asset.");
      (type === "env" ? removeEnv : removeSecret)(file);
    },
  };
}

function keptInStore(store: SecretStore, name: string): Kept {
  return {
    exists: () => store.read(name) !== undefined,
    read() {
      const value = store.read(name);
      if (value === undefined) throw new NotFoundError(`Secret not found: secrets/${name}`);
      return Buffer.from(value);
    },
    write: (content) => store.write(name, Buffer.from(content)),
    remove: () => void store.remove(name),
  };
}

/** An existing env file or secret, resolved by akm's own read-side resolvers. */
function locate(input: SensitiveSelector) {
  const { type, ref } = selection(input);
  // One request to a secret store finds its secret and reads it: `describe` and `readValue` both need the bytes.
  const found = type === "env" ? resolveEnvPath(ref) : resolveSecretPath(ref, { readStoreSecret: true });
  const root = found.source.path;
  const file = found.absPath;
  const bundle = found.source.registryId ?? input.bundle ?? "";
  const located = {
    bundle,
    file,
    type,
    root,
    relative: relative(root, file),
    ref: ref.includes("//") ? ref : `${bundle}//${ref}`,
  };
  const storeValue = "storeValue" in found ? found.storeValue : undefined;
  if (storeValue !== undefined) {
    // A secret store entry has no file to check; what is shown as its path is its store.
    const shown = `${found.source.adapterId}:${found.source.locator}`;
    return { ...located, shown, read: () => Buffer.from(storeValue) };
  }
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
  return { ...located, shown: file, read: () => fs.readFileSync(file) };
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
    name: path.basename(found.file),
    bundle: found.bundle,
    path: found.shown,
    actions: { edit: verdict, delete: verdict },
    revision: digest(found.read()),
    location: { bundle: found.bundle, path: found.relative, parent },
  };
}

/** The file's text and revision. The one result that carries a value. */
export function readValue(input: SensitiveSelector) {
  const found = locate(input);
  let bytes: Buffer;
  try {
    bytes = found.read();
  } catch {
    throw new UsageError("The file could not be read. Check filesystem permissions.");
  }
  const content = bytes.toString("utf8");
  if (bytes.includes(0) || !Buffer.from(content).equals(bytes))
    throw new UsageError("This is a binary file. Open it with a suitable local application.");
  return { content, revision: digest(bytes) };
}

/**
 * Run a write on the bundle that keeps the file or secret. A failure after it changed (git synchronization) is
 * reported, not thrown.
 */
function write(
  selector: SensitiveSelector,
  op: "Update" | "Remove",
  paths: (file: string, marker: string) => string[],
  mutate: (kept: Kept) => void,
) {
  const chosen = selection(selector);
  const type = chosen.type;
  const resolution = (type === "env" ? resolveEnvWriteTarget : resolveSecretWriteTarget)(chosen.ref, undefined);
  const { name, absPath: file, target } = resolution;
  const store = "store" in resolution ? resolution.store : undefined;
  const kept = store ? keptInStore(store, name) : keptAsFile(file, type);
  return interactive(`${type}-${op.toLowerCase()}`, async () => {
    let changed = false;
    const warnings: string[] = [];
    const apply = () => {
      mutate(kept);
      changed = true;
    };
    try {
      // A secret store has no files and no git boundary: the write is the store's own.
      if (store) apply();
      else withEnvSecretWrite(target, { type, name }, op, paths(file, sensitiveMarkerPath(file, type)), apply);
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
      kept,
    };
  });
}

function changedSince(kept: Kept, revision: string) {
  let bytes: Buffer;
  try {
    bytes = kept.read();
  } catch (error) {
    // A failure akm has already worded (a secret store that cannot be reached) is shown as it is.
    if (error instanceof AkmError) throw error;
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
  const { kept, ...result } = await write(
    input,
    "Update",
    (file) => [file],
    (target) => {
      if (input.revision === undefined) {
        if (target.exists())
          throw new UsageError(
            "A file already exists at this path. Choose a different name.",
            "RESOURCE_ALREADY_EXISTS",
          );
      } else changedSince(target, input.revision);
      target.write(content);
    },
  );
  return { ...result, revision: digest(kept.read()) };
}

/** Delete the file and its sensitive marker, if it is still the `revision` the owner last saw. */
export async function remove(input: SensitiveSelector & { revision: string }) {
  if (typeof input.revision !== "string" || !input.revision)
    throw new UsageError("Provide the file and its current revision.");
  const { revision } = input;
  const { kept: _kept, ...result } = await write(
    input,
    "Remove",
    (file, marker) => [file, marker],
    (target) => {
      changedSince(target, revision);
      target.remove();
    },
  );
  return { ...result, removed: true as const };
}
