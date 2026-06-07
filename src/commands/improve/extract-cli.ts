// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * CLI surface for `akm extract`.
 *
 * Examples:
 *   akm extract --type claude-code --session-id <id>
 *   akm extract --type claude-code --since 24h
 *   akm extract --type opencode --since 7d --dry-run
 *   akm extract --auto                 # iterate all available harnesses
 *   akm extract --type claude-code --location /custom/path --session-id <id>
 *
 * Output is the AkmExtractResult JSON envelope (or an aggregated one when
 * `--auto` runs multiple harnesses).
 */

import { defineCommand } from "citty";
import { output, runWithJsonErrors } from "../../cli/shared";
import { UsageError } from "../../core/errors";
import { getAvailableHarnesses } from "../../integrations/session-logs";
import { type AkmExtractResult, akmExtract } from "./extract";

export const extractCommand = defineCommand({
  meta: {
    name: "extract",
    description:
      "Extract durable insights from native session files (claude-code, opencode) and queue them as proposals. Replaces the legacy session-checkpoint hook.",
  },
  args: {
    type: {
      type: "string",
      description: "Harness name (claude-code, opencode). Required unless --auto.",
    },
    "session-id": {
      type: "string",
      description: "Process only this session ID. When absent, discover sessions via --since.",
    },
    location: {
      type: "string",
      description: "Override the harness's default session-discovery location.",
    },
    since: {
      type: "string",
      description: "Discovery cutoff. ISO timestamp or duration (24h, 7d, 30m). Default 24h.",
    },
    auto: {
      type: "boolean",
      description: "Iterate every available harness with default --since. Mutually exclusive with --type.",
      default: false,
    },
    "dry-run": {
      type: "boolean",
      description: "Show candidates without queuing proposals.",
      default: false,
    },
    force: {
      type: "boolean",
      description:
        "Re-process sessions even if they were already extracted and have no new events. Default: skip already-seen sessions.",
      default: false,
    },
    "timeout-ms": {
      type: "string",
      description: "Per-session LLM timeout in ms (default 60000).",
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const type = typeof args.type === "string" ? args.type.trim() : "";
      const sessionId = typeof args["session-id"] === "string" ? args["session-id"].trim() : "";
      const location = typeof args.location === "string" ? args.location.trim() : "";
      const since = typeof args.since === "string" ? args.since.trim() : "";
      const auto = args.auto === true;
      const dryRun = args["dry-run"] === true;
      const force = args.force === true;
      const timeoutMs =
        typeof args["timeout-ms"] === "string" && args["timeout-ms"] !== ""
          ? Number.parseInt(args["timeout-ms"], 10)
          : undefined;
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
        throw new UsageError(
          `--timeout-ms must be a positive integer (got "${args["timeout-ms"]}").`,
          "INVALID_FLAG_VALUE",
        );
      }

      if (auto && type) {
        throw new UsageError("--auto and --type are mutually exclusive. Pick one.", "INVALID_FLAG_VALUE");
      }
      if (!auto && !type) {
        throw new UsageError(
          "--type is required (or pass --auto to try every available harness).",
          "MISSING_REQUIRED_ARGUMENT",
        );
      }

      const commonOptions = {
        ...(sessionId ? { sessionId } : {}),
        ...(location ? { location } : {}),
        ...(since ? { since } : {}),
        dryRun,
        force,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };

      if (auto) {
        const harnesses = getAvailableHarnesses();
        if (harnesses.length === 0) {
          output("extract", {
            schemaVersion: 1,
            ok: false,
            shape: "extract-auto-result" as const,
            warnings: ["no available harnesses found on this machine"],
            results: [] as AkmExtractResult[],
          });
          return;
        }
        const results: AkmExtractResult[] = [];
        for (const h of harnesses) {
          const result = await akmExtract({ type: h.name, ...commonOptions });
          results.push(result);
        }
        const ok = results.every((r) => r.ok);
        const totalProposals = results.reduce((sum, r) => sum + r.proposals.length, 0);
        output("extract", {
          schemaVersion: 1,
          ok,
          shape: "extract-auto-result" as const,
          dryRun,
          harnessesProcessed: results.length,
          totalProposals,
          results,
        });
        return;
      }

      const result = await akmExtract({ type, ...commonOptions });
      output("extract", result);
    });
  },
});
