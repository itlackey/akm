// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A secret store: named secrets kept outside the filesystem, such as an OS
 * keyring or a cloud vault.
 *
 * An adapter whose bundle is a store returns one from `BundleAdapter.secretStore`.
 * Each secret is an entry of the bundle under `secrets/<name>`, the ref a file
 * of that name in a directory bundle has, so the index, a `${ref}` token and
 * `--secret` treat both alike. Only an implementation of this interface knows
 * where a value is kept.
 */

import { makeBundleRef } from "../asset/asset-ref";
import { warnOnce } from "../warn";

export interface SecretStore {
  /** The name of every secret the store holds. */
  list(): string[];
  /** The secret's value, or undefined when the store holds no secret of that name. */
  read(name: string): string | undefined;
  /** Create the secret, or replace its value. */
  write(name: string, value: Buffer): void;
  /** Delete the secret. False when the store held no secret of that name. */
  remove(name: string): boolean;
}

const SECRETS_PREFIX = "secrets/";

/** The ref of the store secret `name` inside its bundle. */
export function secretConceptId(name: string): string {
  return `${SECRETS_PREFIX}${name}`;
}

/** The store secret a ref names, or undefined for a ref that names no secret. */
export function secretNameOf(conceptId: string): string | undefined {
  return conceptId.startsWith(SECRETS_PREFIX) && conceptId.length > SECRETS_PREFIX.length
    ? conceptId.slice(SECRETS_PREFIX.length)
    : undefined;
}

/**
 * The names of the store's secrets that are entries of its bundle. A ref is
 * how every command reaches an entry, so a secret whose name no ref can spell
 * is left out, with a warning naming it.
 */
export function listSecretNames(store: SecretStore): string[] {
  return store.list().filter((name) => {
    const conceptId = secretConceptId(name);
    let spellable: boolean;
    try {
      spellable = !conceptId.endsWith("/") && makeBundleRef(undefined, conceptId) === conceptId;
    } catch {
      spellable = false;
    }
    if (!spellable) warnOnce(`secret-store-name:${name}`, `Skipping secret "${name}": no ref can name it.`);
    return spellable;
  });
}
