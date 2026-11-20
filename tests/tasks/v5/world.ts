// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The reference program's `World` as a real bundle: the tasks, env assets, secrets, prompt assets, scripts and agents
 * a test names are written as files under the isolated stash and a second bundle named `team`, and `check` calls the
 * code a start, `doctor explain` and the scheduler call.
 */

import { afterEach, beforeEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { saveConfig } from "../../../src/core/config/config";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../../src/core/warn";
import { checkTaskV5, type TaskV5StartFlags } from "../../../src/tasks/v5/check";
import { TASK_SOURCE_V5_VERSION } from "../../../src/tasks/v5/source";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
} from "../../_helpers/sandbox";

export interface WorldSpec {
  /** Task ref → the task as the file holds it (`version:` is added). */
  tasks?: Record<string, object>;
  /** `env/<name>` → its variables. A value may hold `${secrets/…}`. */
  envAssets?: Record<string, Record<string, string>>;
  /** `secrets/<name>` → its value. */
  secrets?: Record<string, string>;
  /** `commands/<name>` → the prompt asset's text. */
  commands?: Record<string, string>;
  /** `scripts/<file>` and `agents/<name>` → the file's text. */
  assets?: Record<string, string>;
}

export interface World {
  /** Reads the task and everything it runs, as a start does. */
  check(ref: string, values?: Record<string, string | number | boolean>, flags?: TaskV5StartFlags): Promise<unknown>;
  /** What the checker warned about, in order. */
  readonly warnings: string[];
  /** A folder outside every bundle, for a test that names one. */
  readonly scratch: string;
}

let storage: IsolatedAkmStorage;
let team: SandboxedDir;
let warnings: string[] = [];

/** Call at the top of a test file: each test gets its own isolated akm storage and `team` bundle. */
export function useWorlds(): void {
  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    team = makeSandboxDir("akm-v5-team");
    warnings = [];
    _resetWarnOnceForTests();
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(String(args[0]));
    });
  });
  afterEach(() => {
    _setWarnSinkForTests(undefined);
    team.cleanup();
    storage.cleanup();
  });
}

const FOLDERS = ["tasks", "commands", "scripts", "agents", "env", "secrets"];

/** The file a ref is kept in, in the bundle it names. */
function fileFor(ref: string): string {
  const [bundle, conceptId] = ref.includes("//") ? (ref.split("//") as [string, string]) : [undefined, ref];
  const root = bundle === "team" ? team.dir : storage.stashDir;
  const [folder] = conceptId.split("/");
  const extension =
    folder === "tasks" ? ".yml" : folder === "commands" || folder === "agents" ? ".md" : folder === "env" ? ".env" : "";
  return path.join(root, `${conceptId}${extension}`);
}

function write(ref: string, text: string): void {
  const file = fileFor(ref);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A fresh world: what an earlier one wrote is gone. */
export function world(spec: WorldSpec = {}): World {
  for (const root of [storage.stashDir, team.dir]) {
    for (const folder of FOLDERS) fs.rmSync(path.join(root, folder), { recursive: true, force: true });
  }
  saveConfig({
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    defaultBundle: "stash",
    bundles: { stash: { path: storage.stashDir, writable: true }, team: { path: team.dir, writable: true } },
  });
  for (const [ref, task] of Object.entries(spec.tasks ?? {})) {
    write(ref, stringify({ version: TASK_SOURCE_V5_VERSION, ...task }));
  }
  for (const [ref, variables] of Object.entries(spec.envAssets ?? {})) {
    write(
      ref,
      `${Object.entries(variables)
        .map(([name, value]) => `${name}=${value}`)
        .join("\n")}\n`,
    );
  }
  for (const [ref, value] of Object.entries(spec.secrets ?? {})) write(ref, value);
  for (const [ref, text] of Object.entries(spec.commands ?? {})) write(ref, text);
  for (const [ref, text] of Object.entries(spec.assets ?? {})) write(ref, text);
  return {
    check: (ref, values, flags) =>
      checkTaskV5({ ref, bundle: { name: "stash", dir: storage.stashDir }, values, flags }),
    get warnings() {
      return warnings;
    },
    scratch: storage.root,
  };
}
