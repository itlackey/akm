// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { getDirname } from "./runtime";

// Version: prefer compile-time define, then package.json, then fallback
export const pkgVersion: string = (() => {
  // Injected at compile time via `bun build --define`
  if (typeof AKM_VERSION !== "undefined") return AKM_VERSION;
  try {
    const pkgPath = path.resolve(getDirname(import.meta.url), "../package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (typeof pkg.version === "string") return pkg.version;
    }
  } catch {
    // swallow — running as compiled binary without package.json
  }
  return "0.0.0-dev";
})();

// AKM_VERSION ambient type is declared in globals.d.ts

/**
 * Contract version for payloads plugins parse (`akm search`/`curate`/`show`/
 * `info`/`proposal extract` result envelopes — see `akm info`'s `compat`
 * block, D1). Bump this whenever one of those JSON key sets changes shape;
 * `tests/contracts/plugin-protocol.test.ts` pins the current keys against
 * this number and fails without a bump. A plugin gating on this can detect a
 * contract break that a semver range on the package version cannot see.
 */
export const PLUGIN_PROTOCOL_VERSION = 1 as const;
