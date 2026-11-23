// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `secret-tool` adapter: a bundle that is one collection (keyring, wallet) of
 * the desktop's Secret Service (KWallet on KDE, GNOME Keyring).
 *
 * The bundle's `location` names the collection: the alias of that name, else the
 * collection labelled so. akm resolves it once to the collection's object path and
 * uses that path for every request. Every entry of the collection is a secret of
 * the bundle, `secrets/<label>`.
 *
 * `secret-tool` has no verb that lists a keyring, and finds an entry only by
 * its attribute pairs. So the entries (label and attributes, never a value) are
 * read from the service with `busctl`; a value is read and replaced through the
 * attributes its entry already has; an entry akm creates gets the one pair
 * `secret-tool` requires; and an entry is deleted by its own object path,
 * because `secret-tool clear` deletes every match in every keyring. `secret-tool
 * store` names its collection by alias, so a collection that only a label names
 * gets that alias the first time akm stores into it. A locked collection is
 * unlocked through the Secret Service's own prompt.
 */

import { ConfigError, UsageError } from "../../errors";
import { warn } from "../../warn";
import {
  type Client,
  requireClient,
  runClient,
  type SecretItem,
  SecretManagerAdapterBase,
  sleepSync,
} from "../secret-manager-adapter";

const ID = "secret-tool";
const SECRET_TOOL: Client = { command: "secret-tool", install: "the libsecret-tools package" };
const BUSCTL: Client = { command: "busctl", install: "systemd, which provides it" };

const SERVICE = "org.freedesktop.secrets";

/** The attribute of an entry akm creates; its value, `<keyring>/<name>`, is no other entry's. */
const CREATED_ATTRIBUTE = "akm";

