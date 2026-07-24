// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { isBundleSlug } from "../../../src/core/asset/asset-ref";
import { parseAndValidateConfigText, type AkmConfig } from "../../../src/core/config/config";
import { getConfigPath, getDataDir } from "../../../src/core/paths";
import {
  captureInstallationSnapshot,
  verifyInstallationSnapshot,
} from "./sources/installation-snapshot";

interface CaptureCliOptions {
  out: string;
  config?: string;
  data?: string;
  bundleOverrides: Map<string, string>;
  producerVersion: string;
  producerCommit?: string;
}

const HELP_FLAGS = new Set(["-h", "--help"]);

function printHelp(): void {
  process.stdout.write(`akm-eval-snapshot - capture and verify AKM installation snapshots

Usage:
  akm-eval-snapshot capture --out <dir> --producer-version <version> [options]
  akm-eval-snapshot verify <snapshot-dir>

Commands:
  capture   Capture the current configured installation.
  verify    Verify a snapshot and print its manifest.

Run "akm-eval-snapshot <command> --help" for command options.
`);
}

function printCaptureHelp(): void {
  process.stdout.write(`Usage:
  akm-eval-snapshot capture --out <dir> --producer-version <version> [options]

Options:
  --out <dir>                  New snapshot directory (required; never overwritten).
  --config <path>              Config file (default: AKM config path semantics).
  --data <dir>                 AKM data directory (default: AKM data path semantics).
  --bundle <id=path>           Bundle root override; repeat for multiple bundles.
  --producer-version <version> Snapshot producer version (required).
  --producer-commit <commit>   Snapshot producer commit.
  -h, --help                   Show help.
`);
}

function printVerifyHelp(): void {
  process.stdout.write(`Usage:
  akm-eval-snapshot verify <snapshot-dir>

Verifies snapshot integrity and prints the verified manifest JSON.
`);
}

function requireText(value: string, flag: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${flag} must not be empty`);
  return trimmed;
}

function resolveCliPath(value: string, flag: string): string {
  if (!value.trim() || value.includes("\0")) throw new Error(`${flag} must be a valid non-empty path`);
  return path.resolve(value);
}

function parseBundleOverride(value: string): { id: string; root: string } {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`--bundle must use id=path (got ${JSON.stringify(value)})`);
  }
  const id = value.slice(0, separator);
  if (!isBundleSlug(id)) throw new Error(`invalid bundle ID in --bundle: ${JSON.stringify(id)}`);
  return { id, root: resolveCliPath(value.slice(separator + 1), `--bundle ${id}`) };
}

function parseCaptureArgs(argv: string[]): CaptureCliOptions {
  let out: string | undefined;
  let config: string | undefined;
  let data: string | undefined;
  let producerVersion: string | undefined;
  let producerCommit: string | undefined;
  const bundleOverrides = new Map<string, string>();
  const seen = new Set<string>();

  const setOnce = (flag: string, value: string): void => {
    if (seen.has(flag)) throw new Error(`${flag} may be specified only once`);
    seen.add(flag);
    switch (flag) {
      case "--out":
        out = resolveCliPath(value, flag);
        break;
      case "--config":
        config = resolveCliPath(value, flag);
        break;
      case "--data":
        data = resolveCliPath(value, flag);
        break;
      case "--producer-version":
        producerVersion = requireText(value, flag);
        break;
      case "--producer-commit":
        producerCommit = requireText(value, flag);
        break;
    }
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = (): string => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--out":
      case "--config":
      case "--data":
      case "--producer-version":
      case "--producer-commit":
        setOnce(arg, next());
        break;
      case "--bundle": {
        const override = parseBundleOverride(next());
        if (bundleOverrides.has(override.id)) throw new Error(`duplicate --bundle override for ${override.id}`);
        bundleOverrides.set(override.id, override.root);
        break;
      }
      default:
        throw new Error(`unknown argument for capture: ${arg}`);
    }
  }

  if (!out) throw new Error("capture requires --out <dir>");
  if (!producerVersion) throw new Error("capture requires --producer-version <version>");
  return { out, config, data, bundleOverrides, producerVersion, producerCommit };
}

function parseVerifyArgs(argv: string[]): string {
  if (argv.length === 0) throw new Error("verify requires one snapshot directory");
  for (const arg of argv) {
    if (arg.startsWith("-")) throw new Error(`unknown argument for verify: ${arg}`);
  }
  if (argv.length !== 1) throw new Error("verify requires exactly one snapshot directory");
  return resolveCliPath(argv[0]!, "snapshot directory");
}

function readCurrentConfig(configPath: string): AkmConfig {
  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    throw new Error(`unable to read config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseAndValidateConfigText(text, configPath);
}

function resolveBundleRoots(config: AkmConfig, overrides: ReadonlyMap<string, string>): Record<string, string> {
  const bundles = config.bundles;
  if (!bundles || Object.keys(bundles).length === 0) throw new Error("current config must contain at least one bundle");
  if (!config.defaultBundle) throw new Error("current config must set defaultBundle");

  for (const id of overrides.keys()) {
    if (!Object.hasOwn(bundles, id)) throw new Error(`--bundle override names an unknown configured bundle: ${id}`);
  }

  return Object.fromEntries(
    Object.entries(bundles).map(([id, bundle]) => {
      const override = overrides.get(id);
      if (override) return [id, override];
      if (bundle.path !== undefined) return [id, resolveCliPath(bundle.path, `configured bundle ${id} path`)];
      throw new Error(`bundle ${id} uses a non-filesystem provider; pass --bundle ${id}=<path>`);
    }),
  );
}

function writeManifest(manifest: unknown): void {
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

export function runSnapshotCli(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const command = argv[0];
  if (command === undefined) throw new Error("missing subcommand: expected capture or verify");
  if (HELP_FLAGS.has(command) || command === "help") {
    printHelp();
    return 0;
  }

  const commandArgs = argv.slice(1);
  if (commandArgs.some((arg) => HELP_FLAGS.has(arg))) {
    if (command === "capture") printCaptureHelp();
    else if (command === "verify") printVerifyHelp();
    else throw new Error(`unknown subcommand: ${command}`);
    return 0;
  }

  if (command === "verify") {
    writeManifest(verifyInstallationSnapshot(parseVerifyArgs(commandArgs)));
    return 0;
  }
  if (command !== "capture") throw new Error(`unknown subcommand: ${command}`);

  const options = parseCaptureArgs(commandArgs);
  const configPath = options.config ?? path.resolve(getConfigPath(env));
  const dataDir = options.data ?? path.resolve(getDataDir(env));
  const config = readCurrentConfig(configPath);
  const bundleRoots = resolveBundleRoots(config, options.bundleOverrides);
  writeManifest(
    captureInstallationSnapshot({
      destinationDir: options.out,
      bundleRoots,
      defaultBundle: config.defaultBundle!,
      configPath,
      dataDir,
      producer: { version: options.producerVersion, commit: options.producerCommit ?? null },
    }),
  );
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = runSnapshotCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[akm-eval-snapshot] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
