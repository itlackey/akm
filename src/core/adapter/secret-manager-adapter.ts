// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The base of the adapters of a bundle kept by a secret manager (`secret-tool`,
 * `azure-key-vault`): such a bundle holds secrets only, as the entries
 * `secrets/<name>` (the path a secret file has in a directory bundle), and the
 * adapter reaches them through the manager's command-line client. An entry is
 * no file: it has no `file`, and its index document has no `path`.
 *
 * `SecretManagerAdapterBase` implements every `BundleAdapter` member once; a
 * subclass supplies the four primitives that talk to the manager.
 */

import { spawnSync } from "node:child_process";
import { toErrorMessage } from "../common";
import { ConfigError, NotFoundError, UsageError } from "../errors";
import type { FileChange } from "../file-change";
import { hashContent } from "./adapters/shared";
import type {
  AssetChange,
  AssetEntry,
  BundleAdapter,
  BundleAsset,
  BundleListing,
  NewAsset,
  Retirement,
  RetireNote,
} from "./bundle-adapter";
import type { Bundle, Diagnostic, IndexDocument, ValidateContext } from "./types";

const SECRETS_DIR = "secrets";

/** The entry of the secret `name`. */
function secretEntryPath(name: string): string {
  return `${SECRETS_DIR}/${name}`;
}

/** The secret an entry names, or undefined for an entry outside `secrets/`. */
function secretNameOf(entry: string): string | undefined {
  const prefix = `${SECRETS_DIR}/`;
  return entry.startsWith(prefix) && entry.length > prefix.length ? entry.slice(prefix.length) : undefined;
}

/** The secret `conceptId` names, refused when it names none: these bundles hold secrets only. */
function requireSecretName(conceptId: string): string {
  const name = secretNameOf(conceptId);
  if (name === undefined) {
    throw new UsageError(`This bundle holds secrets only, under ${SECRETS_DIR}/; got "${conceptId}".`);
  }
  return name;
}

/** The secret `name` as an entry, whose value `read` returns, at most once and only when asked. */
function secretEntry(name: string, read: () => string): AssetEntry {
  let content: string | undefined;
  const value = () => {
    content ??= read();
    return content;
  };
  return {
    relPath: secretEntryPath(name),
    content: value,
    bytes: () => Buffer.from(value()),
    frontmatter: () => null,
  };
}

export abstract class SecretManagerAdapterBase implements BundleAdapter {
  abstract readonly id: string;
  abstract readonly version: string;
  readonly writes: readonly string[] = ["secret"];
  /** A secret is deleted, never retired: nothing recoverable should keep its value. */
  readonly retires: readonly string[] = [];

  /** What `location` names, for the error of a bundle without one: "a keyring", "an Azure Key Vault". */
  protected abstract readonly what: string;
  /** The secrets of the store at `location`, each with how to read its value. */
  protected abstract listSecrets(location: string): Array<{ name: string; read(): string }>;
  /** The secret `name`, or undefined when the store has none. */
  protected abstract findSecret(location: string, name: string): { read(): string } | undefined;
  /** Store `value` as the secret `name`, replacing one of that name. */
  protected abstract storeSecret(location: string, name: string, value: Buffer): void;
  /** Delete the secret `name`. False: the store has no such secret. */
  protected abstract deleteSecret(location: string, name: string): boolean;

  /** Where the adapter finds the bundle: its configured `location`. */
  private locationOf(b: Bundle): string {
    if (b.location) return b.location;
    throw new ConfigError(
      `Bundle "${b.id}" uses the ${this.id} adapter, which reads ${this.what}: set the bundle's \`location\` to its name.`,
      "INVALID_CONFIG_FILE",
    );
  }

  /** The name a new asset gives a secret, refused for any other type. */
  private secretNameFor(asset: Pick<NewAsset, "type" | "name">): string {
    if (asset.type !== "secret") {
      throw new UsageError(`The ${this.id} adapter holds secrets only; it cannot create a ${asset.type} asset.`);
    }
    return asset.name;
  }

  /** What a write did to the secret `name` (its `content` after a store): no file changed. */
  private change(name: string, content?: string | Buffer): AssetChange {
    return { conceptId: secretEntryPath(name), changed: [], ...(content !== undefined ? { content } : {}) };
  }

