// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A stand-in for the Azure CLI's `az keyvault secret` commands: `list`, `show`,
 * `set --file` and `delete`, printing what the adapter asks for.
 */

import fs from "node:fs";
import { beginCall, fail, saveState } from "./state";

const state = beginCall("az");
const [group, noun, verb, ...args] = process.argv.slice(2);
if (group !== "keyvault" || noun !== "secret")
  fail(`fake az: unsupported request ${process.argv.slice(2).join(" ")}`, 2);

const option = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? undefined : args[at + 1];
};
const vaultName = option("vault-name") as string;
const vault = state.vaults[vaultName];
if (!vault) fail(`ERROR: (VaultNotFound) The vault '${vaultName}' was not found.`, 3);
const name = option("name") as string;
const missing = (): never =>
  fail(`ERROR: (SecretNotFound) A secret with (name/id) ${name} was not found in this key vault.`, 3);

if (verb === "list") {
  process.stdout.write(`${JSON.stringify(Object.keys(vault))}\n`);
} else if (verb === "show") {
  if (!(name in vault)) missing();
  process.stdout.write(`${JSON.stringify(vault[name])}\n`);
} else if (verb === "set") {
  if (!/^[0-9a-zA-Z-]+$/.test(name)) fail(`ERROR: (BadParameter) The request URI contains an invalid name: ${name}`, 3);
  if (state.deleted?.[vaultName]?.[name] !== undefined)
    fail(
      `ERROR: (Conflict) Secret ${name} is currently in a deleted but recoverable state, and its name cannot be reused.`,
      3,
    );
  vault[name] = fs.readFileSync(option("file") as string, "utf8");
  saveState(state);
} else if (verb === "delete") {
  if (!(name in vault)) missing();
  // A vault soft-deletes: the secret stays recoverable until purged.
  state.deleted = { ...state.deleted, [vaultName]: { ...state.deleted?.[vaultName], [name]: vault[name] as string } };
  delete vault[name];
  saveState(state);
} else if (verb === "purge") {
  if (state.purgeForbidden?.includes(vaultName))
    fail(`ERROR: (Forbidden) The user does not have secrets purge permission on vault '${vaultName}'.`, 3);
  if (state.deleted?.[vaultName]?.[name] === undefined) missing();
  delete (state.deleted as Record<string, Record<string, string>>)[vaultName]?.[name];
  saveState(state);
} else {
  fail(`fake az: unsupported request ${process.argv.slice(2).join(" ")}`, 2);
}
