// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// secret-list strips `path` from each secret object (same as vault-list: avoid
// leaking absolute disk paths) then stamps the envelope.
import { registerOutputShape } from "./registry";

registerOutputShape("secret-list", (result) => {
  const r = result as Record<string, unknown>;
  const secrets = Array.isArray(r.secrets) ? r.secrets : [];
  return {
    ...r,
    shape: (r.shape as string | undefined) ?? "secret-list",
    schemaVersion: (r.schemaVersion as number | undefined) ?? 1,
    secrets: secrets.map((s) => {
      const { path: _path, ...rest } = s as Record<string, unknown>;
      return rest;
    }),
  };
});
