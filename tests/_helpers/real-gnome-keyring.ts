// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Run inside `dbus-run-session`, with HOME and the XDG directories of a test's sandbox: start a gnome-keyring of its
 * own, create the keyring `akmtest` with the password in `AKM_TEST_KEYRING_PASSWORD` and one entry, lock it, then read
 * the entry through akm's `keyring` bundle (`credential: "$AKM_TEST_KEYRING_ATTEMPT"`), once with each password
 * `AKM_TEST_KEYRING_ATTEMPTS` lists (JSON). Prints, as JSON, what each read returned or failed with, and whether the
 * keyring was locked after it.
 */

import { spawn, spawnSync } from "node:child_process";
import { resolveInjectionRefs } from "../../src/commands/env/injection";
import { clearAdapterCaches } from "../../src/core/adapter/registry";
import { akmIndex } from "../../src/indexer/indexer";
import { connect, Writer } from "./dbus-wire";

const SERVICE = "org.freedesktop.secrets";
const SERVICE_PATH = "/org/freedesktop/secrets";
const password = process.env.AKM_TEST_KEYRING_PASSWORD as string;
const attempts = JSON.parse(process.env.AKM_TEST_KEYRING_ATTEMPTS as string) as string[];

const daemon = spawn("gnome-keyring-daemon", ["--foreground", "--components=secrets"], { stdio: "ignore" });
const address = process.env.DBUS_SESSION_BUS_ADDRESS as string;
const socket = address.includes("abstract=")
  ? `\0${/abstract=([^,;]+)/.exec(address)?.[1]}`
  : (/path=([^,;]+)/.exec(address)?.[1] as string);
const bus = await connect(socket);
try {
  for (let tries = 0; ; tries++) {
    const owned = await bus.call(
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "NameHasOwner",
      "s",
      new Writer().string(SERVICE).buffer(),
    );
    if (owned.body.uint32() === 1) break;
    if (tries > 100) throw new Error("gnome-keyring-daemon did not take the Secret Service name");
    await Bun.sleep(100);
  }
  const opened = await bus.call(
    SERVICE,
    SERVICE_PATH,
    "org.freedesktop.Secret.Service",
    "OpenSession",
    "sv",
    new Writer().string("plain").signature("s").string("").buffer(),
  );
  opened.body.signature();
  opened.body.string();
  const session = opened.body.string();
  const created = await bus.call(
    SERVICE,
    SERVICE_PATH,
    "org.gnome.keyring.InternalUnsupportedGuiltRiddenInterface",
    "CreateWithMasterPassword",
    "a{sv}(oayays)",
    new Writer()
      .array(8, (w) => w.pad(8).string("org.freedesktop.Secret.Collection.Label").signature("s").string("akmtest"))
      .secret(session, Buffer.from(password))
      .buffer(),
  );
  const collection = created.body.string();
  const stored = spawnSync(
    "secret-tool",
    ["store", `--collection=${collection}`, "--label=wifi", "akm", "akmtest/wifi"],
    {
      input: "hunter2",
      encoding: "utf8",
    },
  );
  if (stored.status !== 0) throw new Error(`secret-tool store failed: ${stored.stderr}`);
  await bus.call(
    SERVICE,
    SERVICE_PATH,
    "org.freedesktop.Secret.Service",
    "Lock",
    "ao",
    new Writer().array(4, (w) => w.string(collection)).buffer(),
  );
  const locked = () =>
    JSON.parse(
      spawnSync(
        "busctl",
        ["--user", "--json=short", "get-property", SERVICE, collection, "org.freedesktop.Secret.Collection", "Locked"],
        { encoding: "utf8" },
      ).stdout,
    ).data as boolean;

  await akmIndex({ stashDir: process.env.AKM_BUNDLE_DIR as string, full: true });
  const results: Array<{ value?: string; error?: string; locked: boolean }> = [];
  for (const attempt of attempts) {
    clearAdapterCaches();
    process.env.AKM_TEST_KEYRING_ATTEMPT = attempt;
    try {
      results.push({
        value: resolveInjectionRefs({ secret: ["keyring//secrets/wifi:WIFI"] }).values.WIFI,
        locked: locked(),
      });
    } catch (error) {
      results.push({ error: (error as Error).message, locked: locked() });
    }
  }
  process.stdout.write(`${JSON.stringify(results)}\n`);
} finally {
  bus.close();
  daemon.kill();
}
process.exit(0);
