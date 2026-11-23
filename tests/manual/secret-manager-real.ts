// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The scripted run of the keyring and Key Vault bundles against a REAL desktop keyring (Debian 13 + KDE: KWallet) and
 * a REAL Azure Key Vault. It is not part of `bun test`: it touches the machine's Secret Service and an Azure vault, so
 * the owner runs it. Run it from the repository root; it reaches the working tree through `bun src/cli.ts` and keeps
 * akm's own config, data and index in a temporary directory, never in your home.
 *
 *   bun tests/manual/secret-manager-real.ts --keyring <name> --vault <name> [--vault-managed <secret>]
 *   bun tests/manual/secret-manager-real.ts --fake          # the same run against the fake clients (tests/_helpers)
 *
 * `--keyring <name>`: a DEDICATED wallet or keyring made for this run (KWalletManager, Seahorse), whose label is
 * `<name>`. The run stores, locks, unlocks and removes entries in it, and takes the alias `<name>` away and lets akm
 * make it again. Never name the default wallet (`default`, `session`, `kdewallet`, `login`): the run refuses.
 * `--vault <name>`: a Key Vault you may set, delete and purge secrets in, after `az login`.
 * `--vault-managed <secret>`: a secret an Azure service manages in that vault, which must not be listed (one cannot be
 * made by hand, so the step is skipped without it).
 *
 * Every entry the run makes starts with `akm-k-` and is removed at the end, also when a step fails. The "locked wallet"
 * step locks the wallet and then needs you: the keyring manager shows its password prompt, and you answer it within
 * two minutes.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFakeSecretStores } from "../_helpers/fake-secret-stores";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const SERVICE = "org.freedesktop.secrets";
const SERVICE_PATH = "/org/freedesktop/secrets";
const SERVICE_INTERFACE = "org.freedesktop.Secret.Service";
const COLLECTION_INTERFACE = "org.freedesktop.Secret.Collection";
const PROBE = `akm-k-${Math.random().toString(36).slice(2, 8)}`;

interface Options {
  keyring?: string;
  vault?: string;
  vaultManaged?: string;
  fake: boolean;
}

function parseOptions(argv: string[]): Options {
  const options: Options = { fake: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--fake") options.fake = true;
    else if (flag === "--keyring") options.keyring = argv[++i];
    else if (flag === "--vault") options.vault = argv[++i];
    else if (flag === "--vault-managed") options.vaultManaged = argv[++i];
    else throw new Error(`unknown argument ${flag}`);
  }
  if (options.fake) {
    options.keyring ??= "akm-test";
    options.vault ??= "team-vault";
  }
  if (!options.keyring && !options.vault) {
    throw new Error("give --keyring <name>, --vault <name> or both (or --fake)");
  }
  if (options.keyring && ["default", "session", "kdewallet", "login"].includes(options.keyring)) {
    throw new Error(`"${options.keyring}" is a wallet you use: name a dedicated one made for this run`);
  }
  return options;
}

// ── Running programs ────────────────────────────────────────────────────────

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, input = ""): Ran {
  const result = spawnSync(command, args, { encoding: "utf8", env, input, cwd: ROOT });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

class Akm {
  constructor(private readonly env: NodeJS.ProcessEnv) {}
  /** `bun src/cli.ts <args> --format json`, the JSON it printed. */
  json(args: string[], input = ""): { code: number; body: Record<string, unknown>; stderr: string } {
    const ran = run("bun", ["src/cli.ts", ...args, "--format", "json"], this.env, input);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(ran.stdout || ran.stderr) as Record<string, unknown>;
    } catch {
      // Not JSON: the caller reads stderr.
    }
    return { code: ran.status, body, stderr: ran.stderr };
  }
  secretRefs(): string[] {
    const listed = this.json(["secret", "list"]);
    return ((listed.body.secrets ?? []) as Array<{ ref: string }>).map((secret) => secret.ref);
  }
  /** A secret's value, through the same injection a script gets. */
  value(ref: string): string {
    const ran = run("bun", ["src/cli.ts", "exec", "--secret", `${ref}:V`, "--", "printenv", "V"], this.env);
    if (ran.status !== 0) throw new Error(`exec could not read ${ref}: ${ran.stderr.trim() || ran.stdout.trim()}`);
    return ran.stdout.replace(/\n$/, "");
  }
}

