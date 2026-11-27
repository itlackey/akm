// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A `secret-tool` bundle with a `credential`: akm unlocks its locked GNOME keyring with that password itself, so a read
 * needs no person at the keyring's prompt (itlackey/akm#1748). The keyring is the fake stores' (`secret-tool` and
 * `busctl` on PATH), and the unlock goes over a fake session bus that answers as GNOME Keyring does
 * (`tests/_helpers/fake-secret-stores/secret-bus.ts`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveInjectionRefs } from "../../src/commands/env/injection";
import { sessionBusSocket } from "../../src/core/adapter/adapters/gnome-keyring-unlock";
import { resetConfigCache } from "../../src/core/config/config";
import { _setWarnSinkForTests } from "../../src/core/warn";
import { akmIndex } from "../../src/indexer/indexer";
import { runCliCapture } from "../_helpers/cli";
import { type FakeStoreState, withFakeSecretBus, withFakeSecretStores } from "../_helpers/fake-secret-stores";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  withEnv,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../_helpers/sandbox";

const PASSWORD = "keyring-password-7f3a";
const COLLECTION = "/org/freedesktop/secrets/collection/akm";
const KEYRING = {
  akm: [
    {
      path: `${COLLECTION}/1`,
      label: "wifi",
      attributes: { akm: "akm/wifi" },
      secret: "hunter2",
    },
  ],
};

let storage: IsolatedAkmStorage;

function configure(credential: string | undefined): void {
  writeSandboxConfig({
    semanticSearchMode: "off",
    bundles: {
      stash: { path: storage.stashDir, writable: true },
      keyring: { location: "akm", adapter: "secret-tool", ...(credential ? { credential } : {}) },
    },
    defaultBundle: "stash",
  });
  resetConfigCache();
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  fs.mkdirSync(path.join(storage.stashDir, "secrets"), { recursive: true });
  fs.writeFileSync(path.join(storage.stashDir, "secrets", "keyring-password"), PASSWORD);
  configure("${stash//secrets/keyring-password}");
});

afterEach(() => {
  storage.cleanup();
});

/** Run `body` over the fake keyring and session bus, starting from `initial`; it gets the state as it is then. */
function withKeyring(
  initial: Partial<FakeStoreState>,
  body: (state: () => FakeStoreState) => Promise<void>,
): Promise<void> {
  return withFakeSecretStores({ keyrings: KEYRING, locked: ["akm"], ...initial } as never, (stores) =>
    withFakeSecretBus(async () => {
      await akmIndex({ stashDir: storage.stashDir, full: true });
      await body(() => stores.state());
    }),
  );
}

const readWifi = () => resolveInjectionRefs({ secret: ["keyring//secrets/wifi:WIFI"] }).values.WIFI;
const unlocks = (state: FakeStoreState) => state.calls.filter((call) => call[0] === "secret-bus");
const lookups = (state: FakeStoreState) =>
  state.calls.filter((call) => call[0] === "secret-tool" && call[1] === "lookup");

async function warningsOf(body: () => void | Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  _setWarnSinkForTests((_level, args) => warnings.push(args.join(" ")));
  try {
    await body();
  } finally {
    _setWarnSinkForTests(undefined);
  }
  return warnings;
}

