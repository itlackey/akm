// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Setup wizard step: choose the default output format + detail level.
 */

import * as p from "../../cli/clack";
import type { AkmConfig, OutputConfig } from "../../core/config/config";
import { DEFAULT_CONFIG } from "../../core/config/config";
import { prompt } from "../prompt";

export async function stepOutputConfig(current: AkmConfig): Promise<OutputConfig> {
  const defaultOutput = current.output ?? DEFAULT_CONFIG.output ?? { format: "json", detail: "brief" };
  const format = await prompt(() =>
    p.select({
      message: "Default output format?",
      options: [
        { value: "json", label: "json", hint: "structured default" },
        { value: "text", label: "text", hint: "human-readable CLI output" },
        { value: "yaml", label: "yaml", hint: "structured text" },
      ],
      initialValue: defaultOutput.format ?? "json",
    }),
  );
  const detail = await prompt(() =>
    p.select({
      message: "Default output detail level?",
      options: [
        { value: "brief", label: "brief", hint: "compact summaries" },
        { value: "normal", label: "normal", hint: "balanced detail" },
        { value: "full", label: "full", hint: "max available detail" },
      ],
      initialValue: defaultOutput.detail ?? "brief",
    }),
  );

  return { format: format as OutputConfig["format"], detail: detail as OutputConfig["detail"] };
}
