// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFile } from "node:child_process";
import { resetConfigCache } from "../core/config/config";
import { AkmError, type AkmErrorKind } from "../core/errors";
import { resolveAkmInvocation } from "../tasks/resolve-akm-bin";
import { redactForUi, redactUrlsInText } from "./redact";

/** The error kind behind each exit code of the CLI contract (`EXIT_CODES`, `src/cli/shared.ts`). */
const KIND_BY_EXIT: Record<number, AkmErrorKind> = { 1: "not-found", 2: "usage", 75: "transient", 78: "config" };

/** Preserve the CLI's error identity while crossing a process boundary. */
class CommandError extends AkmError {
  constructor(
    message: string,
    readonly code: string,
    readonly kind: AkmErrorKind,
  ) {
    super(message);
  }
  hint() {
    return undefined;
  }
}

/**
 * The child exited zero without the expected result. Not an `AkmError` (akm failed, not the request), but it keeps
 * its own code: the action may already have happened, so a client must reload rather than repeat it.
 */
export class InvalidCommandResponse extends Error {
  readonly code = "INVALID_COMMAND_RESPONSE";
  constructor() {
    super(
      "AKM returned an invalid action response. State may already have changed. Reload the view before retrying; do not automatically repeat the action.",
    );
  }
}

/**
 * The result a CLI child printed, without its envelope (`shape`, `schemaVersion`). Exit zero is not sufficient evidence
 * that the expected action returned a valid result.
 */
export function parseCommandResponse(stdout: string, expectedShape: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stdout);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      parsed.shape !== expectedShape ||
      !Number.isInteger(parsed.schemaVersion) ||
      parsed.ok === false
    )
      throw new Error("Invalid command envelope");
    const { shape: _shape, schemaVersion: _schemaVersion, ...result } = parsed;
    return redactForUi(result) as Record<string, unknown>;
  } catch {
    throw new InvalidCommandResponse();
  }
}

/** `bundle create` and `bundle rename` are the `bundle` subcommands whose output shape is not their name. */
const bundleShape = (subcommand: string) =>
  subcommand === "create" || subcommand === "rename" ? `bundle-${subcommand}` : subcommand;

/**
 * Run the bundled CLI for an action whose validation and orchestration live in its `run()` body (feedback's argv-dependent
 * tag validation, the bundle install audits), and return its typed result. Bundle add and update also do network and git
 * work, which would block the single-threaded host in process.
 */
export async function runCli(args: string[], input?: string, userFeedback = false): Promise<Record<string, unknown>> {
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
          const message = redactUrlsInText(detail.error ?? (stderr.trim() || error.message));
          const kind = typeof error.code === "number" ? KIND_BY_EXIT[error.code] : undefined;
          // Exit 70, a signal or a failed spawn is akm failing, not the request: a plain Error.
          reject(kind ? new CommandError(message, detail.code ?? "COMMAND_FAILED", kind) : new Error(message));
          return;
        }
        try {
          resolve(parseCommandResponse(stdout, args[0] === "bundle" ? bundleShape(args[1]!) : args[0]!));
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
