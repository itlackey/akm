// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * API keys akm holds for the user: `<configDir>/credentials.json` (0600).
 *
 *     { "connections": { "<name>": { "key": "…", "endpoint": "…" } },
 *       "services":    { "embedding": { "key": "…", "endpoint": "…" },
 *                        "curateRerank": { … } } }
 *
 * A key is stored for one endpoint and is read for that endpoint alone: the
 * entry records the endpoint it was stored for, and a block whose endpoint is
 * now another gets no key, with a word saying so. Only the connections this
 * host's own config file defines have a stored key: one that only an `extends`
 * base defines gets none, whatever the store holds under its name. A connection's name and a
 * service's slot are different namespaces, so a connection called `embedding`
 * and the embedding service hold different keys. A block whose `apiKey` is a
 * `$VAR` reference reads that variable and never touches this file. The bundle's
 * `secrets/` store is for secrets the user's own agents need and has nothing to
 * do with these.
 */
import fs from "node:fs";
import path from "node:path";
import { isRecord, writeFileAtomic } from "../common";
import { sameEndpoint } from "../endpoint-url";
import { ConfigError } from "../errors";
import { getConfigDir } from "../paths";
import { collectSensitiveValues, redactUrlCredentials } from "../redaction";
import { warnOnce } from "../warn";
import { isInheritedConnection } from "./config";
import { copyToConfigBackups } from "./config-io";
import type { AkmConfig } from "./config-types";
import { envReferenceName, isEnvReference } from "./schema/primitives";

/** Where a key is stored: a connection, by its name, or one of the two services that have an endpoint of their own. */
export type CredentialSlot = { readonly connection: string } | { readonly service: "embedding" | "curateRerank" };

/** A key and the endpoint it was stored for. */
export interface StoredCredential {
  readonly key: string;
  readonly endpoint: string;
}

const NAMESPACES = ["connections", "services"] as const;

function storePath(): string {
  return path.join(getConfigDir(), "credentials.json");
}

function namespaceOf(slot: CredentialSlot): { group: (typeof NAMESPACES)[number]; name: string } {
  return "connection" in slot
    ? { group: "connections", name: slot.connection }
    : { group: "services", name: slot.service };
}

function describeSlot(slot: CredentialSlot): string {
  return "connection" in slot ? `connection "${slot.connection}"` : `the ${slot.service} service`;
}

/** What is wrong with the store, if anything: it cannot be read, or it is not a JSON object. */
type StoreRead = { readonly entries: Record<string, unknown> } | { readonly problem: string };

/** The stored entries; an absent file holds none. */
function readStore(): StoreRead {
  let text: string;
  try {
    text = fs.readFileSync(storePath(), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { entries: {} }
      : { problem: `${storePath()} cannot be read (${code ?? "unknown error"})` };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) return { entries: parsed };
  } catch {
    // Falls through: not JSON is not a JSON object.
  }
  return { problem: `${storePath()} is not a JSON object` };
}

function writeStore(entries: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true, mode: 0o700 });
  writeFileAtomic(storePath(), `${JSON.stringify(entries, null, 2)}\n`, 0o600);
}

/** The group of entries (`connections` or `services`) a store holds; anything else there is not one. */
function groupOf(entries: Record<string, unknown>, group: (typeof NAMESPACES)[number]): Record<string, unknown> {
  const held = entries[group];
  return isRecord(held) ? held : {};
}

/** Whether a stored value is the current shape of an entry. */
function isStoredCredential(value: unknown): value is StoredCredential {
  return isRecord(value) && typeof value.key === "string" && typeof value.endpoint === "string";
}

/**
 * The stored entry for `slot`, if the store has one in the current shape. One
 * the store has in any other shape (the flat `{ "<name>": "<key>" }` an earlier
 * build wrote, which names no endpoint) is named once and ignored: `akm migrate
 * apply` files it under the endpoint it belongs to.
 */
