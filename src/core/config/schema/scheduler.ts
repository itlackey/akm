// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { nonEmptyString } from "./primitives";

/** One host-local grant allowing an authored asset to create scheduler bindings. */
export const SchedulerActivationSchema = z
  .object({
    kind: z.enum(["task", "workflow"]),
    ref: nonEmptyString,
  })
  .passthrough();

/** Absence from this allow-list means disabled. */
export const SchedulerConfigSchema = z
  .object({
    enabled: z.array(SchedulerActivationSchema).default([]),
  })
  .passthrough();
