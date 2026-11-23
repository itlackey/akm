// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { DirectoryAdapterBase } from "../../src/core/adapter/directory-adapter";

interface Hooks {
  identify(relPath: string): string | null;
  spellings(conceptId: string): string[];
}

/** A directory adapter's protected `identify` hook: the concept a path holds, from the path alone. */
export function identify(adapter: DirectoryAdapterBase, relPath: string): string | null {
  return (adapter as unknown as Hooks).identify(relPath);
}

/** A directory adapter's protected `spellings` hook: the paths a concept can be kept at, the winner first. */
export function spellings(adapter: DirectoryAdapterBase, conceptId: string): string[] {
  return (adapter as unknown as Hooks).spellings(conceptId);
}
