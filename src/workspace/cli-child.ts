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
  readonly kind: AkmErrorKind;
  constructor(
    message: string,
    readonly code: string,
    exitCode: string | number | null | undefined,
  ) {
    super(message);
    // Exit 70, a signal or a failed spawn: akm itself failed, not the request. It stays a plain internal error.
    this.kind = (typeof exitCode === "number" ? KIND_BY_EXIT[exitCode] : undefined) ?? "config";
  }
  hint() {
    return undefined;
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
    throw new Error(
      "AKM returned an invalid action response. State may already have changed. Reload the view before retrying; do not automatically repeat the action.",
    );
  }
}

/** `bundle rename` is the one `bundle` subcommand whose output shape is not its name. */
const bundleShape = (subcommand: string) => (subcommand === "rename" ? "bundle-rename" : subcommand);

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
          const exit = typeof error.code === "number" ? error.code : undefined;
          // An exit the contract does not classify is akm failing, not the request: a plain Error.
          reject(
            exit !== undefined && KIND_BY_EXIT[exit]
              ? new CommandError(message, detail.code ?? "COMMAND_FAILED", exit)
              : new Error(message),
          );
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
