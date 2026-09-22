// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import * as p from "../../cli/clack";
import { decideDangerousKeyInstall } from "../../core/activation-policy";
import { ConfigError } from "../../core/errors";
import { warn } from "../../core/warn";
import { sanitizeString } from "../../sources/providers/provider-utils";
import { scanEnvKeyNames } from "../env/env";
import { isDangerousEnvKey } from "../lint/env-key-rules";

export type DangerousKeyAuditDecision =
  | { blocked: true; exitCode: number; code: "DANGEROUS_ENV_KEY"; error: string; findings: DangerousKeyFinding[] }
  | { blocked: false; findings: DangerousKeyFinding[] };

export interface DangerousKeyFinding {
  envRef: string;
  keyName: string;
  relPath: string;
}

type DangerousKeyScanner = (
  envPath: string,
  relPath: string,
  envRef: string,
) => Array<{ detail: string; file: string }>;

let scannerOverride: DangerousKeyScanner | undefined;

/** TEST-ONLY. Inject a scanner fault at the audit boundary; undefined restores. */
export function _setDangerousKeyScannerForTests(scanner?: DangerousKeyScanner): void {
  scannerOverride = scanner;
}

function collectEnvFilePathsRecursive(rootDir: string): string[] {
  const results: string[] = [];
  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name !== ".env" && !entry.name.endsWith(".env")) continue;
      results.push(full);
    }
  };
  walk(rootDir);
  return results;
}

function collectDangerousKeyFindings(
  installedStashRoot: string,
  checkEnvForDangerousKeys: DangerousKeyScanner,
): DangerousKeyFinding[] {
  const allFindings: DangerousKeyFinding[] = [];
  if (!fs.statSync(installedStashRoot).isDirectory()) {
    throw new Error(`Expected ${installedStashRoot} to be a directory.`);
  }
  const dir = path.join(installedStashRoot, "env");
  try {
    if (!fs.statSync(dir).isDirectory()) {
      throw new Error(`Expected ${dir} to be a directory.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return allFindings;
    throw error;
  }
  for (const envPath of collectEnvFilePathsRecursive(dir)) {
    const relToEnvDir = path.relative(dir, envPath);
    const segments = relToEnvDir.split(path.sep);
    const lastSegment = segments[segments.length - 1] ?? "";
    const lastSegmentBase = lastSegment.endsWith(".env") ? lastSegment.slice(0, -".env".length) : lastSegment;
    const refSegments = [...segments.slice(0, -1), lastSegmentBase === "" ? "default" : lastSegmentBase];
    const envRef = `env/${refSegments.join("/")}`;
    const relPath = path.join("env", relToEnvDir);
    for (const finding of checkEnvForDangerousKeys(envPath, relPath, envRef)) {
      const keyMatch = finding.detail.match(/Env key `([^`]+)`/);
      allFindings.push({ envRef, keyName: keyMatch?.[1] ?? finding.file, relPath });
    }
  }
  return allFindings;
}

/** Scan only; callers that already obtained approval use this for a final materialization fence. */
export function scanStashForDangerousKeys(installedStashRoot: string): DangerousKeyFinding[] {
  const scanner =
    scannerOverride ??
    ((envPath: string, relPath: string) =>
      scanEnvKeyNames(fs.readFileSync(envPath, "utf8"))
        .filter(isDangerousEnvKey)
        .map((key) => ({ file: relPath, detail: `Env key \`${key}\`` })));
  return collectDangerousKeyFindings(installedStashRoot, scanner);
}

export async function auditStashForDangerousKeys(opts: {
  stashRoot: string;
  ref: string;
  allowDangerousKeys: boolean;
  isTTY: boolean;
  operation: "install" | "update";
  rollback?: () => Promise<string | undefined>;
  renderBlockedError?: boolean;
}): Promise<DangerousKeyAuditDecision> {
  let allFindings: DangerousKeyFinding[];
  try {
    allFindings = scanStashForDangerousKeys(opts.stashRoot);
  } catch (error) {
    const rollbackWarning = await opts.rollback?.();
    throw new ConfigError(
      `Dangerous environment-key audit failed for "${opts.ref}"; refusing to ${opts.operation} unverified content. ${error instanceof Error ? error.message : String(error)}${rollbackWarning ? ` ${rollbackWarning}` : ""}`,
      "DANGEROUS_ENV_AUDIT_FAILED",
    );
  }

  const stance = decideDangerousKeyInstall({
    findingsPresent: allFindings.length > 0,
    allowDangerousEnvKeys: opts.allowDangerousKeys,
  });
  if (stance === "allow") return { blocked: false, findings: allFindings };

  if (stance === "warn-allow") {
    for (const finding of allFindings) {
      warn(
        `[dangerous-env-key] ${finding.relPath}: key \`${finding.keyName}\` in ${finding.envRef} can hijack process execution via \`akm env run\`. Proceeding because --allow-dangerous-env-keys was set.`,
      );
    }
    return { blocked: false, findings: allFindings };
  }

  const operationTitle = opts.operation === "install" ? "Install" : "Update";
  const operationPast = opts.operation === "install" ? "installed" : "updated";
  let error: string;
  if (opts.isTTY) {
    const groupedByEnv = new Map<string, string[]>();
    for (const finding of allFindings) {
      const existing = groupedByEnv.get(finding.envRef) ?? [];
      existing.push(finding.keyName);
      groupedByEnv.set(finding.envRef, existing);
    }
    for (const [envRef, keys] of groupedByEnv) {
      warn(
        `[warn] Env "${sanitizeString(envRef)}" in stash "${sanitizeString(opts.ref)}" contains potentially dangerous keys:`,
      );
      for (const key of keys) warn(`  - ${sanitizeString(key)}: can hijack process execution via \`akm env run\``);
    }
    const confirmed = await p.confirm({ message: `${operationTitle} anyway?`, initialValue: false });
    if (!p.isCancel(confirmed) && confirmed === true) return { blocked: false, findings: allFindings };
    error = `${operationTitle} aborted: stash contains dangerous env keys. Remove the keys or re-run with --allow-dangerous-env-keys to bypass.`;
  } else {
    const keyList = allFindings.map((finding) => `  - ${finding.keyName} (${finding.envRef})`).join("\n");
    error = `${operationTitle} blocked: stash "${opts.ref}" contains dangerous env keys that can hijack process execution via \`akm env run\`:\n${keyList}\nRe-run with --allow-dangerous-env-keys to bypass this check after reviewing the env file.`;
  }

  const rollbackWarning = await opts.rollback?.();
  if (opts.renderBlockedError !== false) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error,
          code: "DANGEROUS_ENV_KEY",
          ...(rollbackWarning ? { rollbackWarning } : {}),
        },
        null,
        2,
      ),
    );
  }
  if (rollbackWarning) {
    warn(
      `The blocked ${opts.operation} could not be fully rolled back after content was ${operationPast}: ${rollbackWarning}`,
    );
  }
  return { blocked: true, exitCode: 1, code: "DANGEROUS_ENV_KEY", error, findings: allFindings };
}
