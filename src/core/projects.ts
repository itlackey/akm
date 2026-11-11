// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Projects: named places the user works on, from the `projects` config key.
 * One resolver for every command that applies them (search, curate, remember,
 * proposal extract/new) and for improve's session extract. A project only
 * supplies defaults where a person or agent makes a request; callers merge
 * those defaults under their explicit flags, one kind at a time.
 */

import type { ScopeFilters } from "./adapter/types";
import { isWithin, safeRealpath } from "./common";
import type { AkmConfig } from "./config/config-types";
import { expandProjectPath, NO_PROJECT, type ProjectConfig } from "./config/schema/projects";
import { UsageError } from "./errors";
import { type IncludeSelectors, normalizeInclude } from "./include";

type FrontmatterScalar = string | number | boolean;

export interface ResolvedProject {
  name: string;
  /** The configured path the working directory matched; absent when `--project` selected the project. */
  path?: string;
  from?: string | string[];
  filters?: ScopeFilters;
  include?: IncludeSelectors;
  /** The project's own, else `project=<name>`. */
  prefer: ScopeFilters;
  write: {
    bundle?: string;
    user?: string;
    agent?: string;
    channel?: string;
    /** The project's own, with `project: <name>` when it sets none. */
    metadata: Record<string, FrontmatterScalar>;
  };
}

/** What a search or curate response says about the project it used. */
export interface ProjectView {
  name: string;
  path?: string;
  from?: string | string[];
  filters?: ScopeFilters;
  include?: IncludeSelectors;
  prefer?: ScopeFilters;
}

/** The project whose configured path most specifically contains `dir`, with that path as configured. */
export function projectForDirectory(
  config: Pick<AkmConfig, "projects">,
  dir: string,
): { name: string; path: string } | undefined {
  let best: { name: string; path: string; length: number } | undefined;
  for (const [name, project] of Object.entries(config.projects ?? {})) {
    for (const configured of project.paths ?? []) {
      const root = expandProjectPath(configured);
      if (!isWithin(dir, root)) continue;
      const length = safeRealpath(root).length;
      if (!best || length > best.length) best = { name, path: configured, length };
    }
  }
  return best && { name: best.name, path: best.path };
}

function toResolved(name: string, project: ProjectConfig, matchedPath?: string): ResolvedProject {
  const { write = {} } = project;
  return {
    name,
    ...(matchedPath !== undefined ? { path: matchedPath } : {}),
    ...(project.from !== undefined ? { from: project.from } : {}),
    ...(project.filters !== undefined ? { filters: project.filters } : {}),
    ...(project.include !== undefined ? { include: normalizeInclude(project.include) } : {}),
    prefer: project.prefer ?? { project: name },
    write: {
      ...(write.bundle !== undefined ? { bundle: write.bundle } : {}),
      ...(write.user !== undefined ? { user: write.user } : {}),
      ...(write.agent !== undefined ? { agent: write.agent } : {}),
      ...(write.channel !== undefined ? { channel: write.channel } : {}),
      metadata: { project: name, ...write.metadata },
    },
  };
}

/**
 * The project a call runs under: `project` (`--project`), else the one whose
 * path most specifically contains `cwd` (default: the process's), else none.
 * `none` selects no project; an unknown name is a usage error, because ignoring
 * it would silently drop an isolating filter.
 */
export function resolveProject(
  config: Pick<AkmConfig, "projects">,
  options: { project?: string; cwd?: string } = {},
): ResolvedProject | undefined {
  const { project: selected } = options;
  if (selected === NO_PROJECT) return undefined;
  if (selected !== undefined) {
    const project = Object.hasOwn(config.projects ?? {}, selected) ? config.projects?.[selected] : undefined;
    if (!project) {
      const known = Object.keys(config.projects ?? {});
      throw new UsageError(
        `Unknown project "${selected}". ${known.length > 0 ? `Configured projects: ${known.join(", ")}.` : "No projects are configured."}`,
        "INVALID_FLAG_VALUE",
        `Add it under \`projects\` in your config, or pass --project ${NO_PROJECT} to run without one.`,
      );
    }
    return toResolved(selected, project);
  }
  if (!config.projects) return undefined;
  const match = projectForDirectory(config, options.cwd ?? process.cwd());
  const project = match && config.projects[match.name];
  return match && project ? toResolved(match.name, project, match.path) : undefined;
}

export function projectView(project: ResolvedProject): ProjectView {
  return {
    name: project.name,
    ...(project.path !== undefined ? { path: project.path } : {}),
    ...(project.from !== undefined ? { from: project.from } : {}),
    ...(project.filters !== undefined ? { filters: project.filters } : {}),
    ...(project.include !== undefined ? { include: project.include } : {}),
    prefer: project.prefer,
  };
}

function scopeText(scope: ScopeFilters): string {
  return Object.entries(scope)
    .map(
      ([key, value]) =>
        `${key}=${[value ?? []]
          .flat()
          .map((v) => v || '""')
          .join(",")}`,
    )
    .join(" ");
}

/** `text` opened by the project line when a project applied: `Project akm (~/code/akm): prefer project=akm`. */
export function withProjectLine(text: string, view: ProjectView | undefined): string {
  return view ? `${formatProjectLine(view)}\n${text}` : text;
}

function formatProjectLine(view: ProjectView): string {
  const parts = [
    view.from !== undefined ? `from ${[view.from].flat().join(",")}` : "",
    view.include ? `include ${scopeText(view.include)}` : "",
    view.filters ? `filter ${scopeText(view.filters)}` : "",
    view.prefer ? `prefer ${scopeText(view.prefer)}` : "",
  ].filter(Boolean);
  return `Project ${view.name}${view.path ? ` (${view.path})` : ""}${parts.length > 0 ? `: ${parts.join("; ")}` : ""}`;
}
