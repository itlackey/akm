// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { DirectoryAdapterBase } from "../../src/core/adapter/directory-adapter";
import type { FileChange } from "../../src/core/adapter/file-change";
import type { Bundle } from "../../src/core/adapter/types";
import type { FileDiagnostic, FileValidateContext } from "../../src/core/adapter/validate-context";

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

interface WriteHooks {
  typeOf(relPath: string): string;
  fileMode(type: string): number | undefined;
  serialize(type: string, file: string, content: string | Buffer): string | Buffer;
}

/** A directory adapter's protected `typeOf` hook: the type of the asset kept at a path, from the path alone. */
export function typeOf(adapter: DirectoryAdapterBase, relPath: string): string {
  return (adapter as unknown as WriteHooks).typeOf(relPath);
}

/** A directory adapter's protected `fileMode` hook: the mode a new file of `type` gets. */
export function fileMode(adapter: DirectoryAdapterBase, type: string): number | undefined {
  return (adapter as unknown as WriteHooks).fileMode(type);
}

/** A directory adapter's protected `serialize` hook: the bytes a file of `type` holds for `content`. */
export function serialize(
  adapter: DirectoryAdapterBase,
  type: string,
  file: string,
  content: string | Buffer,
): string | Buffer {
  return (adapter as unknown as WriteHooks).serialize(type, file, content);
}

interface CheckHooks {
  checkChanges(b: Bundle, changes: FileChange[], ctx: FileValidateContext): Promise<FileDiagnostic[]>;
}

/**
 * A directory adapter's protected file-level checks over a hand-built file view, for the tests that pin one check's
 * findings on virtual files. The public path is `validate(edits)`.
 */
export function checkChanges(
  adapter: DirectoryAdapterBase,
  b: Bundle,
  changes: FileChange[],
  ctx: FileValidateContext,
): Promise<FileDiagnostic[]> {
  return (adapter as unknown as CheckHooks).checkChanges(b, changes, ctx);
}
