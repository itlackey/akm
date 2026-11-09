// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { nonEmptyString } from "./primitives";

/**
 * Where this installation keeps what it writes, each an absolute path, `~/...`, or a path relative to the
 * config file. Unset is the platform default (`XDG_*_HOME`, else under the home folder). `core/paths.ts`
 * reads this key from the raw file, before the config module can load.
 */
export const PathsConfigSchema = z
  .object({
    /** `index.db`, `state.db`, `logs.db`, `metrics.db`, `akm.lock`: durable data. */
    data: nonEmptyString.optional(),
    /** Locks and per-run state. */
    state: nonEmptyString.optional(),
    /** Regenerable caches, config backups, models, task logs. */
    cache: nonEmptyString.optional(),
  })
  .passthrough();
