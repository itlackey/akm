// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm migrate apply`'s key step. akm reads a key from a `$VAR` reference or
 * from `credentials.json`, nowhere else. The keys a config still holds in any
 * other form are read once, filed in `credentials.json` for the block they
 * belong to (a connection, or the `embedding` or `curateRerank` service) and the
 * endpoint that block names, and removed from the document:
 *
 *   - an engine's `apiKeyFile`, a literal `apiKey` or a `${secrets/...}` one,
 *     which the conversion to a connection cannot carry;
 *   - the same literal or secret-store `apiKey` on a connection, `embedding` or
 *     `search.curateRerank` that the file already says in the current form.
 *
 * A key that cannot be read, whose block names no endpoint to file it for, whose
 * engine wrote it for another endpoint than the connection now names (the file's
 * current-form entries overlay the converted engine), or whose slot
 * `credentials.json` already holds a different key or endpoint for, is not moved. It stays in the file: on the block that held
 * it, or, for an engine's `apiKey`, put back on the connection as `apiKey`
 * exactly as it was, so the rewrite never leaves it in the backups alone (akm
 * ignores a key held there, with a warning, until it is moved). An engine's
 * `apiKeyFile` is the exception: it names a file, not a key, and a connection
 * cannot hold it (an unowned key is sent as a request field), so a note names
 * the path. A note names the key's place and its entry, never its value.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "../common";
import { sameEndpoint } from "../endpoint-url";
import { redactUrlCredentials } from "../redaction";
import { isSecretRefToken } from "../ref-token";
import type { ConvertEnginesResult } from "./convert-engines";
import { type CredentialSlot, slotStanding } from "./credentials";
import { isEnvReference } from "./schema/primitives";

type Dict = Record<string, unknown>;

export interface MovedKey {
  /** The `credentials.json` entry, and the endpoint it is filed for. */
  readonly slot: CredentialSlot;
  readonly endpoint: string;
  /** The block's name, for the note that reports the move. */
  readonly name: string;
  readonly value: string;
  /** Where the config held it, as a key path. */
  readonly from: string;
}

export interface KeyMovePlan {
  /** The converted document without the keys that will be moved. */
  readonly config: Dict;
  readonly moves: readonly MovedKey[];
  readonly notes: readonly string[];
}

export interface KeyMoveOptions {
  /** The value a `${secrets/...}` reference names; absent or throwing means it cannot be resolved here. */
  readonly resolveSecretRef?: (ref: string) => string | undefined;
}

/** An `apiKeyFile`'s key: the file's contents less one trailing newline, `~` expanded as it always was. */
function readKeyFile(file: string): string | undefined {
  try {
    const expanded = file.startsWith("~") ? path.join(os.homedir(), file.slice(1)) : file;
    return fs.readFileSync(expanded, "utf8").replace(/\r?\n$/, "") || undefined;
  } catch {
    return undefined;
  }
}

/** A key held in the config itself: the literal, or the secret it references. */
function heldValue(value: string, options: KeyMoveOptions): string | undefined {
  if (!isSecretRefToken(value)) return value;
  try {
    return options.resolveSecretRef?.(value) || undefined;
  } catch {
    return undefined;
  }
}

interface Candidate {
  readonly name: string;
  readonly slot: CredentialSlot;
  /** The endpoint of the block the key belongs to; none, and the key cannot be filed. */
  readonly endpoint: string | undefined;
  /** The endpoint the key was written for, when its source says one: an engine's own, read before anything the file says in the current form overlaid it. */
  readonly owner?: string | undefined;
  readonly from: string;
  /** The value, or why there is none. */
  readonly read: () => string | undefined;
  /** What it was read from, for a note when it cannot be. */
  readonly source: string;
  /** Remove it from the document, once it is filed. */
  readonly remove?: () => void;
  /** Put it back on the connection, when it is not filed: the conversion did not carry it. */
  readonly restore?: () => void;
  /** Where it stays when it is not filed, for the note: on the connection as the key it was, or where the document holds it. */
  readonly stays: string;
}

/** The keys of the converted document that are not `$VAR` references. */
function documentCandidates(config: Dict, options: KeyMoveOptions): Candidate[] {
  const blocks: Array<{ name: string; slot: CredentialSlot; from: string; block: Dict }> = [];
  if (isRecord(config.connections)) {
    for (const [name, block] of Object.entries(config.connections)) {
      if (isRecord(block)) blocks.push({ name, slot: { connection: name }, from: `connections.${name}.apiKey`, block });
    }
  }
  const search = isRecord(config.search) ? config.search : {};
  if (isRecord(config.embedding)) {
    blocks.push({
      name: "embedding",
      slot: { service: "embedding" },
      from: "embedding.apiKey",
      block: config.embedding,
    });
  }
  if (isRecord(search.curateRerank)) {
    blocks.push({
      name: "curateRerank",
      slot: { service: "curateRerank" },
      from: "search.curateRerank.apiKey",
      block: search.curateRerank,
    });
  }
  return blocks.flatMap(({ name, slot, from, block }) => {
    const endpoint = typeof block.endpoint === "string" ? block.endpoint : undefined;
    const found: Candidate[] = [];
    const apiKey = block.apiKey;
    if (typeof apiKey === "string" && !isEnvReference(apiKey)) {
      found.push({
        name,
        slot,
        endpoint,
        from,
        read: () => heldValue(apiKey, options),
        source: isSecretRefToken(apiKey) ? "the secret store reference" : "the literal key",
        remove: () => {
          delete block.apiKey;
        },
        stays: "in the file",
      });
    }
    // A key file an earlier run could not read is still named here, so a later run can move its key.
    const keyFile = block.apiKeyFile;
    if (typeof keyFile === "string" && "connection" in slot) {
      found.push({
        name,
        slot,
        endpoint,
        from: from.replace(/apiKey$/, "apiKeyFile"),
        read: () => readKeyFile(keyFile),
        source: `its key file ${keyFile}`,
        remove: () => {
          delete block.apiKeyFile;
        },
        stays: "in the file",
      });
    }
    return found;
  });
}