describe("a secret-tool bundle with a credential", () => {
  test("a read from its locked keyring unlocks it with the password, shows no prompt and succeeds", async () => {
    await withKeyring({ passwords: { akm: PASSWORD } }, async (state) => {
      const warnings = await warningsOf(() => {
        expect(readWifi()).toBe("hunter2");
      });
      expect(warnings).toEqual([]);
      expect(state().locked).toEqual([]);
      expect(state().prompted ?? []).toEqual([]);
      expect(unlocks(state())).toEqual([["secret-bus", "UnlockWithMasterPassword", COLLECTION]]);
    });
  });

  test("a wrong password fails the read once, with no prompt, and leaves the keyring locked", async () => {
    await withKeyring({ passwords: { akm: "another-password" } }, async (state) => {
      expect(readWifi).toThrow(`Keyring "akm" refused the bundle's credential: the password is wrong.`);
      expect(state().locked).toEqual(["akm"]);
      expect(state().prompted ?? []).toEqual([]);
      expect(unlocks(state())).toHaveLength(1);
      expect(lookups(state())).toEqual([]);
    });
  });

  test("a Secret Service that is not GNOME Keyring fails the read: unlocking by password is GNOME-only", async () => {
    await withKeyring({ passwords: { akm: PASSWORD }, noPasswordUnlock: true }, async (state) => {
      expect(readWifi).toThrow("unlocking it with the bundle's credential works only with GNOME Keyring");
      expect(state().locked).toEqual(["akm"]);
      expect(state().prompted ?? []).toEqual([]);
      expect(lookups(state())).toEqual([]);
    });
  });

  test("an unlocked keyring is read without the credential, which is never resolved", async () => {
    configure("$AKM_TEST_UNSET_KEYRING_PASSWORD");
    await withEnv({ AKM_TEST_UNSET_KEYRING_PASSWORD: undefined }, () =>
      withKeyring({ locked: [] }, async (state) => {
        expect(readWifi()).toBe("hunter2");
        expect(unlocks(state())).toEqual([]);
      }),
    );
  });

  test("a credential from an environment variable unlocks the keyring", async () => {
    configure("$AKM_TEST_KEYRING_PASSWORD");
    await withEnv({ AKM_TEST_KEYRING_PASSWORD: PASSWORD }, () =>
      withKeyring({ passwords: { akm: PASSWORD } }, async (state) => {
        expect(readWifi()).toBe("hunter2");
        expect(state().locked).toEqual([]);
      }),
    );
  });

  test("a credential that names a secret of the locked keyring itself fails, and does not recurse", async () => {
    configure("${keyring//secrets/wifi}");
    await withKeyring({ passwords: { akm: PASSWORD } }, async (state) => {
      expect(readWifi).toThrow(`names a secret of "keyring" itself`);
      expect(unlocks(state())).toEqual([]);
    });
  });

  test("akm index unlocks a locked keyring that lists nothing until it is unlocked", async () => {
    await withFakeSecretStores(
      { keyrings: KEYRING, locked: ["akm"], hidesLocked: ["akm"], passwords: { akm: PASSWORD } } as never,
      (stores) =>
        withFakeSecretBus(async () => {
          await akmIndex({ stashDir: storage.stashDir, full: true });
          const shown = await runCliCapture(["show", "keyring//secrets/wifi", "--format", "json"]);
          expect(shown.code).toBe(0);
          expect(stores.state().locked).toEqual([]);
        }),
    );
  });

  test("the password appears in no output, warning, log or index", async () => {
    await withKeyring({ passwords: { akm: PASSWORD } }, async (state) => {
      const said: string[] = [];
      said.push(
        ...(await warningsOf(async () => {
          for (const args of [["index"], ["show", "keyring//secrets/wifi"], ["secret", "list"], ["bundle", "list"]]) {
            const result = await runCliCapture([...args, "--format", "json"]);
            said.push(result.stdout, result.stderr);
          }
          readWifi();
        })),
      );
      expect(state().locked).toEqual([]);
      expect(said.join("\n")).not.toContain(PASSWORD);
      expect(JSON.stringify(state().calls)).not.toContain(PASSWORD);
      // Every file akm wrote: the index, logs and state. The stash holds the password's own secret file.
      const written = [storage.dataDir, storage.cacheDir, storage.stateDir, storage.configDir].flatMap((dir) =>
        fs.existsSync(dir)
          ? fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).map((f) => path.join(dir, f))
          : [],
      );
      expect(written.length).toBeGreaterThan(0);
      for (const file of written) {
        if (fs.statSync(file).isFile()) expect(fs.readFileSync(file).includes(PASSWORD)).toBe(false);
      }
    });
  });
});

