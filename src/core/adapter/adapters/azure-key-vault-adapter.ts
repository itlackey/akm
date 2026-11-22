// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `azure-key-vault` adapter: a bundle that is one Azure Key Vault, reached
 * through the Azure CLI under the account `az login` signed in.
 *
 * The bundle's `location` is the vault's name. Every secret of the vault is a
 * secret of the bundle, `secrets/<name>`, under the vault's own name for it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type Client,
  clientFailure,
  requireClient,
  runClient,
  SecretManagerAdapterBase,
} from "../secret-manager-adapter";

const ID = "azure-key-vault";
const AZ: Client = { command: "az", install: "the Azure CLI" };

/** How the vault's error names a secret it does not hold. */
const NOT_FOUND = "SecretNotFound";

function secretArgs(verb: string, vault: string, name: string): string[] {
  return ["keyvault", "secret", verb, "--vault-name", vault, "--name", name];
}

/** The secret's value, or undefined when the vault has no secret of that name. */
function show(vault: string, name: string): string | undefined {
  const result = runClient(AZ, [...secretArgs("show", vault, name), "--query", "value", "--output", "json"]);
  if (result.status === 0) return JSON.parse(result.stdout) as string;
  if (result.stderr.includes(NOT_FOUND)) return undefined;
  throw clientFailure(AZ, `read "${name}"`, result);
}

export class AzureKeyVaultAdapter extends SecretManagerAdapterBase {
  readonly id = ID;
  readonly version = "0.10.0";
  protected readonly what = "an Azure Key Vault";

  protected listSecrets(vault: string) {
    const names = requireClient(AZ, `list vault "${vault}"`, [
      "keyvault",
      "secret",
      "list",
      "--vault-name",
      vault,
      "--query",
      "[].name",
      "--output",
      "json",
    ]);
    return (JSON.parse(names) as string[]).map((name) => ({ name, read: () => show(vault, name) ?? "" }));
  }

  protected findSecret(vault: string, name: string) {
    // Finding a secret reads it: one request, which `read` then answers from.
    const value = show(vault, name);
    return value === undefined ? undefined : { read: () => value };
  }

  protected storeSecret(vault: string, name: string, value: Buffer): void {
    // `az` takes a value as an argument or from a file. An argument is readable by other
    // processes, so the value goes through a file only this user can read, removed afterwards.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akm-secret-"));
    try {
      const file = path.join(directory, "value");
      fs.writeFileSync(file, value, { mode: 0o600 });
      requireClient(AZ, `store "${name}"`, [
        ...secretArgs("set", vault, name),
        "--file",
        file,
        "--encoding",
        "utf-8",
        "--output",
        "none",
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  protected deleteSecret(vault: string, name: string): boolean {
    const result = runClient(AZ, [...secretArgs("delete", vault, name), "--output", "none"]);
    if (result.status === 0) return true;
    if (result.stderr.includes(NOT_FOUND)) return false;
    throw clientFailure(AZ, `delete "${name}"`, result);
  }
}

export const azureKeyVaultAdapter = new AzureKeyVaultAdapter();
