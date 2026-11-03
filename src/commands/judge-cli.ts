// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm judge <name>`: run one of akm's model judges on one input, on the runner
 * the call selects (#1306). It reads the input as JSON on stdin and writes nothing.
 */

import { SELECTION_ARGS, selectionFromArgs } from "../cli/selection";
import { defineJsonCommand, EXIT_CODES, output, outputWithExitCode } from "../cli/shared";
import { loadConfig } from "../core/config/config";
import { UsageError } from "../core/errors";
import { getJudge, listJudges, runJudge } from "../judges/registry";
import { readStdin } from "../runtime";

export const judgeCommand = defineJsonCommand({
  meta: {
    name: "judge",
    description:
      "Run one of akm's judges on one JSON input read from stdin, and print its verdict, or why it gave none. --list names the judges; --schema prints one's input and output schemas.",
  },
  args: {
    name: { type: "positional", description: "Judge name, such as reflect.quality", required: false },
    list: { type: "boolean", description: "List the registered judges", default: false },
    schema: {
      type: "boolean",
      description: "Print the judge's input schema, output schema and version",
      default: false,
    },
    ...SELECTION_ARGS,
  },
  async run({ args }) {
    if (args.list === true) {
      output("judge-list", {
        judges: listJudges().map(({ name, description, schemaVersion }) => ({ name, description, schemaVersion })),
      });
      return;
    }
    const name = typeof args.name === "string" ? args.name : undefined;
    if (name === undefined) {
      throw new UsageError(
        "`akm judge` needs a judge name. `akm judge --list` names them.",
        "MISSING_REQUIRED_ARGUMENT",
      );
    }
    if (args.schema === true) {
      const { description, schemaVersion, inputSchema, outputSchema, harnessReads } = getJudge(name);
      output("judge-schema", { judge: name, description, schemaVersion, inputSchema, outputSchema, harnessReads });
      return;
    }
    if (process.stdin.isTTY) {
      throw new UsageError(`\`akm judge ${name}\` reads its input as JSON on stdin.`, "MISSING_REQUIRED_ARGUMENT");
    }
    let input: unknown;
    try {
      input = JSON.parse((await readStdin()).toString("utf8"));
    } catch {
      throw new UsageError("The input on stdin is not valid JSON.", "INVALID_JSON_ARGUMENT");
    }
    const envelope = await runJudge(name, input, loadConfig(), selectionFromArgs(args));
    outputWithExitCode("judge", envelope, envelope.outcome === "verdict" ? undefined : EXIT_CODES.GENERAL);
  },
});
