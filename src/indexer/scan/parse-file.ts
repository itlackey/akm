// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The per-file document parse: one file, dispatched through one adapter's
 * `recognize`, reconstructed into a durable `IndexDocument`.
 *
 * Extracted from `drain-dir.ts` (index-redesign B1) so the reconcile engine
 * (`../reconcile.ts`) can parse a single changed file exactly the way the
 * full-directory drain does, without duplicating the recognize → conceptId
 * check → workflow-validity fold. `drainDirDocuments` keeps everything that
 * is genuinely directory-scoped (peer-workflow-format ownership arbitration
 * across the files in one drain) and calls this for each file it has already
 * decided to parse.
 */

import type { BundleAdapter } from "../../core/adapter/bundle-adapter";
import type { BundleComponent, IndexDocument } from "../../core/adapter/types";
import { compileWorkflowSource } from "../../workflows/source-ir/compile";
import { buildMetadataSkipWarning } from "../passes/metadata";
import type { FileContext } from "../walk/file-context";
import { indexDocumentToStashEntry } from "./doc-to-entry";

/** The markdown-workflow renderer name the `akm` adapter carries on `documentJson.renderer`. */
const WORKFLOW_MD_RENDERER = "workflow-md";

/** A successfully recognized file, ready to persist. */
export interface ParsedFile {
  /** The reconstructed durable entry (`indexDocumentToStashEntry(doc)`). */
  entry: IndexDocument;
  /** `doc.hash` — sha256 over the file's full raw content, when the adapter set one. */
  hash: string | undefined;
  /** `doc.conceptId` — the owning adapter's identity for this file. */
  conceptId: string;
}

/**
 * Outcome of parsing one file through one adapter.
 *
 * `parsed` is set exactly when the file yields a durable entry; `warning` is
 * set exactly when the file was skipped WITH a reason worth surfacing (a
 * missing conceptId, or a workflow that fails to compile). A file the
 * adapter silently abstains on (no matcher claims it) returns both `null` —
 * the same "no matcher claims the file" contract `drainDirDocuments` has
 * always had.
 */
export interface ParseFileOutcome {
  parsed: ParsedFile | null;
  warning: string | null;
  /** True when `warning` is specifically a broken-workflow drop (vs. a missing conceptId). */
  isWorkflowDrop: boolean;
}

/**
 * Parse one file through `adapter.recognize`, reconstruct its durable entry,
 * and drop it with a warning when it names no conceptId or is a workflow
 * document that fails to compile. Pure of DB/global state.
 */
export function parseFileDocument(
  adapter: BundleAdapter,
  component: BundleComponent,
  file: FileContext,
): ParseFileOutcome {
  const doc = adapter.recognize(component, file);
  if (doc === null) return { parsed: null, warning: null, isWorkflowDrop: false };

  if (!doc.conceptId) {
    return {
      parsed: null,
      warning: `Skipped ${file.absPath}: adapter "${adapter.id}" returned no conceptId.`,
      isWorkflowDrop: false,
    };
  }

  const entry = indexDocumentToStashEntry(doc);
  const dropWarning = handleWorkflowDoc(doc, file, component.root);
  if (dropWarning !== null) {
    return { parsed: null, warning: dropWarning, isWorkflowDrop: true };
  }

  return { parsed: { entry, hash: doc.hash, conceptId: doc.conceptId }, warning: null, isWorkflowDrop: false };
}

/**
 * If `doc` is a workflow, compile it through source IR: return a
 * `Skipped workflow …` drop warning when it is broken, or return `null` when
 * it compiles. Non-workflow docs return `null` immediately.
 */
function handleWorkflowDoc(doc: IndexDocument, file: FileContext, workspaceRoot: string): string | null {
  if (
    doc.type !== "workflow" ||
    (doc.adapterId !== "akm" && doc.adapterId !== "akm-workflow") ||
    (docRenderer(doc) !== WORKFLOW_MD_RENDERER && doc.adapterId !== "akm-workflow")
  ) {
    return null;
  }

  const result = compileWorkflowSource(file.content(), { path: file.relPath, workspaceRoot });
  if (!result.ok) return workflowDropWarning(file, result.errors);
  return null;
}

/** The winning renderer name the `akm` adapter carries on `documentJson.renderer`, or `undefined`. */
function docRenderer(doc: IndexDocument): string | undefined {
  const dj = doc.documentJson;
  if (dj !== null && typeof dj === "object" && "renderer" in dj) {
    const renderer = (dj as { renderer?: unknown }).renderer;
    return typeof renderer === "string" ? renderer : undefined;
  }
  return undefined;
}

/**
 * Build the `Skipped workflow <path>:\n…` warning byte-for-byte the way the live
 * pipeline did: the workflow parser's `path:line — message` summary wrapped in
 * the `Workflow has errors:` prefix (the string `loadDocument`/`loadProgram`
 * threw), then {@link buildMetadataSkipWarning}'s workflow branch.
 */
function workflowDropWarning(file: FileContext, errors: ReadonlyArray<{ line: number; message: string }>): string {
  const summary = errors.map((e) => `${file.relPath}:${e.line} — ${e.message}`).join("\n");
  return buildMetadataSkipWarning(file.absPath, "workflow", `Workflow has errors:\n${summary}`);
}
