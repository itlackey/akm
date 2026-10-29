import { spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Native listing fixtures keep health tests off the user's Claude installation. */
export function mockClaudePluginList(): void {
  const spawn = childProcess.spawnSync;
  spyOn(childProcess, "spawnSync").mockImplementation(((
    command: string,
    args: string[],
    options: { env?: Record<string, string> },
  ) => {
    if (command !== "claude") return spawn(command, args, options);
    const root = options.env?.CLAUDE_CODE_PLUGIN_CACHE_DIR ?? "";
    let rows = "[]";
    try {
      rows = fs.readFileSync(path.join(root, "native-list.json"), "utf8");
    } catch {
      /* no install */
    }
    return { status: rows === "unavailable" ? 1 : 0, stdout: rows, stderr: "", pid: 0, output: [], signal: null };
  }) as typeof childProcess.spawnSync);
}

export function selectClaudePlugin(root: string, rows: Array<Record<string, unknown>>): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {} }));
  fs.writeFileSync(path.join(root, "native-list.json"), JSON.stringify(rows));
}
