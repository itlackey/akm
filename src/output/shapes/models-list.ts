// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// models-list stamps the envelope; there is nothing sensitive to strip from a
// row (unlike env-list/secret-list, which drop `path`).
import type { OutputShapeEntry } from "./registry";

export const modelsListShapes: OutputShapeEntry[] = [
  {
    command: "models-list",
    handler: (result) => {
      const r = result as Record<string, unknown>;
      return {
        ...r,
        shape: (r.shape as string | undefined) ?? "models-list",
        schemaVersion: (r.schemaVersion as number | undefined) ?? 1,
      };
    },
  },
];
