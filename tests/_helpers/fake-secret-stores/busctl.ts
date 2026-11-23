// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A stand-in for `busctl --user --json=short` against a Secret Service: the
 * requests the `secret-tool` adapter makes, answered in busctl's own JSON.
 */

import { beginCall, fail, keyringOfAlias, saveState } from "./state";

const COLLECTION_PREFIX = "/org/freedesktop/secrets/collection/";
const PROMPT_PREFIX = "/org/freedesktop/secrets/prompt/";

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
  // A locked collection reads as empty.
  reply(
    "ao",
    (isLocked(name) ? [] : items).map((item) => item.path),
  );
} else if (verb === "call" && rest[0] === "org.freedesktop.Secret.Service" && rest[1] === "Unlock") {
  // `ao`, the count, then the paths: a locked collection answers with the prompt that unlocks it.
  const path = rest[4] as string;
  const name = keyringAt(path);
  if (!state.keyrings[name]) fail(`Call failed: Unknown object '${path}'.`);
  if (!isLocked(name)) reply("aoo", [[path], "/"]);
  else {
    state.prompts = [...(state.prompts ?? []), name];
    saveState(state);
    reply("aoo", [[], `${PROMPT_PREFIX}${name}`]);
  }
} else if (verb === "call" && rest[0] === "org.freedesktop.Secret.Service" && rest[1] === "Lock") {
  // `ao`, the count, then the paths: the keyrings lock at once.
  const path = rest[4] as string;
  if (!state.keyrings[keyringAt(path)]) fail(`Call failed: Unknown object '${path}'.`);
  state.locked = [...new Set([...(state.locked ?? []), keyringAt(path)])];
  saveState(state);
  reply("aoo", [[path], "/"]);
} else if (verb === "call" && rest.join(" ").startsWith("org.freedesktop.Secret.Prompt Prompt")) {
  // The user answers the prompt: it unlocks the keyring, or is dismissed. Either way it is gone.
  const name = objectPath.slice(PROMPT_PREFIX.length);
  if (!(state.prompts ?? []).includes(name)) fail(`Call failed: Unknown object '${objectPath}'.`);
  state.prompts = (state.prompts ?? []).filter((open) => open !== name);
  if (!(state.unlockDenied ?? []).includes(name)) state.locked = (state.locked ?? []).filter((open) => open !== name);
  saveState(state);
  reply("", []);
} else if (verb === "introspect") {
  if (!(state.prompts ?? []).includes(objectPath.slice(PROMPT_PREFIX.length)))
    fail(`Failed to introspect object ${objectPath}: Unknown object '${objectPath}'.`);
  process.stdout.write("NAME TYPE\n");
} else if (verb === "call" && rest[0] === "org.freedesktop.Secret.Service" && rest[1] === "SearchItems") {
  // `a{ss}`, the pair count, then the pairs: every item of every keyring whose attributes include them.
  const flat = rest.slice(4);
  const wanted: Record<string, string> = {};
  for (let i = 0; i < flat.length; i += 2) wanted[flat[i] as string] = flat[i + 1] as string;
  const data = Object.values(state.keyrings)
    .flat()
    .filter((item) => Object.entries(wanted).every(([key, value]) => item.attributes[key] === value))
    .map((item) => item.path);
  reply("aoao", [data, []]);
} else if (
  verb === "call" &&
  rest.join(" ") === "org.freedesktop.DBus.Properties GetAll s org.freedesktop.Secret.Item"
) {
  const item = Object.values(state.keyrings)
    .flat()
    .find((candidate) => candidate.path === objectPath);
  if (!item) fail(`Call failed: Unknown object '${objectPath}'.`);
  const properties = {
    Locked: { type: "b", data: false },
    Attributes: { type: "a{ss}", data: item.attributes },
    Label: { type: "s", data: item.label },
  };
  reply("a{sv}", [properties]);
} else if (verb === "call" && rest.join(" ") === "org.freedesktop.Secret.Item Delete") {
  for (const [keyring, items] of Object.entries(state.keyrings)) {
    state.keyrings[keyring] = items.filter((item) => item.path !== objectPath);
  }
  saveState(state);
  reply("o", ["/"]);
} else {
  fail(`fake busctl: unsupported request ${process.argv.slice(2).join(" ")}`);
}
