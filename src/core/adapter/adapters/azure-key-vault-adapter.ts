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
import { NotFoundError } from "../../errors";
import type { AssetChange, BundleAdapter } from "../bundle-adapter";
import type { BundleComponent } from "../types";
import {
  type Client,
  clientFailure,
  listSecrets,
  locationOf,
  newSecretName,
  recognizeSecret,
  requireClient,
  requireSecretName,
  runClient,
  secretAsset,
  secretChange,
  secretNameOf,
} from "./secret-client-shared";

const ID = "azure-key-vault";
const AZ: Client = { command: "az", install: "the Azure CLI" };

/** How the vault's error names a secret it does not hold. */
const NOT_FOUND = "SecretNotFound";

const vaultOf = (c: BundleComponent) => locationOf(c, ID, "an Azure Key Vault");

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

/** Store `content` as the secret `name`. */
function store(c: BundleComponent, name: string, content: string | Buffer): AssetChange {
  // `az` takes a value as an argument or from a file. An argument is readable by other
  // processes, so the value goes through a file only this user can read, removed afterwards.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akm-secret-"));
  try {
    const file = path.join(directory, "value");
    fs.writeFileSync(file, content, { mode: 0o600 });
    requireClient(AZ, `store "${name}"`, [
      ...secretArgs("set", vaultOf(c), name),
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
  return secretChange(c, name);
}

export const azureKeyVaultAdapter: BundleAdapter = {
  id: ID,
  version: "0.10.0",
  extensions: [],
  writes: ["secret"],

  list(c) {
    return listSecrets(
      c,
      () => {
        const vault = vaultOf(c);
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
        return JSON.parse(names) as string[];
      },
      (name) => show(vaultOf(c), name) ?? "",
    );
  },

  read(c, conceptId) {
    const name = secretNameOf(conceptId);
    // Finding a secret reads it: one request, which `content()` then answers from.
    const value = name === undefined ? undefined : show(vaultOf(c), name);
    return name === undefined || value === undefined ? undefined : secretAsset(c, name, () => value);
  },

  recognize: (c, file) => recognizeSecret(ID, c, file.relPath),

  async validate() {
    return [];
  },

  create: (c, asset) => store(c, newSecretName(asset, ID), asset.content),

  update(c, conceptId, content) {
    const name = requireSecretName(conceptId);
    if (show(vaultOf(c), name) === undefined) throw new NotFoundError(`Secret not found: ${c.id}//${conceptId}`);
    return store(c, name, content);
  },

  retire(c, conceptId) {
    const name = requireSecretName(conceptId);
    const result = runClient(AZ, [...secretArgs("delete", vaultOf(c), name), "--output", "none"]);
    if (result.status === 0) return secretChange(c, name);
    if (result.stderr.includes(NOT_FOUND)) throw new NotFoundError(`Secret not found: ${c.id}//${conceptId}`);
    throw clientFailure(AZ, `delete "${name}"`, result);
  },
};
