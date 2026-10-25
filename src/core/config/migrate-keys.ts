// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm migrate apply`'s key step. akm reads a key from a `$VAR` reference or
 * from `credentials.json`, nowhere else. The keys a config still holds in any
 * other form are read once, filed in `credentials.json` under the name of the
 * block they belong to (a connection's name, `embedding`, `curateRerank`) and
 * removed from the document:
 *
 *   - an engine's `apiKeyFile`, a literal `apiKey` or a `${secrets/...}` one,
 *     which the conversion to a connection cannot carry;
 *   - the same literal or secret-store `apiKey` on a connection, `embedding` or
 *     `search.curateRerank` that the file already says in the current form.
 *
 * A key that cannot be read, or whose name `credentials.json` already holds a
 * different key for, is not moved. It stays in the file: on the block that held
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
import { isSecretRefToken } from "../ref-token";
import type { ConvertEnginesResult } from "./convert-engines";
import { readCredential } from "./credentials";
import { isEnvReference } from "./schema/primitives";

type Dict = Record<string, unknown>;

export interface MovedKey {
  /** The `credentials.json` entry. */
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
  readonly from: string;
  /** The value, or why there is none. */
  readonly read: () => string | undefined;
  /** What it was read from, for a note when it cannot be. */
  readonly source: string;
  /** Remove it from the document, once it is filed. */
  readonly remove?: () => void;
  /** Put it back on the connection, when it is not filed: the conversion did not carry it. */
  readonly restore?: () => void;
}

/** The keys of the converted document that are not `$VAR` references. */
function documentCandidates(config: Dict, options: KeyMoveOptions): Candidate[] {
  const blocks: Array<[string, Dict]> = [];
  if (isRecord(config.connections)) {
    for (const [name, block] of Object.entries(config.connections)) if (isRecord(block)) blocks.push([name, block]);
  }
  const search = isRecord(config.search) ? config.search : {};
  if (isRecord(config.embedding)) blocks.push(["embedding", config.embedding]);
  if (isRecord(search.curateRerank)) blocks.push(["curateRerank", search.curateRerank]);
  return blocks.flatMap(([name, block]) => {
    const apiKey = block.apiKey;
    if (typeof apiKey !== "string" || isEnvReference(apiKey)) return [];
    const from =
      name === "embedding"
        ? "embedding.apiKey"
        : name === "curateRerank"
          ? "search.curateRerank.apiKey"
          : `connections.${name}.apiKey`;
    return [
      {
        name,
        from,
        read: () => heldValue(apiKey, options),
        source: isSecretRefToken(apiKey) ? "the secret store reference" : "the literal key",
        remove: () => {
          delete block.apiKey;
        },
      },
    ];
  });
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
    const held = isRecord(engines[engine]) ? (engines[engine] as Dict)[field] : undefined;
    if (typeof held !== "string") return [];
    if (field === "apiKeyFile") {
      return [
        {
          name: connection,
          from: `engines.${engine}.${field}`,
          read: () => readKeyFile(held),
          source: `its key file ${held}`,
        },
      ];
    }
    return [
      {
        name: connection,
        from: `engines.${engine}.${field}`,
        read: () => heldValue(held, options),
        source: isSecretRefToken(held) ? `the secret store reference ${held}` : "the literal key",
        restore: () => {
          const block = isRecord(config.connections) ? config.connections[connection] : undefined;
          if (isRecord(block)) block.apiKey = held;
        },
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
  const planned = new Map<string, string>();
  const moves: MovedKey[] = [];
  const notes: string[] = [];
  for (const candidate of [
    ...engineCandidates(original, converted, config, options),
    ...documentCandidates(config, options),
  ]) {
    const stays = candidate.restore ? " It stays on the connection as apiKey." : "";
    const value = candidate.read();
    if (value === undefined) {
      candidate.restore?.();
      notes.push(
        `${candidate.from}: ${candidate.source} could not be read, so no key moves.${stays} Store it under "${candidate.name}" in credentials.json if it should have one.`,
      );
      continue;
    }
    const existing = planned.get(candidate.name) ?? readCredential(candidate.name);
    if (existing !== undefined && existing !== value) {
      candidate.restore?.();
      notes.push(
        `${candidate.from}: credentials.json already holds a different key for "${candidate.name}"; it is not replaced.${stays}`,
      );
      continue;
    }
    planned.set(candidate.name, value);
    moves.push({ name: candidate.name, value, from: candidate.from });
    notes.push(`${candidate.from}: its key moves to credentials.json as "${candidate.name}".`);
    candidate.remove?.();
  }
  return { config, moves, notes };
}
