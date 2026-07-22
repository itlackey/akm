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

import fs from "node:fs";
import path from "node:path";
import { getStringArg } from "../../cli/parse-args";
import { defineJsonCommand, EXIT_CODES, output } from "../../cli/shared";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { getAvailableHarnesses, getWatchTargets } from "../../integrations/session-logs";
import {
  type AkmExtractOptions,
  type AkmExtractResult,
  akmExtract,
  type ResolvedExtractPlan,
  resolveStandaloneExtractPlan,
} from "./extract";
import { akmExtractWatch, type WatchEvent, type WatchEventSource } from "./extract-watch";

export const extractCommand = defineJsonCommand({
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
    watch: {
      type: "boolean",
      description:
        "Watch harness session-log directories and run extract on change (debounced). Stays alive until SIGINT/SIGTERM.",
      default: false,
    },
    "debounce-ms": {
      type: "string",
      description: "Debounce window in ms for --watch (default 2000).",
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

    const watch = args.watch === true;
    const debounceMs =
      typeof args["debounce-ms"] === "string" && args["debounce-ms"] !== ""
        ? Number.parseInt(args["debounce-ms"], 10)
        : 2000;
    if (watch && (!Number.isFinite(debounceMs) || debounceMs <= 0)) {
      throw new UsageError(
        `--debounce-ms must be a positive integer (got "${args["debounce-ms"]}").`,
        "INVALID_FLAG_VALUE",
      );
    }

    if (!watch && auto && type) {
      throw new UsageError("--auto and --type are mutually exclusive. Pick one.", "INVALID_FLAG_VALUE");
    }
    if (!watch && !auto && !type) {
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

    if (watch) {
      await runWatchMode({ debounceMs, dryRun, force, config, resolvedPlan, ...(since ? { since } : {}) });
      return;
    }

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
      // (not process.exit) lets stdout flush and the watcher/timers settle.
      if (!ok) process.exitCode = EXIT_CODES.GENERAL;
      return;
    }

    const result = await akmExtract({ type, ...commonOptions });
    output("extract", result);
    if (!result.ok) process.exitCode = EXIT_CODES.GENERAL;
  },
});

/**
 * A thin {@link WatchEventSource} over `fs.watch` for each configured root.
 * This adapter is the ONLY place a real `fs.watch` is created (the core stays
 * injectable + fully unit-tested); it is intentionally not unit-covered.
 *
 * `fs.watch(dir, { recursive: true })` is unreliable for recursive mode on some
 * Node/Bun/Linux combinations. A root that cannot be watched is skipped while
 * successfully-created watchers continue running.
 */
function createFsWatchEventSource(roots: string[]): WatchEventSource {
  return {
    subscribe(listener: (e: WatchEvent) => void): () => void {
      const watchers: fs.FSWatcher[] = [];
      for (const root of roots) {
        try {
          const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
            if (!filename) return;
            const filePath = path.isAbsolute(filename.toString())
              ? filename.toString()
              : path.join(root, filename.toString());
            listener({ path: filePath });
          });
          watchers.push(watcher);
        } catch {
          // A root that can't be watched is skipped.
        }
      }
      return () => {
        for (const w of watchers) {
          try {
            w.close();
          } catch {
            // best-effort teardown
          }
        }
      };
    },
  };
}

type ExtractWatchTriggerOptions = Pick<AkmExtractOptions, "config" | "dryRun" | "force" | "resolvedPlan" | "since">;
type ExtractFn = (options: AkmExtractOptions) => Promise<unknown>;

/** Snapshot the CLI-resolved watch options once and reuse them for every debounced trigger. */
export function createExtractWatchTrigger(
  options: ExtractWatchTriggerOptions,
  extractFn: ExtractFn = akmExtract,
): (harnessName: string) => Promise<void> {
  const snapshot = Object.freeze({ ...options });
  return async (harnessName) => {
    await extractFn({ type: harnessName, ...snapshot });
  };
}

/**
 * Run `akm extract --watch`: watch every available harness's session-log
 * roots and run extract (debounced, per-harness) on change. Stays alive until
 * SIGINT/SIGTERM, then stops cleanly. PROCESS-HYGIENE: stop() removes every
 * watcher + pending timer before the process exits.
 */
async function runWatchMode(opts: {
  debounceMs: number;
  dryRun: boolean;
  force: boolean;
  config: ReturnType<typeof loadConfig>;
  resolvedPlan: ResolvedExtractPlan;
  since?: string;
}): Promise<void> {
  const targets = getWatchTargets();
  if (targets.length === 0) {
    output("extract", {
      schemaVersion: 1,
      ok: false,
      shape: "extract-watch-started" as const,
      warnings: ["no watchable harness session-log directories found on this machine"],
      watching: [] as string[],
    });
    return;
  }

  const allRoots = targets.flatMap((t) => t.roots);
  const eventSource = createFsWatchEventSource(allRoots);
  const onTrigger = createExtractWatchTrigger({
    dryRun: opts.dryRun,
    force: opts.force,
    config: opts.config,
    resolvedPlan: opts.resolvedPlan,
    ...(opts.since ? { since: opts.since } : {}),
  });
  const handle = akmExtractWatch({
    roots: targets,
    eventSource,
    debounceMs: opts.debounceMs,
    onTrigger,
  });

  output("extract", {
    schemaVersion: 1,
    ok: true,
    shape: "extract-watch-started" as const,
    debounceMs: opts.debounceMs,
    watching: allRoots,
  });

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      handle.stop();
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
