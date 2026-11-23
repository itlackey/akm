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
import { parseBundleRef } from "../asset/asset-ref";
import { compareCodePoints } from "../common";
import { assetNotFound, ConfigError, UsageError } from "../errors";
import { hashContent } from "./adapters/shared";
import type {
  AssetChange,
  AssetEntry,
  BundleAdapter,
  BundleAsset,
  BundleListing,
  NewAsset,
  PackageFile,
  Retirement,
  RetireNote,
} from "./bundle-adapter";
import type { AssetEdit, Bundle, Diagnostic, IndexDocument, ValidateContext } from "./types";

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

/** The secret `conceptId` names. The facade reads the asset before it changes it, so an id outside `secrets/` is never asked of an adapter. */
function requireSecretName(bundle: string, conceptId: string): string {
  const name = secretNameOf(conceptId);
  if (name === undefined) throw assetNotFound(`${bundle}//${conceptId}`);
  return name;
}

/** Whether `name` is a secret's name as a concept id: the one `secrets/<name>` that parses as a ref and reads back as itself. */
export function isConceptName(name: string): boolean {
  if (name === "" || name.endsWith("/")) return false;
  try {
    const parsed = parseBundleRef(`b//${secretEntryPath(name)}`);
    return parsed.conceptId === secretEntryPath(name) && parsed.fragment === undefined;
  } catch {
    return false;
  }
}

/** The secret `name` as an entry, whose value `read` returns, at most once and only when asked. */
function secretEntry(name: string, read: () => string, locator?: unknown): AssetEntry {
  let content: string | undefined;
  const value = () => {
    content ??= read();
    return content;
  };
  return {
    key: secretEntryPath(name),
    content: value,
    bytes: () => Buffer.from(value()),
    frontmatter: () => null,
    ...(locator !== undefined ? { locator } : {}),
  };
}

/** One item of a store: what its manager holds under a name. Several items can share a name. */
export interface SecretItem {
  /** The name the manager gives it (a keyring entry's label, a vault secret's name). */
  name: string;
  /** What tells items of one name apart: a keyring entry's object path, a vault secret's name. */
  id: string;
  /** What finds it again in the store, when the index records that (a keyring entry's object path and attributes). */
  locator?: unknown;
  /** The value. Called only when someone asks for it. */
  read(): string;
}

/** The items of a store as the rules see them: one winner per valid name; the ignored ones; the items no name fits. */
interface Store {
  winners: Map<string, SecretItem>;
  shadowed: Array<{ name: string; winner: SecretItem; ignored: SecretItem[] }>;
  invalid: SecretItem[];
}

/** One winner per name: the lowest id by code point. */
function classify(items: readonly SecretItem[]): Store {
  const byName = new Map<string, SecretItem[]>();
  const invalid: SecretItem[] = [];
  for (const item of items) {
    if (!isConceptName(item.name)) invalid.push(item);
    else byName.set(item.name, [...(byName.get(item.name) ?? []), item]);
  }
  const winners = new Map<string, SecretItem>();
  const shadowed: Store["shadowed"] = [];
  for (const [name, held] of byName) {
    const ranked = [...held].sort((left, right) => compareCodePoints(left.id, right.id));
    winners.set(name, ranked[0] as SecretItem);
    if (ranked.length > 1) shadowed.push({ name, winner: ranked[0] as SecretItem, ignored: ranked.slice(1) });
  }
  return { winners, shadowed, invalid };
}

export abstract class SecretManagerAdapterBase implements BundleAdapter {
  abstract readonly id: string;
  abstract readonly version: string;
  readonly addressedBy = "location" as const;
  readonly writes: readonly string[] = ["secret"];
  /** A secret is deleted, never retired: nothing recoverable should keep its value. */
  readonly retires: readonly string[] = [];

  /** What `location` names, for the error of a bundle without one: "a keyring", "an Azure Key Vault". */
  protected abstract readonly what: string;
  /** Whether the store at `location` is there. It reads no secret and never prompts. */
  protected abstract locate(location: string): boolean;
  /** Every item of the store, valid name or not, each with how to read its value. */
  protected abstract listSecrets(location: string): SecretItem[];
  /** Store `value` as the secret `name`: in `existing` when the name has an item, else as a new item. */
  protected abstract storeSecret(location: string, name: string, value: Buffer, existing?: SecretItem): void;
  /** Delete `item`. */
  protected abstract deleteSecret(location: string, item: SecretItem): void;
  /** The item that holds `name`, or undefined. By default the winner of one listing; a store can ask for it directly (a vault by name, a keyring by the `locator` the index recorded). */
  protected findSecret(location: string, name: string, _locator?: unknown): SecretItem | undefined {
    return this.store(location).winners.get(name);
  }
  /** Refuse a name the store cannot hold, before anything is asked of it. */
  protected requireStorable(_name: string): void {}

