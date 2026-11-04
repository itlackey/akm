import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Desktop presentation only. This must never modify AKM's own configuration.
const file = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
  "akm-desktop",
  "preferences.json",
);
export function validTheme(value: unknown): value is "system" | "light" | "dark" {
  return value === "system" || value === "light" || value === "dark";
}
export async function readPreferences() {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return { theme: validTheme(value?.theme) ? value.theme : "system" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return { theme: "system" };
    throw error;
  }
}
export async function saveTheme(theme: "system" | "light" | "dark") {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ theme })}\n`, { mode: 0o600 });
  await rename(temporary, file);
  return { theme };
}
