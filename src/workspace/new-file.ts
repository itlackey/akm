// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A new file in a folder of a bundle. akm types the folder (the indexer's own directory rules), starts the file with the
 * text its type starts with (the workflow and task creators' own, the keys the type's validators require), and writes it
 * through the writer every authored file goes through, so the same checks apply to every type. A folder with no type gets
 * an empty file of the name given.
 */

import fs from "node:fs";
import path from "node:path";
import { renderTaskYaml } from "../commands/tasks/tasks";
import { assertFlatAssetName, normalizeCreateSubPath } from "../core/asset/asset-create";
import { refForFile } from "../core/asset/asset-placement";
import { serializeFrontmatter } from "../core/asset/asset-serialize";
import { frontmatterKeysFor } from "../core/asset/type-keys";
import { isWithin } from "../core/common";
import { loadConfig } from "../core/config/config";
import { UsageError } from "../core/errors";
import { appendEvent } from "../core/events";
import { resolveBundleWriteTarget } from "../core/mutation-target";
import {
  assertPlainWritable,
  assertWritableSource,
  commitWriteTargetBoundary,
  prepareWriteTargetForMutation,
  writeSourceFile,
} from "../core/write-source";
import { indexWrittenAssets } from "../indexer/index-written-assets";
import { buildFileContext } from "../indexer/walk/file-context";
import { declaredTypeForPath } from "../indexer/walk/matchers";
import { buildWorkflowTemplate } from "../workflows/authoring/authoring";
import { type FileVerdict, folderBlocker, plainWriteBlocker, type WriteBlockers } from "./file-actions";
import { interactive } from "./lease";

/** The extensions a new file may take, in the order a folder's type is tried when the name gives none. */
const EXTENSIONS = [".md", ".yml", ".sh"];

const typeAt = (relative: string): string | undefined =>
  declaredTypeForPath(buildFileContext("/", path.posix.join("/", relative)));

/** The file name a new file gets in `folder` and the type its place declares (null: none). `name` absent asks about the folder alone. */
export function planNewFile(folder: string, name?: string): { type: string | null; fileName: string | undefined } {
  const candidates =
    name === undefined
      ? EXTENSIONS.map((ext) => `new${ext}`)
      : path.posix.extname(name)
        ? [name]
        : EXTENSIONS.map((ext) => `${name}${ext}`);
  for (const fileName of candidates) {
    const type = typeAt(path.posix.join(folder, fileName));
    if (type !== undefined) return { type, fileName: name === undefined ? undefined : fileName };
  }
  return { type: null, fileName: name };
}

/** The top-level folder akm's env and secret operations write to, and what a file made there is. */
const PROTECTED_FOLDERS: Record<string, "env" | "secret"> = { env: "env", secrets: "secret" };

/**
 * Whether a new file may be made in `folder` of the bundle, and the type it would have. Listings report it for the folder shown.
 * A file made in the top-level `env/` or `secrets/` is an environment file or a secret, made through the protected editor
 * (`through`), not by `documents.createFile`.
 */
export function newFileVerdict(
  folder: string,
  blockers: WriteBlockers,
): FileVerdict & { type: string | null; through?: "protected-editor" } {
  const protectedType = PROTECTED_FOLDERS[folder];
  if (protectedType !== undefined)
    return blockers.plain === null
      ? { allowed: true, type: protectedType, through: "protected-editor" }
      : { allowed: false, reason: blockers.plain, type: protectedType };
  const { type } = planNewFile(folder);
  // A typed asset goes through akm's writer; a file of no type is a plain file.
  const blocker = folderBlocker(folder) ?? blockers.plain ?? (type === null ? null : blockers.asset);
  if (blocker !== null) return { allowed: false, reason: blocker, type: null };
  return type === "skill"
    ? { allowed: false, reason: "A skill is a folder with a SKILL.md: create the folder first.", type }
    : { allowed: true, type };
}

const humanize = (name: string): string =>
  name
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim() || "New file";

/** The text a new file of `type` starts with, from the owners that already create it. */
function startingText(type: string, stem: string): string {
  if (type === "workflow") return buildWorkflowTemplate(stem);
  if (type === "task") return renderTaskYaml({ id: stem, schedule: "", command: 'echo "replace this command"' });
  if (type === "script") return "";
  const asked = frontmatterKeysFor(type).filter((known) => known.required && known.stamped !== true);
  const keys = Object.fromEntries(asked.map((known) => [known.key, known.key === "name" ? stem : ""]));
  const frontmatter = Object.keys(keys).length > 0 ? `---\n${serializeFrontmatter(keys)}\n---\n\n` : "";
  return `${frontmatter}# ${humanize(stem)}\n`;
}

export interface CreateFileInput {
  bundle: string;
  /** The folder inside the bundle; the bundle root when absent. */
  folder?: string;
  name: string;
  /** The text to start with; the type's starting text when absent. */
  content?: string;
}

function required(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim()) throw new UsageError(`${key} is required.`);
  return value.trim();
}

/** A new file in a folder, for any type. An existing file is refused. */
export async function createFile(input: CreateFileInput) {
  const bundle = required(input.bundle, "bundle");
  const name = required(input.name, "name");
  assertFlatAssetName(name);
  if (name === "." || name === ".." || name.includes("\0")) throw new UsageError(`"${name}" is not a file name.`);
  const folder = normalizeCreateSubPath(input.folder);
  if (typeof input.content !== "string" && input.content !== undefined) throw new UsageError("content must be text.");
  return interactive("ui-file-create", async () => {
    const config = loadConfig();
    const blocker = folderBlocker(folder) ?? plainWriteBlocker(config, bundle);
    if (blocker !== null) throw new UsageError(blocker);
    const { type, fileName } = planNewFile(folder, name);
    // A file of no type is a plain file; a typed asset goes through akm's writer, which takes akm bundles only.
    const resolved = resolveBundleWriteTarget(config, bundle, { requireWritable: true });
    const target = prepareWriteTargetForMutation(
      resolved,
      type === null ? { allowedAdapters: [resolved.source.adapterId ?? "akm"] } : undefined,
    );
    if (type === null) assertPlainWritable(target.source, target.config);
    else assertWritableSource(target.source, target.config);
    if (type === "skill" && fileName !== "SKILL.md")
      throw new UsageError("A skill is a folder with a SKILL.md: create the folder first.");
    const root = target.source.path;
    const file = path.join(root, folder, fileName as string);
    if (!isWithin(file, root)) throw new UsageError(`"${name}" resolves outside the bundle.`, "PATH_ESCAPE_VIOLATION");
    if (fs.existsSync(file))
      throw new UsageError("That file name is already used in this folder.", "RESOURCE_ALREADY_EXISTS");
    const relative = path.posix.join(folder, fileName as string);
    const stem = path.posix.basename(fileName as string, path.posix.extname(fileName as string));
    const content = input.content ?? (type === null ? "" : startingText(type, stem));
    writeSourceFile(target.source, file, content, relative, type ?? undefined);
    commitWriteTargetBoundary(target, `Create ${relative}`);
    const indexed = await indexWrittenAssets(root, [file], { bundleId: bundle });
    const concept = type === null ? undefined : refForFile(type, root, file);
    const ref = concept === undefined ? null : `${bundle}//${concept}`;
    appendEvent({
      eventType: "import",
      ...(ref ? { ref } : {}),
      metadata: { source: "-", path: file, force: false },
    });
    return { bundle, file: relative, type, ref, path: file, stashDir: root, indexed };
  });
}