describe("a keyring credential in config", () => {
  const set = (key: string, value: string) => runCliCapture(["config", "set", key, value, "--format", "json"]);

  test("a secret-tool bundle takes a reference, never a literal password", async () => {
    configure(undefined);
    expect((await set("bundles.keyring.credential", "${stash//secrets/keyring-password}")).code).toBe(0);
    expect((await set("bundles.keyring.credential", "$KEYRING_PASSWORD")).code).toBe(0);
    const literal = await set("bundles.keyring.credential", PASSWORD);
    expect(literal.code).not.toBe(0);
    expect(literal.stdout + literal.stderr).toContain("a bundle's credential must be a $VAR");
    expect(literal.stdout + literal.stderr).not.toContain(PASSWORD);
  });

  test("a bundle of another store adapter refuses a credential when it is used", async () => {
    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: {
        stash: { path: storage.stashDir, writable: true },
        vault: { location: "team-vault", adapter: "azure-key-vault", credential: "$VAULT_PASSWORD" },
      },
      defaultBundle: "stash",
    });
    resetConfigCache();
    await withFakeSecretStores({ vaults: { "team-vault": { "deploy-token": "vault-value" } } }, async () => {
      expect(() => resolveInjectionRefs({ secret: ["vault//secrets/deploy-token:T"] })).toThrow(
        'Bundle "vault" has a `credential`, which the azure-key-vault adapter does not take: remove it.',
      );
    });
  });

  test("a directory bundle takes no credential", async () => {
    configure(undefined);
    const refused = await set("bundles.stash.credential", "$STASH_PASSWORD");
    expect(refused.code).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain(
      "credential is only supported on git and location bundle sources",
    );
  });
});

describe("the session bus akm unlocks over", () => {
  test("is the first unix address of DBUS_SESSION_BUS_ADDRESS, as busctl --user finds it", () => {
    expect(sessionBusSocket({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" })).toBe("/run/user/1000/bus");
    expect(sessionBusSocket({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/dbus-x0C,guid=b45c" })).toBe("/tmp/dbus-x0C");
    expect(sessionBusSocket({ DBUS_SESSION_BUS_ADDRESS: "unix:abstract=/tmp/dbus-Ab,guid=1" })).toBe("\0/tmp/dbus-Ab");
    expect(sessionBusSocket({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/a%20b" })).toBe("/tmp/a b");
    expect(sessionBusSocket({ DBUS_SESSION_BUS_ADDRESS: "tcp:host=x,port=1;unix:path=/tmp/bus" })).toBe("/tmp/bus");
    expect(sessionBusSocket({ DBUS_SESSION_BUS_ADDRESS: "tcp:host=x,port=1" })).toBeUndefined();
  });

  test("is $XDG_RUNTIME_DIR/bus when DBUS_SESSION_BUS_ADDRESS is unset", () => {
    expect(sessionBusSocket({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe("/run/user/1000/bus");
    expect(sessionBusSocket({})).toBeUndefined();
  });
});

/** The programs a real GNOME Keyring test runs: it starts a keyring of its own on a session bus of its own. */
const REAL_KEYRING =
  process.platform === "linux" &&
  ["dbus-run-session", "gnome-keyring-daemon", "secret-tool", "busctl"].every((program) => Bun.which(program) !== null);

describe.skipIf(!REAL_KEYRING)("a real GNOME Keyring", () => {
  test("a wrong password fails and leaves it locked; the right one unlocks it and the read succeeds", () => {
    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: {
        stash: { path: storage.stashDir, writable: true },
        keyring: { location: "akmtest", adapter: "secret-tool", credential: "$AKM_TEST_KEYRING_ATTEMPT" },
      },
      defaultBundle: "stash",
    });
    // gnome-keyring finds a running daemon by the runtime directory: a short one of its own keeps it off the user's.
    const home = makeSandboxDir("akm-gk-home");
    const runtime = makeSandboxDir("akm-gk");
    fs.chmodSync(runtime.dir, 0o700);
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home.dir,
        XDG_RUNTIME_DIR: runtime.dir,
        AKM_TEST_KEYRING_PASSWORD: PASSWORD,
        AKM_TEST_KEYRING_ATTEMPTS: JSON.stringify(["not-the-password", PASSWORD]),
      };
      delete env.DBUS_SESSION_BUS_ADDRESS;
      delete env.GNOME_KEYRING_CONTROL;
      const run = spawnSync(
        "dbus-run-session",
        ["--", process.execPath, path.join(import.meta.dir, "..", "_helpers", "real-gnome-keyring.ts")],
        { env, encoding: "utf8", timeout: 90_000 },
      );
      expect(run.stderr.includes(PASSWORD)).toBe(false);
      if (run.status !== 0) throw new Error(`the keyring run failed: ${run.error ?? run.stderr.slice(-2000)}`);
      const results = JSON.parse(run.stdout.trim().split("\n").pop() ?? "null");
      expect(results).toEqual([
        { error: `Keyring "akmtest" refused the bundle's credential: the password is wrong.`, locked: true },
        { value: "hunter2", locked: false },
      ]);
    } finally {
      home.cleanup();
      runtime.cleanup();
    }
  }, 120_000);
});