interface KeyringItem extends SecretItem {
  /** The item's object path in the service. */
  path: string;
  attributes: Record<string, string>;
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

/** How long a locked collection is given to be unlocked, and how often the unlock is looked for. */
const UNLOCK_WAIT_MS = 120_000;
const UNLOCK_POLL_MS = 500;

interface Collection {
  path: string;
  /** Whether the alias `location` already names it: `secret-tool store --collection` takes only an alias. */
  aliased: boolean;
}

/** The collections resolved this command, by location. */
const collections = new Map<string, Collection>();

/** The collection `location` names: the alias of that name, else the collection labelled so; undefined when neither. */
function resolveCollection(location: string): Collection | undefined {
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
  let found: Collection | undefined = alias !== NO_OBJECT ? { path: alias, aliased: true } : undefined;
  if (!found) {
    for (const path of collectionPaths(reading)) {
      if (bus<string>(reading, ["get-property", SERVICE, path, COLLECTION, "Label"]) === location) {
        found = { path, aliased: false };
        break;
      }
    }
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
function requireCollection(location: string): Collection {
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

function isLocked(path: string): boolean {
  return bus<boolean>("read the keyring's lock", ["get-property", SERVICE, path, COLLECTION, "Locked"]);
}

/** Unlock the collection when it is locked: the Secret Service prompts, and akm waits for the answer. */
function ensureUnlocked(keyring: string, collection: Collection): void {
  if (!isLocked(collection.path)) return;
  const refusal = (why: string) =>
    new ConfigError(
      `Keyring "${keyring}" is locked${why}.`,
      "BUNDLE_UNREACHABLE",
      "Unlock the keyring (your keyring manager asks for its password), then try again.",
    );
  const [unlocked, prompt] = bus<[string[], string]>(`unlock keyring "${keyring}"`, [
    "call",
    SERVICE,
    SERVICE_PATH,
    SERVICE_INTERFACE,
    "Unlock",
    "ao",
    "1",
    collection.path,
  ]);
  if (unlocked.includes(collection.path) || !isLocked(collection.path)) return;
  if (prompt === NO_OBJECT) throw refusal("");
  warn(`Keyring "${keyring}" is locked: unlock it in the prompt your keyring manager shows.`);
  try {
    bus(`ask to unlock keyring "${keyring}"`, [
      "call",
      SERVICE,
      prompt,
      "org.freedesktop.Secret.Prompt",
      "Prompt",
      "s",
      "",
    ]);
  } catch {
    throw refusal(", and its prompt could not be shown");
  }
  for (let waited = 0; waited < UNLOCK_WAIT_MS; waited += UNLOCK_POLL_MS) {
    if (!isLocked(collection.path)) return;
    // The prompt goes away when it is answered: still locked then means it was dismissed.
    if (runClient(BUSCTL, ["--user", "introspect", SERVICE, prompt]).status !== 0) break;
    sleepSync(UNLOCK_POLL_MS);
  }
  if (isLocked(collection.path)) throw refusal(", and it was not unlocked");
}

function itemAt(path: string, reading: string): KeyringItem {
  const [properties] = bus<[{ Label: BusReply<string>; Attributes: BusReply<Record<string, string>> }]>(reading, [
    "call",
    SERVICE,
    path,
    "org.freedesktop.DBus.Properties",
    "GetAll",
    "s",
    "org.freedesktop.Secret.Item",
  ]);
  const attributes = properties.Attributes.data;
  const item: KeyringItem = {
    path,
    attributes,
    name: properties.Label.data,
    id: path,
    // An entry akm made carries the attribute it stores under; it wins among entries of one label.
    preferred: CREATED_ATTRIBUTE in attributes,
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

/**
 * `secret-tool` finds an entry by attributes in ANY keyring, and takes the first whose attributes include them. So
 * before it reads or replaces `item`, require `item` to be the only entry the service finds for its attributes.
 */
function requireOnlyMatch(item: KeyringItem): void {
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
  const other = [...unlocked, ...locked].find((path) => path !== item.path);
  if (other === undefined) return;
  const clash = itemAt(other, `check "${item.name}"`);
  throw new UsageError(
    `Keyring entry "${clash.name}" (${clash.path}) has attributes that include those of "${item.name}", so secret-tool would use it in place of "${item.name}".`,
    "INVALID_FLAG_VALUE",
    "Remove one of the entries in your keyring manager, or give one a distinguishing attribute.",
  );
}

function lookup(item: KeyringItem): string {
  requireOnlyMatch(item);
  return requireClient(SECRET_TOOL, `read "${item.name}"`, ["lookup", ...attributePairs(item)]);
}

export class SecretToolAdapter extends SecretManagerAdapterBase {
  readonly id = ID;
  readonly version = "0.10.0";
  protected readonly what = "a keyring";

  /** Forget the collections and entries read so far: the next request reads them again. */
  override clearCache(): void {
    super.clearCache();
    collections.clear();
  }

  protected locate(keyring: string): boolean {
    return resolveCollection(keyring) !== undefined;
  }

  protected listSecrets(keyring: string): SecretItem[] {
    const collection = requireCollection(keyring);
    ensureUnlocked(keyring, collection);
    const reading = `read keyring "${keyring}"`;
    const paths = bus<string[]>(reading, ["get-property", SERVICE, collection.path, COLLECTION, "Items"]);
    return paths.map((path) => itemAt(path, reading));
  }

  /** Store `value` as the secret `name`: into its existing entry, or a new one akm can find again. */
  protected storeSecret(keyring: string, name: string, value: Buffer, existing?: SecretItem): void {
    const collection = requireCollection(keyring);
    ensureUnlocked(keyring, collection);
    if (existing) requireOnlyMatch(existing as KeyringItem);
    const item = (existing as KeyringItem | undefined) ?? {
      name,
      attributes: { [CREATED_ATTRIBUTE]: `${keyring}/${name}` },
    };
    const pairs = attributePairs(item);
    // `secret-tool store --collection` takes an alias, so a collection only its label names gets one, once.
    if (!collection.aliased) {
      bus(`name keyring "${keyring}"`, [
        "call",
        SERVICE,
        SERVICE_PATH,
        SERVICE_INTERFACE,
        "SetAlias",
        "so",
        keyring,
        collection.path,
      ]);
      collection.aliased = true;
    }
    requireClient(
      SECRET_TOOL,
      `store "${name}"`,
      ["store", `--collection=${keyring}`, `--label=${name}`, ...pairs],
      value,
    );
  }

  protected deleteSecret(keyring: string, item: SecretItem): void {
    // `Delete` answers with the prompt it needs, or "/" when it has deleted the item.
    const [prompt] = bus<[string]>(`delete "${item.name}"`, [
      "call",
      SERVICE,
      (item as KeyringItem).path,
      "org.freedesktop.Secret.Item",
      "Delete",
    ]);
    if (prompt !== NO_OBJECT) {
      throw new ConfigError(
        `Keyring "${keyring}" asks for confirmation before it deletes "${item.name}".`,
        "BUNDLE_UNREACHABLE",
        "Unlock the keyring and try again.",
      );
    }
  }
}

export const secretToolAdapter = new SecretToolAdapter();
