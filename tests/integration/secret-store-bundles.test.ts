// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Secret store bundles: a bundle whose `store` descriptor names a keyring
 * (`secret-tool`) or an Azure Key Vault (`azure-key-vault`). Beyond the config
 * entry, its secrets behave as the files under a directory bundle's `secrets/`
 * do: indexed by name, listed, injected, set and removed by the same commands.
 *
 * The adapters run `secret-tool`, `busctl` and `az`; the tests put fakes of
 * them on PATH (`tests/_helpers/fake-secret-stores.ts`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolveEnvBinding } from "../../src/commands/env/env-binding";
import { resolveInjectionRefs } from "../../src/commands/env/injection";
import { akmIndex } from "../../src/indexer/indexer";
import { runCliCapture } from "../_helpers/cli";
import { type FakeKeyringItem, withFakeSecretStores } from "../_helpers/fake-secret-stores";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

const KEYRING_PATH = "/org/freedesktop/secrets/collection/akm";

function keyringItem(id: number, label: string, secret: string, attributes: Record<string, string>): FakeKeyringItem {
  return { path: `${KEYRING_PATH}/${id}`, label, attributes, secret };
}

/** A keyring holding one entry akm stored and one another program stored. */
const KEYRING = {
  akm: [
    keyringItem(1, "gh_token", "ghp-keyring-value\n", { akm: "akm/gh_token" }),
    keyringItem(2, "wifi", "hunter2", { ssid: "home", kind: "wpa" }),
  ],
};
const VAULT = { "team-vault": { "deploy-token": "vault-value" } };

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  for (const dir of ["secrets", "env"]) fs.mkdirSync(path.join(storage.stashDir, dir), { recursive: true });
  writeSandboxConfig({
    semanticSearchMode: "off",
    bundles: {
      stash: { path: storage.stashDir, writable: true },
      keyring: { store: "secret-tool:akm" },
      vault: { store: "azure-key-vault:team-vault" },
    },
    defaultBundle: "stash",
  });
});

afterEach(() => storage.cleanup());

/** Run the CLI and parse what it printed: its JSON result, or on failure its JSON error. */
async function akm(...args: string[]): Promise<{ code: number; json: Record<string, unknown> }> {
  const result = await runCliCapture([...args, "--format", "json"]);
  return { code: result.code, json: JSON.parse(result.stdout || result.stderr) as Record<string, unknown> };
}

function writeValueFile(name: string, value: string): string {
  const file = path.join(storage.root, name);
  fs.writeFileSync(file, value);
  return file;
}

