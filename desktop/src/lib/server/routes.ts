// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createRequire } from "node:module";
import os from "node:os";
import { activity, assets, bundles, config, documents, feedback, proposals, sensitive, setup } from "akm-cli/workspace";
import { compareVersions } from "../engine-skew.js";
import { readFile, saveFile } from "./features/files.js";
import {
  readPreferences,
  savePreferences,
  tryApply,
  validPluginChannel,
  validTheme,
  validUpdateChannel,
} from "./features/preferences.js";
import { reveal } from "./features/reveal.js";
import { desktopApp, followUpdateChannel, hostTools } from "./features/software.js";
import { count, fields, flag, HttpFailure, text } from "./input.js";

const require = createRequire(import.meta.url);
const akmPackage = require("akm-cli/package.json") as { version: string };

type Params = Record<string, string>;
/**
 * Every route Desktop serves, in one table. A route names its operation and turns the request into that operation's
 * input; transport (auth, limits, envelope, scrubbing, error status) is `http.ts`'s. A request field the operation does
 * not know is ignored; what a field means is the operation's to decide. Everything Desktop itself owns is under
 * /api/desktop/*; every other path is akm's.
 */
export type Route =
  | { method: "GET"; path: RegExp; literal?: boolean; run: (query: URLSearchParams, params: Params) => unknown }
  | {
      method: "POST";
      path: RegExp;
      limit?: "document";
      literal?: boolean;
      run: (body: unknown, params: Params) => unknown;
    };

const exact = (path: string) => new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const pattern = (path: string) => new RegExp(`^${path.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`);
const get = (path: string, run: (query: URLSearchParams, params: Params) => unknown, literal = false): Route => ({
  method: "GET",
  path: path.includes(":") ? pattern(path) : exact(path),
  run,
  literal,
});
const post = (
  path: string,
  run: (body: unknown, params: Params) => unknown,
  options: { limit?: "document"; literal?: boolean } = {},
): Route => ({ method: "POST", path: path.includes(":") ? pattern(path) : exact(path), run, ...options });

const refOf = (query: URLSearchParams) => ({ ref: text(query, "ref").trim() });
type Input<T> = T extends (input: infer I) => unknown ? I : never;
/** A route that passes the known fields of its body straight to an operation. */
const body =
  <T extends (input: never) => unknown>(operation: T, keys: readonly string[], where: string) =>
  (value: unknown) =>
    operation(fields<Input<T>>(value, keys, where) as never) as ReturnType<T>;

/** A typed fix travels as two parallel lists; the operation takes pairs. */
function fix(value: { replace?: unknown; with?: unknown }) {
  const { replace, with: replacement } = value;
  if (replace === undefined && replacement === undefined) return undefined;
  const strings = (item: unknown): item is string[] =>
    Array.isArray(item) && item.every((entry) => typeof entry === "string");
  if (!strings(replace) || !strings(replacement) || !replace.length || replace.length !== replacement.length)
    throw new HttpFailure(400, "INVALID_FLAG_VALUE", "replace and with must be lists of the same length.");
  return replace.map((old, index) => ({ replace: old, with: replacement[index] as string }));
}

const sensitiveKeys = ["ref", "bundle", "file", "content", "revision"] as const;
const sensitiveBody = <T>(value: unknown, where: string) => fields<T>(value, sensitiveKeys, where);

