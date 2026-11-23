// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `secret-tool` adapter: a bundle that is one collection (keyring, wallet) of
 * the desktop's Secret Service (KWallet on KDE, GNOME Keyring).
 *
 * The bundle's `location` names the collection: the alias of that name, else the
 * collection labelled so, else the collection whose object path ends in it. akm resolves it once to the collection's object path and
 * uses that path for every request. Every entry of the collection is a secret of
 * the bundle, `secrets/<label>`.
 *
 * `secret-tool` has no verb that lists a keyring, and finds an entry only by
 * its attribute pairs. So `akm index` reads the entries (label, object path and
 * attributes, never a value) from the service with `busctl` and records the path
 * and attributes on each entry's index row; at run time the only thing asked of
 * the store is a value, by those recorded attributes. An entry akm creates gets
 * the one pair `secret-tool` requires, and an entry is deleted by its recorded
 * object path, because `secret-tool clear` deletes every match in every keyring
 * (and KWallet's keeps the entry). A read, store or delete into a locked
 * collection unlocks it through `secret-tool`: the keyring manager shows its
 * prompt to that process, which waits for the answer.
 */

import { compareCodePoints } from "../../common";
import { ConfigError, UsageError } from "../../errors";
import { warn } from "../../warn";
import {
  type Client,
  type ClientResult,
  clientFailure,
  isConceptName,
  requireClient,
  runClient,
  type SecretItem,
  SecretManagerAdapterBase,
} from "../secret-manager-adapter";

const ID = "secret-tool";
const SECRET_TOOL: Client = { command: "secret-tool", install: "the libsecret-tools package" };
const BUSCTL: Client = { command: "busctl", install: "systemd, which provides it" };

const SERVICE = "org.freedesktop.secrets";

/** The one pair `secret-tool store` requires of a new entry; nothing reads it back as meaning anything. */
const CREATED_ATTRIBUTE = "akm";

/** What the index records of an entry (its `locator`): its object path in the service and its attribute pairs. */
interface KeyringLocator {
  item: string;
  attributes: Record<string, string>;
}

interface KeyringItem extends SecretItem {
  /** The item's object path in the service. */
  path: string;
  attributes: Record<string, string>;
  /** The bundle's `location`, for messages. */
  keyring: string;
}

/** One `busctl --json=short` reply: a method's results, or a property's value. */
interface BusReply<T> {
  data: T;
}

function bus<T>(action: string, args: readonly string[]): T {
  const reply = requireClient(BUSCTL, action, ["--user", "--json=short", ...args]);
  return (JSON.parse(reply) as BusReply<T>).data;
}

const SERVICE_PATH = "/org/freedesktop/secrets";
const SERVICE_INTERFACE = "org.freedesktop.Secret.Service";
const COLLECTION = "org.freedesktop.Secret.Collection";
const NO_OBJECT = "/";

/** How long a `secret-tool` call into a locked collection is given: it waits for a person to answer the unlock prompt. */
const UNLOCK_WAIT_MS = 120_000;

/** The collections' object paths resolved this command, by location. */
const collections = new Map<string, string>();

/** The object path of the collection `location` names: the alias of that name, else the collection labelled so; undefined when neither. */
function resolveCollection(location: string): string | undefined {
  const known = collections.get(location);
  if (known) return known;
  const reading = `find keyring "${location}"`;
  const [alias] = bus<[string]>(reading, [
    "call",
    SERVICE,
    SERVICE_PATH,
    SERVICE_INTERFACE,
    "ReadAlias",
    "s",
    location,
  ]);
  let found: string | undefined = alias !== NO_OBJECT ? alias : undefined;
  if (!found) {
    for (const path of collectionPaths(reading)) {
      if (bus<string>(reading, ["get-property", SERVICE, path, COLLECTION, "Label"]) === location) {
        found = path;
        break;
      }
    }
  }
  // Before the alias and the label, a collection was named by its own object path: `/collection/<location>` still is.
  if (!found) {
    const own = `/org/freedesktop/secrets/collection/${location}`;
    if (collectionPaths(reading).includes(own)) found = own;
  }
  if (found) collections.set(location, found);
  return found;
}

function collectionPaths(action: string): string[] {
  return bus<string[]>(action, ["get-property", SERVICE, SERVICE_PATH, SERVICE_INTERFACE, "Collections"]).filter(
    (path) => path !== NO_OBJECT && path !== "",
  );
}

/** The collection `location` names, or a refusal naming the ones the service has. */
function requireCollection(location: string): string {
  const found = resolveCollection(location);
  if (found) return found;
  const available = collectionPaths("list keyrings").map((path) =>
    bus<string>("list keyrings", ["get-property", SERVICE, path, COLLECTION, "Label"]),
  );
  throw new ConfigError(
    `Keyring "${location}" does not exist. The Secret Service has: ${available.join(", ") || "no keyrings"}.`,
    "BUNDLE_UNREACHABLE",
    `secret-tool cannot create a keyring. Create the wallet or keyring "${location}" in your keyring manager (KWalletManager, Seahorse), or set the bundle's \`location\` to the alias or label of one that exists.`,
  );
}

/**
 * Run `secret-tool`. When the collection is `locked`, `secret-tool` itself shows the keyring's unlock prompt and waits
 * for the answer, so say so first and give the call the time a person needs.
 */
function runSecretTool(
  keyring: string,
  locked: boolean,
  action: string,
  args: readonly string[],
  input?: Buffer,
): ClientResult {
  if (locked) warn(`Keyring "${keyring}" is locked: unlock it in the prompt your keyring manager shows.`);
  return runClient(SECRET_TOOL, args, input, locked ? UNLOCK_WAIT_MS : undefined);
}

/** The collection an item's object path belongs to. */
const collectionOf = (item: Pick<KeyringItem, "path">): string => item.path.slice(0, item.path.lastIndexOf("/"));

function itemAt(path: string, reading: string, keyring: string): KeyringItem {
  const [properties] = bus<[{ Label: BusReply<string>; Attributes: BusReply<Record<string, string>> }]>(reading, [
    "call",
    SERVICE,
    path,
    "org.freedesktop.DBus.Properties",
    "GetAll",
    "s",
    "org.freedesktop.Secret.Item",
  ]);
  return keyringItem(keyring, path, properties.Label.data, properties.Attributes.data);
}

function keyringItem(keyring: string, path: string, name: string, attributes: Record<string, string>): KeyringItem {
  const item: KeyringItem = {
    path,
    attributes,
    name,
    keyring,
    id: path,
    locator: { item: path, attributes } satisfies KeyringLocator,
    read: () => lookup(item),
  };
  return item;
}

/** The `attribute value …` arguments by which `secret-tool` finds `item`. */
function attributePairs(item: Pick<KeyringItem, "name" | "attributes">): string[] {
  const pairs = Object.entries(item.attributes).flat();
  if (pairs.length === 0) {
    throw new ConfigError(
      `Keyring entry "${item.name}" has no attributes, and secret-tool finds an entry only by its attributes.`,
      "BUNDLE_UNREACHABLE",
      "Give the entry an attribute in your keyring manager, or store it again with `akm secret set`.",
    );
  }
  return pairs;
}

const movedError = (item: Pick<KeyringItem, "keyring" | "name">): ConfigError =>
  new ConfigError(
    `Keyring "${item.keyring}" no longer holds "${item.name}" as indexed: run akm index.`,
    "BUNDLE_UNREACHABLE",
  );

/**
 * `secret-tool` finds an entry by attributes in ANY keyring, and takes the first whose attributes include them. So
 * before it reads or replaces `item`, require `item` to be the only entry the service finds for its recorded
 * attributes (one `SearchItems`). Answers whether its collection is locked. An entry the service no longer finds by
 * them (KWallet rewrites attributes) is refused: the index is out of date.
 */
function requireOnlyMatch(item: KeyringItem): boolean {
  const pairs = attributePairs(item);
  const [unlocked, locked] = bus<[string[], string[]]>(`check "${item.name}"`, [
    "call",
    SERVICE,
    SERVICE_PATH,
    SERVICE_INTERFACE,
    "SearchItems",
    "a{ss}",
    String(pairs.length / 2),
    ...pairs,
  ]);
  if (![...unlocked, ...locked].includes(item.path)) throw movedError(item);
  const other = [...unlocked, ...locked].find((path) => path !== item.path);
  if (other !== undefined) {
    const clash = itemAt(other, `check "${item.name}"`, item.keyring);
    throw new UsageError(
      `Keyring entry "${clash.name}" (${clash.path}) has attributes that include those of "${item.name}", so secret-tool would use it in place of "${item.name}".`,
      "INVALID_FLAG_VALUE",
      "Remove one of the entries in your keyring manager, or give one a distinguishing attribute.",
    );
  }
  return locked.includes(item.path);
}

function lookup(item: KeyringItem): string {
  const locked = requireOnlyMatch(item);
  const result = runSecretTool(item.keyring, locked, `read "${item.name}"`, ["lookup", ...attributePairs(item)]);
  if (result.status === 1 && result.stderr.trim() === "") throw movedError(item);
  if (result.status !== 0) throw clientFailure(SECRET_TOOL, `read "${item.name}"`, result);
  return result.stdout;
}

/** The entries listed or written this command, by `<keyring>/<name>`: a write's index row is refreshed from them, before the next `akm index`. */
const written = new Map<string, KeyringItem>();

/** The entry `name` of `keyring` as this command wrote it, else as the index recorded it (`locator`, from the facade). */
function recorded(keyring: string, name: string, locator: KeyringLocator | undefined): KeyringItem | undefined {
  const fresh = written.get(`${keyring}/${name}`);
  if (fresh) return fresh;
  return locator ? keyringItem(keyring, locator.item, name, locator.attributes) : undefined;
}

export class SecretToolAdapter extends SecretManagerAdapterBase {
  readonly id = ID;
  // 0.10.1: the index row records the entry's `locator`, so `akm index` rewrites rows that recorded it under another name.
  readonly version = "0.10.1";
  protected readonly what = "a keyring";

  /** Forget the collections and entries read so far: the next request reads them again. */
  override clearCache(): void {
    super.clearCache();
    collections.clear();
    written.clear();
  }

  protected locate(keyring: string): boolean {
    return resolveCollection(keyring) !== undefined;
  }

  /** For `akm index`: the one place the service is listed. */
  protected listSecrets(keyring: string): SecretItem[] {
    const collection = requireCollection(keyring);
    const reading = `read keyring "${keyring}"`;
    const paths = bus<string[]>(reading, ["get-property", SERVICE, collection, COLLECTION, "Items"]);
    // A closed KWallet lists no entries while it is locked, which is not an empty wallet.
    if (paths.length === 0 && bus<boolean>(reading, ["get-property", SERVICE, collection, COLLECTION, "Locked"])) {
      throw new ConfigError(
        `Keyring "${keyring}" is locked and lists no entries until it is unlocked: unlock it in your keyring manager (KWalletManager, Seahorse), then run akm index again.`,
        "BUNDLE_UNREACHABLE",
      );
    }
    const items = paths.map((path) => itemAt(path, reading, keyring));
    for (const item of [...items].sort((left, right) => compareCodePoints(left.path, right.path))) {
      if (isConceptName(item.name) && !written.has(`${keyring}/${item.name}`))
        written.set(`${keyring}/${item.name}`, item);
    }
    return items;
  }

  protected override findSecret(keyring: string, name: string, locator?: unknown): SecretItem | undefined {
    return recorded(keyring, name, locator as KeyringLocator | undefined);
  }

  /** Store `value` as the secret `name`: into its existing entry, or a new one akm can find again. */
  protected storeSecret(keyring: string, name: string, value: Buffer, existing?: SecretItem): void {
    const entry = existing as KeyringItem | undefined;
    const collection = entry ? collectionOf(entry) : requireCollection(keyring);
    const locked = entry
      ? requireOnlyMatch(entry)
      : bus<boolean>(`store "${name}"`, ["get-property", SERVICE, collection, COLLECTION, "Locked"]);
    const attributes = entry?.attributes ?? { [CREATED_ATTRIBUTE]: `${keyring}/${name}` };
    const pairs = attributePairs({ name, attributes });
    const action = `store "${name}"`;
    const result = runSecretTool(
      keyring,
      locked,
      action,
      ["store", `--collection=${collection}`, `--label=${name}`, ...pairs],
      value,
    );
    if (result.status !== 0) throw clientFailure(SECRET_TOOL, action, result);
    // The entry as the service now holds it: its object path and current pairs, for the index row.
    const [unlocked, lockedPaths] = bus<[string[], string[]]>(action, [
      "call",
      SERVICE,
      SERVICE_PATH,
      SERVICE_INTERFACE,
      "SearchItems",
      "a{ss}",
      String(pairs.length / 2),
      ...pairs,
    ]);
    const path = [...unlocked, ...lockedPaths].find((found) => found.startsWith(`${collection}/`));
    if (path) written.set(`${keyring}/${name}`, itemAt(path, action, keyring));
  }

  protected deleteSecret(keyring: string, item: SecretItem): void {
    const entry = item as KeyringItem;
    written.delete(`${keyring}/${item.name}`);
    const refusal = () =>
      new ConfigError(
        `Keyring "${keyring}" asks for confirmation before it deletes "${item.name}".`,
        "BUNDLE_UNREACHABLE",
        "Unlock the keyring and try again.",
      );
    // `Delete` answers with the prompt it needs, or "/" when it has deleted the item. A prompt belongs to the
    // connection that asked, so unlock in `secret-tool` (a lookup of the entry) and ask again.
    const del = () =>
      bus<[string]>(`delete "${item.name}"`, ["call", SERVICE, entry.path, "org.freedesktop.Secret.Item", "Delete"])[0];
    if (del() !== NO_OBJECT) {
      if (Object.keys(entry.attributes).length === 0) throw refusal();
      lookup(entry);
      if (del() !== NO_OBJECT) throw refusal();
    }
    const remaining = bus<string[]>(`check "${item.name}" was deleted`, [
      "get-property",
      SERVICE,
      collectionOf(entry),
      COLLECTION,
      "Items",
    ]);
    if (remaining.includes(entry.path)) {
      throw new ConfigError(
        `Keyring "${keyring}" answered that "${item.name}" was deleted, but the entry is still there.`,
        "BUNDLE_UNREACHABLE",
        "Delete it in your keyring manager (KWalletManager, Seahorse).",
      );
    }
  }
}

export const secretToolAdapter = new SecretToolAdapter();
