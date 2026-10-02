// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm proposal new` — the asset-authoring entry point (formerly the
 * top-level `akm propose`, moved under the `proposal` group per the 0.9 CLI
 * overhaul, S8). Shares no private helper with the proposal MANAGEMENT
 * family (list/show/accept/reject/…, `./proposal-cli.ts`) — its path/name
 * helpers come from the shared src/core/asset/asset-create.ts module.
 *
 * Keeps the inline `runWithJsonErrors` form (branches on the result and sets
 * `process.exitCode` conditionally on a failed proposal) rather than
 * migrating to `defineJsonCommand`, matching the original contribute-cli.ts
 * rationale: `process.exitCode` (not `process.exit()`) so the process still
 * exits via natural event-loop drain rather than skipping pending cleanup.
 */

import fs from "node:fs";
import path from "node:path";
import { defineCommand } from "citty";
import { getStringArg, parsePositiveIntFlag } from "../../cli/parse-args";
import { EXIT_CODES, GLOBAL_OUTPUT_ARGS, output, runWithJsonErrors } from "../../cli/shared";
import { assertFlatAssetName, combineCreatePath, normalizeCreateSubPath } from "../../core/asset/asset-create";
import { UsageError } from "../../core/errors";
import { akmPropose } from "./propose";

const EXIT_GENERAL = EXIT_CODES.GENERAL;

export const proposeCommand = defineCommand({
  meta: {
    name: "new",
    description: "Ask the configured engine to author a brand-new asset as JSON and queue it as a proposal",
  },
  // Raw defineCommand: declare the global output flags so their space-separated
  // values are consumed rather than shifting the `type` / `name` positionals.
  args: {
    ...GLOBAL_OUTPUT_ARGS,
    // Optional in citty so run() is invoked when omitted; we re-validate
    // below to surface a structured UsageError (exit 2) instead of citty's
    // default help-banner exit-0.
    type: { type: "positional", description: "Asset type (skill, command, knowledge, lesson, ...)", required: false },
    name: {
      type: "positional",
      description: "Asset name (flat, no '/'; use --path for a subdirectory)",
      required: false,
    },
    path: {
      type: "string",
      description:
        "Relative subdirectory under the type dir to place the proposed asset in (e.g. 'release'). The filename comes from the name.",
    },
    task: { type: "string", description: "Task description for the agent (what should the asset do?)" },
    file: { type: "string", description: "Read the task or prompt text from a UTF-8 file" },
    engine: { type: "string", description: "Engine to use (defaults to defaults.engine)" },
    "timeout-ms": { type: "string", description: "Override the engine timeout in milliseconds" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      // citty silently shows help and exits 0 when required positionals are
      // omitted. Re-validate explicitly so the exit code is 2 (USAGE) and a
      // structured JSON error reaches scripted callers.
      const taskFromFlag = typeof args.task === "string" ? args.task : undefined;
      const fileFromFlag = typeof args.file === "string" ? args.file : undefined;
      if (!args.type || !args.name || (!taskFromFlag && !fileFromFlag)) {
        throw new UsageError(
          "Usage: akm proposal new <type> <name> (--task '<task>' | --file <path>).",
          "MISSING_REQUIRED_ARGUMENT",
          "Provide the asset type, name, and exactly one of --task or --file.",
        );
      }
      if (taskFromFlag && fileFromFlag) {
        throw new UsageError("Pass exactly one of --task or --file.", "INVALID_FLAG_VALUE");
      }
      // `name` is flat; subdirectory placement is `--path`'s job.
      assertFlatAssetName(String(args.name));
      const proposedName = combineCreatePath(normalizeCreateSubPath(getStringArg(args, "path")), String(args.name));
      const taskText = fileFromFlag ? fs.readFileSync(path.resolve(fileFromFlag), "utf8") : (taskFromFlag ?? "");
      const timeoutMs = parsePositiveIntFlag(args["timeout-ms"], "--timeout-ms");
      const result = await akmPropose({
        type: String(args.type),
        name: proposedName,
        task: taskText,
        engine: getStringArg(args, "engine"),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      output("proposal-new", result);
      if (result.ok === false) {
        // Same reasoning as agentCommand in contribute-cli.ts: output() already
        // ran, this is the last statement in the handler, so process.exitCode +
        // return is equivalent without skipping any pending cleanup.
        process.exitCode = EXIT_GENERAL;
        return;
      }
    });
  },
});
