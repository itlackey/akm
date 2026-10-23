// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFile } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { parseRefInput } from "../../core/asset/resolve-ref";
import {
  getConfigValueSource,
  loadConfig,
  mutateConfig,
  resetConfigCache,
  sanitizeConfigForWrite,
} from "../../core/config/config";
import { AkmError, type AkmErrorKind, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { resolveAkmInvocation } from "../../tasks/resolve-akm-bin";
import { setConfigValue, unsetConfigValue } from "../config-cli";
import { writeMarkdownAsset } from "../read/knowledge";
import { readDocumentSource } from "./document-source";
import { assertWriteLeaseFree, classifyProposalError, type ProposalActionError } from "./proposal-actions";
import { redactForUi, redactUrlsInText } from "./redact";

export type WorkspaceAction =
  | "feedback"
  | "bundle-add"
  | "bundle-remove"
  | "bundle-update"
  | "bundle-settings"
  | "document-save"
  | "knowledge-create";

const ROUTES: Record<string, WorkspaceAction> = {
  "/api/feedback": "feedback",
  "/api/bundles/add": "bundle-add",
  "/api/bundles/remove": "bundle-remove",
  "/api/bundles/update": "bundle-update",
  "/api/bundles/settings": "bundle-settings",
  "/api/knowledge/create": "knowledge-create",
  "/api/asset/save": "document-save",
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
  if (!isDeepStrictEqual(sanitizeConfigForWrite(config, { quiet: true }), config)) {
    throw new UsageError(
      "AKM's config sanitizer would remove unrelated credentials. Move literal API keys to $VAR or ${secrets/name} references and remove registry URL credentials using the CLI before changing bundle configuration in the UI.",
    );
  }
}

/** The error kind behind each exit code of the CLI contract (`EXIT_CODES`, `src/cli/shared.ts`). */
const KIND_BY_EXIT: Record<number, AkmErrorKind> = { 1: "not-found", 2: "usage", 75: "transient", 78: "config" };

/** Preserve the CLI's error identity while crossing a process boundary. */
class CommandError extends AkmError {
  readonly kind: AkmErrorKind;
  /** Exit 70, a signal or a failed spawn: akm itself failed, not the request. */
  readonly internal: boolean;
  constructor(
    message: string,
    readonly code: string,
    exitCode: string | number | null | undefined,
  ) {
    super(message);
    const kind = typeof exitCode === "number" ? KIND_BY_EXIT[exitCode] : undefined;
    this.internal = kind === undefined;
    this.kind = kind ?? "config";
  }
  hint() {
    return undefined;
  }
}

/** Exit zero is not sufficient evidence that the expected action returned a valid result. */
export function parseCommandResponse(stdout: string, expectedShape: string): unknown {
  try {
    const result = JSON.parse(stdout);
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      result.shape !== expectedShape ||
      !Number.isInteger(result.schemaVersion) ||
      result.ok === false
    )
      throw new Error("Invalid command envelope");
    return redactForUi(result);
  } catch {
    throw new CommandError(
      "AKM returned an invalid action response. State may already have changed. Reload the view before retrying; do not automatically repeat the action.",
      "INVALID_COMMAND_RESPONSE",
      70,
    );
  }
}

/**
 * HTTP status and code for a failed workspace action. A config refusal (a
 * read-only bundle, exit 78) is something the user can address: `409`. Exit 70
 * and anything unclassified stay `500`; the rest map as for proposal decisions.
 */
export function classifyWorkspaceError(error: unknown): ProposalActionError {
  if (error instanceof CommandError && error.internal) return { status: 500, code: error.code, message: error.message };
  const classified = classifyProposalError(error);
  return error instanceof AkmError && error.kind === "config" ? { ...classified, status: 409 } : classified;
}

/** Fixed UI actions use the real CLI, including feedback's argv-dependent tag validation and bundle install audits. */
async function command(args: string[], input?: string, userFeedback = false): Promise<unknown> {
  const [bin, ...prefix] = resolveAkmInvocation().argv;
  // Options go before a `--` that ends them, so a positional name may begin with a dash.
  const end = args.indexOf("--");
  const argv = end === -1 ? [...args, "--format=json"] : [...args.slice(0, end), "--format=json", ...args.slice(end)];
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin!,
      [...prefix, ...argv],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        // An ambient event source (an improve or task run) wins, as for every akm child.
        ...(userFeedback ? { env: { ...process.env, AKM_EVENT_SOURCE: process.env.AKM_EVENT_SOURCE || "user" } } : {}),
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
          resolve(parseCommandResponse(stdout, args[0] === "bundle" ? args[1]! : args[0]!));
        } catch (error) {
          reject(error);
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
      const source = name ? "" : getConfigValueSource(key);
      if (source.startsWith("extends:"))
        throw new UsageError(
          `Config key "${key}" is inherited from ${source} and cannot be unset here.`,
          "TARGET_NOT_UPDATABLE",
          `Override it locally with "akm config set ${key} <value>", or edit the base file directly.`,
        );
      updated = name ? setConfigValue(updated, key, name) : unsetConfigValue(updated, key);
    }
    // Only a write can drop credentials, so a request that changes nothing is never refused.
    if (updated !== current) preserveUnrelatedConfig(current);
    return updated;
  });
  return { saved: result.written };
}

export async function handleWorkspaceAction(action: WorkspaceAction, value: unknown): Promise<unknown> {
  const body = object(value);
  // `bundle update` writes only the lockfile, so it never passes config through the sanitizer.
  if (action === "bundle-add" || action === "bundle-remove") preserveUnrelatedConfig();
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
      return command(["bundle", "remove", "--yes", "--", name]);
    }
    case "bundle-update": {
      const name = text(body, "bundle");
      if (!Object.hasOwn(loadConfig().bundles ?? {}, name))
        throw new UsageError(`No configured bundle named "${name}".`);
      return command(["bundle", "update", "--", name]);
    }
    case "bundle-settings":
      return settings(body);
    case "document-save": {
      if (typeof body.content !== "string") throw new UsageError("Markdown content is required.");
      const content = body.content;
      const revision = text(body, "revision");
      const ref = text(body, "ref");
      await assertWriteLeaseFree("ui-document-save");
      // The writer takes the lease and compares `revision` with the live bytes inside it.
      const source = await readDocumentSource(ref);
      const identity = parseRefInput(source.ref);
      const result = await writeMarkdownAsset({
        type: source.type,
        content,
        name: identity.name,
        fallbackPrefix: source.type,
        target: identity.origin,
        force: true,
        expectedContentHash: revision,
      });
      if (!result.unchanged)
        appendEvent({
          eventType: source.type === "knowledge" ? "import" : "remember",
          ref: result.ref,
          metadata: { source: "ui", path: result.path, force: true },
        });
      return result;
    }
    case "knowledge-create": {
      if (typeof body.content !== "string" || !body.content.trim())
        throw new UsageError("Document content is required.");
      const args = ["import", "-", `--name=${text(body, "name")}`, `--bundle=${text(body, "bundle")}`];
      if (typeof body.path === "string" && body.path.trim()) args.push(`--path=${body.path.trim()}`);
      await assertWriteLeaseFree("ui-knowledge-create");
      return command(args, body.content);
    }
  }
}
