// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Bundles kept by a secret manager: a bundle whose adapter is `secret-tool` (a
 * Secret Service keyring) or `azure-key-vault`, and whose `location` names the
 * keyring or the vault. Beyond the config entry, its secrets behave as the
 * files under a directory bundle's `secrets/` do: indexed by name, listed,
 * injected, set and removed by the same commands, through the same adapter
 * contract.
 *
 * The adapters run `secret-tool`, `busctl` and `az`; the tests put fakes of
 * them on PATH (`tests/_helpers/fake-secret-stores.ts`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveEnvBinding } from "../../src/commands/env/env-binding";
import { resolveInjectionRefs } from "../../src/commands/env/injection";
import { collectBundleAdaptersCheck } from "../../src/commands/health/bundle-adapters-check";
import { azureKeyVaultAdapter, purgeRetry } from "../../src/core/adapter/adapters/azure-key-vault-adapter";
import { secretToolAdapter } from "../../src/core/adapter/adapters/secret-tool-adapter";
import { clearAdapterCaches } from "../../src/core/adapter/registry";
import { clientFailure } from "../../src/core/adapter/secret-manager-adapter";
import { parseBundleRef } from "../../src/core/asset/asset-ref";
import { assetBundleOf } from "../../src/core/assets/bundle";
import { resetConfigCache } from "../../src/core/config/config";
import { ConfigError } from "../../src/core/errors";
import { _setWarnSinkForTests } from "../../src/core/warn";
import { akmIndex } from "../../src/indexer/indexer";
import { sensitive } from "../../src/workspace";
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

/** A store's entries are read from the index: index them, as a user runs `akm index`, before a read or write. */
const indexStores = (keyringLocation = "akm") => {
  if (keyringLocation !== "akm") {
    writeSandboxConfig({
      ...sandboxConfig(),
      bundles: { ...sandboxConfig().bundles, keyring: { location: keyringLocation, adapter: "secret-tool" } },
    });
    resetConfigCache();
  }
  return akmIndex({ stashDir: storage.stashDir, full: true });
};

function sandboxConfig() {
  return {
    semanticSearchMode: "off" as const,
    bundles: {
      stash: { path: storage.stashDir, writable: true },
      keyring: { location: "akm", adapter: "secret-tool" },
      vault: { location: "team-vault", adapter: "azure-key-vault" },
    },
    defaultBundle: "stash",
  };
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  for (const dir of ["secrets", "env"]) fs.mkdirSync(path.join(storage.stashDir, dir), { recursive: true });
  writeSandboxConfig(sandboxConfig());
});

afterEach(() => {
  storage.cleanup();
});

/** Run the CLI and parse what it printed: its JSON result, or on failure its JSON error. */
async function akm(...args: string[]): Promise<{ code: number; json: Record<string, unknown> }> {
  const result = await runCliCapture([...args, "--format", "json"]);
  return { code: result.code, json: JSON.parse(result.stdout || result.stderr) as Record<string, unknown> };
}

