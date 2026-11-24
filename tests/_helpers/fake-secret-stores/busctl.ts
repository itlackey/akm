// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A stand-in for `busctl --user --json=short` against a Secret Service: the
 * requests the `secret-tool` adapter makes, answered in busctl's own JSON.
 */

import { beginCall, fail, keyringOfAlias, saveState } from "./state";

const COLLECTION_PREFIX = "/org/freedesktop/secrets/collection/";

const state = beginCall("busctl");
const [verb, , objectPath = "", ...rest] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const reply = (type: string, data: unknown) => process.stdout.write(`${JSON.stringify({ type, data })}\n`);
const keyringAt = (path: string) => path.slice(COLLECTION_PREFIX.length);
const isLocked = (name: string) => (state.locked ?? []).includes(name);

if (verb === "get-property" && rest.join(" ") === "org.freedesktop.Secret.Service Collections") {
  reply(
    "ao",
    Object.keys(state.keyrings).map((name) => `${COLLECTION_PREFIX}${name}`),
  );
} else if (verb === "call" && rest[0] === "org.freedesktop.Secret.Service" && rest[1] === "ReadAlias") {
  const name = keyringOfAlias(state, rest[3] as string);
  reply("o", [name === undefined ? "/" : `${COLLECTION_PREFIX}${name}`]);
} else if (verb === "call" && rest[0] === "org.freedesktop.Secret.Service" && rest[1] === "SetAlias") {
  // `so`, then the alias and the collection's path.
  const [alias, path] = [rest[3] as string, rest[4] as string];
  if (alias !== "default" && !state.anyAlias) fail("Call failed: Only the 'default' alias is supported");
  if (path === "/") {
    // "/" takes the alias away.
    const { [alias]: _gone, ...aliases } = state.aliases ?? {};
    state.aliases = aliases;
    if (state.keyrings[alias]) state.unaliased = [...(state.unaliased ?? []), alias];
  } else {
    if (!state.keyrings[keyringAt(path)]) fail(`Call failed: Unknown object '${path}'.`);
    state.aliases = { ...state.aliases, [alias]: keyringAt(path) };
    state.unaliased = (state.unaliased ?? []).filter((name) => name !== alias);
  }
  saveState(state);
  reply("", []);
} else if (verb === "get-property" && rest.join(" ") === "org.freedesktop.Secret.Collection Label") {
  const name = keyringAt(objectPath);
  if (!state.keyrings[name]) fail(`Failed to get property Label: Unknown object '${objectPath}'.`);
  reply("s", state.labels?.[name] ?? name);
} else if (verb === "get-property" && rest.join(" ") === "org.freedesktop.Secret.Collection Locked") {
  const name = keyringAt(objectPath);
  if (!state.keyrings[name]) fail(`Failed to get property Locked: Unknown object '${objectPath}'.`);
  reply("b", isLocked(name));
} else if (verb === "get-property" && rest.join(" ") === "org.freedesktop.Secret.Collection Items") {
  const name = keyringAt(objectPath);
  const items = state.keyrings[name];
  if (!items)
    fail(
      `Failed to get property Items on interface org.freedesktop.Secret.Collection: Unknown object '${objectPath}'.`,
    );
  // A locked collection still lists its items: their labels and attributes read, and each is `Locked`.
  reply(
    "ao",
    (isLocked(name) && (state.hidesLocked ?? []).includes(name) ? [] : items).map((item) => item.path),
  );
} else if (verb === "call" && rest[0] === "org.freedesktop.Secret.Service" && rest[1] === "Lock") {
  // `ao`, the count, then the paths: the keyrings lock at once.
  const path = rest[4] as string;
  if (!state.keyrings[keyringAt(path)]) fail(`Call failed: Unknown object '${path}'.`);
  state.locked = [...new Set([...(state.locked ?? []), keyringAt(path)])];
  saveState(state);
  reply("aoo", [[path], "/"]);
} else if (verb === "call" && rest[0] === "org.freedesktop.Secret.Service" && rest[1] === "SearchItems") {
  // `a{ss}`, the pair count, then the pairs: every item of every keyring whose attributes include them.
  const flat = rest.slice(4);
  const wanted: Record<string, string> = {};
  for (let i = 0; i < flat.length; i += 2) wanted[flat[i] as string] = flat[i + 1] as string;
  // As the service answers: the matches in unlocked collections, then those in locked ones.
  const found = Object.entries(state.keyrings).flatMap(([keyring, items]) =>
    items
      .filter((item) => Object.entries(wanted).every(([key, value]) => item.attributes[key] === value))
      .map((item) => ({ path: item.path, locked: isLocked(keyring) })),
  );
  reply("aoao", [
    found.filter((item) => !item.locked).map((item) => item.path),
    found.filter((item) => item.locked).map((item) => item.path),
  ]);
} else if (
  verb === "call" &&
  rest.join(" ") === "org.freedesktop.DBus.Properties GetAll s org.freedesktop.Secret.Item"
) {
  const owner = Object.entries(state.keyrings).find(([, items]) => items.some((item) => item.path === objectPath));
  const item = owner?.[1].find((candidate) => candidate.path === objectPath);
  if (!owner || !item) fail(`Call failed: Unknown object '${objectPath}'.`);
  const properties = {
    Locked: { type: "b", data: isLocked(owner[0]) },
    Attributes: { type: "a{ss}", data: item.attributes },
    Label: { type: "s", data: item.label },
  };
  reply("a{sv}", [properties]);
} else if (verb === "call" && rest.join(" ") === "org.freedesktop.Secret.Item Delete") {
  // A locked collection answers with the prompt the delete needs, which this connection cannot show; it deletes nothing.
  const owner = Object.entries(state.keyrings).find(([, items]) => items.some((item) => item.path === objectPath));
  if (owner && isLocked(owner[0])) {
    reply("o", ["/org/freedesktop/secrets/prompt/p1"]);
    process.exit(0);
  }
  // KWallet's reply can be "/" with the entry still there.
  if (!(owner && (state.deleteKeeps ?? []).includes(owner[0]))) {
    for (const [keyring, items] of Object.entries(state.keyrings)) {
      state.keyrings[keyring] = items.filter((item) => item.path !== objectPath);
    }
  }
  saveState(state);
  reply("o", ["/"]);
} else {
  fail(`fake busctl: unsupported request ${process.argv.slice(2).join(" ")}`);
}
