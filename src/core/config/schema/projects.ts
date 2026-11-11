// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { isRecord } from "../../common";
/**
 * `projects` config section: named places the user works on, with the
 * directories they live in and what akm reads and writes there. The shape is
 * checked piece by piece by {@link dropUnusableProjects} (a malformed piece
 * warns once and is ignored), so what reaches {@link ProjectsSchema} is valid.
 */
import { IncludeSchema } from "../../include";
import { warnOnce } from "../../warn";
import { nonEmptyString } from "./primitives";

type Dict = Record<string, unknown>;

/** The name that means "no project" on `--project`. */
export const NO_PROJECT = "none";

/** Names that would collide with object prototype keys; reserved like `none`. */
const PROTOTYPE_NAMES = new Set(["__proto__", "constructor", "prototype"]);

const scopeValues = z.union([z.string(), z.array(z.string()).min(1)]);

const WriteFields = {
  bundle: nonEmptyString,
  user: nonEmptyString,
  agent: nonEmptyString,
  channel: nonEmptyString,
  metadata: z.record(nonEmptyString, z.union([z.string(), z.number(), z.boolean()])),
};

const ProjectFields = {
  include: IncludeSchema,
  from: z.union([nonEmptyString, z.array(nonEmptyString).min(1)]),
  filters: z.record(nonEmptyString, scopeValues),
  prefer: z.record(nonEmptyString, scopeValues),
};

/** A directory a project lives in: absolute, `~` or `~/...` (not `~user/...`). */
const projectPath = nonEmptyString.refine(
  (p) => p === "~" || /^~[\\/]/.test(p) || p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p),
  { message: "must be an absolute path, ~ or ~/..." },
);

/** A configured path as a directory: `~` expanded, trailing slashes and `..` resolved. */
export function expandProjectPath(p: string): string {
  return path.resolve(p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
}

/** Frontmatter keys akm sets itself: a project's `write.metadata` never carries them. */
const AKM_OWNED_KEYS = new Set([
  "name",
  "type",
  "description",
  "tags",
  "source",
  "xrefs",
  "observed",
  "expires",
  "updated",
  "subjective",
  "captureMode",
  "beliefState",
  "supersededBy",
  "when_to_use",
  "provenance",
  "scope",
]);

export const ProjectWriteSchema = z
  .object({
    bundle: WriteFields.bundle.optional(),
    user: WriteFields.user.optional(),
    agent: WriteFields.agent.optional(),
    channel: WriteFields.channel.optional(),
    metadata: WriteFields.metadata.optional(),
  })
  .passthrough();

export const ProjectSchema = z
  .object({
    paths: z.array(projectPath).optional(),
    from: ProjectFields.from.optional(),
    filters: ProjectFields.filters.optional(),
    include: ProjectFields.include.optional(),
    prefer: ProjectFields.prefer.optional(),
    write: ProjectWriteSchema.optional(),
  })
  .passthrough();

export const ProjectsSchema = z.record(nonEmptyString, ProjectSchema);

export type ProjectConfig = z.infer<typeof ProjectSchema>;

type Report = (key: string, message: string) => void;

/** `raw` without the keys of `fields` whose value its schema rejects; one warning each, naming the first problem. */
function keepValid(
  raw: Dict,
  fields: Record<string, z.ZodTypeAny>,
  where: string,
  sourcePath: string | undefined,
  report: Report,
): Dict {
  const out = { ...raw };
  for (const [key, schema] of Object.entries(fields)) {
    if (raw[key] === undefined) continue;
    const parsed = schema.safeParse(raw[key]);
    if (parsed.success) continue;
    const issue = parsed.error.issues[0];
    report(
      `config:unusable:project:${sourcePath ?? "inline"}:${where}.${key}`,
      `Ignoring ${where}.${key}${sourcePath ? ` in ${sourcePath}` : ""}: ${issue?.message ?? "it is not valid"}.`,
    );
    delete out[key];
  }
  return out;
}

/**
 * Each project, and each part of it, that its schema rejects is dropped from what
 * is read, with one warning naming it: a typo in one project never refuses the
 * config or disables another project. A `paths` entry that is not absolute is
 * dropped on its own. The file keeps what was dropped.
 */
export function dropUnusableProjects(raw: Dict, sourcePath?: string, report: Report = warnOnce): Dict {
  if (raw.projects === undefined) return raw;
  const warn = (where: string, why: string) =>
    report(
      `config:unusable:project:${sourcePath ?? "inline"}:${where}`,
      `Ignoring ${where}${sourcePath ? ` in ${sourcePath}` : ""}: ${why}.`,
    );
  if (!isRecord(raw.projects)) {
    warn("projects", "it must be an object of project names");
    const { projects: _dropped, ...rest } = raw;
    return rest;
  }
  const kept: Dict = Object.create(null);
  for (const [name, entry] of Object.entries(raw.projects)) {
    const where = `projects.${name}`;
    if (name === NO_PROJECT || !name.trim() || PROTOTYPE_NAMES.has(name)) {
      warn(where, `"${NO_PROJECT}", "__proto__", "constructor", "prototype" and empty names are reserved`);
    } else if (!isRecord(entry)) {
      warn(where, "it must be an object");
    } else {
      let project = keepValid(entry, ProjectFields, where, sourcePath, report);
      if (Array.isArray(entry.paths)) {
        const paths = entry.paths.filter((p) => {
          const ok = projectPath.safeParse(p).success;
          if (!ok) warn(`${where}.paths`, `${JSON.stringify(p)} must be an absolute path, ~ or ~/...`);
          return ok;
        });
        project = { ...project, paths };
      } else {
        project = keepValid(project, { paths: z.array(projectPath) }, where, sourcePath, report);
      }
      if (isRecord(entry.write)) {
        const write = keepValid(entry.write, WriteFields, `${where}.write`, sourcePath, report);
        if (isRecord(write.metadata)) {
          const metadata: Dict = {};
          for (const [key, value] of Object.entries(write.metadata)) {
            if (AKM_OWNED_KEYS.has(key) || key.startsWith("scope_")) {
              warn(`${where}.write.metadata.${key}`, "akm sets this key itself");
            } else metadata[key] = value;
          }
          write.metadata = metadata;
        }
        project = { ...project, write };
      } else {
        project = keepValid(project, { write: z.object({}) }, where, sourcePath, report);
      }
      kept[name] = project;
    }
  }
  const owners = new Map<string, string>();
  for (const [name, project] of Object.entries(kept)) {
    for (const configured of (isRecord(project) && Array.isArray(project.paths) ? project.paths : []) as string[]) {
      const dir = expandProjectPath(configured);
      const first = owners.get(dir);
      if (first !== undefined && first !== name) {
        warnOnce(
          `config:project-shared-path:${sourcePath ?? "inline"}:${name}:${configured}`,
          `projects.${name}.paths: ${configured} is also a path of "${first}"${sourcePath ? ` in ${sourcePath}` : ""}; "${first}" is used there.`,
        );
      } else owners.set(dir, name);
    }
  }
  return { ...raw, projects: kept };
}