export function storedCredential(slot: CredentialSlot): StoredCredential | undefined {
  const store = readStore();
  if ("problem" in store) {
    warnOnce(`credentials:unusable:${storePath()}`, `${store.problem}; ignoring it.`);
    return undefined;
  }
  const { group, name } = namespaceOf(slot);
  const held = groupOf(store.entries, group)[name];
  if (held === undefined) {
    const flat = store.entries[name];
    if (typeof flat === "string") {
      warnOnce(
        `credentials:flat:${storePath()}:${name}`,
        `${storePath()}: the key "${name}" is in the older form, which names no endpoint, so it is not used; \`akm migrate apply\` files it under the endpoint it belongs to.`,
      );
    }
    return undefined;
  }
  if (!isStoredCredential(held)) {
    warnOnce(
      `credentials:malformed:${storePath()}:${group}:${name}`,
      `${storePath()}: the entry for ${describeSlot(slot)} is not { "key": "…", "endpoint": "…" }; ignoring it.`,
    );
    return undefined;
  }
  return held;
}

/**
 * The key stored for `slot` and `endpoint`. A key stored for another endpoint is
 * not read: it is named once, without its value, and the block goes without.
 * `storedKey` is a connection's eligibility already decided (a runner carries it);
 * absent, the config on this host decides now.
 */
export function readCredential(slot: CredentialSlot, endpoint: string, storedKey?: boolean): string | undefined {
  if ("connection" in slot) {
    const eligible = storedKey ?? !isInheritedConnection(slot.connection);
    if (!eligible) return undefined;
  }
  const held = storedCredential(slot);
  if (!held) return undefined;
  if (!sameEndpoint(held.endpoint, endpoint)) {
    const shownHeld = redactUrlCredentials(held.endpoint);
    const shownNow = redactUrlCredentials(endpoint);
    warnOnce(
      `credentials:endpoint:${storePath()}:${describeSlot(slot)}:${shownHeld}:${shownNow}`,
      `The key stored for ${describeSlot(slot)} belongs to ${shownHeld}, not ${shownNow}, so it is not sent there. Store a key for the new endpoint with \`akm setup\`.`,
    );
    return undefined;
  }
  return held.key || undefined;
}

function writableStore(): Record<string, unknown> {
  const store = readStore();
  if ("problem" in store) throw new ConfigError(`${store.problem}; refusing to overwrite it.`, "INVALID_CONFIG_FILE");
  return store.entries;
}

/**
 * Store `key` for `slot` and `endpoint`, keeping every other entry as it is. A root
 * `connections` or `services` that is not an object is a key of the older flat form
 * (a connection of that name) in the namespace's place: it is kept, and the write stops,
 * because the write would replace it. `akm migrate apply` files it under its endpoint.
 */
export function writeCredential(slot: CredentialSlot, key: string, endpoint: string): void {
  const entries = writableStore();
  const { group, name } = namespaceOf(slot);
  const root = entries[group];
  if (root !== undefined && !isRecord(root)) {
    throw new ConfigError(
      `${storePath()}: "${group}" holds ${typeof root === "string" ? "a key in the older form" : "something that is not an object"}, which is where the ${group} are stored, so ${describeSlot(slot)} cannot be stored beside it; refusing to overwrite it. ${typeof root === "string" ? "`akm migrate apply` files it under its endpoint; then store this key again." : "Fix the file, then store this key again."}`,
      "INVALID_CONFIG_FILE",
    );
  }
  writeStore({ ...entries, [group]: { ...groupOf(entries, group), [name]: { key, endpoint } } });
}

/** The entries the store holds in the current shape, by slot, whatever endpoint each is stored for. */
export function storedCredentials(): Array<{ slot: CredentialSlot; credential: StoredCredential }> {
  const store = readStore();
  if ("problem" in store) return [];
  return NAMESPACES.flatMap((group) =>
    Object.entries(groupOf(store.entries, group)).flatMap(([name, held]) =>
      isStoredCredential(held)
        ? [
            {
              slot: group === "connections" ? { connection: name } : { service: name as "embedding" | "curateRerank" },
              credential: held,
            },
          ]
        : [],
    ),
  );
}

