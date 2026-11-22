// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What the adapters of a bundle kept by a secret manager share (`secret-tool`,
 * `azure-key-vault`): such a bundle holds secrets only, as the entries
 * `secrets/<name>` (the path a secret file has in a directory bundle), and the
 * adapter reaches them through the manager's command-line client.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { buildFileContext, type FileContext } from "../../../indexer/walk/file-context";
import { toErrorMessage } from "../../common";
import { ConfigError, UsageError } from "../../errors";
import type { AssetChange, BundleAsset, BundleListing, NewAsset } from "../bundle-adapter";
import type { BundleComponent, IndexDocument } from "../types";
import { hashContent } from "./shared";

const SECRETS_DIR = "secrets";

/** The entry of the secret `name`. */
export function secretEntry(name: string): string {
  return `${SECRETS_DIR}/${name}`;
}

/** The secret an entry names, or undefined for an entry outside `secrets/`. */
export function secretNameOf(entry: string): string | undefined {
  const prefix = `${SECRETS_DIR}/`;
  return entry.startsWith(prefix) && entry.length > prefix.length ? entry.slice(prefix.length) : undefined;
}

/** The secret `conceptId` names, refused when it names none: these bundles hold secrets only. */
export function requireSecretName(conceptId: string): string {
  const name = secretNameOf(conceptId);
  if (name === undefined)
    throw new UsageError(`This bundle holds secrets only, under ${SECRETS_DIR}/; got "${conceptId}".`);
  return name;
}

/** The secret a new asset is, refused for any other type. */
export function newSecretName(asset: NewAsset, adapterId: string): string {
  if (asset.type !== "secret") {
    throw new UsageError(`The ${adapterId} adapter holds secrets only; it cannot create a ${asset.type} asset.`);
  }
  if (asset.sensitive) throw new UsageError(`The ${adapterId} adapter cannot mark a secret sensitive.`);
  return asset.name;
}

/** Where the adapter finds the bundle: its configured `location`. */
export function locationOf(c: BundleComponent, adapterId: string, what: string): string {
  if (c.location) return c.location;
  throw new ConfigError(
    `Bundle "${c.id}" uses the ${adapterId} adapter, which reads ${what}: set the bundle's \`location\` to its name.`,
    "INVALID_CONFIG_FILE",
  );
}

/** The secret `name` as an asset of the bundle, whose value `read` returns, at most once and only when asked. */
export function secretAsset(c: BundleComponent, name: string, read: () => string): BundleAsset {
  const conceptId = secretEntry(name);
  let content: string | undefined;
  const file: FileContext = {
    ...buildFileContext(c.root, path.join(c.root, conceptId)),
    content: () => (content ??= read()),
  };
  return { conceptId, file };
}

/** What a write did to the secret `name` (its `content` after a store): no file changed. */
export function secretChange(c: BundleComponent, name: string, content?: string | Buffer): AssetChange {
  const conceptId = secretEntry(name);
  return { conceptId, path: path.join(c.root, conceptId), changed: [], ...(content !== undefined ? { content } : {}) };
}

/** List the bundle's secrets with `names`; a listing that fails leaves the bundle as the index last saw it. */
export function listSecrets(c: BundleComponent, names: () => string[], read: (name: string) => string): BundleListing {
  try {
    const files = names().map((name) => secretAsset(c, name, () => read(name)).file);
    return { files, complete: true };
  } catch (error) {
    return { files: [], complete: false, incompleteReason: toErrorMessage(error) };
  }
}

/** A secret is recognized from its path alone: its name, and nothing of its value. */
export function recognizeSecret(adapterId: string, c: BundleComponent, entry: string): IndexDocument | null {
  const name = secretNameOf(entry);
  if (name === undefined) return null;
  return {
    ref: `${c.id}//${entry}`,
    bundle: c.id,
    component: "main",
    conceptId: entry,
    path: path.join(c.root, entry),
    // An entry is its name: an unchanged listing rewrites no row.
    hash: hashContent(entry),
    adapterId,
    type: "secret",
    name: name.split("/").pop() as string,
  };
}

/** A command-line client an adapter runs: its program and how to get it. */
export interface Client {
  command: string;
  /** Completes "Install …" when the program is not on PATH. */
  install: string;
}

export interface ClientResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a client and return what it printed and how it exited. `input` is
 * written to its stdin, which is how a value reaches a client: never as an
 * argument, where other processes could read it.
 */
export function runClient(client: Client, args: readonly string[], input?: Buffer): ClientResult {
  const result = spawnSync(client.command, [...args], { encoding: "utf8", input });
  if (result.error) {
    const missing = (result.error as NodeJS.ErrnoException).code === "ENOENT";
    throw new ConfigError(
      missing
        ? `"${client.command}" is not installed.`
        : `"${client.command}" could not be run: ${result.error.message}`,
      "BUNDLE_UNREACHABLE",
      missing ? `Install ${client.install}.` : undefined,
    );
  }
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

/** The error for a request a client failed, with the client's own message. */
export function clientFailure(client: Client, action: string, result: ClientResult): ConfigError {
  const reason = result.stderr.trim() || `exit status ${result.status}`;
  return new ConfigError(`${client.command} could not ${action}: ${reason}`, "BUNDLE_UNREACHABLE");
}

/** Run a client request that must succeed, and return what it printed. */
export function requireClient(client: Client, action: string, args: readonly string[], input?: Buffer): string {
  const result = runClient(client, args, input);
  if (result.status !== 0) throw clientFailure(client, action, result);
  return result.stdout;
}
