// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import workflowTemplate from "../../assets/workflows/workflow-template.md" with { type: "text" };
import { ensureAkmMarkdownType } from "../../core/asset/akm-markdown";
import { makeBundleRef } from "../../core/asset/asset-ref";
import { isWithin, writeFileAtomic } from "../../core/common";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { defaultBundleForTarget } from "../../core/mutation-target";
import { canonicalizeWorkflowName, WORKFLOW_EXTENSIONS } from "../../core/recognition-util";
import { warn } from "../../core/warn";
import { prepareWriteTargetForMutation, resolveWriteTarget, withWriteTargetMutation } from "../../core/write-source";
import { checkWorkflowPlan, compileWorkflowSource } from "../compile";
import type { WorkflowError } from "../plan";

const DEFAULT_WORKFLOW_TEMPLATE = renderWorkflowTemplate("New Workflow");

export function getWorkflowTemplate(): string {
  return DEFAULT_WORKFLOW_TEMPLATE;
}

export function buildWorkflowTemplate(name?: string): string {
  if (!name) return DEFAULT_WORKFLOW_TEMPLATE;

  // Only the H1 is customized. Step ids are STRUCTURAL in the Markdown authoring form
  // — each appears in `steps[].id`, as a body `## <id>` heading, and possibly in
  // another step's `inputs:` — so rewriting them from a name would have to patch
  // three places consistently to stay parseable. Generic `first-step`/
  // `second-step` are the author's to rename.
  const customized = renderWorkflowTemplate(humanizeWorkflowName(name));
  validateWorkflowContent(customized, `<template:${name}>.md`);
  return customized;
}

/** Parse AND compile `content`, so a create never writes an asset that `show`/`start`/`validate` would then reject. */
function validateWorkflowContent(content: string, sourcePath: string): void {
  const result = compileWorkflowSource(content, { path: sourcePath });
  if (!result.ok) {
    throw new UsageError(formatWorkflowErrors(sourcePath, result.errors));
  }
  const compiled = checkWorkflowPlan(result.plan);
  if (!compiled.ok) {
    throw new UsageError(formatWorkflowErrors(sourcePath, compiled.errors));
  }
}

/** Peer YAML is executable, but `akm workflow create` emits the Markdown authoring form only. */
const YAML_SUFFIX_RE = /\.ya?ml$/i;

export function assertWorkflowMarkdownName(name: string): void {
  if (!YAML_SUFFIX_RE.test(name.trim())) return;
  throw new UsageError(
    `akm workflow create is markdown-only: it emits Markdown and cannot create "${name}". ` +
      `Use a plain name (no ".yaml"/".yml" suffix), or author a peer GitHub-shaped ".yml" workflow directly.`,
  );
}

// 0.9.2 review round 2 (P4 sweep criterion-21 caveat, spec
// docs/plans/specs/p4-deletions-closeout.md §4.1 row B-49): this return's
// third member was `stashDir` through 0.9.1 and leaked verbatim into the
// `akm workflow create` JSON envelope (Stable per STABILITY.md) via
// `output("workflow-create", { ok: true, ...result })`
// (src/commands/workflow-cli.ts). Renamed to `bundleDir` here — the same
// value-preserving field rename `RunTaskOptions.stashDir` got in P1b (see
// src/tasks/run/task-result.ts's header, F-3) — so the shipped envelope now
// matches current bundle vocabulary. BREAKING vs 0.9.1's envelope shape.
export function createWorkflowAsset(input: { name: string; content?: string; from?: string; force?: boolean }): {
  ref: string;
  path: string;
  bundleDir: string;
} {
  assertWorkflowMarkdownName(input.name);

  const config = loadConfig();
  const resolvedTarget = resolveWriteTarget(config);
  const target = prepareWriteTargetForMutation(resolvedTarget, { allowedAdapters: ["akm", "akm-workflow"] });
  const bundleDir = target.source.path;
  const standaloneWorkflowBundle = target.source.adapterId === "akm-workflow";
  const typeRoot = standaloneWorkflowBundle ? bundleDir : path.join(bundleDir, "workflows");

  const normalizedName = normalizeWorkflowName(input.name);
  const conceptId = standaloneWorkflowBundle ? normalizedName : `workflows/${normalizedName}`;
  const assetPath = path.join(typeRoot, `${normalizedName}.md`);
  const relativeAssetPath = path.relative(path.resolve(typeRoot), path.resolve(assetPath));
  if (
    relativeAssetPath === ".." ||
    relativeAssetPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeAssetPath)
  ) {
    throw new UsageError(`Resolved workflow path escapes the bundle: "${normalizedName}"`, "PATH_ESCAPE_VIOLATION");
  }
  // A peer `.md` or `.yml` file whose canonical name matches already owns this
  // ref. Case variants (`upper.MD` vs `upper.md`) may also name one physical
  // file on a case-insensitive filesystem, so writing the Markdown create
  // target would silently clobber or shadow the existing asset.
  const shadowing = findExistingWorkflowPaths(typeRoot, normalizedName).find((p) => p !== assetPath);
  if (shadowing !== undefined) {
    throw new UsageError(
      `Workflow "${normalizedName}" already exists as ${path.relative(bundleDir, shadowing)} — the ` +
        `\`${conceptId}\` ref resolves to that file, so creating this one would shadow it. ` +
        `Remove or rename the existing file first, or create the workflow under a different name.`,
      "RESOURCE_ALREADY_EXISTS",
    );
  }
  if (fs.existsSync(assetPath) && !input.force) {
    throw new UsageError(
      `Workflow "${normalizedName}" already exists. Re-run with --force to overwrite it.`,
      "RESOURCE_ALREADY_EXISTS",
    );
  }

  const content = input.from
    ? readWorkflowSource(input.from, bundleDir)
    : (input.content ?? buildWorkflowTemplate(normalizedName));
  const sourcePath = input.from ?? `workflows/${normalizedName}.md`;

  validateWorkflowContent(content, sourcePath);

  const authoredContent = ensureAkmMarkdownType(content, "workflow");
  const mode = fs.existsSync(assetPath) ? fs.lstatSync(assetPath).mode & 0o777 : 0o644;

  const defaultBundle = defaultBundleForTarget(config);
  const ref = makeBundleRef(target.source.name === defaultBundle ? undefined : target.source.name, conceptId);
  withWriteTargetMutation(target, [assetPath], { purpose: "workflow-authoring", message: `Create ${ref}` }, () => {
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    writeFileAtomic(assetPath, authoredContent.endsWith("\n") ? authoredContent : `${authoredContent}\n`, mode);
  });

  return {
    ref,
    path: assetPath,
    bundleDir,
  };
}