/** What `slot` holds against a key a migration would file there. */
export type SlotStanding = "free" | "same" | "different";

/**
 * Every migration into a credential slot asks this one question. An empty slot is
 * `free`; one holding exactly this key for this endpoint is `same` (filing it again
 * changes nothing); anything else, a malformed entry included, is `different`, and
 * is never replaced: the migration leaves both and says so. `ahead` is the entry the
 * same migration has already planned for the slot, which stands in for the store's.
 */
export function slotStanding(
  slot: CredentialSlot,
  key: string,
  endpoint: string,
  ahead?: { readonly key: string; readonly endpoint: string },
): SlotStanding {
  let held: unknown = ahead;
  if (held === undefined) {
    const store = readStore();
    // An unusable store is not a conflict: it refuses every write, which stops the migration with nothing lost.
    if ("problem" in store) return "free";
    const { group, name } = namespaceOf(slot);
    held = groupOf(store.entries, group)[name];
  }
  if (held === undefined) return "free";
  return isStoredCredential(held) && held.key === key && sameEndpoint(held.endpoint, endpoint) ? "same" : "different";
}

/**
 * File every key the store holds in the older flat `{ "<name>": "<key>" }` form under
 * the endpoint of the block it belongs to, as `endpointOf` says: a name that is a
 * connection's, or `curateRerank`, or `embedding` (the service's, or a connection
 * called that: one of the two must have an endpoint, or it is not filed). `pending` is
 * what the same migration is about to file in the current form, which a flat key is
 * measured against like the store's own entries ({@link slotStanding}): a slot that
 * already holds the same key for the same endpoint just drops the older entry, and one
 * that holds anything else keeps the older entry, with a note. An entry that cannot be
 * filed stays as it is, and a note says why. Writes only when `apply`, after copying
 * the store to the config-backups directory (`backupPath`).
 */
export function fileFlatCredentials(
  endpointOf: (slot: CredentialSlot) => string | undefined,
  apply: boolean,
  pending: ReadonlyArray<{ readonly slot: CredentialSlot; readonly value: string; readonly endpoint: string }> = [],
): { readonly filed: readonly string[]; readonly notes: readonly string[]; readonly backupPath?: string } {
  const store = readStore();
  if ("problem" in store) return { filed: [], notes: [`${store.problem}; its keys were not filed.`] };
  const entries = { ...store.entries };
  const filed: string[] = [];
  const notes: string[] = [];
  // A key called `connections` or `services` is told from the namespace of that name by its shape: a string. It sits
  // where the namespace goes, so it is filed first, and until it is, no other key can be filed into that namespace.
  const rank = (name: string): number => {
    const index = (NAMESPACES as readonly string[]).indexOf(name);
    return index < 0 ? NAMESPACES.length : index;
  };
  for (const name of Object.keys(store.entries).sort((a, b) => rank(a) - rank(b))) {
    const value = store.entries[name];
    if (typeof value !== "string") continue;
    const slots: CredentialSlot[] =
      name === "curateRerank"
        ? [{ service: "curateRerank" }]
        : name === "embedding"
          ? [{ service: "embedding" }, { connection: name }]
          : [{ connection: name }];
    const homes = slots.flatMap((slot) => {
      const endpoint = endpointOf(slot);
      return endpoint === undefined ? [] : [{ slot, endpoint }];
    });
    const home = homes[0];
    if (homes.length !== 1 || home === undefined) {
      notes.push(
        homes.length > 1
          ? `credentials.json: the key "${name}" could belong to the embedding service or to the connection of that name; store it again with \`akm setup\`. It stays as it is.`
          : `credentials.json: the key "${name}" belongs to no block this config gives an endpoint, so it cannot be bound to one. It stays as it is.`,
      );
      continue;
    }
    const { group, name: slotName } = namespaceOf(home.slot);
    if (name !== group && entries[group] !== undefined && !isRecord(entries[group])) {
      notes.push(
        `credentials.json: the key "${name}" cannot be filed while the key "${group}" in the older form holds the place the ${group} go. It stays as it is; give the block called "${group}" an endpoint so it can be filed first, or remove it.`,
      );
      continue;
    }
    const ahead = pending.find((move) => JSON.stringify(move.slot) === JSON.stringify(home.slot));
    const standing = slotStanding(
      home.slot,
      value,
      home.endpoint,
      ahead && { key: ahead.value, endpoint: ahead.endpoint },
    );
    if (standing === "different") {
      notes.push(
        `credentials.json: ${describeSlot(home.slot)} already holds a different key or endpoint than the older entry "${name}"; neither is replaced. Remove the older entry when the stored one is the key you want.`,
      );
      continue;
    }
    if (standing === "free" || name === group) {
      entries[group] = { ...groupOf(entries, group), [slotName]: { key: value, endpoint: home.endpoint } };
    }
    // The key called like its own namespace has just become that namespace's child, in the same place.
    if (name !== group) delete entries[name];
    filed.push(name);
    notes.push(
      standing === "free"
        ? `credentials.json: the key "${name}" is filed for ${describeSlot(home.slot)} at ${redactUrlCredentials(home.endpoint)}.`
        : `credentials.json: the key "${name}" is already stored for ${describeSlot(home.slot)} at ${redactUrlCredentials(home.endpoint)}; the older entry is removed.`,
    );
  }
  if (!apply || filed.length === 0) return { filed, notes };
  const backupPath = copyToConfigBackups(storePath(), (stamp) => `credentials.json.${stamp}`);
  writeStore(entries);
  return { filed, notes, backupPath };
}

