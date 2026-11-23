// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `azure-key-vault` adapter: a bundle that is one Azure Key Vault, reached
 * through the Azure CLI under the account `az login` signed in.
 *
 * The bundle's `location` is the vault's name. Every enabled, unmanaged secret of
 * the vault is a secret of the bundle, `secrets/<name>`, under the vault's own
 * name for it. A secret that is disabled, or that another Azure service manages,
 * is not akm's to list or read.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageError } from "../../errors";
import { warn } from "../../warn";
import {
  type Client,
  clientFailure,
  requireClient,
  runClient,
  type SecretItem,
  SecretManagerAdapterBase,
  sleepSync,
} from "../secret-manager-adapter";

const ID = "azure-key-vault";
const AZ: Client = { command: "az", install: "the Azure CLI" };

/** How the vault's error names a secret it does not hold. */
const NOT_FOUND = "SecretNotFound";

/** The names a vault accepts for a secret. */
const VALID_NAME = /^[0-9A-Za-z-]{1,127}$/;

/** How the vault's error says a name is held by a deleted secret it still keeps. */
const DELETED_CONFLICT = "deleted but recoverable";

/** How the vault's error says a secret cannot be read because it is disabled (not that the account is refused). */
const DISABLED = /disabled/i;

/** A purge right after a delete can meet the delete still going: it is tried again, this often and this far apart. */
export const purgeRetry = { tries: 5, delayMs: 1000 };

function secretArgs(verb: string, vault: string, name: string): string[] {
  return ["keyvault", "secret", verb, "--vault-name", vault, "--name", name];
}

/** The secret's value, or undefined when the vault has no secret of that name (a managed one is not akm's). */
function show(vault: string, name: string): string | undefined {
  // A name the vault cannot hold names no secret.
  if (!VALID_NAME.test(name)) return undefined;
  const result = runClient(AZ, [...secretArgs("show", vault, name), "--query", "[value, managed]", "--output", "json"]);
  if (result.status === 0) {
    const [value, managed] = JSON.parse(result.stdout) as [string, boolean | null];
    return managed ? undefined : value;
  }
  if (result.stderr.includes(NOT_FOUND)) return undefined;
  // The vault answers a disabled secret with "Forbidden", which is no sign the account is refused.
  if (DISABLED.test(result.stderr)) {
    throw new Error(`az could not read "${name}": it is disabled in vault "${vault}". ${result.stderr.trim()}`);
  }
  throw clientFailure(AZ, `read "${name}"`, result);
}

export class AzureKeyVaultAdapter extends SecretManagerAdapterBase {
  readonly id = ID;
  readonly version = "0.10.0";
  protected readonly what = "an Azure Key Vault";

  protected locate(vault: string): boolean {
    const result = runClient(AZ, [
      "keyvault",
      "secret",
      "list",
      "--vault-name",
      vault,
      "--maxresults",
      "1",
      "--output",
      "none",
    ]);
    if (result.status === 0) return true;
    if (result.stderr.includes("VaultNotFound")) return false;
    // A vault that refuses the account is there.
    if (/Forbidden/.test(result.stderr)) return true;
    throw clientFailure(AZ, `find vault "${vault}"`, result);
  }

  /** Names are unique in a vault: one `show`, no listing first. */
  protected findSecret(vault: string, name: string): SecretItem | undefined {
    if (!VALID_NAME.test(name)) return undefined;
    const value = show(vault, name);
    return value === undefined ? undefined : { name, id: name, preferred: true, read: () => value };
  }

  protected listSecrets(vault: string): SecretItem[] {
    const names = requireClient(AZ, `list vault "${vault}"`, [
      "keyvault",
      "secret",
      "list",
      "--vault-name",
      vault,
      "--query",
      "[?!managed && attributes.enabled].name",
      "--output",
      "json",
    ]);
    return (JSON.parse(names) as string[]).map((name) => ({
      name,
      id: name,
      preferred: true,
      read: () => {
        const value = show(vault, name);
        if (value === undefined) throw new Error(`Vault "${vault}" no longer holds a secret named "${name}".`);
        return value;
      },
    }));
  }

  protected requireStorable(name: string): void {
    if (!VALID_NAME.test(name)) {
      throw new UsageError(
        `"${name}" is not a name an Azure Key Vault accepts: use 1 to 127 letters, digits and hyphens.`,
        "INVALID_FLAG_VALUE",
      );
    }
  }

  protected storeSecret(vault: string, name: string, value: Buffer): void {
    // `az` takes a value as an argument or from a file. An argument is readable by other
    // processes, so the value goes through a file only this user can read, removed afterwards.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akm-secret-"));
    try {
      const file = path.join(directory, "value");
      fs.writeFileSync(file, value, { mode: 0o600 });
      const result = runClient(AZ, [
        ...secretArgs("set", vault, name),
        "--file",
        file,
        "--encoding",
        "utf-8",
        "--output",
        "none",
      ]);
      if (result.status !== 0) {
        if (result.stderr.includes(DELETED_CONFLICT)) {
          throw new UsageError(
            `Vault "${vault}" still holds a deleted secret named "${name}", so the name cannot be reused yet.`,
            "RESOURCE_ALREADY_EXISTS",
            `Recover it with \`az keyvault secret recover --vault-name ${vault} --name ${name}\`, or purge it with \`az keyvault secret purge --vault-name ${vault} --name ${name}\`, then set it again.`,
          );
        }
        throw clientFailure(AZ, `store "${name}"`, result);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  protected deleteSecret(vault: string, { name }: SecretItem): void {
    const result = runClient(AZ, [...secretArgs("delete", vault, name), "--output", "none"]);
    if (result.status !== 0) throw clientFailure(AZ, `delete "${name}"`, result);
    // A vault keeps a deleted secret, recoverable, until it is purged: purge it, so a removal removes. The delete may
    // still be going on, which the vault answers with a conflict: try again briefly.
    let purged = runClient(AZ, [...secretArgs("purge", vault, name), "--output", "none"]);
    for (let tries = 1; purged.status !== 0 && /Conflict/i.test(purged.stderr) && tries < purgeRetry.tries; tries++) {
      sleepSync(purgeRetry.delayMs);
      purged = runClient(AZ, [...secretArgs("purge", vault, name), "--output", "none"]);
    }
    if (purged.status !== 0) {
      warn(
        `Deleted "${name}", but vault "${vault}" refused to purge it (${purged.stderr.trim() || `exit status ${purged.status}`}): ` +
          "the vault keeps the deleted secret, and its value, until its retention period ends.",
      );
    }
  }
}

export const azureKeyVaultAdapter = new AzureKeyVaultAdapter();
