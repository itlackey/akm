// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type ArgsDef, defineCommand } from "citty";
import { findCittyTopLevelCommandIndex } from "../../cli/invocation";
import { defineJsonCommand, GLOBAL_OUTPUT_ARGS, output } from "../../cli/shared";
import { assertKnownFlags, type FlagScanCommand } from "../../cli/unknown-flags";
import { CLI_USAGE_SOURCES, readUsage } from "../../cli/usage";
import { UsageError } from "../../core/errors";
import { parseHealthSince } from "../health";
import { improveReportCommand } from "../improve/improve-cli";
import { doctorMetricsAssetsCommand } from "../read/search-cli";
import { metricsCommand } from "./metrics-cli";

const usageCommand = defineJsonCommand({
  meta: {
    name: "usage",
    description:
      "Report/export local CLI attempts, arguments, outcomes and coverage. JSON aggregates have stable keys for overlap deduplication.",
  },
  args: {
    since: {
      type: "string",
      description: "UTC window start: ISO date, epoch ms, or duration such as 30d; aggregates select whole UTC days",
    },
    until: { type: "string", description: "UTC window end (inclusive day)" },
    "cli-version": { type: "string", description: "Filter by exact CLI version" },
    source: { type: "string", description: "Filter user, agent, task, improve, audit or unknown provenance" },
    export: {
      type: "boolean",
      default: false,
      description: "Include retained invocation details as well as durable aggregates",
    },
  },
  run({ args }) {
    if (args.source && !CLI_USAGE_SOURCES.has(args.source)) {
      throw new UsageError("Source must be user, agent, task, improve, audit or unknown.", "INVALID_FLAG_VALUE");
    }
    const since = args.since ? new Date(parseHealthSince(args.since)).toISOString() : undefined;
    const until = args.until ? new Date(parseHealthSince(args.until)).toISOString() : undefined;
    if (since && until && since > until) {
      throw new UsageError("Usage window start must not follow its end.", "INVALID_FLAG_VALUE");
    }
    const report = readUsage({
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
      ...(args["cli-version"] ? { version: args["cli-version"] } : {}),
      ...(args.source ? { source: args.source } : {}),
    });
    const aggregates = report.aggregates;
    const commands: Record<
      string,
      { attempts: number; completed: number; failures: number; durationMs: number; instances: Set<string> }
    > = {};
    const argumentsUsed: Record<string, number> = {};
    for (const row of aggregates) {
      const dimensions = row.dimensions as {
        command: string[];
        instance: string;
        arguments: Array<{ name: string; explicit: boolean }>;
      };
      const name = dimensions.command.join(" ") || "[root]";
      commands[name] ??= {
        attempts: 0,
        completed: 0,
        failures: 0,
        durationMs: 0,
        instances: new Set(),
      };
      const command = commands[name]!;
      command.attempts += Number(row.attempts);
      command.completed += Number(row.completed);
      command.failures += Number(row.failures);
      command.durationMs += Number(row.duration_ms);
      command.instances.add(dimensions.instance);
      for (const argument of dimensions.arguments.filter((arg) => arg.explicit)) {
        const identity = `${name}:${argument.name}`;
        argumentsUsed[identity] = (argumentsUsed[identity] ?? 0) + Number(row.attempts);
      }
    }
    output("doctor metrics usage", {
      ...report,
      details: args.export ? report.details : undefined,
      commands: Object.entries(commands).map(([command, row]) => ({
        command,
        ...row,
        instances: row.instances.size,
        meanDurationMs: row.completed ? row.durationMs / row.completed : null,
      })),
      arguments: argumentsUsed,
      exportContract:
        "Deduplicate overlapping snapshots by aggregate key; retain the latest snapshot per key, never sum snapshots. Details are subsets of aggregates: deduplicate by invocation id and never add detail counts to aggregate counts.",
    });
  },
});

const METRICS_SUBCOMMANDS = { usage: 1, improve: 1, assets: 1 };

// Retain the old leaf handler and args verbatim; citty selects a child before
// running this handler, so existing bare doctor metrics output stays intact.
export const doctorMetricsCommand = defineCommand({
  ...metricsCommand,
  subCommands: {
    usage: usageCommand,
    improve: improveReportCommand as never,
    assets: doctorMetricsAssetsCommand as never,
  },
  setup({ rawArgs }) {
    const index = findCittyTopLevelCommandIndex(rawArgs, metricsCommand.args as ArgsDef);
    if (index < 0 || !(rawArgs[index]! in METRICS_SUBCOMMANDS)) {
      // The bare report remains a leaf for flag validation even though this
      // wrapper also routes usage; health-only flags must still be rejected.
      assertKnownFlags(metricsCommand as FlagScanCommand, rawArgs);
      return;
    }
    try {
      assertKnownFlags({ args: GLOBAL_OUTPUT_ARGS }, rawArgs.slice(0, index));
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      throw new UsageError(
        `Put ${rawArgs[index]} report options after it: akm doctor metrics ${rawArgs[index]} --since 7d.`,
        "INVALID_FLAG_VALUE",
      );
    }
  },
  run(context) {
    if (String(context.args._[0]) in METRICS_SUBCOMMANDS) return;
    return metricsCommand.run?.(context);
  },
});