/** Each request a fake client received, as its program and verb: `az show`, `busctl get-property`, `secret-tool lookup`. */
function requests(calls: string[][]): string[] {
  return calls.map(([program, ...args]) => {
    const words = args.filter((arg) => !arg.startsWith("--"));
    return `${program} ${program === "az" ? words[2] : words[0]}`;
  });
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** The error code a workspace operation fails with. */
const code = (operation: Promise<unknown>) =>
  operation.then(
    () => undefined,
    (error: { code?: string }) => error.code,
  );

function writeValueFile(name: string, value: string): string {
  const file = path.join(storage.root, name);
  fs.writeFileSync(file, value);
  return file;
}

describe("secret manager bundles", () => {
  test("every entry of the store is indexed as a secret, by name only", async () => {
    await withFakeSecretStores({ keyrings: KEYRING, vaults: VAULT }, async () => {
      await akmIndex({ stashDir: storage.stashDir, full: true });

      const search = await akm("search", "token", "--type", "secret");
      expect(search.code).toBe(0);
      const refs = (search.json.hits as Array<{ ref: string }>).map((hit) => hit.ref).sort();
      expect(refs).toEqual(["keyring//secrets/gh_token", "vault//secrets/deploy-token"]);

      const shown = await akm("show", "keyring//secrets/wifi");
      expect(String(shown.json.error ?? "")).toBe("");
      expect(shown.code).toBe(0);
      expect(shown.json).toMatchObject({ type: "secret", name: "wifi" });
      expect(JSON.stringify([search.json, shown.json])).not.toContain("hunter2");
    });
  });

  test("no output prints a path for an entry the store keeps: no file holds it", async () => {
    await withFakeSecretStores({ keyrings: KEYRING, vaults: VAULT }, async () => {
      await akmIndex({ stashDir: storage.stashDir, full: true });

      const search = await akm("search", "token", "--type", "secret");
      const hits = search.json.hits as Array<Record<string, unknown>>;
      expect(hits).toHaveLength(2);
      for (const hit of hits) expect(hit).not.toHaveProperty("path");

      const shown = await akm("show", "keyring//secrets/wifi");
      expect(String(shown.json.error ?? "")).toBe("");
      expect(shown.code).toBe(0);
      expect(shown.json).not.toHaveProperty("path");
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
    await withFakeSecretStores({ keyrings: KEYRING, vaults: VAULT }, async (stores) => {
      await akmIndex({ stashDir: storage.stashDir, full: true });
      const before = stores.state().calls.length;
      const listed = await akm("secret", "list");
      expect(listed.code).toBe(0);
      // Listing reads the index: it asks neither store.
      expect(stores.state().calls.length).toBe(before);
      expect((listed.json.secrets as Array<{ ref: string }>).map((secret) => secret.ref).sort()).toEqual([
        "keyring//secrets/gh_token",
        "keyring//secrets/wifi",
        "secrets/local",
        "vault//secrets/deploy-token",
      ]);
    });
  });

  test("a keyring's secret is found through its index row: without one, akm says to run akm index", async () => {
    await withFakeSecretStores({ keyrings: KEYRING, vaults: VAULT }, async () => {
      // No index yet: the list says so, and so does a read and a write.
      const unindexed = await runCliCapture(["secret", "list", "--format", "json"]);
      expect(unindexed.code).toBe(0);
      expect(unindexed.stderr).toContain('Bundle "keyring" is listed from the index, and there is no usable index');
      expect(unindexed.stderr).toContain('Bundle "vault" is listed from the index');
      const missing = await akm("secret", "run", "keyring//secrets/wifi", "WIFI", "--", "true");
      expect(missing.code).toBe(1);
      expect(missing.json).toMatchObject({ code: "ASSET_NOT_FOUND", error: "Secret not found: keyring//secrets/wifi" });
      expect(String(missing.json.hint)).toContain('akm finds the entries of bundle "keyring" through the index');
      const set = await runCliCapture([
        "secret",
        "set",
        "keyring//secrets/fresh",
        "--from-file",
        writeValueFile("fresh", "v"),
        "--format",
        "json",
      ]);
      expect(set.code).toBe(0);
      expect(set.stderr).toContain('The index was not updated for "keyring//secrets/fresh"');
      // A directory bundle's secret is found without the index: its hint is the usual one.
      const local = await akm("secret", "run", "secrets/nope", "X", "--", "true");
      expect(String(local.json.hint ?? "")).not.toContain("akm finds the entries");
    });
  });

  test("secret list shows the indexed entries while the store is unreachable", async () => {
    await withFakeSecretStores({ keyrings: KEYRING, vaults: VAULT }, async () => {
      await akmIndex({ stashDir: storage.stashDir, full: true });
    });
    await withFakeSecretStores({}, async () => {
      const listed = await akm("secret", "list");
      expect(listed.code).toBe(0);
      expect((listed.json.secrets as Array<{ ref: string }>).map((secret) => secret.ref).sort()).toEqual([
        "keyring//secrets/gh_token",
        "keyring//secrets/wifi",
        "vault//secrets/deploy-token",
      ]);
    });
  });

  test("akm index warns of a locked keyring that lists nothing, goes on and keeps the indexed rows", async () => {
    await withFakeSecretStores({ keyrings: KEYRING, vaults: VAULT }, async () => {
      await akmIndex({ stashDir: storage.stashDir, full: true });
    });
    await withFakeSecretStores(
      { keyrings: KEYRING, vaults: VAULT, locked: ["akm"], hidesLocked: ["akm"] } as never,
      async () => {
        const warnings: string[] = [];
        _setWarnSinkForTests((level, args) => {
          if (level === "warn") warnings.push(args.map(String).join(" "));
        });
        try {
          await akmIndex({ stashDir: storage.stashDir, full: true });
        } finally {
          _setWarnSinkForTests(undefined);
        }
        expect(warnings.join("\n")).toContain(
          'Keyring "akm" is locked and lists no entries until it is unlocked: unlock it in your keyring manager (KWalletManager, Seahorse), then run akm index again.',
        );
        const listed = await akm("secret", "list");
        expect((listed.json.secrets as Array<{ ref: string }>).map((secret) => secret.ref)).toContain(
          "keyring//secrets/wifi",
        );
      },
    );
  });

  test("--secret and an env file's ref token read the value from the store, trimmed", async () => {
    fs.writeFileSync(
      path.join(storage.stashDir, "env", "prod.env"),
      "GH=${keyring//secrets/gh_token}\nDEPLOY=${vault//secrets/deploy-token}\n",
    );
    await withFakeSecretStores({ keyrings: KEYRING, vaults: VAULT }, async () => {
      await indexStores();
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

  test("reading a vault secret is one request, whatever else the vault holds", async () => {
    await withFakeSecretStores({ vaults: { "team-vault": { ...VAULT["team-vault"], other: "o" } } }, async (stores) => {
      resolveInjectionRefs({ secret: ["vault//secrets/deploy-token:T"] });
      expect(requests(stores.state().calls)).toEqual(["az show"]);
    });
    fs.writeFileSync(path.join(storage.stashDir, "env", "one.env"), "DEPLOY=${vault//secrets/deploy-token}\n");
    await withFakeSecretStores({ vaults: VAULT }, async (stores) => {
      resolveEnvBinding("env/one");
      expect(requests(stores.state().calls)).toEqual(["az show"]);
    });
  });

  test("an unqualified ref reaches a store bundle after the bundles before it", async () => {
    await withFakeSecretStores({ keyrings: KEYRING, vaults: VAULT }, async () => {
      await indexStores();
      expect(resolveInjectionRefs({ secret: ["secrets/gh_token:T"] }).values).toEqual({ T: "ghp-keyring-value" });
      expect(resolveInjectionRefs({ secret: ["secrets/deploy-token:T"] }).values).toEqual({ T: "vault-value" });

      fs.writeFileSync(path.join(storage.stashDir, "secrets", "gh_token"), "from-the-default-bundle");
      expect(resolveInjectionRefs({ secret: ["secrets/gh_token:T"] }).values).toEqual({ T: "from-the-default-bundle" });
    });
  });

  test("secret set stores a new keyring entry, and replaces an entry through the attributes it has", async () => {
    await withFakeSecretStores({ keyrings: KEYRING }, async (stores) => {
      await indexStores();
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
      expect(fs.existsSync(path.join(storage.cacheDir, "akm", "index", "bundles"))).toBe(false);
    });
  });

  test("secret set over an existing secret replaces it, in a vault and in a directory bundle", async () => {
    fs.writeFileSync(path.join(storage.stashDir, "secrets", "local"), "old-file-value");
    await withFakeSecretStores({ vaults: VAULT }, async (stores) => {
      const vault = await akm(
        "secret",
        "set",
        "vault//secrets/deploy-token",
        "--from-file",
        writeValueFile("v1", "vault-2"),
      );
      expect(vault.code).toBe(0);
      expect(stores.state().vaults["team-vault"]).toEqual({ "deploy-token": "vault-2" });

      const file = await akm("secret", "set", "secrets/local", "--from-file", writeValueFile("v2", "new-file-value"));
      expect(file.code).toBe(0);
      expect(fs.readFileSync(path.join(storage.stashDir, "secrets", "local"), "utf8")).toBe("new-file-value");
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
        await indexStores();
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
    await withFakeSecretStores({ keyrings: bare, vaults: VAULT }, async () => {
      await akmIndex({ stashDir: storage.stashDir, full: true });
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
      expect(() => resolveInjectionRefs({ secret: ["keyring//secrets/gh_token:T"] })).toThrow(
        'Keyring "akm" no longer holds "gh_token" as indexed: run akm index.',
      );
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
          code: "BUNDLE_UNREACHABLE",
          hint: "Install the Azure CLI.",
        });

        // A listing reads the index for a store: it needs no client.
        expect((await runCliCapture(["secret", "list", "--format", "json"])).code).toBe(0);
        // `env list` holds no secret, so a store that takes secrets only is none of its business.
        expect((await runCliCapture(["env", "list", "--format", "json"])).code).toBe(0);
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

describe("secret manager bundles in the workspace API", () => {
  test("the protected editor describes and reads a store secret with one request to the vault", async () => {
    await withFakeSecretStores({ vaults: VAULT }, async (stores) => {
      const info = sensitive.describe({ bundle: "vault", file: "secrets/deploy-token" });
      expect(info).toEqual({
        ref: "vault//secrets/deploy-token",
        type: "secret",
        name: "deploy-token",
        bundle: "vault",
        // The store keeps the secret: no file holds it, so there is no path.
        path: null,
        actions: { edit: { allowed: true }, delete: { allowed: true } },
        revision: sha("vault-value"),
        location: { bundle: "vault", path: "secrets/deploy-token", parent: "secrets" },
      });
      expect(requests(stores.state().calls)).toEqual(["az show"]);

      expect(sensitive.readValue({ ref: info.ref })).toEqual({ content: "vault-value", revision: info.revision });
      expect(requests(stores.state().calls)).toEqual(["az show", "az show"]);
    });
  });

  test("the protected editor creates, replaces and deletes a store secret, checking the revision it replaces", async () => {
    await withFakeSecretStores({ keyrings: KEYRING, vaults: VAULT }, async (stores) => {
      await indexStores();
      const created = await sensitive.save({ bundle: "vault", file: "secrets/api-key", content: "k-1" });
      expect(created).toEqual({
        bundle: "vault",
        file: "secrets/api-key",
        ref: "vault//secrets/api-key",
        warnings: [],
        revision: sha("k-1"),
      });
      expect(await code(sensitive.save({ ref: created.ref, content: "k-2" }))).toBe("RESOURCE_ALREADY_EXISTS");
      expect(await code(sensitive.save({ ref: created.ref, content: "k-2", revision: sha("old") }))).toBe(
        "ASSET_CONTENT_CHANGED",
      );
      expect(await code(sensitive.remove({ ref: created.ref, revision: sha("old") }))).toBe("ASSET_CONTENT_CHANGED");
      expect(stores.state().vaults["team-vault"]?.["api-key"]).toBe("k-1");

      const saved = await sensitive.save({ ref: created.ref, content: "k-2", revision: created.revision });
      expect(saved.revision).toBe(sha("k-2"));
      expect(stores.state().vaults["team-vault"]?.["api-key"]).toBe("k-2");
      expect(await sensitive.remove({ ref: created.ref, revision: saved.revision })).toMatchObject({ removed: true });
      expect(stores.state().vaults["team-vault"]).toEqual(VAULT["team-vault"]);

      // A keyring entry another program stored is replaced through the attributes it has.
      const wifi = sensitive.describe({ ref: "keyring//secrets/wifi" });
      await sensitive.save({ ref: wifi.ref, content: "new-pass", revision: wifi.revision });
      expect(stores.state().keyrings.akm).toContainEqual(
        keyringItem(2, "wifi", "new-pass", { ssid: "home", kind: "wpa" }),
      );

      expect(JSON.stringify(stores.state().calls)).not.toContain("new-pass");
      expect(fs.existsSync(path.join(storage.cacheDir, "akm", "index", "bundles"))).toBe(false);
    });
  });

  test("a store bundle that takes no writes says so before the editor is opened", async () => {
    writeSandboxConfig({
      bundles: {
        stash: { path: storage.stashDir, writable: true },
        vault: { location: "team-vault", adapter: "azure-key-vault", writable: false },
      },
    });
    await withFakeSecretStores({ vaults: VAULT }, async (stores) => {
      const info = sensitive.describe({ ref: "vault//secrets/deploy-token" });
      expect(info.actions.edit).toMatchObject({ allowed: false });
      await expect(sensitive.save({ bundle: "vault", file: "secrets/api-key", content: "k" })).rejects.toThrow();
      expect(stores.state().vaults).toEqual(VAULT);
    });
  });
});

describe("secret manager bundles: what the stores do that a file does not", () => {
  const bundle = (id: string, location: string) => ({
    id,
    root: path.join(storage.root, id),
    writable: true,
    location,
  });

  test("a keyring entry whose attributes another keyring's entry includes is refused, naming the other", async () => {
    const clash = {
      akm: [keyringItem(1, "wifi", "home-value", { ssid: "home" })],
      login: [
        {
          path: "/org/freedesktop/secrets/collection/login/1",
          label: "wifi-login",
          attributes: { ssid: "home", kind: "wpa" },
          secret: "login-value",
        },
      ],
    };
    await withFakeSecretStores({ keyrings: clash }, async () => {
      await indexStores();
      const adapter = secretToolAdapter;
      const read = () => adapter.read(bundle("keyring", "akm"), "secrets/wifi")?.entry.content();
      expect(read).toThrow(/"wifi-login".*include those of "wifi"/);
      expect(() => adapter.update(bundle("keyring", "akm"), "secrets/wifi", "new")).toThrow(/"wifi-login"/);
    });
  });

  test("a keyring read asks the store once: one SearchItems and one lookup, no listing", async () => {
    await withFakeSecretStores({ keyrings: KEYRING }, async (stores) => {
      await indexStores();
      const before = stores.state().calls.length;
      expect(secretToolAdapter.read(bundle("keyring", "akm"), "secrets/wifi")?.entry.content()).toBe("hunter2");
      const calls = stores.state().calls.slice(before);
      expect(requests(calls)).toEqual(["busctl call", "secret-tool lookup"]);
      expect(calls[0]).toContain("SearchItems");
      expect(calls.flat()).not.toContain("Items");
      expect(calls.flat()).not.toContain("GetAll");
    });
  });

  test("a secret akm stores is readable in the next command: its index row records its path and pairs", async () => {
    await withFakeSecretStores({ keyrings: KEYRING }, async (stores) => {
      await indexStores();
      const set = await akm("secret", "set", "keyring//secrets/fresh", "--from-file", writeValueFile("v", "new-value"));
      expect(set.code).toBe(0);
      clearAdapterCaches();
      const before = stores.state().calls.length;
      expect(resolveInjectionRefs({ secret: ["keyring//secrets/fresh:T"] }).values).toEqual({ T: "new-value" });
      const calls = stores.state().calls.slice(before);
      expect(requests(calls)).toEqual(["busctl call", "secret-tool lookup"]);
      const made = stores.state().keyrings.akm?.find((item) => item.label === "fresh");
      expect(made?.attributes).toEqual({ akm: "akm/fresh" });
    });
  });

  test("a keyring entry whose pairs the keyring rewrote asks for akm index", async () => {
    await withFakeSecretStores({ keyrings: KEYRING }, async (stores) => {
      await indexStores();
      const state = JSON.parse(fs.readFileSync(process.env.AKM_FAKE_STORE_STATE as string, "utf8"));
      state.keyrings.akm[1].attributes = { server: "Secret Service", type: "plaintext", user: "wifi" };
      fs.writeFileSync(process.env.AKM_FAKE_STORE_STATE as string, JSON.stringify(state));
      expect(() => secretToolAdapter.read(bundle("keyring", "akm"), "secrets/wifi")?.entry.content()).toThrow(
        'Keyring "akm" no longer holds "wifi" as indexed: run akm index.',
      );
      expect(stores.state().calls.some((call) => call[0] === "secret-tool" && call[1] === "lookup")).toBe(false);
    });
  });

  test("a keyring that does not exist names the ones that do, and says how to make it", async () => {
    await withFakeSecretStores({ keyrings: { login: [] } }, async () => {
      const failure = await Promise.resolve()
        .then(() => secretToolAdapter.list(bundle("keyring", "akm")))
        .catch((error: Error & { hint?: () => string }) => error);
      expect((failure as Error).message).toBe('Keyring "akm" does not exist. The Secret Service has: login.');
      expect(String((failure as { hint: () => string }).hint())).toContain("Create the wallet or keyring");
    });
  });

  test("a vault removal purges the soft-deleted secret, and says so when the purge is refused", async () => {
    await withFakeSecretStores({ vaults: VAULT }, async (stores) => {
      const b = bundle("vault", "team-vault");
      azureKeyVaultAdapter.delete(b, "secrets/deploy-token");
      expect(stores.state().deleted?.["team-vault"] ?? {}).toEqual({});
      azureKeyVaultAdapter.create(b, { type: "secret", name: "deploy-token", content: "again" });
    });
    const warnings: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    try {
      await withFakeSecretStores({ vaults: VAULT, purgeForbidden: ["team-vault"] } as never, async (stores) => {
        const b = bundle("vault", "team-vault");
        azureKeyVaultAdapter.delete(b, "secrets/deploy-token");
        expect(stores.state().deleted?.["team-vault"]).toEqual({ "deploy-token": "vault-value" });
      });
    } finally {
      _setWarnSinkForTests(undefined);
    }
    expect(warnings.join("\n")).toMatch(/refused to purge.*until its retention period ends/);
  });

  test("setting a name a deleted vault secret still holds hints at recover or purge", async () => {
    await withFakeSecretStores({ vaults: VAULT, purgeForbidden: ["team-vault"] } as never, async () => {
      const b = bundle("vault", "team-vault");
      azureKeyVaultAdapter.delete(b, "secrets/deploy-token");
      let failure: (Error & { hint?: () => string }) | undefined;
      try {
        azureKeyVaultAdapter.create(b, { type: "secret", name: "deploy-token", content: "x" });
      } catch (error) {
        failure = error as Error & { hint?: () => string };
      }
      expect(failure?.message).toContain("still holds a deleted secret");
      expect(String(failure?.hint?.())).toMatch(/recover.*purge/);
    });
  });

  test("a vault refuses a name it cannot hold before it calls az", async () => {
    await withFakeSecretStores({ vaults: VAULT }, async (stores) => {
      expect(() =>
        azureKeyVaultAdapter.create(bundle("vault", "team-vault"), { type: "secret", name: "bad_name", content: "x" }),
      ).toThrow(/not a name an Azure Key Vault accepts/);
      expect(stores.state().calls).toEqual([]);
    });
  });

  test("a failure that is not about reaching the store is a plain error, not BUNDLE_UNREACHABLE", () => {
    const refused = clientFailure({ command: "az", install: "the Azure CLI" }, "store x", {
      status: 1,
      stdout: "",
      stderr: "ERROR: (BadRequest) The value is too large.",
    });
    expect(refused).not.toBeInstanceOf(ConfigError);
    const down = clientFailure({ command: "az", install: "the Azure CLI" }, "list v", {
      status: 1,
      stdout: "",
      stderr: "ERROR: Please run 'az login' to setup account.",
    });
    expect((down as ConfigError).code).toBe("BUNDLE_UNREACHABLE");
  });

  test("a misconfigured secret bundle does not throw for a ref that is not a secret", () => {
    const b = { id: "keyring", root: "/x", writable: true };
    expect(secretToolAdapter.read(b, "skills/x")).toBeUndefined();
  });

  test("showing a store secret does not say its value is a file", async () => {
    await withFakeSecretStores({ keyrings: KEYRING }, async () => {
      await akmIndex({ stashDir: storage.stashDir, full: true });
      const shown = await akm("show", "keyring//secrets/wifi");
      expect(String(shown.json.action)).toContain("its content is the value");
      expect(String(shown.json.action)).not.toContain("file contents");
    });
  });
});

/** A fake store's state file, to change what a store holds while a test runs. */
function editState(change: (state: Record<string, unknown>) => void): void {
  const file = process.env.AKM_FAKE_STORE_STATE as string;
  const state = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  change(state);
  fs.writeFileSync(file, JSON.stringify(state));
}

describe("a keyring behaves like a directory of secrets (A10, N3)", () => {
  const b = { id: "keyring", root: "/x", location: "akm" };

  const lockedWarning = 'Keyring "akm" is locked: unlock it in the prompt your keyring manager shows.';
  const capture = async (body: () => void | Promise<void>): Promise<string[]> => {
    const warnings: string[] = [];
    _setWarnSinkForTests((_level, args) => warnings.push(args.join(" ")));
    try {
      await body();
    } finally {
      _setWarnSinkForTests(undefined);
    }
    return warnings;
  };

  test("a locked keyring lists without a prompt, and akm never calls Unlock or Prompt", async () => {
    await withFakeSecretStores({ keyrings: KEYRING, locked: ["akm"] } as never, async (stores) => {
      const warnings = await capture(() => {
        const listed = secretToolAdapter.list(b).assets.map((asset) => asset.conceptId);
        expect(listed).toEqual(["secrets/gh_token", "secrets/wifi"]);
      });
      expect(warnings).toEqual([]);
      expect(stores.state().locked).toEqual(["akm"]);
      const words = stores.state().calls.flat();
      expect(words).not.toContain("Unlock");
      expect(words).not.toContain("Prompt");
    });
  });

  test("a read from a locked keyring prints the unlock line once, and succeeds", async () => {
    await withFakeSecretStores({ keyrings: KEYRING, locked: ["akm"] } as never, async (stores) => {
      await indexStores();
      const warnings = await capture(() => {
        expect(secretToolAdapter.read(b, "secrets/wifi")?.entry.content()).toBe("hunter2");
      });
      expect(warnings).toEqual([lockedWarning]);
      expect(stores.state().locked).toEqual([]);
      expect(stores.state().calls.flat()).not.toContain("Unlock");
    });
  });

  test("a store into a locked keyring prints the unlock line once, and succeeds", async () => {
    await withFakeSecretStores({ keyrings: KEYRING, locked: ["akm"] } as never, async (stores) => {
      const warnings = await capture(() => {
        secretToolAdapter.create(b, { type: "secret", name: "new", content: "fresh" });
      });
      expect(warnings).toEqual([lockedWarning]);
      expect(stores.state().locked).toEqual([]);
      expect(stores.state().keyrings.akm?.some((item) => item.label === "new" && item.secret === "fresh")).toBe(true);
    });
  });

  test("a delete from a locked keyring unlocks through a lookup, then deletes by object path", async () => {
    await withFakeSecretStores({ keyrings: KEYRING, locked: ["akm"] } as never, async (stores) => {
      await indexStores();
      const warnings = await capture(() => {
        secretToolAdapter.delete(b, "secrets/wifi");
      });
      expect(warnings).toEqual([lockedWarning]);
      expect(stores.state().keyrings.akm?.map((item) => item.label)).toEqual(["gh_token"]);
      const calls = stores.state().calls;
      expect(calls.some((call) => call[0] === "secret-tool" && call[1] === "lookup")).toBe(true);
      expect(calls.some((call) => call[0] === "secret-tool" && call[1] === "clear")).toBe(false);
    });
  });

  test("a delete the keyring answers but does not carry out is an error", async () => {
    await withFakeSecretStores({ keyrings: KEYRING, deleteKeeps: ["akm"] } as never, async () => {
      await indexStores();
      expect(() => secretToolAdapter.delete(b, "secrets/wifi")).toThrow("is still there");
    });
  });

  test("a locked keyring that lists nothing is not an empty keyring", async () => {
    await withFakeSecretStores({ keyrings: KEYRING, locked: ["akm"], hidesLocked: ["akm"] } as never, async () => {
      expect(() => secretToolAdapter.list(b)).toThrow("is locked and lists no entries until it is unlocked");
    });
  });

  test("entries KWallet gave its own attributes are read by those, and a shared label has one winner", async () => {
    const own = (id: number, label: string, secret: string, user: string): FakeKeyringItem =>
      keyringItem(id, label, secret, { server: "Secret Service", type: "plaintext", user });
    const kwallet = {
      akm: [own(1, "dup", "one", "dup"), own(2, "dup", "two", "dup__0_"), own(3, "solo", "s", "solo")],
    };
    await withFakeSecretStores({ keyrings: kwallet } as never, async () => {
      await indexStores();
      const listed = secretToolAdapter.list(b).assets.map((asset) => asset.conceptId);
      expect(listed).toEqual(["secrets/dup", "secrets/solo"]);
      expect(secretToolAdapter.read(b, "secrets/dup")?.entry.content()).toBe("one");
      expect(secretToolAdapter.read(b, "secrets/solo")?.entry.content()).toBe("s");
    });
  });

  test("a keyring whose unlock prompt is dismissed leaves a read failing and the keyring locked", async () => {
    await withFakeSecretStores(
      { keyrings: KEYRING, locked: ["akm"], unlockDenied: ["akm"] } as never,
      async (stores) => {
        await indexStores();
        await capture(() => {
          expect(() => secretToolAdapter.read(b, "secrets/wifi")?.entry.content()).toThrow("locked");
        });
        expect(stores.state().locked).toEqual(["akm"]);
      },
    );
  });

  test("exists asks nothing of a locked keyring: no prompt, no entry read", async () => {
    await withFakeSecretStores({ keyrings: KEYRING, locked: ["akm"] } as never, async (stores) => {
      expect(secretToolAdapter.exists(b)).toBe(true);
      expect(secretToolAdapter.exists({ ...b, location: "nowhere" })).toBe(false);
      expect(secretToolAdapter.exists({ id: "keyring", root: "/x" })).toBe(false);
      const words = stores.state().calls.flat();
      expect(words).not.toContain("Unlock");
      expect(words).not.toContain("Items");
    });
  });

  test("a collection only its label names, with a hyphen in the name, is found and stored into by its object path, with no alias set", async () => {
    const wallet = {
      wallet: [
        {
          ...keyringItem(1, "wifi", "hunter2", { ssid: "home" }),
          path: "/org/freedesktop/secrets/collection/wallet/1",
        },
      ],
    };
    const hyphen = { ...b, location: "akm-test" };
    await withFakeSecretStores(
      { keyrings: wallet, labels: { wallet: "akm-test" }, unaliased: ["wallet"] } as never,
      async (stores) => {
        await indexStores("akm-test");
        expect(secretToolAdapter.read(hyphen, "secrets/wifi")?.entry.content()).toBe("hunter2");
        secretToolAdapter.create(hyphen, { type: "secret", name: "fresh", content: "v1" });
        expect(
          stores
            .state()
            .keyrings.wallet?.map((item) => item.label)
            .sort(),
        ).toEqual(["fresh", "wifi"]);
        secretToolAdapter.create(hyphen, { type: "secret", name: "again", content: "v2" }, { replace: true });
        expect(stores.state().aliases).toBeUndefined();
        expect(stores.state().calls.some((call) => call.includes("SetAlias"))).toBe(false);
        const stored = stores.state().calls.filter((call) => call[0] === "secret-tool" && call[1] === "store");
        expect(stored).toHaveLength(2);
        expect(stored.every((call) => call.includes("--collection=/org/freedesktop/secrets/collection/wallet"))).toBe(
          true,
        );
      },
    );
  });

  test("the alias wins over a collection that happens to be labelled the same", async () => {
    const two = {
      home: [keyringItem(1, "in-home", "h", { k: "h" })],
      work: [{ ...keyringItem(1, "in-work", "w", { k: "w" }), path: "/org/freedesktop/secrets/collection/work/1" }],
    };
    await withFakeSecretStores(
      { keyrings: two, labels: { home: "akm" }, aliases: { akm: "work" } } as never,
      async () => {
        expect(secretToolAdapter.list(b).assets.map((asset) => asset.conceptId)).toEqual(["secrets/in-work"]);
      },
    );
  });

  test("an entry another program made is a secret like any other, and a name two entries share has one winner", async () => {
    const entries = {
      akm: [
        { ...keyringItem(3, "dup", "other-value", { app: "x" }) },
        { ...keyringItem(2, "dup", "akm-value", { akm: "akm/dup" }) },
        { ...keyringItem(1, "dup", "first-value", { app: "y" }) },
        keyringItem(4, "solo", "s", { app: "z" }),
      ],
    };
    await withFakeSecretStores({ keyrings: entries }, async () => {
      await indexStores();
      expect(secretToolAdapter.list(b).assets.map((asset) => asset.conceptId)).toEqual(["secrets/dup", "secrets/solo"]);
      // The lowest object path wins.
      expect(secretToolAdapter.read(b, "secrets/dup")?.entry.content()).toBe("first-value");
      const found = await secretToolAdapter.validate(b, [], {});
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ ref: "keyring//secrets/dup", issue: "shadowed-spelling", fixed: false });
      expect(found[0]?.detail).toContain(`${KEYRING_PATH}/1 is used and ${KEYRING_PATH}/2, ${KEYRING_PATH}/3 ignored`);
      secretToolAdapter.update(b, "secrets/dup", "changed");
      expect(secretToolAdapter.read(b, "secrets/dup")?.entry.content()).toBe("changed");
    });
    const plain = { akm: [keyringItem(7, "same", "seven", { a: "1" }), keyringItem(5, "same", "five", { a: "2" })] };
    await withFakeSecretStores({ keyrings: plain }, async () => {
      await indexStores();
      expect(secretToolAdapter.read(b, "secrets/same")?.entry.content()).toBe("five");
    });
  });

  test("a label that is no concept name is not listed and is reported with its ref; every listed id reads back", async () => {
    const odd = {
      akm: [
        keyringItem(1, "good", "g", { a: "1" }),
        keyringItem(2, "has#hash", "h", { a: "2" }),
        keyringItem(3, " padded ", "p", { a: "3" }),
        keyringItem(4, "up/../out", "o", { a: "4" }),
        keyringItem(5, "", "e", { a: "5" }),
        keyringItem(6, "nested/name", "n", { a: "6" }),
      ],
    };
    await withFakeSecretStores({ keyrings: odd }, async () => {
      await indexStores();
      const listed = secretToolAdapter.list(b).assets.map((asset) => asset.conceptId);
      expect(listed).toEqual(["secrets/good", "secrets/nested/name"]);
      for (const conceptId of listed) {
        expect(parseBundleRef(`keyring//${conceptId}`).conceptId).toBe(conceptId);
        expect(secretToolAdapter.read(b, conceptId)?.conceptId).toBe(conceptId);
      }
      expect(secretToolAdapter.read(b, "secrets/has#hash")).toBeUndefined();
      const found = await secretToolAdapter.validate(b, [], {});
      expect(found.map((diagnostic) => diagnostic.ref).sort()).toEqual([
        "keyring//secrets/",
        "keyring//secrets/ padded ",
        "keyring//secrets/has#hash",
        "keyring//secrets/up/../out",
      ]);
      expect(found.every((diagnostic) => diagnostic.issue === "invalid-name")).toBe(true);
    });
  });
});

describe("a vault behaves like a directory of secrets (N1, N2, N4)", () => {
  const b = { id: "vault", root: "/x", location: "team-vault" };

  test("a managed secret and a disabled secret are not listed", async () => {
    await withFakeSecretStores(
      {
        vaults: { "team-vault": { ...VAULT["team-vault"], mgd: "m", off: "o" } },
        managed: { "team-vault": ["mgd"] },
        disabled: { "team-vault": ["off"] },
      } as never,
      async () => {
        expect(azureKeyVaultAdapter.list(b).assets.map((asset) => asset.conceptId)).toEqual(["secrets/deploy-token"]);
        // Read directly, a disabled secret is a plain error (N4), not an absent one.
        expect(() => azureKeyVaultAdapter.read(b, "secrets/off")).toThrow(/disabled/);
      },
    );
  });

  test("reading a disabled secret is a plain error, not an unreachable vault", async () => {
    await withFakeSecretStores({ vaults: VAULT, disabled: { "team-vault": ["deploy-token"] } } as never, async () => {
      let failure: unknown;
      try {
        azureKeyVaultAdapter.read(b, "secrets/deploy-token");
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(ConfigError);
      expect((failure as Error).message).toContain("disabled");
    });
  });

  test("removing a secret retries a purge the delete is still blocking, then sets the name again", async () => {
    const before = { ...purgeRetry };
    purgeRetry.delayMs = 1;
    try {
      await withFakeSecretStores({ vaults: VAULT, purgeConflicts: { "team-vault": 2 } } as never, async (stores) => {
        azureKeyVaultAdapter.delete(b, "secrets/deploy-token");
        expect(stores.state().calls.filter((call) => call.includes("purge"))).toHaveLength(3);
        expect(stores.state().deleted?.["team-vault"] ?? {}).toEqual({});
        azureKeyVaultAdapter.create(b, { type: "secret", name: "deploy-token", content: "again" });
        expect(stores.state().vaults["team-vault"]?.["deploy-token"]).toBe("again");
      });
      const warnings: string[] = [];
      _setWarnSinkForTests((level, args) => {
        if (level === "warn") warnings.push(args.map(String).join(" "));
      });
      try {
        await withFakeSecretStores({ vaults: VAULT, purgeConflicts: { "team-vault": 9 } } as never, async (stores) => {
          azureKeyVaultAdapter.delete(b, "secrets/deploy-token");
          expect(stores.state().calls.filter((call) => call.includes("purge"))).toHaveLength(purgeRetry.tries);
        });
      } finally {
        _setWarnSinkForTests(undefined);
      }
      expect(warnings.join("\n")).toMatch(/refused to purge/);
    } finally {
      Object.assign(purgeRetry, before);
    }
  });

  test("exists says whether the vault is there", async () => {
    await withFakeSecretStores({ vaults: VAULT }, async () => {
      expect(azureKeyVaultAdapter.exists(b)).toBe(true);
      expect(azureKeyVaultAdapter.exists({ ...b, location: "gone" })).toBe(false);
    });
    await withFakeSecretStores({}, async () => {
      expect(azureKeyVaultAdapter.exists(b)).toBe(false);
    }, []);
  });
});

describe("keyring and vault bundles in config and commands (P3, N3, N5, N6)", () => {
  const sources = async () =>
    (await akm("bundle", "list")).json.sources as Array<{ name: string; status: { exists: boolean } }>;

  test("bundle list says from the adapter whether a store is there", async () => {
    await withFakeSecretStores({ keyrings: KEYRING, vaults: {} }, async () => {
      const listed = await sources();
      expect(listed.find((entry) => entry.name === "keyring")?.status).toEqual({ exists: true });
      expect(listed.find((entry) => entry.name === "vault")?.status).toEqual({ exists: false });
      expect(listed.find((entry) => entry.name === "stash")?.status).toEqual({ exists: true });
    });
  });

  test("bundle add <location> --adapter <id> adds a bundle with a location, and never reads the name as a package", async () => {
    await withFakeSecretStores({ keyrings: KEYRING, vaults: VAULT }, async () => {
      const added = await akm("bundle", "add", "login", "--adapter", "secret-tool", "--name", "login-keyring");
      expect(added.code).toBe(0);
      expect(added.json.bundleId).toBe("login-keyring");
      expect(added.json.sourceAdded).toEqual({ type: "location", location: "login", name: "login-keyring" });
      const config = (await akm("config", "get", "bundles.login-keyring")).json;
      expect(config).toMatchObject({ location: "login", adapter: "secret-tool" });
      // Adding it again is no second bundle.
      const again = await akm("bundle", "add", "login", "--adapter", "secret-tool");
      expect(again.json.bundleId).toBe("login-keyring");
      const named = await akm("bundle", "add", "team-vault2", "--adapter", "azure-key-vault");
      expect(named.json.bundleId).toBe("team-vault2");
    });
  });

  test("config set takes the adapter and the location one at a time, and refuses a pair that does not fit", async () => {
    expect((await akm("config", "set", "bundles.keyring.location", "wallet")).code).toBe(0);
    expect((await akm("config", "set", "bundles.keyring.adapter", "azure-key-vault")).code).toBe(0);
    const bundles = (await akm("config", "get", "bundles")).json as Record<string, Record<string, string>>;
    expect(bundles.keyring).toMatchObject({ location: "wallet", adapter: "azure-key-vault" });

    // A directory adapter cannot read a store, and a store adapter cannot read a directory: the config stays as it was.
    for (const [key, value] of [
      ["bundles.keyring.adapter", "akm"],
      ["bundles.stash.adapter", "secret-tool"],
    ] as const) {
      const refused = await akm("config", "set", key, value);
      expect(refused.code).not.toBe(0);
      expect(String(refused.json.error)).toMatch(/location/);
    }
    const after = (await akm("config", "get", "bundles")).json as Record<string, Record<string, string>>;
    expect(after.keyring?.adapter).toBe("azure-key-vault");
    expect(after.stash?.adapter).not.toBe("secret-tool");
  });

  test("a bundle whose adapter and address do not fit is a config error where it is resolved, and a fail in the doctor check", async () => {
    const entry = { path: storage.stashDir, adapter: "secret-tool" };
    expect(() => assetBundleOf({ name: "mixed", path: storage.stashDir, adapterId: "secret-tool" })).toThrow(
      'Bundle "mixed" uses adapter "secret-tool", which reads a store named by `location`',
    );
    expect(() => assetBundleOf({ name: "mixed", path: storage.stashDir, adapterId: "akm", location: "akm" })).toThrow(
      /which reads a directory, but the bundle has a `location`/,
    );
    const failing = collectBundleAdaptersCheck(
      () => ({ bundles: { mixed: entry, keyring: { location: "akm", adapter: "akm" } } }) as never,
    );
    expect(failing.status).toBe("fail");
    expect(failing.message).toContain('Bundle "mixed"');
    expect(collectBundleAdaptersCheck().status).toBe("pass");
  });

  test("akm lint reports a name it cannot list and a name two entries share, by ref", async () => {
    const entries = {
      akm: [
        keyringItem(1, "good", "g", { a: "1" }),
        keyringItem(2, "has#hash", "h", { a: "2" }),
        keyringItem(3, "twice", "t1", { a: "3" }),
        keyringItem(4, "twice", "t2", { a: "4" }),
      ],
    };
    await withFakeSecretStores({ keyrings: entries, vaults: VAULT }, async (stores) => {
      // Never indexed: lint says nothing of the store.
      const unindexed = await akm("lint");
      expect(
        (unindexed.json.flagged as Array<Record<string, string>>).filter((i) => i.file?.startsWith("keyring//")),
      ).toEqual([]);
      // `akm index` warns of them, with the lint codes and refs.
      const warnings: string[] = [];
      _setWarnSinkForTests((_level, args) => warnings.push(args.join(" ")));
      try {
        await indexStores();
      } finally {
        _setWarnSinkForTests(undefined);
      }
      expect(warnings.some((line) => line.startsWith("keyring//secrets/has#hash invalid-name:"))).toBe(true);
      expect(warnings.some((line) => line.startsWith("keyring//secrets/twice shadowed-spelling:"))).toBe(true);
      const before = stores.state().calls.length;
      const linted = await akm("lint");
      // Lint reads the last index: it asks neither store.
      expect(stores.state().calls.length).toBe(before);
      const issues = [...(linted.json.flagged as Array<Record<string, string>>)].filter((issue) =>
        issue.file?.startsWith("keyring//"),
      );
      expect(issues.map((issue) => `${issue.file} ${issue.issue}`).sort()).toEqual([
        "keyring//secrets/has#hash adapter-diagnostic",
        "keyring//secrets/twice shadowed-spelling",
      ]);
    });
    // A store that cannot be reached is skipped.
    await withFakeSecretStores({}, async () => {
      const linted = await akm("lint");
      expect(linted.code).toBe(0);
    });
  });
});

describe("lint lists a locked keyring without a prompt (A10)", () => {
  test("akm lint reads a locked wallet's entries and leaves it locked", async () => {
    await withFakeSecretStores({ keyrings: KEYRING, locked: ["akm"] } as never, async (stores) => {
      const linted = await akm("lint");
      expect(linted.code).toBe(0);
      expect(stores.state().calls.flat()).not.toContain("Unlock");
      expect(stores.state().locked).toEqual(["akm"]);
    });
  });
});

describe("review fixes (K gate)", () => {
  const b = { id: "keyring", root: "/x", location: "login" };

  test("a location still matches the collection's own object-path name, after the alias and the label", async () => {
    const login = {
      login: [{ ...keyringItem(1, "wifi", "w", { a: "1" }), path: "/org/freedesktop/secrets/collection/login/1" }],
    };
    await withFakeSecretStores(
      { keyrings: login, labels: { login: "Login" }, unaliased: ["login"] } as never,
      async () => {
        await indexStores("login");
        expect(secretToolAdapter.read(b, "secrets/wifi")?.entry.content()).toBe("w");
      },
    );
  });

  test("a store that fails to list with an unrecognised error keeps its indexed rows, and akm index completes", async () => {
    await withFakeSecretStores({ keyrings: KEYRING, vaults: VAULT }, async () => {
      await akmIndex({ stashDir: storage.stashDir, full: true });
    });
    const warnings: string[] = [];
    _setWarnSinkForTests((_level, args) => warnings.push(args.join(" ")));
    try {
      await withFakeSecretStores({ keyrings: KEYRING, vaults: VAULT, listFails: ["team-vault"] } as never, async () => {
        const result = await akmIndex({ stashDir: storage.stashDir });
        expect(result.incompleteSources?.map((source) => source.bundle)).toEqual(["vault"]);
        const search = await akm("search", "token", "--type", "secret");
        expect((search.json.hits as Array<{ ref: string }>).map((hit) => hit.ref)).toContain(
          "vault//secrets/deploy-token",
        );
      });
    } finally {
      _setWarnSinkForTests(undefined);
    }
    expect(
      warnings.some(
        (w) =>
          w.includes('source "vault" was not scanned completely; preserving its last-known-good rows') &&
          w.includes("InternalServerError"),
      ),
    ).toBe(true);
  });

  test("akm lint skips a store that fails in an ordinary way, silently", async () => {
    await withFakeSecretStores({ keyrings: KEYRING, vaults: VAULT, listFails: ["team-vault"] } as never, async () => {
      const linted = await runCliCapture(["lint", "--format", "json"]);
      expect(linted.code).toBe(0);
      expect(linted.stderr).not.toContain("did not check");
    });
  });

  test("keyring findings follow lint's --type, carry their ref, and invalid-name is its own code", async () => {
    const entries = {
      akm: [
        keyringItem(1, "has#hash", "h", { a: "1" }),
        keyringItem(2, "twice", "x", { a: "2" }),
        keyringItem(3, "twice", "y", { a: "3" }),
      ],
    };
    await withFakeSecretStores({ keyrings: entries, vaults: VAULT }, async () => {
      await indexStores();
      const stored = (json: Record<string, unknown>) =>
        (json.flagged as Array<{ file: string; issue: string; ref?: string }>).filter((i) =>
          i.file.startsWith("keyring//"),
        );
      expect(stored((await akm("lint", "--type", "knowledge")).json)).toEqual([]);
      const secrets = stored((await akm("lint", "--type", "secrets")).json);
      expect(secrets.map((i) => i.issue).sort()).toEqual(["adapter-diagnostic", "shadowed-spelling"]);
      expect(secrets.find((i) => i.issue === "adapter-diagnostic")).toMatchObject({
        detail: expect.stringContaining("[invalid-name]"),
      });
      expect(secrets.every((i) => i.ref === i.file)).toBe(true);
    });
  });

  test("a managed vault secret cannot be read, set over or removed by name", async () => {
    await withFakeSecretStores(
      { vaults: { "team-vault": { mgd: "m" } }, managed: { "team-vault": ["mgd"] } } as never,
      async () => {
        const v = { id: "vault", root: "/x", location: "team-vault" };
        expect(azureKeyVaultAdapter.read(v, "secrets/mgd")).toBeUndefined();
        expect(() => azureKeyVaultAdapter.delete(v, "secrets/mgd")).toThrow();
      },
    );
  });

  test("a bundle that does not fit does not stop config set on anything else, and its own edits are refused", async () => {
    writeSandboxConfig({
      bundles: {
        stash: { path: storage.stashDir, writable: true },
        bad: { path: storage.root, adapter: "secret-tool" },
      },
      defaultBundle: "stash",
    });
    expect((await akm("config", "set", "semanticSearchMode", "off")).code).toBe(0);
    expect((await akm("config", "set", "bundles.stash.writable", "true")).code).toBe(0);
    const refused = await akm("config", "set", "bundles.bad.writable", "true");
    expect(refused.code).not.toBe(0);
    expect(String(refused.json.error)).toContain("in place of its path");
    expect(String(refused.json.error)).not.toContain("set `bundles.bad.location`");
  });
});

describe("a locked keyring is unlocked by the keyring manager wherever a command reads it (A10)", () => {
  const unlocked = (stores: { state(): { locked?: string[] } }) => stores.state().locked?.length === 0;

  test("a CLI run reads it, and the keyring is unlocked", async () => {
    await withFakeSecretStores({ keyrings: KEYRING, locked: ["akm"] } as never, async (stores) => {
      await indexStores();
      expect(resolveInjectionRefs({ secret: ["keyring//secrets/wifi:V"] }).values).toEqual({ V: "hunter2" });
      expect(unlocked(stores)).toBe(true);
    });
  });

  test("a workspace host reads it too", async () => {
    await withFakeSecretStores({ keyrings: KEYRING, locked: ["akm"] } as never, async (stores) => {
      await indexStores();
      const described = await Promise.resolve().then(() => sensitive.describe({ ref: "keyring//secrets/wifi" }));
      expect(described).toBeDefined();
      expect(unlocked(stores)).toBe(true);
    });
  });
});