  /** The stores read so far this command, by location: a listing is one request, and a write drops it. */
  private readonly stores = new Map<string, Store>();

  /** Forget what was read: the next request reads the store again. The CLI calls it per command, a server per request. */
  clearCache(): void {
    this.stores.clear();
  }

  private store(location: string): Store {
    let held = this.stores.get(location);
    if (!held) {
      held = classify(this.listSecrets(location));
      this.stores.set(location, held);
    }
    return held;
  }

  /** Where the adapter finds the bundle: its configured `location`. */
  private locationOf(b: Bundle): string {
    if (b.location) return b.location;
    throw new ConfigError(
      `Bundle "${b.id}" uses the ${this.id} adapter, which reads ${this.what}: set the bundle's \`location\` to its name.`,
      "INVALID_CONFIG_FILE",
    );
  }

  /** The name a new asset gives a secret. The facade checks `writes` first, so another type is never asked of the adapter. */
  private secretNameFor(asset: Pick<NewAsset, "type" | "name">): string {
    if (asset.type !== "secret") {
      throw new Error(
        `Adapter "${this.id}" does not write ${asset.type} assets; the asset facade checks \`writes\` first.`,
      );
    }
    if (!isConceptName(asset.name)) {
      throw new UsageError(
        `"${asset.name}" is not a name a secret can have: it must read back as the ref "secrets/${asset.name}".`,
        "INVALID_FLAG_VALUE",
      );
    }
    this.requireStorable(asset.name);
    return asset.name;
  }

  /** What a write did to the secret `name` (its `content` after a store): no file changed. */
  private change(name: string, content?: string | Buffer): AssetChange {
    return { conceptId: secretEntryPath(name), changed: [], ...(content !== undefined ? { content } : {}) };
  }

  /** Run a write on the store: whatever was read of it is stale afterwards, whether the write worked or not. */
  private writing<T>(location: string, write: () => T): T {
    try {
      return write();
    } finally {
      this.stores.delete(location);
    }
  }

  exists(b: Bundle): boolean {
    try {
      return this.locate(this.locationOf(b));
    } catch {
      return false;
    }
  }

  /** List the bundle's secrets. A store that cannot be reached throws `BUNDLE_UNREACHABLE`: the index keeps its rows. */
  list(b: Bundle): BundleListing {
    const held = this.store(this.locationOf(b));
    return {
      assets: [...held.winners.values()].map(({ name, read, locator }) => ({
        conceptId: secretEntryPath(name),
        entry: secretEntry(name, read, locator),
      })),
      complete: true,
      findings: this.findings(b, held),
    };
  }

  read(b: Bundle, conceptId: string, locator?: unknown): BundleAsset | undefined {
    const name = secretNameOf(conceptId);
    if (name === undefined) return undefined;
    const found = this.findSecret(this.locationOf(b), name, locator);
    return found === undefined
      ? undefined
      : { conceptId: secretEntryPath(name), entry: secretEntry(name, found.read, found.locator) };
  }

  /** A secret is described from its path alone: its name, and nothing of its value. */
  recognize(b: Bundle, entry: AssetEntry): IndexDocument | null {
    const name = secretNameOf(entry.key);
    if (name === undefined) return null;
    return {
      ref: `${b.id}//${entry.key}`,
      bundle: b.id,
      conceptId: entry.key,
      // An entry is its name and where the store holds it: an unchanged listing rewrites no row.
      hash: hashContent(entry.locator === undefined ? entry.key : `${entry.key}\n${JSON.stringify(entry.locator)}`),
      adapterId: this.id,
      type: "secret",
      name: name.split("/").pop() as string,
      ...(entry.locator !== undefined ? { locator: entry.locator } : {}),
    };
  }

