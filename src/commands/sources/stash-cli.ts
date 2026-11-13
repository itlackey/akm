// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Stash-lifecycle command cluster — the index/ingest/inspect verbs for
 * the working stash and its index database: `akm index` (build/refresh the
 * search index), `akm import` (ingest a knowledge doc/URL), and `akm info`
 * (system capabilities + index stats).
 * Extracted verbatim from src/cli.ts (WS6) so the God Module shrinks; the
 * `main.subCommands.{index,import,info}` keys and every subcommand's
 * args/output shape stay byte-identical.
 *
 * 0.9 CLI overhaul (S7): `init` moved out of this cluster into the new
 * `akm bundle create` (src/commands/sources/bundle-cli.ts) — no top-level
 * `init` remains.
 *
 * These share no private helper with any command still inline in cli.ts — every
 * dependency is already exported from a shared module (core/paths, core/warn,
 * core/errors, core/events, output/context, cli/shared, cli/parse-args, plus the
 * per-command implementations in ./init, ./indexer, ./info, ./knowledge,
 * ./core/asset-create, ./core/common), so the cluster moves with zero hoisting.
 *
 * The leaf handlers whose body is a plain `runWithJsonErrors(...) + output(...)`
 * (`import`, `info`) are migrated onto
 * `defineJsonCommand`, which emits the same JSON envelope (stdout/stderr/
 * exit-code) as the inline form. `index` keeps a plain `defineCommand` wrapping
 * `runWithJsonErrors` because its body owns a spinner, an AbortController, and
 * SIGINT/SIGTERM handlers in a try/finally — left byte-for-byte untouched.
 */

import path from "node:path";
import { defineCommand } from "citty";
import * as p from "../../cli/clack";
import { defineJsonCommand, GLOBAL_OUTPUT_ARGS, output, parseAllFlagValues, runWithJsonErrors } from "../../cli/shared";
import { assertFlatAssetName } from "../../core/asset/asset-create";
import { placementTypes } from "../../core/asset/asset-placement";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { isHttpUrl, resolveStashDir } from "../../core/common";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { resolveBundleWriteTarget } from "../../core/mutation-target";
import { getRunLogDir } from "../../core/paths";
import { clearLogFile, info, isVerbose, setLogFile, warn } from "../../core/warn";
import { resolveWriteTarget } from "../../core/write-source";
import { exportVectors } from "../../indexer/export-vectors";
import { buildIndex, isSkippedIndexBuild } from "../../indexer/index-build";
import { getOutputMode } from "../../output/context";
import { pkgVersion } from "../../version";
import {
  inferAssetName,
  mergeXrefsIntoContent,
  readKnowledgeInput,
  resolveSupersedesForWrite,
  resolveSupersedesWriteTarget,
  resolveXrefsForWrite,
  writeMarkdownAsset,
} from "../read/knowledge";
import { importTaskFile } from "./import-task";
import { assembleInfo } from "./info";
import { akmClone } from "./source-clone";

/** Matches the high-frequency per-committed-batch progress line (#954), excluded from non-verbose JSON-mode stderr. */
const EMBEDDED_BATCH_PROGRESS_PATTERN = /^Embedded \d+\/\d+ entries\.$/;

