// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `projects` config section: named places the user works on, with the
 * directories they live in and what akm reads and writes there. The shape is
 * checked piece by piece by {@link dropUnusableProjects} (a malformed piece
 * warns once and is ignored), so what reaches {@link ProjectsSchema} is valid.
 */
import { z } from "zod";
import { isRecord } from "../../common";
import { warnOnce } from "../../warn";
import { nonEmptyString } from "./primitives";

type Dict = Record<string, unknown>;

/** The name that means "no project" on `--project`. */
export const NO_PROJECT = "none";

const scopeValues = z.union([z.string(), z.array(z.string()).min(1)]);

const WriteFields = {
  bundle: nonEmptyString,
  user: nonEmptyString,
  agent: nonEmptyString,
  channel: nonEmptyString,
  metadata: z.record(nonEmptyString, z.union([z.string(), z.number(), z.boolean()])),
};

const ProjectFields = {
  from: z.union([nonEmptyString, z.array(nonEmptyString).min(1)]),
  filters: z.record(nonEmptyString, scopeValues),
  prefer: z.record(nonEmptyString, scopeValues),
};

/** A directory a project lives in: absolute, or starting with `~`. */
const projectPath = nonEmptyString.refine((p) => p.startsWith("~") || p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p), {
  message: "must be an absolute path or start with ~",
});

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
    prefer: ProjectFields.prefer.optional(),
    write: ProjectWriteSchema.optional(),
  })
  .passthrough();

export const ProjectsSchema = z.record(nonEmptyString, ProjectSchema);

export type ProjectConfig = z.infer<typeof ProjectSchema>;

/** `raw` without the keys of `fields` whose value its schema rejects; one warning each, naming the first problem. */
function keepValid(raw: Dict, fields: Record<string, z.ZodTypeAny>, where: string, sourcePath?: string): Dict {
  const out = { ...raw };
  for (const [key, schema] of Object.entries(fields)) {
    if (raw[key] === undefined) continue;
    const parsed = schema.safeParse(raw[key]);
    if (parsed.success) continue;
    const issue = parsed.error.issues[0];
    warnOnce(
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
export function dropUnusableProjects(raw: Dict, sourcePath?: string): Dict {
  if (raw.projects === undefined) return raw;
  const warn = (where: string, why: string) =>
    warnOnce(
      `config:unusable:project:${sourcePath ?? "inline"}:${where}`,
      `Ignoring ${where}${sourcePath ? ` in ${sourcePath}` : ""}: ${why}.`,
    );
  if (!isRecord(raw.projects)) {
    warn("projects", "it must be an object of project names");
    const { projects: _dropped, ...rest } = raw;
    return rest;
  }
  const kept: Dict = {};
  for (const [name, entry] of Object.entries(raw.projects)) {
    const where = `projects.${name}`;
    if (name === NO_PROJECT || !name.trim()) {
      warn(where, `"${NO_PROJECT}" and empty names are reserved`);
    } else if (!isRecord(entry)) {
      warn(where, "it must be an object");
    } else {
      let project = keepValid(entry, ProjectFields, where, sourcePath);
      if (Array.isArray(entry.paths)) {
        const paths = entry.paths.filter((p) => {
          const ok = projectPath.safeParse(p).success;
          if (!ok) warn(`${where}.paths`, `${JSON.stringify(p)} must be an absolute path or start with ~`);
          return ok;
        });
        project = { ...project, paths };
      } else {
        project = keepValid(project, { paths: z.array(projectPath) }, where, sourcePath);
      }
      if (isRecord(entry.write)) {
        project = { ...project, write: keepValid(entry.write, WriteFields, `${where}.write`, sourcePath) };
      } else {
        project = keepValid(project, { write: z.object({}) }, where, sourcePath);
      }
      kept[name] = project;
    }
  }
  return { ...raw, projects: kept };
}
