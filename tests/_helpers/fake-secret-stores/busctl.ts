// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A stand-in for `busctl --user --json=short` against a Secret Service: the
 * three requests the `secret-tool` adapter makes, answered in busctl's own JSON.
 */

import { beginCall, fail, saveState } from "./state";

const COLLECTION_PREFIX = "/org/freedesktop/secrets/collection/";

const state = beginCall("busctl");
const [verb, , objectPath = "", ...rest] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));

if (verb === "get-property" && rest.join(" ") === "org.freedesktop.Secret.Service Collections") {
  const data = Object.keys(state.keyrings).map((name) => `${COLLECTION_PREFIX}${name}`);
  process.stdout.write(`${JSON.stringify({ type: "ao", data })}\n`);
} else if (verb === "get-property" && rest.join(" ") === "org.freedesktop.Secret.Collection Locked") {
  const name = objectPath.slice(COLLECTION_PREFIX.length);
  if (!state.keyrings[name]) fail(`Failed to get property Locked: Unknown object '${objectPath}'.`);
  process.stdout.write(`${JSON.stringify({ type: "b", data: (state.locked ?? []).includes(name) })}\n`);
} else if (verb === "get-property" && rest.join(" ") === "org.freedesktop.Secret.Collection Items") {
  const name = objectPath.slice(COLLECTION_PREFIX.length);
  const items = state.keyrings[name];
  if (!items)
    fail(
      `Failed to get property Items on interface org.freedesktop.Secret.Collection: Unknown object '${objectPath}'.`,
    );
  // A locked collection reads as empty.
  const visible = (state.locked ?? []).includes(name) ? [] : items;
  process.stdout.write(`${JSON.stringify({ type: "ao", data: visible.map((item) => item.path) })}\n`);
} else if (verb === "call" && rest[0] === "org.freedesktop.Secret.Service" && rest[1] === "SearchItems") {
  // `a{ss}`, the pair count, then the pairs: every item of every keyring whose attributes include them.
  const flat = rest.slice(4);
  const wanted: Record<string, string> = {};
  for (let i = 0; i < flat.length; i += 2) wanted[flat[i] as string] = flat[i + 1] as string;
  const data = Object.values(state.keyrings)
    .flat()
    .filter((item) => Object.entries(wanted).every(([key, value]) => item.attributes[key] === value))
    .map((item) => item.path);
  process.stdout.write(`${JSON.stringify({ type: "aoao", data: [data, []] })}\n`);
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
  process.stdout.write(`${JSON.stringify({ type: "a{sv}", data: [properties] })}\n`);
} else if (verb === "call" && rest.join(" ") === "org.freedesktop.Secret.Item Delete") {
  for (const [keyring, items] of Object.entries(state.keyrings)) {
    state.keyrings[keyring] = items.filter((item) => item.path !== objectPath);
  }
  saveState(state);
  process.stdout.write(`${JSON.stringify({ type: "o", data: ["/"] })}\n`);
} else {
  fail(`fake busctl: unsupported request ${process.argv.slice(2).join(" ")}`);
}