  /** List the bundle's secrets; a listing that fails leaves the bundle as the index last saw it. */
  list(b: Bundle): BundleListing {
    try {
      return {
        entries: this.listSecrets(this.locationOf(b)).map(({ name, read }) => secretEntry(name, read)),
        complete: true,
      };
    } catch (error) {
      return { entries: [], complete: false, incompleteReason: toErrorMessage(error) };
    }
  }

  read(b: Bundle, conceptId: string): BundleAsset | undefined {
    const name = secretNameOf(conceptId);
    if (name === undefined) return undefined;
    const found = this.findSecret(this.locationOf(b), name);
    return found === undefined
      ? undefined
      : { conceptId: secretEntryPath(name), type: "secret", entry: secretEntry(name, found.read), listed: true };
  }

  /** A secret is recognized from its path alone: its name, and nothing of its value. */
  recognize(b: Bundle, entry: AssetEntry): IndexDocument | null {
    const name = secretNameOf(entry.relPath);
    if (name === undefined) return null;
    return {
      ref: `${b.id}//${entry.relPath}`,
      bundle: b.id,
      conceptId: entry.relPath,
      // An entry is its name: an unchanged listing rewrites no row.
      hash: hashContent(entry.relPath),
      adapterId: this.id,
      type: "secret",
      name: name.split("/").pop() as string,
    };
  }

  async validate(_b: Bundle, _changes: FileChange[], _ctx: ValidateContext): Promise<Diagnostic[]> {
    return [];
  }

  place(_b: Bundle, asset: Pick<NewAsset, "type" | "name">): string {
    return secretEntryPath(this.secretNameFor(asset));
  }

  create(b: Bundle, asset: NewAsset): AssetChange {
    const name = this.secretNameFor(asset);
    if (asset.unlisted) throw new UsageError(`The ${this.id} adapter cannot mark a secret sensitive.`);
    this.storeSecret(this.locationOf(b), name, Buffer.from(asset.content));
    return this.change(name, asset.content);
  }

  update(b: Bundle, conceptId: string, content: string | Buffer): AssetChange {
    const location = this.locationOf(b);
    const name = requireSecretName(conceptId);
    if (!this.findSecret(location, name)) throw new NotFoundError(`Secret not found: ${b.id}//${conceptId}`);
    this.storeSecret(location, name, Buffer.from(content));
    return this.change(name, content);
  }

  delete(b: Bundle, conceptId: string): AssetChange {
    const location = this.locationOf(b);
    const name = requireSecretName(conceptId);
    if (!this.deleteSecret(location, name)) throw new NotFoundError(`Secret not found: ${b.id}//${conceptId}`);
    return this.change(name);
  }

  retire(_b: Bundle, _conceptId: string, _note: RetireNote): AssetChange & { handle: string } {
    return this.refuseRetire();
  }

  retired(_b: Bundle): Retirement[] {
    return [];
  }

  restore(_b: Bundle, _handle: string, _fallback?: string | Buffer): AssetChange {
    return this.refuseRetire();
  }

  forget(_b: Bundle, _handle: string): { changed: string[] } {
    return this.refuseRetire();
  }

  expireRetired(_b: Bundle, _before: Date): { changed: string[] } {
    return this.refuseRetire();
  }

  private refuseRetire(): never {
    throw new UsageError(`The ${this.id} adapter deletes secrets; it does not retire them.`);
  }
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

/** What a client's message says when it could not reach the store or was not let in: a vault or keyring that is not there, no session bus, no login. */
const UNREACHABLE =
  /az login|AADSTS|AuthorizationFailed|Forbidden|VaultNotFound|ServiceUnknown|Failed to connect|Cannot autolaunch|No such (secret )?collection|Unknown object|org\.freedesktop\.DBus\.Error/i;

/**
 * The error for a request a client failed, with the client's own message. A store that cannot be reached or
 * refuses the account is `BUNDLE_UNREACHABLE`; any other failure is a plain error naming the operation.
 */
export function clientFailure(client: Client, action: string, result: ClientResult): Error {
  const reason = result.stderr.trim() || `exit status ${result.status}`;
  const message = `${client.command} could not ${action}: ${reason}`;
  return UNREACHABLE.test(reason) ? new ConfigError(message, "BUNDLE_UNREACHABLE") : new Error(message);
}

/** Run a client request that must succeed, and return what it printed. */
export function requireClient(client: Client, action: string, args: readonly string[], input?: Buffer): string {
  const result = runClient(client, args, input);
  if (result.status !== 0) throw clientFailure(client, action, result);
  return result.stdout;
}
