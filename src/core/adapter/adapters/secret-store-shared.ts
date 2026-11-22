// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What every secret store adapter shares: the adapter built around a store,
 * and the call to the store's command-line client.
 */

import { spawnSync } from "node:child_process";
import type { FileContext } from "../../../indexer/walk/file-context";
import { ConfigError } from "../../errors";
import type { BundleAdapter } from "../bundle-adapter";
import { type SecretStore, secretNameOf } from "../secret-store";
import type { BundleComponent, IndexDocument } from "../types";
import { hashContent } from "./shared";

/**
 * The adapter of a bundle that is the secret store `open` returns for the
 * bundle's locator. An entry is recognized from its ref alone and carries its
 * name and nothing of its value; a store has no files to validate.
 */
export function secretStoreAdapter(id: string, version: string, open: (locator: string) => SecretStore): BundleAdapter {
  return {
    id,
    version,
    extensions: [],
    secretStore: open,

    recognize(c: BundleComponent, file: FileContext): IndexDocument | null {
      const name = secretNameOf(file.relPath);
      if (name === undefined) return null;
      return {
        ref: `${c.id}//${file.relPath}`,
        bundle: c.id,
        component: "main",
        conceptId: file.relPath,
        path: file.absPath,
        // An entry is its name, so an unchanged listing rewrites no row.
        hash: hashContent(file.relPath),
        adapterId: id,
        type: "secret",
        name: name.split("/").pop() as string,
      };
    },

    async validate() {
      return [];
    },
  };
}

export interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** A store's command-line client: its program and how to get it. */
export interface StoreCli {
  command: string;
  /** Completes "Install …" when the program is not on PATH. */
  install: string;
}

/**
 * Run a store's client and return what it printed and how it exited. `input`
 * is written to its stdin, which is how a value reaches a client: never as an
 * argument, where other processes could read it.
 */
export function runStoreCli(cli: StoreCli, args: readonly string[], input?: Buffer): CliResult {
  const result = spawnSync(cli.command, [...args], { encoding: "utf8", input });
  if (result.error) {
    const missing = (result.error as NodeJS.ErrnoException).code === "ENOENT";
    throw new ConfigError(
      missing ? `"${cli.command}" is not installed.` : `"${cli.command}" could not be run: ${result.error.message}`,
      "SECRET_STORE_UNAVAILABLE",
      missing ? `Install ${cli.install}.` : undefined,
    );
  }
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

/** The error for a request the store's client failed, carrying the client's own message. */
export function storeFailure(cli: StoreCli, action: string, result: CliResult): ConfigError {
  const reason = result.stderr.trim() || `exit status ${result.status}`;
  return new ConfigError(`${cli.command} could not ${action}: ${reason}`, "SECRET_STORE_UNAVAILABLE");
}

/** Run a client request that must succeed, and return what it printed. */
export function requireStoreCli(cli: StoreCli, action: string, args: readonly string[], input?: Buffer): string {
  const result = runStoreCli(cli, args, input);
  if (result.status !== 0) throw storeFailure(cli, action, result);
  return result.stdout;
}