// ── The keyring, as another program sees it ─────────────────────────────────

class Keyring {
  constructor(
    private readonly name: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}
  private bus(args: string[]): Ran {
    return run("busctl", ["--user", "--json=short", ...args], this.env);
  }
  private data<T>(ran: Ran, what: string): T {
    if (ran.status !== 0) throw new Error(`busctl ${what}: ${ran.stderr.trim()}`);
    return (JSON.parse(ran.stdout) as { data: T }).data;
  }
  /** The collection's object path: the alias, else the collection labelled `name`. */
  path(): string {
    const [alias] = this.data<[string]>(
      this.bus(["call", SERVICE, SERVICE_PATH, SERVICE_INTERFACE, "ReadAlias", "s", this.name]),
      "ReadAlias",
    );
    if (alias !== "/") return alias;
    const paths = this.data<string[]>(
      this.bus(["get-property", SERVICE, SERVICE_PATH, SERVICE_INTERFACE, "Collections"]),
      "Collections",
    );
    for (const candidate of paths) {
      const label = this.data<string>(
        this.bus(["get-property", SERVICE, candidate, COLLECTION_INTERFACE, "Label"]),
        "Label",
      );
      if (label === this.name) return candidate;
    }
    throw new Error(`no keyring is named or labelled "${this.name}": make a dedicated one in your keyring manager`);
  }
  hasAlias(): boolean {
    return (
      this.data<[string]>(
        this.bus(["call", SERVICE, SERVICE_PATH, SERVICE_INTERFACE, "ReadAlias", "s", this.name]),
        "ReadAlias",
      )[0] !== "/"
    );
  }
  setAlias(on: boolean): void {
    this.data(
      this.bus(["call", SERVICE, SERVICE_PATH, SERVICE_INTERFACE, "SetAlias", "so", this.name, on ? this.path() : "/"]),
      "SetAlias",
    );
  }
  isLocked(): boolean {
    return this.data<boolean>(
      this.bus(["get-property", SERVICE, this.path(), COLLECTION_INTERFACE, "Locked"]),
      "Locked",
    );
  }
  lock(): void {
    this.data(this.bus(["call", SERVICE, SERVICE_PATH, SERVICE_INTERFACE, "Lock", "ao", "1", this.path()]), "Lock");
  }
  /** Store an entry the way another program does: `secret-tool store` with attributes of its own. */
  storeForeign(label: string, value: string, attributes: Record<string, string>): void {
    const pairs = Object.entries({ "akm-probe": PROBE, ...attributes }).flat();
    const ran = run(
      "secret-tool",
      ["store", `--collection=${this.name}`, `--label=${label}`, ...pairs],
      this.env,
      value,
    );
    if (ran.status !== 0) throw new Error(`secret-tool store: ${ran.stderr.trim()}`);
  }
  /** Every entry this run made, found by its probe attribute, whichever program stored it. */
  removeProbeEntries(): void {
    const found = this.bus([
      "call",
      SERVICE,
      SERVICE_PATH,
      SERVICE_INTERFACE,
      "SearchItems",
      "a{ss}",
      "1",
      "akm-probe",
      PROBE,
    ]);
    if (found.status !== 0) return;
    const [unlocked, locked] = (JSON.parse(found.stdout) as { data: [string[], string[]] }).data;
    for (const item of [...unlocked, ...locked])
      this.bus(["call", SERVICE, item, "org.freedesktop.Secret.Item", "Delete"]);
  }
}

// ── Steps ───────────────────────────────────────────────────────────────────

const results: Array<{ name: string; outcome: "PASS" | "FAIL" | "SKIP"; detail: string }> = [];

function step(name: string, body: () => void): void {
  try {
    body();
    results.push({ name, outcome: "PASS", detail: "" });
  } catch (error) {
    results.push({ name, outcome: "FAIL", detail: error instanceof Error ? error.message : String(error) });
  }
  const last = results.at(-1);
  console.log(`${last?.outcome} ${name}${last?.detail ? `\n     ${last.detail.replace(/\n/g, "\n     ")}` : ""}`);
}

