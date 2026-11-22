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

if (verb === "get-property" && rest.join(" ") === "org.freedesktop.Secret.Collection Items") {
  const items = state.keyrings[objectPath.slice(COLLECTION_PREFIX.length)];
  if (!items)
    fail(
      `Failed to get property Items on interface org.freedesktop.Secret.Collection: Unknown object '${objectPath}'.`,
    );
  process.stdout.write(`${JSON.stringify({ type: "ao", data: items.map((item) => item.path) })}\n`);
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
