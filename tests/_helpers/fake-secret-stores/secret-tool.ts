// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A stand-in for `secret-tool`: `lookup` and `store`, with the real tool's
 * rules. A request into a locked keyring "prompts" in this process, as the real tool does: the fake answers its
 * own prompt (unlocking the keyring, unless `unlockDenied` names it) and then goes on. An entry is found by attribute pairs, in any keyring; `store` reads the
 * value from stdin and replaces the entry of its keyring that has the same attributes.
 */

import fs from "node:fs";
import { beginCall, type FakeKeyringItem, fail, keyringOfCollection, saveState } from "./state";

const COLLECTION_PREFIX = "/org/freedesktop/secrets/collection/";

const state = beginCall("secret-tool");
const [verb, ...args] = process.argv.slice(2);
const options = Object.fromEntries(
  args.filter((arg) => arg.startsWith("--")).map((arg) => arg.slice(2).split("=", 2) as [string, string]),
);
const pairs = args.filter((arg) => !arg.startsWith("--"));
if (pairs.length === 0 || pairs.length % 2 !== 0) fail("secret-tool: must specify attribute and value pairs", 2);
const wanted: Record<string, string> = {};
for (let i = 0; i < pairs.length; i += 2) wanted[pairs[i] as string] = pairs[i + 1] as string;

function unlock(keyring: string): void {
  if (!(state.locked ?? []).includes(keyring)) return;
  if ((state.unlockDenied ?? []).includes(keyring)) fail("secret-tool: Cannot get secret of a locked object");
  state.locked = (state.locked ?? []).filter((name) => name !== keyring);
  saveState(state);
}

const hasAll = (item: FakeKeyringItem) =>
  Object.entries(wanted).every(([key, value]) => item.attributes[key] === value);

if (verb === "lookup") {
  const found = Object.entries(state.keyrings)
    .flatMap(([keyring, items]) => items.map((item) => ({ keyring, item })))
    .find(({ item }) => hasAll(item));
  if (!found) process.exit(1);
  unlock(found.keyring);
  process.stdout.write(found.item.secret);
} else if (verb === "store") {
  // `--collection` takes an alias or an object path.
  const keyring = keyringOfCollection(state, options.collection as string);
  const items = keyring === undefined ? undefined : state.keyrings[keyring];
  if (keyring === undefined || !items)
    fail(`secret-tool: No such secret collection at path: ${COLLECTION_PREFIX}${options.collection}`);
  unlock(keyring);
  const same = (item: FakeKeyringItem) => JSON.stringify(item.attributes) === JSON.stringify(wanted);
  const next = Math.max(0, ...items.map((item) => Number(item.path.split("/").pop()))) + 1;
  const stored: FakeKeyringItem = {
    path: items.find(same)?.path ?? `${COLLECTION_PREFIX}${keyring}/${next}`,
    label: options.label as string,
    attributes: wanted,
    secret: fs.readFileSync(0, "utf8"),
  };
  state.keyrings[keyring] = [...items.filter((item) => !same(item)), stored];
  saveState(state);
} else {
  fail(`fake secret-tool: unsupported request ${process.argv.slice(2).join(" ")}`, 2);
}