function skip(name: string, why: string): void {
  results.push({ name, outcome: "SKIP", detail: why });
  console.log(`SKIP ${name}\n     ${why}`);
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function lintFindings(akm: Akm, bundle: string): Array<{ file: string; issue: string }> {
  const linted = akm.json(["lint"]);
  const flagged = (linted.body.flagged ?? []) as Array<{ file: string; issue: string }>;
  return flagged.filter((issue) => issue.file?.startsWith(`${bundle}//`));
}

function keyringSteps(akm: Akm, keyring: Keyring, options: Options): void {
  const bundle = "keyring";
  const ref = (name: string) => `${bundle}//secrets/${name}`;

  step("keyring: the wallet is there, and an alias makes `secret-tool store` reach it", () => {
    keyring.path();
    if (!keyring.hasAlias()) keyring.setAlias(true);
    expect(keyring.hasAlias(), "the alias could not be made");
  });

  step("keyring: secret set, list, read and remove", () => {
    const name = `${PROBE}-basic`;
    expect(akm.json(["secret", "set", ref(name)], "value-one\n").code === 0, "secret set failed");
    expect(akm.secretRefs().includes(ref(name)), "secret list does not name the secret");
    expect(akm.value(ref(name)) === "value-one", "the value read is not the value set");
    expect(
      akm.json(["secret", "set", ref(name)], "value-two\n").code === 0,
      "secret set over an existing secret failed",
    );
    expect(akm.value(ref(name)) === "value-two", "the secret was not replaced");
    expect(akm.json(["secret", "remove", ref(name), "--yes"]).code === 0, "secret remove failed");
    expect(!akm.secretRefs().includes(ref(name)), "the removed secret is still listed");
  });

  step("keyring: an entry another program made is listed and read", () => {
    keyring.storeForeign(`${PROBE}-foreign`, "from-elsewhere", { app: "other-program" });
    expect(akm.secretRefs().includes(ref(`${PROBE}-foreign`)), "the foreign entry is not listed");
    expect(akm.value(ref(`${PROBE}-foreign`)) === "from-elsewhere", "the foreign entry's value is wrong");
  });

  step("keyring: a name two entries share has one winner, and lint reports the other", () => {
    keyring.storeForeign(`${PROBE}-dup`, "first", { app: "one" });
    keyring.storeForeign(`${PROBE}-dup`, "second", { app: "two" });
    const listed = akm.secretRefs().filter((entry) => entry === ref(`${PROBE}-dup`));
    expect(listed.length === 1, `the shared name is listed ${listed.length} times`);
    const found = lintFindings(akm, bundle).filter((issue) => issue.issue === "shadowed-spelling");
    expect(
      found.some((issue) => issue.file === ref(`${PROBE}-dup`)),
      "lint does not report the shared name",
    );
  });

  step("keyring: a label that is no valid name is not listed, and lint reports it", () => {
    keyring.storeForeign(`${PROBE}#bad`, "x", { app: "bad" });
    expect(!akm.secretRefs().some((entry) => entry.includes("#bad")), "the invalid label is listed");
    const found = lintFindings(akm, bundle);
    expect(
      found.some((issue) => issue.file === ref(`${PROBE}#bad`)),
      "lint does not report the invalid label",
    );
  });

  step("keyring: a locked wallet asks to be unlocked, then lists", () => {
    keyring.lock();
    expect(keyring.isLocked(), "the wallet did not lock");
    console.log(
      options.fake
        ? "     (the fake keyring answers its own prompt)"
        : `     Answer the keyring manager's password prompt for "${options.keyring}" within two minutes.`,
    );
    expect(akm.secretRefs().includes(ref(`${PROBE}-foreign`)), "the secrets are not listed after the unlock");
    expect(!keyring.isLocked(), "the wallet is still locked");
  });

  step(
    "keyring: a wallet with no alias is found by its label, untouched by a read, and aliased by the first write",
    () => {
      keyring.setAlias(false);
      expect(!keyring.hasAlias(), "the alias could not be taken away");
      expect(akm.secretRefs().includes(ref(`${PROBE}-foreign`)), "a wallet only its label names is not found");
      expect(!keyring.hasAlias(), "reading made the alias");
      const name = `${PROBE}-aliased`;
      expect(akm.json(["secret", "set", ref(name)], "v\n").code === 0, "secret set failed");
      expect(keyring.hasAlias(), "the first write did not make the alias");
      expect(akm.value(ref(name)) === "v", "the secret written next to the new alias is wrong");
      akm.json(["secret", "remove", ref(name), "--yes"]);
    },
  );
}

function vaultSteps(akm: Akm, options: Options, env: NodeJS.ProcessEnv): void {
  const bundle = "vault";
  const ref = (name: string) => `${bundle}//secrets/${name}`;
  const az = (...args: string[]) =>
    run("az", ["keyvault", "secret", ...args, "--vault-name", options.vault as string], env);

  step("vault: secret set, list, read and remove", () => {
    const name = `${PROBE}-basic`;
    expect(akm.json(["secret", "set", ref(name)], "vault-one\n").code === 0, "secret set failed");
    expect(akm.secretRefs().includes(ref(name)), "secret list does not name the secret");
    expect(akm.value(ref(name)) === "vault-one", "the value read is not the value set");
    expect(akm.json(["secret", "remove", ref(name), "--yes"]).code === 0, "secret remove failed");
    expect(!akm.secretRefs().includes(ref(name)), "the removed secret is still listed");
  });

  step("vault: remove purges, so the same name can be set again at once", () => {
    const name = `${PROBE}-again`;
    expect(akm.json(["secret", "set", ref(name)], "one\n").code === 0, "the first secret set failed");
    expect(akm.json(["secret", "remove", ref(name), "--yes"]).code === 0, "secret remove failed");
    const again = akm.json(["secret", "set", ref(name)], "two\n");
    expect(again.code === 0, `setting the removed name again failed: ${JSON.stringify(again.body)}`);
    expect(akm.value(ref(name)) === "two", "the secret set again has the wrong value");
    akm.json(["secret", "remove", ref(name), "--yes"]);
  });

  step("vault: a disabled secret is not listed", () => {
    const name = `${PROBE}-disabled`;
    expect(az("set", "--name", name, "--value", "x", "--output", "none").status === 0, "az could not set the secret");
    expect(
      az("set-attributes", "--name", name, "--enabled", "false", "--output", "none").status === 0,
      "az could not disable it",
    );
    expect(!akm.secretRefs().includes(ref(name)), "the disabled secret is listed");
    az("delete", "--name", name, "--output", "none");
    az("purge", "--name", name, "--output", "none");
  });

  if (options.vaultManaged) {
    step("vault: a managed secret is not listed", () => {
      expect(!akm.secretRefs().includes(ref(options.vaultManaged as string)), "the managed secret is listed");
    });
  } else {
    skip("vault: a managed secret is not listed", "pass --vault-managed <secret>: one cannot be made by hand");
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(options: Options, clientEnv: NodeJS.ProcessEnv): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "akm-k-real-"));
  const stash = path.join(home, "stash");
  fs.mkdirSync(stash, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...clientEnv,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    AKM_STASH_DIR: stash,
  };
  const configFile = path.join(env.XDG_CONFIG_HOME as string, "akm", "config.json");
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      experimental: { exec: true },
      defaultBundle: "stash",
      bundles: {
        stash: { path: stash, adapter: "akm", writable: true },
        ...(options.keyring ? { keyring: { adapter: "secret-tool", location: options.keyring } } : {}),
        ...(options.vault ? { vault: { adapter: "azure-key-vault", location: options.vault } } : {}),
      },
    }),
  );
  console.log(`akm run in ${home} (a throwaway config; your own is not touched); probes are named ${PROBE}-*\n`);
  const akm = new Akm(env);
  const keyring = options.keyring ? new Keyring(options.keyring, env) : undefined;
  try {
    if (keyring) keyringSteps(akm, keyring, options);
    if (options.vault) vaultSteps(akm, options, env);
  } finally {
    keyring?.removeProbeEntries();
    if (keyring && options.fake === false)
      console.log(`\nEntries named ${PROBE}-* were removed from "${options.keyring}".`);
    fs.rmSync(home, { recursive: true, force: true });
  }
  const failed = results.filter((result) => result.outcome === "FAIL").length;
  const skipped = results.filter((result) => result.outcome === "SKIP").length;
  console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
  process.exitCode = failed === 0 ? 0 : 1;
}

const options = parseOptions(process.argv.slice(2));
if (options.fake) {
  await withFakeSecretStores(
    {
      keyrings: options.keyring ? { [options.keyring]: [] } : {},
      vaults: options.vault ? { [options.vault]: {} } : {},
    },
    () => main(options, process.env),
  );
} else {
  await main(options, process.env);
}
