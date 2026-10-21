// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFile } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
  getConfigValueSource,
  loadConfig,
  mutateConfig,
  resetConfigCache,
  sanitizeConfigForWrite,
} from "../../core/config/config";
import { AkmError, type AkmErrorKind, UsageError } from "../../core/errors";
import { resolveAkmInvocation } from "../../tasks/resolve-akm-bin";
import { setConfigValue, unsetConfigValue } from "../config-cli";
import { redactForUi, redactUrlsInText } from "./redact";

export type WorkspaceAction =
  | "feedback"
  | "bundle-add"
  | "bundle-remove"
  | "bundle-update"
  | "bundle-settings"
  | "knowledge-create";

const ROUTES: Record<string, WorkspaceAction> = {
  "/api/feedback": "feedback",
  "/api/bundles/add": "bundle-add",
  "/api/bundles/remove": "bundle-remove",
  "/api/bundles/update": "bundle-update",
  "/api/bundles/settings": "bundle-settings",
  "/api/knowledge/create": "knowledge-create",
};

export function matchWorkspaceAction(path: string): WorkspaceAction | null {
  return ROUTES[path] ?? null;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UsageError("A JSON object is required.");
  return value as Record<string, unknown>;
}

function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new UsageError(`${key} is required.`);
  return value.trim();
}

function positional(body: Record<string, unknown>, key: string): string {
  const value = text(body, key);
  if (value.startsWith("-"))
    throw new UsageError(
      `${key} must be a target, not a command option. Use ./ for a relative path beginning with a dash.`,
    );
  return value;
}

function preserveUnrelatedConfig(config = loadConfig()) {
  if (!isDeepStrictEqual(sanitizeConfigForWrite(config), config)) {
    throw new UsageError(
      "AKM's config sanitizer would remove unrelated credentials. Move literal API keys to $VAR or secret:// references and remove registry URL credentials using the CLI before changing bundles or creating knowledge in the UI.",
    );
  }
}

/** Preserve the CLI's error identity while crossing a process boundary. */
class CommandError extends AkmError {
  readonly kind: AkmErrorKind;
  constructor(
    message: string,
    readonly code: string,
    exitCode: string | number | null | undefined,
  ) {
    super(message);
    this.kind = exitCode === 2 ? "usage" : exitCode === 75 ? "transient" : exitCode === 1 ? "not-found" : "config";
  }
  hint() {
    return undefined;
  }
}

/** Fixed UI actions use the real CLI, including feedback's argv-dependent tag validation and bundle install audits. */
async function command(args: string[], input?: string, userFeedback = false): Promise<unknown> {
  const [bin, ...prefix] = resolveAkmInvocation().argv;
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin!,
      [...prefix, ...args, "--format", "json"],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        ...(userFeedback ? { env: { ...process.env, AKM_EVENT_SOURCE: "user" } } : {}),
      },
      (error, stdout, stderr) => {
        resetConfigCache();
        if (error) {
          const json = stderr.slice(stderr.lastIndexOf("\n{") + 1).trim();
          let detail: { error?: string; code?: string } = {};
          try {
            detail = JSON.parse(json);
          } catch {
            /* Keep the command's readable error. */
          }
          reject(
            new CommandError(
              redactUrlsInText(detail.error ?? (stderr.trim() || error.message)),
              detail.code ?? "COMMAND_FAILED",
              error.code,
            ),
          );
          return;
        }
        try {
          resolve(redactForUi(JSON.parse(stdout)));
        } catch {
          resolve({ completed: true });
        }
      },
    );
    // Argument validation can close the child before a Markdown body finishes writing.
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin?.end(input);
  });
}

function settings(body: Record<string, unknown>) {
  const result = mutateConfig((current) => {
    preserveUnrelatedConfig(current);
    let updated = current;
    if (body.bundle !== undefined) {
      const name = text(body, "bundle");
      const entry = current.bundles?.[name];
      if (!entry || !Object.hasOwn(current.bundles ?? {}, name))
        throw new UsageError(`No configured bundle named "${name}".`);
      for (const key of ["enabled", "writable"] as const) {
        if (body[key] === undefined) continue;
        if (typeof body[key] !== "boolean") throw new UsageError(`${key} must be a boolean.`);
        updated = setConfigValue(updated, `bundles.${name}.${key}`, String(body[key]));
      }
      if (body.componentWritability !== undefined) {
        for (const [id, writable] of Object.entries(object(body.componentWritability))) {
          if (!Object.hasOwn(entry.components ?? {}, id) || id.includes(".") || typeof writable !== "boolean") {
            throw new UsageError("Only existing components with a boolean writable value can be changed.");
          }
          updated = setConfigValue(updated, `bundles.${name}.components.${id}.writable`, String(writable));
        }
      }
    }
    for (const key of ["defaultBundle", "defaultWriteTarget"] as const) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== "string") throw new UsageError(`${key} must be a bundle name or empty.`);
      const name = body[key].trim();
      if (name && !Object.hasOwn(current.bundles ?? {}, name))
        throw new UsageError(`No configured bundle named "${name}".`);
      if (!name && getConfigValueSource(key).startsWith("extends:"))
        throw new UsageError(`The inherited ${key} cannot be unset here; choose a local override.`);
      updated = name ? setConfigValue(updated, key, name) : unsetConfigValue(updated, key);
    }
    return updated;
  });
  return { saved: result.written };
}

export async function handleWorkspaceAction(action: WorkspaceAction, value: unknown): Promise<unknown> {
  const body = object(value);
  if (action !== "feedback" && action !== "bundle-settings") preserveUnrelatedConfig();
  switch (action) {
    case "feedback": {
      const signal = text(body, "signal");
      if (signal !== "positive" && signal !== "negative") throw new UsageError("signal must be positive or negative.");
      const args = ["feedback", positional(body, "ref"), `--${signal}`];
      if (typeof body.reason === "string" && body.reason.trim()) args.push(`--reason=${body.reason.trim()}`);
      if (body.tags !== undefined) {
        if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== "string"))
          throw new UsageError("tags must be strings.");
        for (const tag of body.tags as string[]) args.push(`--tag=${tag}`);
      }
      return command(args, undefined, true);
    }
    case "bundle-add": {
      const args = ["bundle", "add", positional(body, "source")];
      if (typeof body.name === "string" && body.name.trim()) args.push(`--name=${body.name.trim()}`);
      if (body.writable === true) args.push("--writable");
      return command(args);
    }
    case "bundle-remove": {
      if (body.confirm !== true) throw new UsageError("Confirm removal of this configured bundle first.");
      const name = text(body, "bundle");
      if (!Object.hasOwn(loadConfig().bundles ?? {}, name))
        throw new UsageError(`No configured bundle named "${name}".`);
      return command(["bundle", "remove", name, "--yes"]);
    }
    case "bundle-update": {
      const name = text(body, "bundle");
      if (!Object.hasOwn(loadConfig().bundles ?? {}, name))
        throw new UsageError(`No configured bundle named "${name}".`);
      return command(["bundle", "update", name]);
    }
    case "bundle-settings":
      return settings(body);
    case "knowledge-create": {
      if (typeof body.content !== "string" || !body.content.trim())
        throw new UsageError("Document content is required.");
      const args = ["import", "-", `--name=${text(body, "name")}`, `--bundle=${text(body, "bundle")}`];
      if (typeof body.path === "string" && body.path.trim()) args.push(`--path=${body.path.trim()}`);
      return command(args, body.content);
    }
  }
}