function readWorkflowSource(source: string, bundleDir: string): string {
  const resolved = path.resolve(source);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new UsageError(`Workflow source not found: "${source}".`);
  }
  if (!stat.isFile()) {
    throw new UsageError(`Workflow source must be a file: "${source}".`);
  }
  // The user is allowed to import any readable file as a workflow body, but
  // an import from outside the stash is unusual enough to warn about. Anyone
  // running `akm workflow create --from /etc/passwd` deserves a heads-up.
  if (!isWithin(resolved, bundleDir)) {
    warn(
      `Importing workflow content from outside the stash: ${resolved}\n  ` +
        `If this was unintentional, abort and re-run with a --from path inside ${bundleDir}.`,
    );
  }
  return fs.readFileSync(resolved, "utf8");
}

function normalizeWorkflowName(name: string): string {
  // Strip a recognized workflow extension (.md) so the canonical name — and
  // thus the `workflows/<name>` ref — is extension-free regardless of how the
  // user spelled it.
  const normalized = canonicalizeWorkflowName(
    name
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, ""),
  );
  if (!normalized) {
    throw new UsageError("Workflow name cannot be empty.");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new UsageError("Workflow name must be a relative path without '.' or '..' segments.");
  }
  return normalized;
}

function humanizeWorkflowName(name: string): string {
  return (
    name
      .split("/")
      .pop()
      ?.replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (match) => match.toUpperCase())
      .trim() || "New Workflow"
  );
}

export function formatWorkflowErrors(path: string, errors: WorkflowError[]): string {
  const lines = errors.map((e) => `  ${path}:${e.line} — ${e.message}`);
  const heading = errors.length === 1 ? "Workflow has 1 error:" : `Workflow has ${errors.length} errors:`;
  return [heading, ...lines].join("\n");
}

/**
 * Every file under `typeRoot` whose canonical workflow name equals
 * `normalizedName`. Peer `.md`/`.yml` extension matching is case-INSENSITIVE,
 * so both cross-format owners and case variants are returned for the create
 * path to refuse rather than silently clobber or shadow them.
 */
function findExistingWorkflowPaths(typeRoot: string, normalizedName: string): string[] {
  const parent = path.join(typeRoot, path.dirname(normalizedName));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const basename = path.basename(normalizedName);
  return WORKFLOW_EXTENSIONS.flatMap((extension) =>
    entries
      .filter((entry) => {
        if (!entry.isFile() && !entry.isSymbolicLink()) return false;
        const entryExtension = path.extname(entry.name);
        return entryExtension.toLowerCase() === extension && entry.name.slice(0, -entryExtension.length) === basename;
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => path.join(parent, entry.name)),
  );
}

function renderWorkflowTemplate(title: string): string {
  return workflowTemplate.replace("{{TITLE}}", title);
}
