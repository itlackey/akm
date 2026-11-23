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

if (verb === "list" && (state.listFails ?? []).includes(vaultName)) {
  fail("ERROR: (InternalServerError) The service failed.", 3);
} else if (verb === "list") {
  // A query that asks for what is enabled and unmanaged leaves out the secrets that are not.
  const excluded = option("query")?.includes("managed")
    ? [...(state.disabled?.[vaultName] ?? []), ...(state.managed?.[vaultName] ?? [])]
    : [];
  process.stdout.write(`${JSON.stringify(Object.keys(vault).filter((secret) => !excluded.includes(secret)))}\n`);
} else if (verb === "show") {
  if (!(name in vault)) missing();
  if (state.disabled?.[vaultName]?.includes(name))
    fail("ERROR: (Forbidden) Operation get is not allowed on a disabled secret.\nCode: SecretDisabled", 3);
  const managed = (state.managed?.[vaultName] ?? []).includes(name);
  process.stdout.write(
    `${JSON.stringify(option("query")?.includes("managed") ? [vault[name], managed] : vault[name])}\n`,
  );
} else if (verb === "set") {
  if (!/^[0-9a-zA-Z-]+$/.test(name)) fail(`ERROR: (BadParameter) The request URI contains an invalid name: ${name}`, 3);
  if (state.deleted?.[vaultName]?.[name] !== undefined)
    fail(
      `ERROR: (Conflict) Secret ${name} is currently in a deleted but recoverable state, and its name cannot be reused.`,
      3,
    );
  vault[name] =
    option("file") !== undefined ? fs.readFileSync(option("file") as string, "utf8") : (option("value") as string);
  saveState(state);
} else if (verb === "set-attributes") {
  if (!(name in vault)) missing();
  const others = (state.disabled?.[vaultName] ?? []).filter((secret) => secret !== name);
  state.disabled = { ...state.disabled, [vaultName]: option("enabled") === "false" ? [...others, name] : others };
  saveState(state);
} else if (verb === "delete") {
  if (!(name in vault)) missing();
  // A vault soft-deletes: the secret stays recoverable until purged.
  state.deleted = { ...state.deleted, [vaultName]: { ...state.deleted?.[vaultName], [name]: vault[name] as string } };
  delete vault[name];
  saveState(state);
} else if (verb === "purge") {
  if ((state.purgeConflicts?.[vaultName] ?? 0) > 0) {
    (state.purgeConflicts as Record<string, number>)[vaultName] = (state.purgeConflicts?.[vaultName] ?? 1) - 1;
    saveState(state);
    fail(`ERROR: (Conflict) Secret ${name} is currently being deleted.`, 3);
  }
  if (state.purgeForbidden?.includes(vaultName))
    fail(`ERROR: (Forbidden) The user does not have secrets purge permission on vault '${vaultName}'.`, 3);
  if (state.deleted?.[vaultName]?.[name] === undefined) missing();
  delete (state.deleted as Record<string, Record<string, string>>)[vaultName]?.[name];
  saveState(state);
} else {
  fail(`fake az: unsupported request ${process.argv.slice(2).join(" ")}`, 2);
}
