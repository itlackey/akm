// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A minimal `ValidateContext` test double, shared by the WI-2.1 adapter
 * parity tests (`tests/core/adapter/{skill,wiki,script}-adapter.test.ts`).
 *
 * `ValidateContext` (`src/core/adapter/types.ts`) is specified as serving
 * "the run snapshot WITH the pending changes overlaid" — no concrete
 * implementation exists yet (that's a later chunk's job; chunk 2 only
 * consumes the interface). This double backs `readFile`/`list` with plain
 * filesystem reads rooted at a given directory (good enough for a read-only
 * fixture stash with no pending changes to overlay) and `resolveRef` with a
 * caller-supplied resolver (defaulting to "nothing resolves" — the
 * skill/wiki/script fixtures carry no refs, so the default is never
 * exercised by the parity assertions).
 */

import fs from "node:fs";
import path from "node:path";
import type { ValidateContext } from "../../../../src/core/adapter/types";

export function makeFsValidateContext(
  root: string,
  resolveRefImpl: (ref: string) => Promise<{ exists: boolean; path?: string }> = async () => ({ exists: false }),
): ValidateContext {
  const resolve = (p: string): string => (path.isAbsolute(p) ? p : path.join(root, p));
  return {
    async readFile(p: string) {
      try {
        return fs.readFileSync(resolve(p), "utf8");
      } catch {
        return null;
      }
    },
    async list(dir: string) {
      try {
        return fs.readdirSync(resolve(dir));
      } catch {
        return [];
      }
    },
    resolveRef: resolveRefImpl,
  };
}
