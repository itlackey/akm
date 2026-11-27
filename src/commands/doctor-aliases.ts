// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { deprecatedMount } from "../cli/shared";
import { judgeCommand } from "./judge-cli";
import { metricsCommand } from "./metrics/metrics-cli";
import { logCommand } from "./observability-cli";
import { infoCommand } from "./sources/stash-cli";

/**
 * The Deprecated top-level forms of `akm doctor`'s subcommands (`akm health` is defined with `akm doctor`). `info` and
 * `judge` mount the very definitions `akm doctor` mounts, so only these mounts are marked Deprecated.
 */
export const DOCTOR_ALIASES = {
  metrics: metricsCommand,
  info: deprecatedMount(infoCommand, "`akm doctor info`"),
  log: logCommand,
  judge: deprecatedMount(judgeCommand, "`akm doctor judge`"),
};
