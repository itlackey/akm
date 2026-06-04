// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// vault-list strips `path` from each vault object (security fix M3: avoid
// leaking absolute disk paths) then stamps the envelope (#484).
import { registerOutputShape } from "./registry";

registerOutputShape("vault-list", (result) => {
  const r = result as Record<string, unknown>;
  const vaults = Array.isArray(r.vaults) ? r.vaults : [];
  return {
    ...r,
    shape: (r.shape as string | undefined) ?? "vault-list",
    schemaVersion: (r.schemaVersion as number | undefined) ?? 1,
    vaults: vaults.map((v) => {
      const { path: _path, ...rest } = v as Record<string, unknown>;
      return rest;
    }),
  };
});
