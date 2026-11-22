// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `secret-tool` adapter: a bundle that is one keyring of the desktop's
 * Secret Service (KWallet on KDE, GNOME Keyring), the store `secret-tool`
 * reads and writes.
 *
 * The bundle's locator is the keyring's name, as `secret-tool store
 * --collection` takes it. Every entry of the keyring is a secret of the
 * bundle, named by its label.
 *
 * `secret-tool` has no verb that lists a keyring, and it finds an entry only
 * by attribute pairs. So the entries (label and attributes, never a value) are
 * read from the service with `busctl`; a value is read and replaced through the
 * attributes its entry already has; an entry akm creates gets the one pair
 * `secret-tool` requires; and an entry is deleted by its own path, because
 * `secret-tool clear` deletes every match in every keyring.
 */

import { ConfigError } from "../../errors";
import type { SecretStore } from "../secret-store";
import { requireStoreCli, type StoreCli, secretStoreAdapter } from "./secret-store-shared";

const SECRET_TOOL: StoreCli = { command: "secret-tool", install: "the libsecret-tools package" };
const BUSCTL: StoreCli = { command: "busctl", install: "systemd, which provides it" };

const SERVICE = "org.freedesktop.secrets";
const COLLECTION_PREFIX = "/org/freedesktop/secrets/collection/";

/** The attribute of an entry akm creates; its value is `<keyring>/<name>`, which no other entry carries. */
const CREATED_ATTRIBUTE = "akm";

interface KeyringEntry {
  /** The entry's object path in the service. */
  path: string;
  label: string;
  attributes: Record<string, string>;
}

/** One `busctl --json=short` reply: the method's results, or a property's value. */
interface BusReply<T> {
  data: T;
}

function bus<T>(action: string, args: readonly string[]): T {
  const reply = requireStoreCli(BUSCTL, action, ["--user", "--json=short", ...args]);
  return (JSON.parse(reply) as BusReply<T>).data;
}

function keyringEntries(keyring: string): KeyringEntry[] {
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

/** The `attribute value …` arguments by which `secret-tool` finds `entry`. */
function attributePairs(entry: Pick<KeyringEntry, "label" | "attributes">): string[] {
  const pairs = Object.entries(entry.attributes).flat();
  if (pairs.length === 0) {
    throw new ConfigError(
      `Keyring entry "${entry.label}" has no attributes, and secret-tool finds an entry only by its attributes.`,
      "SECRET_STORE_UNAVAILABLE",
      "Give the entry an attribute in your keyring manager, or store it again with `akm secret set`.",
    );
  }
  return pairs;
}

function openKeyring(keyring: string): SecretStore {
  const find = (name: string) => keyringEntries(keyring).find((entry) => entry.label === name);
  return {
    list() {
      return [...new Set(keyringEntries(keyring).map((entry) => entry.label))].filter((label) => label !== "");
    },

    read(name) {
      const entry = find(name);
      return entry && requireStoreCli(SECRET_TOOL, `read "${name}"`, ["lookup", ...attributePairs(entry)]);
    },

    write(name, value) {
      const entry = find(name) ?? { label: name, attributes: { [CREATED_ATTRIBUTE]: `${keyring}/${name}` } };
      requireStoreCli(
        SECRET_TOOL,
        `store "${name}"`,
        ["store", `--collection=${keyring}`, `--label=${name}`, ...attributePairs(entry)],
        value,
      );
    },

    remove(name) {
      const entry = find(name);
      if (!entry) return false;
      // `Delete` answers with the prompt it needs, or "/" when it has deleted the entry.
      const [prompt] = bus<[string]>(`delete "${name}"`, [
        "call",
        SERVICE,
        entry.path,
        "org.freedesktop.Secret.Item",
        "Delete",
      ]);
      if (prompt !== "/") {
        throw new ConfigError(
          `Keyring "${keyring}" asks for confirmation before it deletes "${name}".`,
          "SECRET_STORE_UNAVAILABLE",
          "Unlock the keyring and try again.",
        );
      }
      return true;
    },
  };
}

export const secretToolAdapter = secretStoreAdapter("secret-tool", "0.10.0", openKeyring);
