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

import { ConfigError } from "../../errors";
import type { BundleAdapter } from "../bundle-adapter";
import type { BundleComponent } from "../types";
import {
  type Client,
  listSecrets,
  locationOf,
  recognizeSecret,
  requireClient,
  requireSecretName,
  secretEntryContext,
  secretNameOf,
  secretReadCandidates,
} from "./secret-client-shared";

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

const keyringOf = (c: BundleComponent) => locationOf(c, ID, "a keyring");

function bus<T>(action: string, args: readonly string[]): T {
  const reply = requireClient(BUSCTL, action, ["--user", "--json=short", ...args]);
  return (JSON.parse(reply) as BusReply<T>).data;
}

function keyringItems(keyring: string): KeyringItem[] {
  const reading = `read keyring "${keyring}"`;
  const paths = bus<string[]>(reading, [
    "get-property",
    SERVICE,
    `${COLLECTION_PREFIX}${keyring}`,
    "org.freedesktop.Secret.Collection",
    "Items",
  ]);
  return paths.map((path) => {
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
  });
}

function findItem(keyring: string, name: string | undefined): KeyringItem | undefined {
  return name === undefined ? undefined : keyringItems(keyring).find((item) => item.label === name);
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

function lookup(item: KeyringItem): string {
  return requireClient(SECRET_TOOL, `read "${item.label}"`, ["lookup", ...attributePairs(item)]);
}

export const secretToolAdapter: BundleAdapter = {
  id: ID,
  version: "0.10.0",
  extensions: [],

  list(c) {
    let items: KeyringItem[] = [];
    return listSecrets(
      c,
      () => {
        items = keyringItems(keyringOf(c)).filter((item) => item.label !== "");
        return [...new Set(items.map((item) => item.label))];
      },
      (name) => lookup(items.find((item) => item.label === name) as KeyringItem),
    );
  },

  entry(c, entry) {
    const item = findItem(keyringOf(c), secretNameOf(entry));
    return item && secretEntryContext(c, entry, () => lookup(item));
  },

  write(c, entry, content) {
    const keyring = keyringOf(c);
    const name = requireSecretName(entry);
    const item = findItem(keyring, name) ?? { label: name, attributes: { [CREATED_ATTRIBUTE]: `${keyring}/${name}` } };
    requireClient(
      SECRET_TOOL,
      `store "${name}"`,
      ["store", `--collection=${keyring}`, `--label=${name}`, ...attributePairs(item)],
      content,
    );
  },

  remove(c, entry) {
    const keyring = keyringOf(c);
    const item = findItem(keyring, secretNameOf(entry));
    if (!item) return false;
    // `Delete` answers with the prompt it needs, or "/" when it has deleted the item.
    const [prompt] = bus<[string]>(`delete "${item.label}"`, [
      "call",
      SERVICE,
      item.path,
      "org.freedesktop.Secret.Item",
      "Delete",
    ]);
    if (prompt !== "/") {
      throw new ConfigError(
        `Keyring "${keyring}" asks for confirmation before it deletes "${item.label}".`,
        "BUNDLE_UNREACHABLE",
        "Unlock the keyring and try again.",
      );
    }
    return true;
  },

  recognize: (c, file) => recognizeSecret(ID, c, file.relPath),

  async validate() {
    return [];
  },

  readCandidates: secretReadCandidates,
};
