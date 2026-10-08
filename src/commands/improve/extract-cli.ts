// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * CLI surface for `akm proposal extract` (formerly the top-level `akm
 * extract`, moved under the `proposal` group in the 0.9 CLI overhaul, S8 —
 * see src/commands/proposal/proposal-cli.ts for its registration).
 *
 * Examples:
 *   akm proposal extract --type claude --session-id <id>
 *   akm proposal extract --type claude --since 24h
 *   akm proposal extract --type opencode --since 7d --dry-run
 *   akm proposal extract --type codex --since 24h
 *   akm proposal extract --auto                 # iterate all available harnesses
 *   akm proposal extract --type claude --location /custom/path --session-id <id>
 *
 * Output is the AkmExtractResult JSON envelope (or an aggregated one when
 * `--auto` runs multiple harnesses).
 */

import { getStringArg } from "../../cli/parse-args";
import { defineJsonCommand, EXIT_CODES, output } from "../../cli/shared";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { getAvailableHarnesses } from "../../integrations/session-logs";
import { type AkmExtractResult, akmExtract, resolveStandaloneExtractPlan } from "./extract";

export const extractCommand = defineJsonCommand({
  meta: {
    name: "extract",
    description:
      "Experimental: extract durable insights from native session files (claude, codex, opencode) and queue them as proposals.",
  },
  args: {
    type: {
      type: "string",
      description: "Harness name (claude, codex, opencode). Required unless --auto.",
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
      description: "Per-session LLM timeout in ms (default 600000).",
    },
    engine: {
      type: "string",
      description: "Named LLM engine for this invocation. Mutually exclusive with --strategy.",
    },
    strategy: {
      type: "string",
      description: "Improve strategy supplying extract behavior and engine. Mutually exclusive with --engine.",
    },
  },
  async run({ args }) {
    const type = getStringArg(args, "type") ?? "";
    const sessionId = getStringArg(args, "session-id") ?? "";
    const location = getStringArg(args, "location") ?? "";
    const since = getStringArg(args, "since") ?? "";
    const auto = args.auto === true;
    const dryRun = args["dry-run"] === true;
    const force = args.force === true;
    const engine = getStringArg(args, "engine");
    const strategy = getStringArg(args, "strategy");
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
    if (engine && strategy) {
      throw new UsageError("--engine and --strategy are mutually exclusive. Pick one.", "INVALID_FLAG_VALUE");
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

    const config = loadConfig();
    const resolvedPlan = resolveStandaloneExtractPlan(config, {
      ...(engine ? { engine } : {}),
      ...(strategy ? { strategy } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });

    const commonOptions = Object.freeze({
      ...(sessionId ? { sessionId } : {}),
      ...(location ? { location } : {}),
      ...(since ? { since } : {}),
      dryRun,
      force,
      config,
      resolvedPlan,
    });

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
      // Signal failure to callers/schedulers when every harness failed. output()
      // only renders; without this a scheduled run exits 0 on a total failure
      // and the breakage is invisible to exit-code monitoring. process.exitCode
      // (not process.exit) lets stdout flush before the process exits.
      if (!ok) process.exitCode = EXIT_CODES.GENERAL;
      return;
    }

    const result = await akmExtract({ type, ...commonOptions });
    output("extract", result);
    if (!result.ok) process.exitCode = EXIT_CODES.GENERAL;
  },
});
