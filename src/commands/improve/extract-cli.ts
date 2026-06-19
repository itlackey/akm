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
import { defineCommand } from "citty";
import { output, runWithJsonErrors } from "../../cli/shared";
import { UsageError } from "../../core/errors";
import { getAvailableHarnesses, getWatchTargets } from "../../integrations/session-logs";
import { type AkmExtractResult, akmExtract } from "./extract";
import { akmExtractWatch, type WatchEvent, type WatchEventSource } from "./extract-watch";

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
    watch: {
      type: "boolean",
      description:
        "Watch harness session-log directories and run extract on change (debounced). Stays alive until SIGINT/SIGTERM. Falls back to the */30 cron when off.",
      default: false,
    },
    "debounce-ms": {
      type: "string",
      description: "Debounce window in ms for --watch (default 2000).",
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

      if (watch) {
        await runWatchMode({ debounceMs, dryRun, force, ...(since ? { since } : {}) });
        return;
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

/**
 * A thin {@link WatchEventSource} over `fs.watch` for each configured root.
 * This adapter is the ONLY place a real `fs.watch` is created (the core stays
 * injectable + fully unit-tested); it is intentionally not unit-covered.
 *
 * `fs.watch(dir, { recursive: true })` is unreliable for recursive mode on some
 * Node/Bun/Linux combinations — that is acceptable here: missed events degrade
 * to the unchanged scheduled cron fallback, never worse than today.
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
          // A root that can't be watched is skipped; the cron fallback covers it.
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
  const handle = akmExtractWatch({
    roots: targets,
    eventSource,
    debounceMs: opts.debounceMs,
    onTrigger: async (harnessName) => {
      await akmExtract({
        type: harnessName,
        dryRun: opts.dryRun,
        force: opts.force,
        ...(opts.since ? { since: opts.since } : {}),
      });
    },
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