describe("secret store bundles", () => {
  test("every entry of the store is indexed as a secret, by name only", async () => {
    await withFakeSecretStores({ keyrings: KEYRING, vaults: VAULT }, async () => {
      await akmIndex({ stashDir: storage.stashDir, full: true });

      const search = await akm("search", "token", "--type", "secret");
      expect(search.code).toBe(0);
      const refs = (search.json.hits as Array<{ ref: string }>).map((hit) => hit.ref).sort();
      expect(refs).toEqual(["keyring//secrets/gh_token", "vault//secrets/deploy-token"]);

      const shown = await akm("show", "keyring//secrets/wifi");
      expect(shown.code).toBe(0);
      expect(shown.json).toMatchObject({ type: "secret", name: "wifi" });
      expect(JSON.stringify([search.json, shown.json])).not.toContain("hunter2");
    });
  });

  test("an entry that left the store leaves the index on the next build", async () => {
    await withFakeSecretStores({ keyrings: KEYRING }, async () => {
      await akmIndex({ stashDir: storage.stashDir, full: true });
      expect((await akm("show", "keyring//secrets/wifi")).code).toBe(0);
    });
    await withFakeSecretStores({ keyrings: { akm: [KEYRING.akm[0] as FakeKeyringItem] } }, async () => {
      await akmIndex({ stashDir: storage.stashDir });
      const search = await akm("search", "wifi", "--type", "secret");
      expect(search.json.hits).toEqual([]);
    });
  });

  test("secret list names the secrets of every bundle", async () => {
    fs.writeFileSync(path.join(storage.stashDir, "secrets", "local"), "file-value");
    await withFakeSecretStores({ keyrings: KEYRING, vaults: VAULT }, async () => {
      const listed = await akm("secret", "list");
      expect(listed.code).toBe(0);
      expect((listed.json.secrets as Array<{ ref: string }>).map((secret) => secret.ref).sort()).toEqual([
        "keyring//secrets/gh_token",
        "keyring//secrets/wifi",
        "secrets/local",
        "vault//secrets/deploy-token",
      ]);
    });
  });

  test("--secret and an env file's ref token read the value from the store, trimmed", async () => {
    fs.writeFileSync(
      path.join(storage.stashDir, "env", "prod.env"),
      "GH=${keyring//secrets/gh_token}\nDEPLOY=${vault//secrets/deploy-token}\n",
    );
    await withFakeSecretStores({ keyrings: KEYRING, vaults: VAULT }, async () => {
      const injected = resolveInjectionRefs({
        secret: [
          "keyring//secrets/gh_token:GH_TOKEN",
          "keyring//secrets/wifi:WIFI",
          "vault//secrets/deploy-token:DEPLOY",
        ],
      });
      expect(injected.values).toEqual({ GH_TOKEN: "ghp-keyring-value", WIFI: "hunter2", DEPLOY: "vault-value" });

      expect(resolveEnvBinding("env/prod").values).toEqual({ GH: "ghp-keyring-value", DEPLOY: "vault-value" });
    });
  });

  test("an unqualified ref reaches a store bundle after the bundles before it", async () => {
    await withFakeSecretStores({ keyrings: KEYRING, vaults: VAULT }, async () => {
      expect(resolveInjectionRefs({ secret: ["secrets/gh_token:T"] }).values).toEqual({ T: "ghp-keyring-value" });
      expect(resolveInjectionRefs({ secret: ["secrets/deploy-token:T"] }).values).toEqual({ T: "vault-value" });

      fs.writeFileSync(path.join(storage.stashDir, "secrets", "gh_token"), "from-the-default-bundle");
      expect(resolveInjectionRefs({ secret: ["secrets/gh_token:T"] }).values).toEqual({ T: "from-the-default-bundle" });
    });
  });

  test("secret set stores a new keyring entry, and replaces an entry through the attributes it has", async () => {
    await withFakeSecretStores({ keyrings: KEYRING }, async (stores) => {
      const created = await akm(
        "secret",
        "set",
        "keyring//secrets/npm_token",
        "--from-file",
        writeValueFile("v1", "npm-1"),
      );
      expect(created.code).toBe(0);
      expect(created.json.ref).toBe("keyring//secrets/npm_token");

      const replaced = await akm(
        "secret",
        "set",
        "keyring//secrets/wifi",
        "--from-file",
        writeValueFile("v2", "new-pass"),
      );
      expect(replaced.code).toBe(0);

      const state = stores.state();
      expect(state.keyrings.akm).toEqual([
        KEYRING.akm[0] as FakeKeyringItem,
        keyringItem(3, "npm_token", "npm-1", { akm: "akm/npm_token" }),
        keyringItem(2, "wifi", "new-pass", { ssid: "home", kind: "wpa" }),
      ]);
      // A value reaches the client on stdin, never on its command line.
      expect(JSON.stringify(state.calls)).not.toContain("npm-1");
      expect(JSON.stringify(state.calls)).not.toContain("new-pass");
      // Nothing is written where the bundle's entries are indexed.
      expect(fs.existsSync(path.join(storage.cacheDir, "akm", "index", "stores"))).toBe(false);
    });
  });

  test("secret set and remove work on a vault", async () => {
    await withFakeSecretStores({ vaults: VAULT }, async (stores) => {
      const file = writeValueFile("v", "line-1\nline-2\n");
      expect((await akm("secret", "set", "vault//secrets/tls-key", "--from-file", file)).code).toBe(0);
      expect(stores.state().vaults["team-vault"]).toEqual({
        "deploy-token": "vault-value",
        "tls-key": "line-1\nline-2\n",
      });
      expect(JSON.stringify(stores.state().calls)).not.toContain("line-1");

      const removed = await akm("secret", "remove", "vault//secrets/deploy-token", "--yes");
      expect(removed.json).toMatchObject({ ref: "vault//secrets/deploy-token", removed: true });
      expect(stores.state().vaults["team-vault"]).toEqual({ "tls-key": "line-1\nline-2\n" });

      const again = await akm("secret", "remove", "vault//secrets/deploy-token", "--yes");
      expect(again.code).not.toBe(0);
      expect(again.json.error).toBe("Secret not found: vault//secrets/deploy-token");
    });
  });

  test("secret remove deletes exactly the keyring entry it names", async () => {
    const twin = keyringItem(7, "wifi", "other-keyring", { ssid: "home", kind: "wpa" });
    await withFakeSecretStores(
      { keyrings: { ...KEYRING, login: [{ ...twin, path: "/org/freedesktop/secrets/collection/login/7" }] } },
      async (stores) => {
        const removed = await akm("secret", "remove", "keyring//secrets/wifi", "--yes");
        expect(removed.json).toMatchObject({ removed: true });
        const state = stores.state();
        expect(state.keyrings.akm?.map((item) => item.label)).toEqual(["gh_token"]);
        expect(state.keyrings.login).toHaveLength(1);
      },
    );
  });

  test("a keyring entry without attributes is listed, and reading it says why it cannot be read", async () => {
    const bare = { akm: [keyringItem(1, "bare", "value", {})] };
    await withFakeSecretStores({ keyrings: bare }, async () => {
      const listed = await akm("secret", "list");
      expect((listed.json.secrets as Array<{ ref: string }>).map((secret) => secret.ref)).toContain(
        "keyring//secrets/bare",
      );
      expect(() => resolveInjectionRefs({ secret: ["keyring//secrets/bare:T"] })).toThrow(
        'Keyring entry "bare" has no attributes, and secret-tool finds an entry only by its attributes.',
      );
    });
  });

  test("a store that cannot be reached fails the command that needs it and keeps its indexed entries", async () => {
    await withFakeSecretStores({ keyrings: KEYRING, vaults: VAULT }, async () => {
      await akmIndex({ stashDir: storage.stashDir, full: true });
    });
    // No vault and no keyring answer here: the keyring is unknown and the vault is not found.
    await withFakeSecretStores({}, async () => {
      await akmIndex({ stashDir: storage.stashDir });
      expect((await akm("show", "keyring//secrets/gh_token")).code).not.toBe(0);
      const search = await akm("search", "token", "--type", "secret");
      expect((search.json.hits as Array<{ ref: string }>).map((hit) => hit.ref).sort()).toEqual([
        "keyring//secrets/gh_token",
        "vault//secrets/deploy-token",
      ]);
      expect(() => resolveInjectionRefs({ secret: ["vault//secrets/deploy-token:T"] })).toThrow("VaultNotFound");
    });
  });

  test("a client that is not installed is named, with what provides it", async () => {
    fs.writeFileSync(path.join(storage.stashDir, "secrets", "local"), "file-value");
    const file = writeValueFile("v", "value");
    await withFakeSecretStores({}, async () => {
      // No program is on this PATH, the fakes included.
      await withEnv({ PATH: storage.root }, async () => {
        const set = await akm("secret", "set", "vault//secrets/token", "--from-file", file);
        expect(set.code).not.toBe(0);
        expect(set.json).toMatchObject({
          error: '"az" is not installed.',
          code: "SECRET_STORE_UNAVAILABLE",
          hint: "Install the Azure CLI.",
        });

        // Listing goes on without the stores it cannot reach, and says which.
        const listed = await runCliCapture(["secret", "list", "--format", "json"]);
        expect(listed.code).toBe(0);
        expect(JSON.parse(listed.stdout).secrets).toEqual([{ ref: "secrets/local" }]);
        expect(listed.stderr).toContain('Bundle "keyring" was not listed: "busctl" is not installed.');
        expect(listed.stderr).toContain('Bundle "vault" was not listed: "az" is not installed.');
      });
    });
  });

  test("a store bundle takes secrets only", async () => {
    await withFakeSecretStores({ keyrings: KEYRING }, async () => {
      const remembered = await akm("remember", "a note", "--bundle", "keyring");
      expect(remembered.code).not.toBe(0);
      expect(remembered.json.error).toBe(
        'Bundle "keyring" uses adapter "secret-tool", which does not support AKM asset writes.',
      );
    });
  });
});
