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

import { getStringArg, PROJECT_ARG, parsePositiveIntFlag, SCOPE_ARGS, scopeFromArgs } from "../../cli/parse-args";
import { RETIRED_ENGINE_ARG, SELECTION_ARGS, selectionFromArgs } from "../../cli/selection";
import { defineJsonCommand, EXIT_CODES, output } from "../../cli/shared";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { resolveProject } from "../../core/projects";
import { getAvailableHarnesses } from "../../integrations/session-logs";
import { type AkmExtractResult, akmExtract, resolveStandaloneExtractPlan } from "./extract";

export const extractCommand = defineJsonCommand({
  meta: {
    name: "extract",
    description:
      "Extract durable insights from native session files (claude, codex, opencode) and queue them as proposals.",
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
      description: "Re-process sessions already extracted with no new events",
      default: false,
    },
    "timeout-ms": {
      type: "string",
      description: "Per-session LLM timeout in ms. Default: the engine's own timeout.",
    },
    ...SELECTION_ARGS,
    ...RETIRED_ENGINE_ARG,
    ...SCOPE_ARGS,
    ...PROJECT_ARG,
    strategy: {
      type: "string",
      description: "Improve strategy supplying extract behavior.",
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
    const strategy = getStringArg(args, "strategy");
    const timeoutMs = parsePositiveIntFlag(args["timeout-ms"] as string | undefined, "--timeout-ms");
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
      ...selectionFromArgs(args),
      ...(strategy ? { strategy } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });

    // The project is chosen per session from its own directory; `--project` names one for every session.
    const projectName = getStringArg(args, "project");
    resolveProject(config, { project: projectName });
    const scope = scopeFromArgs(args);
    const commonOptions = Object.freeze({
      ...(projectName !== undefined ? { project: projectName } : {}),
      ...(Object.keys(scope).length > 0 ? { scope } : {}),
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
