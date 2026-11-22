// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `azure-key-vault` adapter: a bundle that is one Azure Key Vault, reached
 * through the Azure CLI under the account `az login` signed in.
 *
 * The bundle's locator is the vault's name. Every secret of the vault is a
 * secret of the bundle, under the vault's own name for it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SecretStore } from "../secret-store";
import { requireStoreCli, runStoreCli, type StoreCli, secretStoreAdapter, storeFailure } from "./secret-store-shared";

const AZ: StoreCli = { command: "az", install: "the Azure CLI" };

/** How the vault's error names a secret it does not hold. */
const NOT_FOUND = "SecretNotFound";

function openVault(vault: string): SecretStore {
  const secretArgs = (verb: string, name: string) => [
    "keyvault",
    "secret",
    verb,
    "--vault-name",
    vault,
    "--name",
    name,
  ];
  return {
    list() {
      const names = requireStoreCli(AZ, `list vault "${vault}"`, [
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
      return JSON.parse(names) as string[];
    },

    read(name) {
      const result = runStoreCli(AZ, [...secretArgs("show", name), "--query", "value", "--output", "json"]);
      if (result.status === 0) return JSON.parse(result.stdout) as string;
      if (result.stderr.includes(NOT_FOUND)) return undefined;
      throw storeFailure(AZ, `read "${name}"`, result);
    },

    write(name, value) {
      // `az` takes a value as an argument or from a file. An argument is readable by other
      // processes, so the value goes through a file only this user can read, removed afterwards.
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akm-secret-"));
      try {
        const file = path.join(directory, "value");
        fs.writeFileSync(file, value, { mode: 0o600 });
        requireStoreCli(AZ, `store "${name}"`, [
          ...secretArgs("set", name),
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
    },

    remove(name) {
      const result = runStoreCli(AZ, [...secretArgs("delete", name), "--output", "none"]);
      if (result.status === 0) return true;
      if (result.stderr.includes(NOT_FOUND)) return false;
      throw storeFailure(AZ, `delete "${name}"`, result);
    },
  };
}

export const azureKeyVaultAdapter = secretStoreAdapter("azure-key-vault", "0.10.0", openVault);