export const routes: Route[] = [
  // Desktop's own.
  get("/api/desktop", () => ({
    hostname: os.hostname(),
    version: process.env.AKM_DESKTOP_VERSION ?? "development",
    akmVersion: akmPackage.version,
    commit: process.env.AKM_DESKTOP_COMMIT,
  })),
  get("/api/desktop/preferences", () => readPreferences()),
  post("/api/desktop/preferences", async (value) => {
    const { theme, updateChannel, pluginChannel } = fields<{
      theme?: unknown;
      updateChannel?: unknown;
      pluginChannel?: unknown;
    }>(value, ["theme", "updateChannel", "pluginChannel"], "preferences");
    if (theme !== undefined && !validTheme(theme))
      throw new HttpFailure(400, "INVALID_PREFERENCE", "Choose system, light, or dark appearance.");
    if (updateChannel !== undefined && !validUpdateChannel(updateChannel))
      throw new HttpFailure(
        400,
        "INVALID_PREFERENCE",
        "Desktop updates follow stable releases, or stable and prereleases.",
      );
    if (pluginChannel !== undefined && !validPluginChannel(pluginChannel))
      throw new HttpFailure(
        400,
        "INVALID_PREFERENCE",
        "Plugins install from the stable (latest) or prerelease (next) channel.",
      );
    const saved = await savePreferences({
      ...(validTheme(theme) ? { theme } : {}),
      ...(validUpdateChannel(updateChannel) ? { updateChannel } : {}),
      ...(validPluginChannel(pluginChannel) ? { pluginChannel } : {}),
    });
    // The choice is saved either way; `applied` says whether the running updater has it yet.
    return updateChannel === undefined
      ? saved
      : { ...saved, ...(await tryApply(() => followUpdateChannel(saved.updateChannel))) };
  }),
  get("/api/desktop/software", async () => ({
    host: hostTools.snapshot(),
    desktop: await desktopApp(),
    engine: akmPackage.version,
    preferences: await readPreferences(),
  })),
  post("/api/desktop/software", async (value) => {
    const request = fields<{ action?: unknown; harness?: unknown; channel?: unknown; consent?: unknown }>(
      value,
      ["action", "harness", "channel", "consent"],
      "software action",
    );
    if (
      typeof request.action !== "string" ||
      (request.harness !== undefined && typeof request.harness !== "string") ||
      (request.channel !== undefined && typeof request.channel !== "string") ||
      (request.consent !== undefined && typeof request.consent !== "boolean")
    )
      throw new HttpFailure(400, "INVALID_SOFTWARE_ACTION", "Invalid software action, harness or release channel.");
    try {
      // A host upgrade past Desktop's engine would leave Desktop unable to read an index the host migrated; HostTools
      // asks akm for the release it would install, right before it upgrades, and refuses one `within` cannot clear.
      return request.action === "desktop-menu-install"
        ? await desktopApp("menu-install")
        : request.action === "desktop-update-check"
          ? await desktopApp("update-check")
          : hostTools.start(
              request.action,
              request.harness as string | undefined,
              request.channel as string | undefined,
              {
                consent: request.consent === true,
                within: (version) => {
                  const order = compareVersions(version, akmPackage.version);
                  return order === null ? undefined : order <= 0;
                },
              },
            );
    } catch (error) {
      throw new HttpFailure(
        400,
        "SOFTWARE_ACTION_FAILED",
        error instanceof Error ? error.message : "Software operation failed.",
      );
    }
  }),
  post("/api/desktop/pick-folder", async (value) => {
    const { start } = fields<{ start?: unknown }>(value, ["start"], "folder dialog");
    if (start !== undefined && typeof start !== "string")
      throw new HttpFailure(400, "INVALID_FOLDER_DIALOG", "The folder dialog start must be a path.");
    try {
      return { path: await desktopApp("pick-folder", start === undefined ? {} : { start }) };
    } catch (error) {
      throw new HttpFailure(
        400,
        "FOLDER_DIALOG_FAILED",
        error instanceof Error ? error.message : "The folder dialog failed.",
      );
    }
  }),
  get("/api/desktop/file", (query) => readFile(Object.fromEntries(query)), true),
  post("/api/desktop/file/save", (value) => saveFile(value), { limit: "document" }),
  get("/api/desktop/sensitive", (query) => sensitive.describe(Object.fromEntries(query))),
  post("/api/desktop/sensitive/reveal", (value) => reveal(value), { literal: true }),
  post(
    "/api/desktop/sensitive/create",
    (value) => {
      const { revision: _ignored, ...input } = sensitiveBody<Input<typeof sensitive.save>>(value, "sensitive create");
      return sensitive.save(input);
    },
    { limit: "document" },
  ),
  post(
    "/api/desktop/sensitive/save",
    (value) => sensitive.save(sensitiveBody<Input<typeof sensitive.save>>(value, "sensitive save")),
    { limit: "document" },
  ),
  post(
    "/api/desktop/sensitive/delete",
    (value) => sensitive.remove(sensitiveBody<Input<typeof sensitive.remove>>(value, "sensitive delete")),
    { limit: "document" },
  ),

  // Reads.
  get("/api/overview", (query) =>
    activity.overview({ probe: flag(query, "probe"), metricsSince: text(query, "metricsSince") }),
  ),
  get("/api/overview/pulse", () => activity.pulse()),
  get("/api/health", (query) => activity.health({ probe: flag(query, "probe") })),
  get("/api/retrieval", (query) => activity.retrievalTrend({ since: text(query, "since") })),
  get("/api/improve/impact", (query) => activity.improveImpact({ since: text(query, "since") })),
  get("/api/tasks/history", (query) =>
    activity.taskHistory({ taskId: text(query, "taskId"), since: text(query, "since"), limit: count(query, "limit") }),
  ),
  get("/api/meta", () => activity.meta()),
  get("/api/tasks/runs", (query) => activity.taskRuns({ since: text(query, "since") })),
  get("/api/improve/run", (query) => activity.improveRun({ id: text(query, "id") })),
  get("/api/workflows/runs", (query) => activity.workflowRuns({ since: text(query, "since") })),
  get("/api/workflows/run", (query) => activity.workflowRun({ id: text(query, "id") })),
  get("/api/events", (query) => activity.events({ since: text(query, "since"), until: text(query, "until") })),
  get("/api/graph", () => assets.graph()),
  get("/api/search", (query) =>
    assets.search({
      q: text(query, "q"),
      type: query.get("type") || undefined,
      bundle: query.get("bundle") || undefined,
      belief: query.get("belief") || undefined,
      project: query.get("project") || undefined,
      scope: Object.fromEntries(["user", "agent", "run", "channel"].map((key) => [key, text(query, `scope_${key}`)])),
      limit: count(query, "limit"),
    }),
  ),
  get("/api/projects/overview", (query) => assets.projectOverview({ project: text(query, "project") })),
  get("/api/search/misses", (query) => assets.searchMisses({ since: text(query, "since") })),
  get("/api/asset", (query) => assets.show(refOf(query))),
  get("/api/asset/history", (query) =>
    assets.history({ ...refOf(query), revision: query.get("revision") ?? undefined, limit: count(query, "limit") }),
  ),
  get("/api/asset/related", (query) =>
    assets.related({ ...refOf(query), scope: (text(query, "scope") as "all" | "bundle") || "all" }),
  ),
  get("/api/asset/improve", (query) => assets.improvement(refOf(query))),
  get("/api/asset/source", (query) => documents.readSource({ ref: text(query, "ref") })),
  get("/api/bundles", () => bundles.list()),
  get("/api/bundles/files", (query) =>
    assets.bundleFiles({ bundle: text(query, "bundle"), path: text(query, "path"), hidden: flag(query, "hidden") }),
  ),
  get("/api/config", () => config.get()),
  get("/api/setup/detect", () => setup.detect()),
  get("/api/proposals", (query) =>
    proposals.list({
      status: text(query, "status"),
      source: text(query, "source"),
      age: text(query, "age"),
      week: text(query, "week"),
      class: text(query, "class"),
      limit: count(query, "limit"),
    }),
  ),
  get("/api/proposals/:id", (_query, params) => proposals.get({ id: params.id! })),
  get("/api/changes", (query) => proposals.recentChanges({ limit: count(query, "limit") })),

  // Writes.
  post("/api/feedback", (value) => {
    const input = fields<{
      ref: string;
      signal: "positive" | "negative";
      reason?: string;
      tags?: string[];
      source?: string;
      replace?: unknown;
      with?: unknown;
    }>(value, ["ref", "signal", "reason", "tags", "source", "replace", "with"], "feedback");
    const { replace: _replace, with: _with, ...rest } = input;
    return feedback.record({ ...rest, fix: fix(input) });
  }),
  post("/api/bundles/add", body(bundles.add, ["source", "name", "writable"], "bundle add")),
  post("/api/bundles/remove", body(bundles.remove, ["bundle", "confirm"], "bundle remove")),
  post("/api/bundles/update", body(bundles.update, ["bundle"], "bundle update")),
  post("/api/bundles/rename", body(bundles.rename, ["bundle", "name", "dryRun"], "bundle rename")),
  post(
    "/api/bundles/settings",
    body(bundles.setSettings, ["bundle", "enabled", "writable", "componentWritability"], "bundle settings"),
  ),
  // The improve task's scheduler entry is written by the host `akm`, when there is one (see docs/software.md).
  post("/api/setup/apply", async (value) =>
    setup.apply(
      fields<Input<typeof setup.apply>>(value, ["dir", "harness", "connection", "learning"], "setup apply"),
      await hostTools.cli(),
    ),
  ),
  post("/api/config/set", body(config.change, ["set", "unset"], "config")),
  post("/api/config/projects", body(config.changeProjects, ["set", "unset"], "projects")),
  post("/api/config/connections/save", body(config.saveConnection, ["name", "entry"], "connection save")),
  post("/api/config/connections/remove", body(config.removeConnection, ["name"], "connection remove")),
  post(
    "/api/knowledge/create",
    body(documents.createKnowledge, ["bundle", "name", "path", "content"], "knowledge create"),
    { limit: "document" },
  ),
  post("/api/asset/save", body(documents.save, ["ref", "content", "revision"], "document save"), { limit: "document" }),
  post("/api/asset/retire", body(documents.retire, ["ref", "revision"], "document retire")),
  post("/api/asset/copy", body(documents.copy, ["sourceRef", "target", "newName"], "copy")),
  post("/api/proposals/accept", body(proposals.acceptMany, ["ids"], "accept")),
  post("/api/proposals/reject", body(proposals.rejectMany, ["ids", "reason"], "reject")),
  post("/api/proposals/:id/accept", (_value, params) => proposals.accept({ id: params.id! })),
  post("/api/proposals/:id/reject", (value, params) =>
    proposals.reject({ id: params.id!, reason: fields<{ reason: string }>(value ?? {}, ["reason"], "reject").reason }),
  ),
  post("/api/proposals/:id/revert", (_value, params) => proposals.revert({ id: params.id! })),
  post("/api/proposals/:id/reopen", (_value, params) => proposals.reopen({ id: params.id! })),
];