/** The endpoint the document gives the block that `slot` stands for, if it gives one. */
export function documentEndpoint(config: Dict, slot: CredentialSlot): string | undefined {
  const search = isRecord(config.search) ? config.search : {};
  const block =
    "connection" in slot
      ? isRecord(config.connections)
        ? config.connections[slot.connection]
        : undefined
      : slot.service === "embedding"
        ? config.embedding
        : search.curateRerank;
  return isRecord(block) && typeof block.endpoint === "string" ? block.endpoint : undefined;
}

/** The keys the conversion could not carry from an engine, read from the original document. */
function engineCandidates(
  original: Dict,
  converted: ConvertEnginesResult,
  config: Dict,
  options: KeyMoveOptions,
): Candidate[] {
  const engines = isRecord(original.engines) ? original.engines : {};
  return converted.keys.flatMap(({ engine, connection, field }) => {
    const source = isRecord(engines[engine]) ? (engines[engine] as Dict) : {};
    const held = source[field];
    if (typeof held !== "string") return [];
    const owner = typeof source.endpoint === "string" ? source.endpoint : undefined;
    if (field === "apiKeyFile") {
      return [
        {
          name: connection,
          slot: { connection },
          endpoint: documentEndpoint(config, { connection }),
          owner,
          from: `engines.${engine}.${field}`,
          read: () => readKeyFile(held),
          source: `its key file ${held}`,
          restore: () => {
            const block = isRecord(config.connections) ? config.connections[connection] : undefined;
            if (isRecord(block)) block.apiKeyFile = held;
          },
          stays: "on the connection as apiKeyFile",
        },
      ];
    }
    return [
      {
        name: connection,
        slot: { connection },
        endpoint: documentEndpoint(config, { connection }),
        owner,
        from: `engines.${engine}.${field}`,
        read: () => heldValue(held, options),
        source: isSecretRefToken(held) ? `the secret store reference ${held}` : "the literal key",
        restore: () => {
          const block = isRecord(config.connections) ? config.connections[connection] : undefined;
          if (isRecord(block)) block.apiKey = held;
        },
        stays: "on the connection as apiKey",
      },
    ];
  });
}

export function planKeyMoves(
  original: Dict,
  converted: ConvertEnginesResult,
  options: KeyMoveOptions = {},
): KeyMovePlan {
  const config = structuredClone(converted.config);
  const planned = new Map<string, MovedKey>();
  const moves: MovedKey[] = [];
  const notes: string[] = [];
  for (const candidate of [
    ...engineCandidates(original, converted, config, options),
    ...documentCandidates(config, options),
  ]) {
    const stays = ` It stays ${candidate.stays}.`;
    const { owner } = candidate;
    if (owner !== undefined && candidate.endpoint !== undefined && !sameEndpoint(owner, candidate.endpoint)) {
      candidate.restore?.();
      notes.push(
        `${candidate.from}: this key was written for ${redactUrlCredentials(owner)}, and the file now gives "${candidate.name}" ${redactUrlCredentials(candidate.endpoint)}, so no key moves and it is not sent there.${stays} Store a key for the new endpoint with \`akm setup\`.`,
      );
      continue;
    }
    const value = candidate.read();
    if (value === undefined) {
      candidate.restore?.();
      notes.push(
        `${candidate.from}: ${candidate.source} could not be read, so no key moves and this is still to do.${stays} A later \`akm migrate apply\` moves it once it can be read.`,
      );
      continue;
    }
    const { endpoint } = candidate;
    if (endpoint === undefined) {
      candidate.restore?.();
      notes.push(
        `${candidate.from}: the block names no endpoint of its own, so its key cannot be filed for one and no key moves.${stays} Store it for the endpoint that serves it with \`akm setup\`.`,
      );
      continue;
    }
    const slotKey = JSON.stringify(candidate.slot);
    const earlier = planned.get(slotKey);
    const standing = slotStanding(
      candidate.slot,
      value,
      endpoint,
      earlier && { key: earlier.value, endpoint: earlier.endpoint },
    );
    if (standing === "different") {
      candidate.restore?.();
      notes.push(
        `${candidate.from}: credentials.json already holds a different key or endpoint for "${candidate.name}"; it is not replaced.${stays}`,
      );
      continue;
    }
    const move: MovedKey = { slot: candidate.slot, endpoint, name: candidate.name, value, from: candidate.from };
    planned.set(slotKey, move);
    moves.push(move);
    notes.push(
      `${candidate.from}: its key moves to credentials.json for "${candidate.name}" at ${redactUrlCredentials(endpoint)}.`,
    );
    candidate.remove?.();
  }
  return { config, moves, notes };
}