  /** What is wrong with the store as listed: a name that is not a valid concept name is not listed, and items sharing a name leave one winner. */
  private findings(b: Bundle, held: Store): Diagnostic[] {
    return [
      ...held.invalid.map(({ name, id }) => ({
        ref: `${b.id}//${secretEntryPath(name)}`,
        issue: "invalid-name",
        detail: `The entry "${name}" (${id}) is not a name a secret can have, so it is not listed. Rename it in ${this.what}.`,
        fixed: false as const,
      })),
      ...held.shadowed.map(({ name, winner, ignored }) => ({
        ref: `${b.id}//${secretEntryPath(name)}`,
        issue: "shadowed-spelling",
        detail: `"${secretEntryPath(name)}" is held by more than one entry; ${winner.id} is used and ${ignored.map((item) => item.id).join(", ")} ignored. Remove the ignored ${ignored.length === 1 ? "entry" : "entries"}.`,
        fixed: false as const,
      })),
    ];
  }

  /** Nothing is checked live: lint never lists the store. What `akm index` found (`findings`) the facade adds from the index. */
  async validate(_b: Bundle, _edits: AssetEdit[], _ctx: ValidateContext): Promise<Diagnostic[]> {
    return [];
  }

  place(_b: Bundle, asset: Pick<NewAsset, "type" | "name">): string {
    return secretEntryPath(this.secretNameFor(asset));
  }

  create(
    b: Bundle,
    asset: NewAsset,
    options: { replace?: boolean; verbatim?: boolean; locator?: unknown } = {},
  ): AssetChange {
    const name = this.secretNameFor(asset);
    const location = this.locationOf(b);
    const existing = this.findSecret(location, name, options.locator);
    if (existing && !options.replace) {
      throw new Error(
        `Adapter "${this.id}" will not create "${b.id}//${secretEntryPath(name)}" over an existing secret without \`replace\`; the asset facade checks \`exclusive\` first.`,
      );
    }
    this.writing(location, () => this.storeSecret(location, name, Buffer.from(asset.content), existing));
    return this.change(name, asset.content);
  }

  update(b: Bundle, conceptId: string, content: string | Buffer, options: { locator?: unknown } = {}): AssetChange {
    const location = this.locationOf(b);
    const name = requireSecretName(b.id, conceptId);
    const existing = this.findSecret(location, name, options.locator);
    if (!existing) throw assetNotFound(`${b.id}//${conceptId}`);
    this.writing(location, () => this.storeSecret(location, name, Buffer.from(content), existing));
    return this.change(name, content);
  }

  delete(b: Bundle, conceptId: string, options: { locator?: unknown } = {}): AssetChange {
    const location = this.locationOf(b);
    const name = requireSecretName(b.id, conceptId);
    const existing = this.findSecret(location, name, options.locator);
    if (!existing) throw assetNotFound(`${b.id}//${conceptId}`);
    this.writing(location, () => this.deleteSecret(location, existing));
    return this.change(name);
  }

  packageFiles(_b: Bundle, _conceptId: string): PackageFile[] {
    return this.refusePackages();
  }

  mirrorPackage(
    _b: Bundle,
    _asset: Pick<NewAsset, "type" | "name">,
    _files: readonly PackageFile[],
    _options?: { replace?: boolean },
  ): AssetChange[] {
    return this.refusePackages();
  }

  private refusePackages(): never {
    throw new Error(`Adapter "${this.id}" keeps no packages; the asset facade checks \`writes\` first.`);
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
    throw new Error(`Adapter "${this.id}" does not retire assets; the asset facade checks \`retires\` first.`);
  }
}

/** Wait `ms` without returning to the event loop: adapters answer synchronously. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

/** How long one client call is given: a client that hangs fails the command, not akm. */
const CLIENT_TIMEOUT_MS = 60_000;

/**
 * Run a client and return what it printed and how it exited. `input` is
 * written to its stdin, which is how a value reaches a client: never as an
 * argument, where other processes could read it.
 */
export function runClient(
  client: Client,
  args: readonly string[],
  input?: Buffer,
  timeoutMs = CLIENT_TIMEOUT_MS,
): ClientResult {
  // The environment as it is now: Bun 1.3 finds the program on the PATH the process started with unless it is given.
  const result = spawnSync(client.command, [...args], {
    encoding: "utf8",
    input,
    env: process.env,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  if (result.error) {
    const missing = (result.error as NodeJS.ErrnoException).code === "ENOENT";
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw new ConfigError(`"${client.command}" did not answer within ${timeoutMs / 1000} s.`, "BUNDLE_UNREACHABLE");
    }
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
export function requireClient(
  client: Client,
  action: string,
  args: readonly string[],
  input?: Buffer,
  timeoutMs?: number,
): string {
  const result = runClient(client, args, input, timeoutMs);
  if (result.status !== 0) throw clientFailure(client, action, result);
  return result.stdout;
}
