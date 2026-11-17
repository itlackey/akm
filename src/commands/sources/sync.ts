// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { loadConfig } from "../../core/config/config";
import { appendEvent } from "../../core/events";
import { resolveWritableOverride, saveGitStash } from "../../sources/providers/git";

/**
 * `akm sync`: commit every unignored change inside a git-backed bundle (the named one, or the primary bundle), and push when
 * it is writable with a remote configured. The CLI and the workspace's bundle commit both run this.
 */
export function akmSync(args: { name?: string; message?: string; push?: boolean }) {
  // Primary stash — honour the configured default bundle's writable flag.
  const writable = args.name === undefined ? resolveWritableOverride(loadConfig()) : undefined;
  const result = saveGitStash(args.name, args.message, writable, { push: args.push !== false });
  appendEvent({
    eventType: "sync",
    metadata: {
      name: args.name ?? null,
      message: args.message ?? null,
      ok: (result as { ok?: boolean }).ok !== false,
    },
  });
  return result;
}