export const indexCommand = defineCommand({
  meta: { name: "index", description: "Build search index (incremental by default; --full forces full reindex)" },
  args: {
    // R-051: `index` is a raw `defineCommand` (not `defineJsonCommand`), so it
    // does not get `GLOBAL_OUTPUT_ARGS` for free. `--format`/`--detail`/
    // `--output` already parsed correctly here (this command has no
    // extra positional for a stray value to fall into), so this is purely a
    // `--help` visibility / consistency fix, not a behavior change.
    ...GLOBAL_OUTPUT_ARGS,
    full: { type: "boolean", description: "Force full reindex", default: false },
    clean: {
      type: "boolean",
      description: "After indexing, remove any entries whose source file no longer exists on disk.",
      default: false,
    },
    "dry-run": {
      type: "boolean",
      description: "When combined with --clean, report stale entries without deleting them.",
      default: false,
    },
    reembed: {
      type: "boolean",
      description: "Discard every stored vector and re-embed all entries under the configured model.",
      default: false,
    },
    "export-vectors": {
      type: "string",
      description:
        "Write the current model's embedding vectors to <file> (no model calls) instead of indexing, so another host can import them. Experimental.",
    },
    "import-vectors": {
      type: "string",
      description:
        "Index as usual, but store vectors found in <file> instead of embedding those entries, so a new host skips embedding. Experimental.",
    },
    "skip-if-locked": {
      type: "boolean",
      description: "Skip (exit 0) instead of waiting if another `akm index` holds the rebuild lock",
      default: false,
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const exportFile = args["export-vectors"];
      if (exportFile !== undefined) {
        if (!exportFile) {
          warn("--export-vectors needs a file path; nothing exported and no index run.");
          return;
        }
        if (args["import-vectors"] !== undefined) warn("--import-vectors is ignored with --export-vectors.");
        output("index", { ok: true, exported: exportVectors(loadConfig(), path.resolve(exportFile)) });
        return;
      }
      const importFile = args["import-vectors"];
      if (importFile === "") warn("--import-vectors needs a file path; indexing without it.");
      const outputMode = getOutputMode();
      const controller = new AbortController();
      const abort = (): void => controller.abort(new Error("index interrupted"));
      process.once("SIGINT", abort);
      process.once("SIGTERM", abort);
      const verbose = isVerbose();
      const spin = !verbose && outputMode.format === "text" ? p.spinner() : null;
      // The log file and spinner start with the build, not while waiting for the lock: a skipped run leaves neither.
      let started = false;
      const begin = (): void => {
        if (started) return;
        started = true;
        setLogFile(path.join(getRunLogDir("index"), `${new Date().toISOString().replace(/[:.]/g, "-")}.log`));
        spin?.start(`Building search index${args.full ? " (full rebuild)" : ""}...`);
      };
      let latestMessage = "";
      const stashDir = resolveStashDir();
      try {
        // One build at a time: wait for a running build, or with --skip-if-locked step aside.
        const result = await buildIndex(
          {
            stashDir,
            full: args.full,
            clean: args.clean,
            dryRun: args["dry-run"],
            reembed: args.reembed,
            importVectors: importFile ? path.resolve(importFile) : undefined,
            onProgress: ({ phase, message, processed, total }) => {
              begin();
              latestMessage = message;
              const progressPrefix = processed !== undefined && total !== undefined ? `[${processed}/${total}] ` : "";
              if (verbose) {
                info(`[index:${phase}] ${progressPrefix}${message}`);
              } else if (spin) {
                spin.stop(`${progressPrefix}${message}`);
                spin.start(`${progressPrefix}${message}`);
              } else if (!EMBEDDED_BATCH_PROGRESS_PATTERN.test(message)) {
                // Structured output modes still show phase starts and the embedding heartbeat on stderr (#954);
                // the per-batch "Embedded N/M" line is excluded as spam.
                info(`[index:${phase}] ${progressPrefix}${message}`);
              }
            },
            signal: controller.signal,
          },
          args["skip-if-locked"] ? "try" : "wait",
        );
        if (isSkippedIndexBuild(result)) {
          output("index", {
            ok: true,
            skipped: {
              reason: "lock-held",
              pid: result.skipped.pid,
              // The launcher pid is what process listings and task logs show, not the bun/node child's.
              launcherPid: result.skipped.launcherPid,
              startedAt: result.skipped.startedAt,
            },
          });
          return;
        }
        if (spin) {
          spin.stop(`Indexed ${result.totalEntries} assets.`);
        }
        output("index", result);
      } catch (error) {
        if (spin && started) {
          spin.stop(latestMessage ? `Indexing failed after: ${latestMessage}` : "Indexing failed.");
        }
        throw error;
      } finally {
        clearLogFile();
        process.off("SIGINT", abort);
        process.off("SIGTERM", abort);
      }
    });
  },
});

export const infoCommand = defineJsonCommand({
  meta: { name: "info", description: "Show system capabilities, configuration, and index stats" },
  run() {
    // `akm info` must behave like a help command: always exit 0 with a
    // report. `assembleInfo()` already degrades what it reasonably can
    // per-section; this is the final backstop for whatever it can't (e.g.
    // every path resolver needs an environment variable, such as `HOME`,
    // that this process genuinely does not have) — still a report, with
    // whatever is cheap and safe enough to never itself throw.
    let result: unknown;
    try {
      result = assembleInfo();
    } catch (err) {
      result = {
        schemaVersion: 1,
        version: pkgVersion,
        error: err instanceof Error ? err.message : String(err),
        assetTypes: [...placementTypes()],
        searchModes: ["fts"],
      };
    }
    output("info", result);
  },
});