/**
 * The key of the block stored in `slot`, whose config `apiKey` is `apiKey` and
 * whose endpoint is `endpoint`: the variable it references, else the key stored
 * for that endpoint. An unset variable is named once and sends no key. `quiet`
 * is for callers that only collect values to redact; `storedKey` is as for
 * {@link readCredential}.
 */
export function resolveApiKey(
  apiKey: string | undefined,
  slot: CredentialSlot,
  endpoint: string,
  env: NodeJS.ProcessEnv = process.env,
  quiet = false,
  storedKey?: boolean,
): string | undefined {
  const variable = apiKey === undefined ? undefined : envReferenceName(apiKey);
  if (variable === undefined) return readCredential(slot, endpoint, storedKey);
  const value = env[variable]?.trim();
  if (!value && !quiet) {
    warnOnce(
      `credentials:env-unset:${variable}`,
      `Environment variable ${variable} referenced by an apiKey is unset or empty; requests are sent without a key.`,
    );
  }
  return value || undefined;
}

/**
 * The `$VAR` reference an `apiKey` holds. Anything else in that field is a key
 * the user left in the file, which akm never reads or sends and never passes on.
 */
export function apiKeyReference(apiKey: string | undefined): string | undefined {
  return apiKey !== undefined && isEnvReference(apiKey) ? apiKey : undefined;
}

/**
 * Every key akm could send or has been given, for redaction: whatever the store
 * holds, the variables the config's blocks reference, and any key left in the
 * file as written.
 */
export function collectCredentialValues(
  config: Pick<AkmConfig, "connections" | "embedding" | "search">,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const blocks: Array<{ apiKey?: string } | undefined> = [
    ...Object.values(config.connections ?? {}),
    config.embedding,
    config.search?.curateRerank,
  ];
  return collectSensitiveValues([
    ...storedCredentials().map(({ credential }) => credential.key),
    ...blocks.flatMap((block) => {
      const variable = block?.apiKey === undefined ? undefined : envReferenceName(block.apiKey);
      return [
        variable === undefined ? undefined : env[variable]?.trim(),
        apiKeyReference(block?.apiKey) === undefined ? block?.apiKey : undefined,
      ];
    }),
  ]);
}
