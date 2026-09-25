// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { nonEmptyString } from "./primitives";

/** A 0.9.17-alpha `{kind, ref, sourceId}` activation, read as its ref. */
const LegacySchedulerActivationSchema = z
  .object({ ref: nonEmptyString })
  .passthrough()
  .transform((activation) => activation.ref);

export const SchedulerConfigSchema = z.object({
  /**
   * Fully-qualified refs (`bundle//tasks/x`, `bundle//workflows/y`) this host
   * schedules. Absent when the host has never chosen: `akm task sync` then
   * takes the akm-written rows already installed as the choice and writes it.
   */
  enabled: z.array(z.union([nonEmptyString, LegacySchedulerActivationSchema])).optional(),
});
