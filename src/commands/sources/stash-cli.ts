// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Stash-lifecycle command cluster — the create/index/ingest/inspect verbs for
 * the working stash and its index database: `akm init` (create the stash +
 * persist stashDir), `akm index` (build/refresh the search index), `akm import`
 * (ingest a knowledge doc/URL), and `akm info` (system capabilities + index
 * stats).
 * Extracted verbatim from src/cli.ts (WS6) so the God Module shrinks; the
 * `main.subCommands.{init,index,import,info}` keys and every subcommand's
 * args/output shape stay byte-identical.
 *
 * These share no private helper with any command still inline in cli.ts — every
 * dependency is already exported from a shared module (core/paths, core/warn,
 * core/errors, core/events, output/context, cli/shared, cli/parse-args, plus the
 * per-command implementations in ./init, ./indexer, ./info, ./knowledge,
 * ./core/asset-create, ./core/common), so the cluster moves with zero hoisting.
 *
 * The leaf handlers whose body is a plain `runWithJsonErrors(...) + output(...)`
 * (`init`, `import`, `info`) are migrated onto
 * `defineJsonCommand`, which emits the same JSON envelope (stdout/stderr/
 * exit-code) as the inline form. `index` keeps a plain `defineCommand` wrapping
 * `runWithJsonErrors` because its body owns a spinner, an AbortController, and
 * SIGINT/SIGTERM handlers in a try/finally — left byte-for-byte untouched.
 */

import path from "node:path";
import { defineCommand } from "citty";
import * as p from "../../cli/clack";
import { getParsedInvocation } from "../../cli/invocation";
import { defineJsonCommand, output, parseAllFlagValues, runWithJsonErrors } from "../../cli/shared";
import { assertFlatAssetName } from "../../core/asset/asset-create";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { isHttpUrl, resolveStashDir } from "../../core/common";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { getCacheDir } from "../../core/paths";
import { clearLogFile, info, isVerbose, setLogFile } from "../../core/warn";
import { resolveWriteTarget } from "../../core/write-source";
import { akmIndex } from "../../indexer/indexer";
import { getHyphenatedBoolean, getOutputMode } from "../../output/context";
import {
  inferAssetName,
  mergeXrefsIntoContent,
  readKnowledgeInput,
  resolveSupersedesForWrite,
  resolveXrefsForWrite,
  writeMarkdownAsset,
} from "../read/knowledge";
import { assembleInfo } from "./info";
import { akmInit } from "./init";

export const initCommand = defineJsonCommand({
  meta: {
    name: "init",
    description: "Initialize akm's working stash directory and persist stashDir in config",
  },
  args: {
    dir: { type: "string", description: "Custom stash directory path (default: ~/akm)" },
    "set-default": {
      type: "boolean",
      description:
        "Make --dir the default stash (write stashDir to config.json). Without this, `akm init --dir X` scaffolds X but leaves your existing default stash unchanged.",
      default: false,
    },
  },
  async run({ args }) {
    // Accept both historical spellings for backwards compatibility with
    // older docs/scripts that used `--stashDir`.
    const invocation = getParsedInvocation();
    const legacyDir = invocation.getFlagValue("--stashDir") ?? invocation.getFlagValue("--stash-dir");
    const result = await akmInit({
      dir: args.dir ?? legacyDir,
      setDefault: args["set-default"],
    });
    output("init", result);
  },
});