export const importKnowledgeCommand = defineJsonCommand({
  meta: {
    name: "import",
    description: "Import a document, explicit asset ref, or typed task file",
  },
  args: {
    source: {
      type: "positional",
      description: "Document file/URL/stdin, asset ref with --asset-ref, or task file with --type task",
      required: true,
    },
    name: {
      type: "string",
      description: "Asset rename, task id, or flat knowledge name (default: source name)",
    },
    "asset-ref": { type: "boolean", description: "Copy source as an asset ref (same behavior as clone)" },
    type: { type: "string", description: "Explicit file type: task" },
    dest: { type: "string", description: "Unmanaged destination directory (requires --asset-ref)" },
    path: {
      type: "string",
      description: "Subdirectory under knowledge/ (e.g. 'projects/example')",
    },
    force: {
      type: "boolean",
      description: "Overwrite an existing destination asset with the same name",
      default: false,
    },
    bundle: {
      type: "string",
      description: "Write destination: a source name (default: defaultWriteTarget)",
    },
    xref: {
      type: "string",
      description: "Asset ref to cross-reference in `xrefs:` (repeatable); it must resolve",
    },
    supersedes: {
      type: "string",
      description: "Ref of an asset this document corrects (repeatable); the old asset is marked superseded",
    },
  },
  async run({ args }) {
    if (args.type !== undefined && args.type !== "task") {
      throw new UsageError("--type accepts only task.", "INVALID_FLAG_VALUE");
    }
    if (args["asset-ref"] || args.type === "task") {
      if (
        (args["asset-ref"] && args.type !== undefined) ||
        args.path !== undefined ||
        args.xref !== undefined ||
        args.supersedes !== undefined ||
        (args.type === "task" && args.dest !== undefined)
      ) {
        throw new UsageError(
          "Asset-ref and task imports cannot combine input modes or use document-only flags; --dest requires --asset-ref.",
          "INVALID_FLAG_VALUE",
        );
      }
      const result = args["asset-ref"]
        ? await akmClone({
            sourceRef: args.source,
            newName: args.name,
            force: args.force,
            target: args.bundle,
            dest: args.dest,
          })
        : await importTaskFile({ source: args.source, name: args.name, force: args.force, target: args.bundle });
      output("import", { ok: true, source: args.source, ...result });
      return;
    }
    if (args.dest !== undefined) throw new UsageError("--dest requires --asset-ref.", "INVALID_FLAG_VALUE");
    // `--name` is a flat name; subdirectory placement is `--path`'s job.
    assertFlatAssetName(args.name);
    // Collect and validate --xref occurrences (repeatable; citty only exposes
    // the last value, so read argv directly). Validation happens BEFORE any
    // read/write so an unresolvable ref (UsageError → exit 2) leaves the
    // stash untouched.
    const rawSupersedes = parseAllFlagValues("--supersedes");
    const writeTarget = resolveSupersedesWriteTarget(rawSupersedes, args.bundle);
    const xrefs = resolveXrefsForWrite(parseAllFlagValues("--xref"), writeTarget);
    // Collect and validate --supersedes occurrences (repeatable). Same
    // before-any-read/write contract: an unresolvable ref exits 2 with nothing
    // imported AND nothing demoted. The superseded refs fold into the imported
    // doc's xrefs automatically (correction provenance); the demotion runs
    // inside writeMarkdownAsset, ordered before the git boundary commit.
    const supersedes = resolveSupersedesForWrite(rawSupersedes, writeTarget);
    for (const s of supersedes) {
      if (!xrefs.includes(s.ref)) xrefs.push(s.ref);
    }
    const config = loadConfig();
    const stashDir = (() => {
      try {
        return resolveWriteTarget(config, writeTarget).source.path;
      } catch (error) {
        if (!writeTarget) throw error;
        try {
          return resolveBundleWriteTarget(config, writeTarget).source.path;
        } catch {
          throw error;
        }
      }
    })();
    const { content, preferredName } = await readKnowledgeInput(args.source, { stashDir });
    // Imported docs may carry their own frontmatter: merge (dedupe-append)
    // BEFORE the write so write-path indexing sees the final content and no
    // second frontmatter block is ever nested.
    // The slug must come from the document BODY: a merged (or self-carried)
    // frontmatter block puts the `---` fence on the first line, which
    // inferAssetName would slugify to "" and fall back to a random
    // knowledge-<epoch>-<rand> name. A stdin import (no filename-derived
    // preferredName) therefore pre-infers the name from the pre-merge
    // content's PARSED body — not the raw text, whose first line is the fence
    // whenever the piped doc carries its own frontmatter — so --xref/
    // --supersedes never change the slug and a frontmattered doc gets its
    // heading-derived slug on every path.
    const result = await writeMarkdownAsset({
      type: "knowledge",
      content: mergeXrefsIntoContent(content, xrefs),
      name: args.name ?? (isHttpUrl(args.source) ? preferredName : undefined),
      fallbackPrefix: "knowledge",
      preferredName: preferredName ?? inferAssetName(parseFrontmatter(content).content, "knowledge"),
      force: args.force,
      target: writeTarget,
      path: args.path,
      supersedes,
    });
    appendEvent({
      eventType: "import",
      ref: result.ref,
      metadata: { source: args.source, path: result.path, force: args.force === true },
    });
    output("import", { ok: true, source: args.source, ...result });
  },
});
