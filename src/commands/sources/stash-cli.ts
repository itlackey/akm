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
import * as p from "../../cli/clack";
import { getParsedInvocation } from "../../cli/invocation";
import {
  defineGroupCommand,
  defineJsonCommand,
  GLOBAL_OUTPUT_ARGS,
  output,
  parseAllFlagValues,
} from "../../cli/shared";
import { assertFlatAssetName } from "../../core/asset/asset-create";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { isHttpUrl, resolveStashDir } from "../../core/common";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { resolveBundleWriteTarget } from "../../core/mutation-target";
import { getCacheDir } from "../../core/paths";
import { clearLogFile, info, isVerbose, setLogFile, warn } from "../../core/warn";
import { resolveWriteTarget } from "../../core/write-source";
import { DRAIN_BATCH_PROGRESS_PREFIX } from "../../indexer/drain";
import { akmIndex } from "../../indexer/indexer";
import { RECONCILE_ROOT_PROGRESS_PREFIX } from "../../indexer/reconcile";
import { getHyphenatedBoolean, getOutputMode } from "../../output/context";
import {
  inferAssetName,
  mergeXrefsIntoContent,
  readKnowledgeInput,
  resolveSupersedesForWrite,
  resolveSupersedesWriteTarget,
  resolveXrefsForWrite,
  writeMarkdownAsset,
} from "../read/knowledge";
import { assembleIndexStatus } from "./index-status";
import { assembleInfo } from "./info";

/**
 * The two high-frequency, one-line-per-unit-of-work progress lines (#954) —
 * drain's per-batch commit line and reconcile's per-root "done" line —
 * excluded from non-verbose, non-text (JSON/yaml/etc) stderr. Matched by the
 * exact prefix each producer exports, not a re-derived regex, so the two
 * never drift apart (index-redesign B5g): this used to be a regex tuned to
 * the deleted per-entry pipeline's `Embedded N/M entries.` line, which never
 * matched either replacement line, so every progress line reached stderr
 * regardless of `--verbose`.
 */
function isDetailProgressLine(message: string): boolean {
  return message.startsWith(DRAIN_BATCH_PROGRESS_PREFIX) || message.startsWith(RECONCILE_ROOT_PROGRESS_PREFIX);
}

export const indexStatusCommand = defineJsonCommand({
  meta: {
    name: "status",
    description: "Show index.db's current state: files, entries, unit coverage, and the last reconcile time.",
  },
  run() {
    output("index-status", assembleIndexStatus());
  },
});

/**
 * `akm index` = reconcile + drain (docs/plans/index-redesign.md). Still a raw
 * group command (not `defineJsonCommand`) because its default body owns a
 * spinner, an AbortController, and SIGINT/SIGTERM handlers in a try/finally;
 * `defineGroupCommand` gives it `status` as a real subcommand while keeping
 * that default body as plain `akm index`'s behavior (S-057 canonical
 * bare-group rule does not apply here — a bare `akm index` has always run the
 * indexer, and that stays).
 */
export const indexCommand = defineGroupCommand({
  meta: {
    name: "index",
    description: "Reconcile the search index and drain the embedding queue (--full forces a full re-derivation)",
  },
  args: {
    // R-051: `index` is a raw `defineCommand` (not `defineJsonCommand`), so it
    // does not get `GLOBAL_OUTPUT_ARGS` for free. `--format`/`--detail`/
    // `--shape`/`--output` already parsed correctly here (this command has no
    // extra positional for a stray value to fall into), so this is purely a
    // `--help` visibility / consistency fix, not a behavior change.
    ...GLOBAL_OUTPUT_ARGS,
    full: {
      type: "boolean",
      description:
        "Force every file to be re-derived (ignore the unchanged-file shortcut), reconciling in place — " +
        "existing rows keep their id/embeddings/utility scores; nothing is dropped first.",
      default: false,
    },
    reembed: {
      type: "boolean",
      description: "Drop the active embedding identity's vectors, then re-embed every unit from scratch.",
      default: false,
    },
    "skip-if-locked": {
      type: "boolean",
      description:
        "Deprecated, no effect. Index runs no longer take a rebuild lock (docs/plans/index-redesign.md) — " +
        "every write is a short, idempotent, content-addressed transaction, so two concurrent index runs " +
        "converge instead of contending. Kept only so existing scripts do not fail on an unknown flag.",
      default: false,
    },
  },
  subCommands: { status: indexStatusCommand },
  async defaultRun({ args }) {
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
    if (args["skip-if-locked"]) {
      warn("[index] --skip-if-locked is deprecated and has no effect — index runs no longer take a rebuild lock.");
    }
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
    const spin = !verbose && outputMode.format === "text" ? p.spinner() : null;
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
        reembed: args.reembed,
        onProgress: ({ phase, message, processed, total }) => {
          latestMessage = message;
          const progressPrefix = processed !== undefined && total !== undefined ? `[${processed}/${total}] ` : "";
          if (verbose) {
            info(`[index:${phase}] ${progressPrefix}${message}`);
          } else if (spin) {
            spin.stop(`${progressPrefix}${message}`);
            spin.start(`${progressPrefix}${message}`);
          } else if (!isDetailProgressLine(message)) {
            // Non-verbose, non-text (JSON/yaml/etc) mode: silence used to be
            // total until the run finished (#954) — a stalled
            // run looked identical to "nothing written". Phase-start
            // messages, the credential diagnostic, and the reconcile/drain
            // totals now reach stderr here too; the high-frequency
            // per-root `Reconciled "…"` and per-batch `[drain] batch N: …`
            // lines are deliberately excluded — that would be spam, not a
            // heartbeat. `--verbose` (the `if` branch above) still gets
            // every one of them.
            info(`[index:${phase}] ${progressPrefix}${message}`);
          }
        },
        signal: controller.signal,
      });
      if (spin) {
        spin.stop(`Indexed ${result.totalEntries} assets.`);
      }
      output("index", result);
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
    description: "Import a knowledge document or URL into the default bundle",
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
        "Override the write destination. Accepts a source name from your config; falls back to defaultWriteTarget then the working bundle.",
    },
    xref: {
      type: "string",
      description:
        "Cross-reference ref merged into the document's `xrefs:` frontmatter (repeatable: --xref knowledge/auth-flow). Existing frontmatter is preserved (dedupe-append, never a nested block); a document whose frontmatter is not parseable YAML aborts the import rather than being rewritten lossily. Each ref must resolve in the write target or a configured source; an unresolvable ref aborts the import.",
    },
    supersedes: {
      type: "string",
      description:
        "Ref of an existing asset this document corrects (repeatable: --supersedes knowledge/legacy-guide). Imports the correction with an xref to the old asset AND demotes the old asset (`beliefState: superseded` + `supersededBy`, a metadata-only edit) so ranking prefers the correction and `--belief current` hides the stale version. An unresolvable or self-referencing ref aborts the import; a ref outside the write target and working bundle still imports the correction but skips the demotion (reported as applied: false).",
    },
  },
  async run({ args }) {
    // `--name` is a flat name; subdirectory placement is `--path`'s job.
    assertFlatAssetName(args.name);
    // Collect and validate --xref occurrences (repeatable; citty only exposes
    // the last value, so read argv directly). Validation happens BEFORE any
    // read/write so an unresolvable ref (UsageError → exit 2) leaves the
    // stash untouched.
    const rawSupersedes = parseAllFlagValues("--supersedes");
    const writeTarget = resolveSupersedesWriteTarget(rawSupersedes, args.target);
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