export const indexCommand = defineCommand({
  meta: { name: "index", description: "Build search index (incremental by default; --full forces full reindex)" },
  args: {
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
    background: {
      type: "boolean",
      description: "Run as a background process (suppresses interactive output, manages PID file).",
      default: false,
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      if (getHyphenatedBoolean(args, "enrich") || getParsedInvocation().getFlagValue("--enrich") !== undefined) {
        throw new UsageError(
          "`akm index --enrich` has been removed. Plain `akm index` now performs metadata enrichment by default.",
        );
      }
      if (getHyphenatedBoolean(args, "re-enrich") || getParsedInvocation().getFlagValue("--re-enrich") !== undefined) {
        throw new UsageError(
          "`akm index --re-enrich` has been removed. Re-enrichment of index-time LLM passes is not exposed in this slice.",
        );
      }
      const isBackground = args.background === true;
      const outputMode = getOutputMode();
      const controller = new AbortController();
      const abort = (): void => controller.abort(new Error("index interrupted"));
      process.once("SIGINT", abort);
      process.once("SIGTERM", abort);
      const indexLogFile = path.join(
        getCacheDir(),
        "logs",
        "index",
        `${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
      );
      setLogFile(indexLogFile);
      const verbose = isVerbose();
      const spin = !verbose && !isBackground && outputMode.format === "text" ? p.spinner() : null;
      if (spin) {
        spin.start(`Building search index${args.full ? " (full rebuild)" : ""}...`);
      }
      let latestMessage = "";
      // Resolve the stash dir once at the `akm index` command boundary and
      // thread it into the indexer (WI-9.10 CLI-wide sweep) — the indexer leaf
      // no longer reads the ambient `resolveStashDir()`.
      const stashDir = resolveStashDir();
      try {
        const result = await akmIndex({
          stashDir,
          full: args.full,
          clean: args.clean,
          dryRun: args["dry-run"],
          onProgress: ({ phase, message, processed, total }) => {
            latestMessage = message;
            const progressPrefix = processed !== undefined && total !== undefined ? `[${processed}/${total}] ` : "";
            if (verbose) {
              info(`[index:${phase}] ${progressPrefix}${message}`);
            } else if (spin) {
              spin.stop(`${progressPrefix}${message}`);
              spin.start(`${progressPrefix}${message}`);
            }
          },
          signal: controller.signal,
        });
        if (spin) {
          spin.stop(`Indexed ${result.totalEntries} assets.`);
        }
        if (!isBackground) {
          output("index", result);
        }
      } catch (error) {
        if (spin) {
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
    const result = assembleInfo();
    output("info", result);
  },
});

export const importKnowledgeCommand = defineJsonCommand({
  meta: {
    name: "import",
    description: "Import a knowledge document or URL into the default stash",
  },
  args: {
    source: {
      type: "positional",
      description: 'Source file path, URL, or "-" to read from stdin',
      required: true,
    },
    name: {
      type: "string",
      description:
        "Knowledge name (flat, no '/'; defaults to the source filename or content slug). Use --path for a subdirectory.",
    },
    path: {
      type: "string",
      description:
        "Relative subdirectory under knowledge/ to place the document in (e.g. 'projects/example'). The filename still comes from --name or the source slug.",
    },
    force: {
      type: "boolean",
      description: "Overwrite an existing knowledge document with the same name",
      default: false,
    },
    target: {
      type: "string",
      description:
        "Override the write destination. Accepts a source name from your config; falls back to defaultWriteTarget then the working stash.",
    },
    xref: {
      type: "string",
      description:
        "Cross-reference ref merged into the document's `xrefs:` frontmatter (repeatable: --xref knowledge:auth-flow). Existing frontmatter is preserved (dedupe-append, never a nested block); a document whose frontmatter is not parseable YAML aborts the import rather than being rewritten lossily. Each ref must resolve in the write target or a configured source; an unresolvable ref aborts the import.",
    },
    supersedes: {
      type: "string",
      description:
        "Ref of an existing asset this document corrects (repeatable: --supersedes knowledge:legacy-guide). Imports the correction with an xref to the old asset AND demotes the old asset (`beliefState: superseded` + `supersededBy`, a metadata-only edit) so ranking prefers the correction and `--belief current` hides the stale version. An unresolvable or self-referencing ref aborts the import; a ref outside the write target and working stash still imports the correction but skips the demotion (reported as applied: false).",
    },
  },
  async run({ args }) {
    // `--name` is a flat name; subdirectory placement is `--path`'s job.
    assertFlatAssetName(args.name);
    // Collect and validate --xref occurrences (repeatable; citty only exposes
    // the last value, so read argv directly). Validation happens BEFORE any
    // read/write so an unresolvable ref (UsageError → exit 2) leaves the
    // stash untouched.
    const xrefs = resolveXrefsForWrite(parseAllFlagValues("--xref"), args.target);
    // Collect and validate --supersedes occurrences (repeatable). Same
    // before-any-read/write contract: an unresolvable ref exits 2 with nothing
    // imported AND nothing demoted. The superseded refs fold into the imported
    // doc's xrefs automatically (correction provenance); the demotion runs
    // inside writeMarkdownAsset, ordered before the git boundary commit.
    const supersedes = resolveSupersedesForWrite(parseAllFlagValues("--supersedes"), args.target);
    for (const s of supersedes) {
      if (!xrefs.includes(s.ref)) xrefs.push(s.ref);
    }
    const stashDir = resolveWriteTarget(loadConfig(), args.target).source.path;
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
      target: args.target,
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
