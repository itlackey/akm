// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The `akm metrics` command; the report itself is built in `metrics.ts`. */
import { defineJsonCommand, output } from "../../cli/shared";
import { getOutputMode } from "../../output/context";
import { akmMetrics, DEFAULT_SINCE, metricsIncludeRows } from "./metrics";

export const metricsCommand = defineJsonCommand({
  meta: {
    name: "metrics",
    description:
      "Experimental: report asset usage, feedback, utility, LLM usage, tasks, proposals and workflow spend from local records. Read-only.",
  },
  args: {
    since: {
      type: "string",
      description: `Window start: ISO, date, epoch ms, or 24h / 7d / 30d (default ${DEFAULT_SINCE})`,
    },
  },
  async run({ args }) {
    output(
      "metrics",
      await akmMetrics({
        since: args.since,
        includeRows: metricsIncludeRows(getOutputMode()),
      }),
    );
  },
});
