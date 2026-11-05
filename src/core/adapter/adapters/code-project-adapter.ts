// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `code-project` adapter (#1411): an ordinary coding repository as a
 * read-only bundle, one document per eligible file.
 *
 * EXPLICIT-CONFIG ONLY (`akm bundle add . --adapter code-project`): there is no
 * `looksLikeRoot`, so it is never auto-detected.
 *
 * What a document is, in the order `recognize` decides it (path first, so the
 * ownership probe, which treats any content read as a claim, stays exact):
 *   - the path must pass {@link isEligible}: a fixed extension/filename
 *     allowlist (source, Markdown/text docs, a few named config files) minus
 *     generated, lock and secret-shaped names and vendored/build directories.
 *     An allowlist excludes binaries without sniffing content;
 *   - only then is the file read. Markdown is the only format whose frontmatter
 *     is parsed (a YAML config starting with `---` keeps its header).
 *
 * Refs are the file's bundle-relative path, extension included, so
 * `readCandidates` is the identity inversion. Types are open and the adapter
 * owns their presentation: `source`, `doc` and `config`. The language is a tag.
 *
 * The walk (`walkMode: "all-directories"`) lists every directory except `.git`
 * and `node_modules`, honouring `.gitignore` inside a git repository, so
 * `.github/` and `.agents/` instructions reach `recognize`. The indexer owns
 * fingerprints, deletion and renames. Source code is sent to the embedding
 * endpoint like any other indexed text: with a remote endpoint it leaves the
 * machine.
 */

import path from "node:path";
import type { FileContext } from "../../../indexer/walk/file-context";
import { parseFrontmatter } from "../../asset/frontmatter";
import { toPosix } from "../../common";
import type { BundleAdapter } from "../bundle-adapter";
import type { BundleComponent, IndexDocument } from "../types";
import { hashContent, nonEmptyString, readTags, validateChangesWithBaseChecks } from "./shared";

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "scala",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".swift": "swift",
  ".dart": "dart",
  ".lua": "lua",
  ".ex": "elixir",
  ".exs": "elixir",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".ps1": "powershell",
  ".sql": "sql",
  ".vue": "vue",
  ".svelte": "svelte",
};

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);
const DOC_EXTENSIONS = new Set([...MARKDOWN_EXTENSIONS, ".txt", ".rst"]);

/** Configuration files indexed by exact name (lowercased). */
const CONFIG_FILENAMES = new Set([
  "package.json",
  "pyproject.toml",
  "cargo.toml",
  "go.mod",
  "composer.json",
  "build.gradle",
  "build.gradle.kts",
  "pom.xml",
  "gemfile",
  "makefile",
  "justfile",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "biome.json",
]);

/** `tsconfig.json`, `tsconfig.build.json`, ... */
const TSCONFIG = /^tsconfig(\..+)?\.json$/;

/** Directories that hold generated, vendored or tool-local files at any depth. */
const EXCLUDED_DIRS = new Set([
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".gradle",
  ".terraform",
  ".idea",
  ".vscode",
]);

/** Root-level directories that conventionally hold secrets or a virtualenv. */
const EXCLUDED_ROOT_DIRS = new Set(["env", "secrets"]);

/** Generated or secret-shaped names that would otherwise pass the allowlist. */
const EXCLUDED_FILENAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "poetry.lock",
  "pipfile.lock",
  "composer.lock",
  "gemfile.lock",
  "go.sum",
  "uv.lock",
]);
const EXCLUDED_NAME_PATTERN =
  /(^\.env(\.|$))|(\.min\.(js|css)$)|(\.map$)|(\.(pem|key|p12|pfx)$)|(^id_(rsa|dsa|ecdsa|ed25519))/;

type CodeType = "source" | "doc" | "config";

function classify(base: string, ext: string): CodeType | undefined {
  if (CONFIG_FILENAMES.has(base) || TSCONFIG.test(base)) return "config";
  if (DOC_EXTENSIONS.has(ext)) return "doc";
  if (ext in LANGUAGE_BY_EXTENSION) return "source";
  return undefined;
}

/** Pure path-only eligibility: the type of an indexable file, or undefined. */
export function eligibleType(relPath: string): CodeType | undefined {
  const segments = toPosix(relPath).split("/");
  const base = (segments.pop() ?? "").toLowerCase();
  if (segments.some((segment, i) => EXCLUDED_DIRS.has(segment) || (i === 0 && EXCLUDED_ROOT_DIRS.has(segment)))) {
    return undefined;
  }
  if (EXCLUDED_FILENAMES.has(base) || EXCLUDED_NAME_PATTERN.test(base)) return undefined;
  return classify(base, path.extname(base));
}

export function languageOf(relPath: string): string | undefined {
  return LANGUAGE_BY_EXTENSION[path.extname(relPath).toLowerCase()];
}

function recognize(c: BundleComponent, file: FileContext): IndexDocument | null {
  const conceptId = toPosix(file.relPath);
  const type = eligibleType(conceptId);
  if (type === undefined) return null; // decided before any byte is read

  const raw = file.content();
  const isMarkdown = MARKDOWN_EXTENSIONS.has(file.ext.toLowerCase());
  const parsed = isMarkdown ? parseFrontmatter(raw) : undefined;

  const doc: IndexDocument = {
    ref: `${c.id}//${conceptId}`,
    bundle: c.id,
    component: c.id,
    conceptId,
    path: file.absPath,
    hash: hashContent(raw),
    adapterId: "code-project",
    ownsPresentation: true,
    type,
    name: conceptId,
    content: parsed ? parsed.content : raw,
  };
  const language = languageOf(conceptId);
  if (language !== undefined) doc.tags = [language];
  if (parsed) {
    const description = nonEmptyString(parsed.data.description);
    if (description !== undefined) doc.description = description;
    const tags = readTags(parsed.data.tags);
    if (tags !== undefined) doc.tags = tags;
  }
  return doc;
}

export const codeProjectAdapter: BundleAdapter = {
  id: "code-project",
  version: "0.10.0",
  // The files `validate` checks; the walk and `recognize` decide what is indexed.
  extensions: [...MARKDOWN_EXTENSIONS],
  walkMode: "all-directories",

  recognize,

  // The base checks misfire on source (`stale-path` flags `/tmp/...` literals,
  // the ref regex matches Python's `y//2`), so they run on Markdown only.
  validate: (c, changes, ctx) =>
    validateChangesWithBaseChecks(
      c,
      changes.filter((change) => MARKDOWN_EXTENSIONS.has(path.extname(change.path).toLowerCase())),
      ctx,
    ),

  readCandidates: (c, conceptId) => [{ path: path.join(c.root, conceptId), conceptId }],
};
