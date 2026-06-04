// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// env-list strips `path` from each env object (security: avoid leaking
// absolute disk paths) then stamps the envelope.
import { registerOutputShape } from "./registry";

registerOutputShape("env-list", (result) => {
  const r = result as Record<string, unknown>;
  const envs = Array.isArray(r.envs) ? r.envs : [];
  return {
    ...r,
    shape: (r.shape as string | undefined) ?? "env-list",
    schemaVersion: (r.schemaVersion as number | undefined) ?? 1,
    envs: envs.map((v) => {
      const { path: _path, ...rest } = v as Record<string, unknown>;
      return rest;
    }),
  };
});
