// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `secret-tool` adapter: a bundle that is one keyring of the desktop's
 * Secret Service (KWallet on KDE, GNOME Keyring).
 *
 * The bundle's `location` is the keyring's name, as `secret-tool store
 * --collection` takes it. Every entry of the keyring is a secret of the bundle,
 * `secrets/<label>`.
 *
 * `secret-tool` has no verb that lists a keyring, and finds an entry only by
 * its attribute pairs. So the entries (label and attributes, never a value) are
 * read from the service with `busctl`; a value is read and replaced through the
 * attributes its entry already has; an entry akm creates gets the one pair
 * `secret-tool` requires; and an entry is deleted by its own object path,
 * because `secret-tool clear` deletes every match in every keyring.
 */

import { ConfigError, UsageError } from "../../errors";
import {
  type Client,
  clientFailure,
  requireClient,
  runClient,
  SecretManagerAdapterBase,
} from "../secret-manager-adapter";

const ID = "secret-tool";
const SECRET_TOOL: Client = { command: "secret-tool", install: "the libsecret-tools package" };
const BUSCTL: Client = { command: "busctl", install: "systemd, which provides it" };

const SERVICE = "org.freedesktop.secrets";
const COLLECTION_PREFIX = "/org/freedesktop/secrets/collection/";

/** The attribute of an entry akm creates; its value, `<keyring>/<name>`, is no other entry's. */
const CREATED_ATTRIBUTE = "akm";

interface KeyringItem {
  /** The item's object path in the service. */
  path: string;
  label: string;
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
const COLLECTION = "org.freedesktop.Secret.Collection";

/** The keyring's items, read once per process and dropped when akm stores or deletes one. */
const itemCache = new Map<string, KeyringItem[]>();

/** Forget the keyrings read so far: the next request reads them again. */
export function clearKeyringCache(): void {
  itemCache.clear();
}

/** Refuse a keyring that is not there, or is locked (a locked collection may read as empty rather than fail). */
function requireOpenKeyring(keyring: string): void {
  const result = runClient(BUSCTL, [
    "--user",
    "--json=short",
    "get-property",
    SERVICE,
    `${COLLECTION_PREFIX}${keyring}`,
    COLLECTION,
    "Locked",
  ]);
  if (result.status !== 0) {
    if (!/Unknown object/.test(result.stderr)) throw clientFailure(BUSCTL, `read keyring "${keyring}"`, result);
    const available = bus<string[]>(`list keyrings`, [
      "get-property",
      SERVICE,
      SERVICE_PATH,
      "org.freedesktop.Secret.Service",
      "Collections",
    ])
      .map((path) => path.slice(COLLECTION_PREFIX.length))
      .filter((name) => name !== "");
    throw new ConfigError(
      `Keyring "${keyring}" does not exist. The Secret Service has: ${available.join(", ") || "no keyrings"}.`,
      "BUNDLE_UNREACHABLE",
      `secret-tool cannot create a keyring. Create the wallet or keyring "${keyring}" in your keyring manager (KWalletManager, Seahorse), or set the bundle's \`location\` to one that exists.`,
    );
  }
  if ((JSON.parse(result.stdout) as BusReply<boolean>).data) {
    throw new ConfigError(
      `Keyring "${keyring}" is locked.`,
      "BUNDLE_UNREACHABLE",
      "Unlock the keyring (your keyring manager asks for its password), then try again.",
    );
  }
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
  return { path, label: properties.Label.data, attributes: properties.Attributes.data };
}

function keyringItems(keyring: string): KeyringItem[] {
  const cached = itemCache.get(keyring);
  if (cached) return cached;
  requireOpenKeyring(keyring);
  const reading = `read keyring "${keyring}"`;
  const paths = bus<string[]>(reading, [
    "get-property",
    SERVICE,
    `${COLLECTION_PREFIX}${keyring}`,
    COLLECTION,
    "Items",
  ]);
  const items = paths.map((path) => itemAt(path, reading));
  itemCache.set(keyring, items);
  return items;
}

function findItem(keyring: string, name: string): KeyringItem | undefined {
  return keyringItems(keyring).find((item) => item.label === name);
}

/** The `attribute value …` arguments by which `secret-tool` finds `item`. */
function attributePairs(item: Pick<KeyringItem, "label" | "attributes">): string[] {
  const pairs = Object.entries(item.attributes).flat();
  if (pairs.length === 0) {
    throw new ConfigError(
      `Keyring entry "${item.label}" has no attributes, and secret-tool finds an entry only by its attributes.`,
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
  const [unlocked, locked] = bus<[string[], string[]]>(`check "${item.label}"`, [
    "call",
    SERVICE,
    SERVICE_PATH,
    "org.freedesktop.Secret.Service",
    "SearchItems",
    "a{ss}",
    String(pairs.length / 2),
    ...pairs,
  ]);
  const other = [...unlocked, ...locked].find((path) => path !== item.path);
  if (other === undefined) return;
  const clash = itemAt(other, `check "${item.label}"`);
  throw new UsageError(
    `Keyring entry "${clash.label}" (${clash.path}) has attributes that include those of "${item.label}", so secret-tool would use it in place of "${item.label}".`,
    "INVALID_FLAG_VALUE",
    "Remove one of the entries in your keyring manager, or give one a distinguishing attribute.",
  );
}

function lookup(item: KeyringItem): string {
  requireOnlyMatch(item);
  return requireClient(SECRET_TOOL, `read "${item.label}"`, ["lookup", ...attributePairs(item)]);
}

export class SecretToolAdapter extends SecretManagerAdapterBase {
  readonly id = ID;
  readonly version = "0.10.0";
  protected readonly what = "a keyring";

  protected listSecrets(keyring: string) {
    const items = keyringItems(keyring).filter((item) => item.label !== "");
    return [...new Set(items.map((item) => item.label))].map((name) => ({
      name,
      read: () => lookup(items.find((item) => item.label === name) as KeyringItem),
    }));
  }

  protected findSecret(keyring: string, name: string) {
    const item = findItem(keyring, name);
    return item && { read: () => lookup(item) };
  }

  /** Store `value` as the secret `name`: into its existing entry, or a new one akm can find again. */
  protected storeSecret(keyring: string, name: string, value: Buffer): void {
    const existing = findItem(keyring, name);
    if (existing) requireOnlyMatch(existing);
    const item = existing ?? { label: name, attributes: { [CREATED_ATTRIBUTE]: `${keyring}/${name}` } };
    try {
      requireClient(
        SECRET_TOOL,
        `store "${name}"`,
        ["store", `--collection=${keyring}`, `--label=${name}`, ...attributePairs(item)],
        value,
      );
    } finally {
      itemCache.delete(keyring);
    }
  }

  protected deleteSecret(keyring: string, name: string): boolean {
    const item = findItem(keyring, name);
    if (!item) return false;
    // `Delete` answers with the prompt it needs, or "/" when it has deleted the item.
    const [prompt] = bus<[string]>(`delete "${item.label}"`, [
      "call",
      SERVICE,
      item.path,
      "org.freedesktop.Secret.Item",
      "Delete",
    ]);
    itemCache.delete(keyring);
    if (prompt !== "/") {
      throw new ConfigError(
        `Keyring "${keyring}" asks for confirmation before it deletes "${item.label}".`,
        "BUNDLE_UNREACHABLE",
        "Unlock the keyring and try again.",
      );
    }
    return true;
  }
}

export const secretToolAdapter = new SecretToolAdapter();
