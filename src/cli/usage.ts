// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "../core/paths";
import { isKnownType } from "../core/recognition-util";
import { hasSignalOwner, observeSignal } from "../core/signal-observers";
import { type Database, openDatabase } from "../storage/database";
import { cittyComparableName, findCittyTopLevelCommandIndex, toAliasArray } from "./invocation";

interface ArgDefinition {
  type?: string;
  alias?: string | readonly string[];
  default?: unknown;
  options?: readonly string[];
}
export interface UsageCommand {
  args?: Record<string, ArgDefinition>;
  subCommands?: Record<string, UsageCommand>;
}
interface ArgumentUsage {
  name: string;
  spelling: string;
  kind: string;
  explicit: boolean;
  negated?: boolean;
  value: string | boolean;
}
export interface InvocationUsage {
  command: string[];
  invokedCommand?: string[];
  arguments: ArgumentUsage[];
  childArgumentCount: number;
}

// Enum-like string flags are not enums in citty. Keep this finite allowlist
// independent of user data and never infer safety from the supplied value.
const SAFE_VALUES: Record<string, readonly string[]> = {
  format: ["json", "jsonl", "yaml", "text", "md"],
  detail: ["agent", "brief", "normal", "full"],
  type: ["skill", "agent", "command", "script", "knowledge", "workflow", "env", "secret", "memory", "lesson"],
};

/** Scan declared identities only. Unknown spellings can themselves contain secrets. */
export function describeUsage(root: UsageCommand, raw: readonly string[]): InvocationUsage {
  const boundary = raw.indexOf("--");
  const own = boundary < 0 ? raw : raw.slice(0, boundary);
  const result: InvocationUsage = {
    command: [],
    arguments: [],
    childArgumentCount: boundary < 0 ? 0 : raw.length - boundary - 1,
  };
  const definitions: Record<string, ArgDefinition> = {
    help: { type: "boolean", alias: "h" },
    version: { type: "boolean", alias: "v" },
  };
  const commandIndices = new Set<number>();
  let command = root;
  let offset = 0;
  for (;;) {
    const scanArgs = { "scheduler-context": { type: "string" }, ...command.args };
    Object.assign(definitions, scanArgs);
    const index = findCittyTopLevelCommandIndex(own.slice(offset), definitions);
    const token = index < 0 ? undefined : own[offset + index];
    const sub =
      token !== undefined && Object.hasOwn(command.subCommands ?? {}, token) ? command.subCommands?.[token] : undefined;
    if (!sub) {
      if (
        token !== undefined &&
        command.subCommands &&
        !Object.values(command.args ?? {}).some((arg) => arg.type === "positional")
      )
        result.command.push("[unknown]");
      break;
    }
    offset += index;
    commandIndices.add(offset++);
    result.command.push(token!);
    command = sub;
  }
  result.invokedCommand = [...result.command];
  const aliases: Record<string, string[]> = {
    health: ["doctor"],
    metrics: ["doctor", "metrics"],
    info: ["doctor", "info"],
    log: ["doctor", "log"],
    judge: ["doctor", "judge"],
  };
  const canonical = aliases[result.command[0] ?? ""];
  if (canonical) result.command = [...canonical, ...result.command.slice(1)];
  const flagNames = (definitions: Record<string, ArgDefinition>) => {
    const flags = new Map<string, string>();
    for (const [name, def] of Object.entries(definitions)) {
      if (def.type === "positional") continue;
      for (const spelling of [name, ...toAliasArray(def.alias)]) flags.set(cittyComparableName(spelling), name);
    }
    return flags;
  };
  const prefixFlags = flagNames(definitions);
  // A dynamic leaf may intentionally omit a root option such as --config:
  // after its command token that spelling is an authored asset input.
  const leafDefinitions: Record<string, ArgDefinition> = {
    help: { type: "boolean", alias: "h" },
    version: { type: "boolean", alias: "v" },
    "scheduler-context": { type: "string" },
    ...command.args,
  };
  const leafFlags = flagNames(leafDefinitions);
  const dynamicInputs = ["run", "workflow run", "task run", "task explain"].includes(result.command.join(" "));
  const positional = Object.entries(command.args ?? {}).filter(([, def]) => def.type === "positional");
  const explicit = new Set<string>();
  let position = 0;
  for (let index = 0; index < own.length; index++) {
    if (commandIndices.has(index)) continue;
    const token = own[index]!;
    const currentDefinitions = index < offset ? definitions : leafDefinitions;
    const flags = index < offset ? prefixFlags : leafFlags;
    if (token.startsWith("-") && token !== "-" && !/^-\d/.test(token)) {
      if (!token.startsWith("--")) {
        for (let shortIndex = 1; shortIndex < token.length; shortIndex++) {
          const spelling = token[shortIndex]!;
          const name = flags.get(cittyComparableName(spelling));
          const def = name ? currentDefinitions[name] : undefined;
          let value: string | boolean = def?.type === "boolean" ? true : "[redacted]";
          if (def && def.type !== "boolean") {
            const input = shortIndex + 1 < token.length ? token.slice(shortIndex + 1) : own[++index];
            const safe = def.type === "enum" ? def.options : SAFE_VALUES[name!];
            if (input !== undefined && safe?.includes(input)) value = input;
          }
          if (name) explicit.add(name);
          result.arguments.push({
            name: name ?? "[unknown]",
            spelling: name ? `-${spelling}` : "[redacted]",
            kind: def?.type ?? "unknown",
            explicit: true,
            value,
          });
          // An unknown short spelling may introduce an opaque attached value.
          if (!def || def.type !== "boolean") break;
        }
        continue;
      }
      const equal = token.indexOf("=");
      const spelling = (equal < 0 ? token : token.slice(0, equal)).replace(/^-+/, "");
      const negativeName = spelling.startsWith("no-") ? flags.get(cittyComparableName(spelling.slice(3))) : undefined;
      const negated = negativeName !== undefined && currentDefinitions[negativeName]?.type === "boolean";
      const name = negated ? negativeName : flags.get(cittyComparableName(spelling));
      const def = name ? currentDefinitions[name] : undefined;
      const supplied = equal < 0 ? undefined : token.slice(equal + 1);
      let value: string | boolean = "[redacted]";
      if (def?.type === "boolean") {
        // citty removes a complete --no-* token before parsing: an inline
        // assignment negates a different (undeclared) key, not this boolean.
        value = negated ? (supplied === undefined ? false : "[not-applied]") : supplied !== "false";
      } else if (def) {
        const input = supplied ?? own[++index];
        const safe = def.type === "enum" ? def.options : SAFE_VALUES[name!];
        if (input !== undefined && safe?.includes(input)) value = input;
      }
      // Match task/workflow exact-name input scanners: a separate value belongs
      // to its dynamic flag, rather than becoming another positional ref.
      if (!def && dynamicInputs && supplied === undefined) {
        const next = own[index + 1];
        if (next !== undefined && (!next.startsWith("-") || /^-\d/.test(next))) index += 1;
      }
      if (name) explicit.add(name);
      result.arguments.push({
        name: name ?? "[unknown]",
        spelling: name ? `-${token.startsWith("--") ? "-" : ""}${spelling}` : "[redacted]",
        kind: def?.type ?? (dynamicInputs ? "asset-input" : "unknown"),
        explicit: true,
        negated,
        value,
      });
    } else {
      result.arguments.push({
        name: positional[Math.min(position++, positional.length - 1)]?.[0] ?? "[extra]",
        spelling: "positional",
        kind: "positional",
        explicit: true,
        value: "[redacted]",
      });
    }
  }
  for (const [name, def] of Object.entries(definitions)) {
    // run declares a union of executor options; these are not effective defaults.
    if (result.command[0] === "run") continue;
    if (def.default === undefined || explicit.has(name)) continue;
    const value =
      typeof def.default === "boolean"
        ? def.default
        : SAFE_VALUES[name]?.includes(String(def.default))
          ? String(def.default)
          : "[redacted]";
    result.arguments.push({ name, spelling: "default", kind: def.type ?? "unknown", explicit: false, value });
  }
  return result;
}

export const CLI_USAGE_SOURCES: ReadonlySet<string> = new Set(["user", "agent", "task", "improve", "audit", "unknown"]);

const RETENTION_MS = 30 * 86400_000;
function usagePath(): string {
  return path.join(getDataDir(), "usage.sqlite");
}
function openUsage(filename: string): Database {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = openDatabase(filename);
  try {
    db.exec("PRAGMA busy_timeout=250;");
    const schema = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (schema > 1) {
      throw new Error("Newer usage schema");
    }
    db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invocations (id TEXT PRIMARY KEY, ts TEXT NOT NULL, aggregate_key TEXT NOT NULL, data TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, category TEXT, asset_type TEXT, signal TEXT);
    CREATE INDEX IF NOT EXISTS invocations_ts ON invocations(ts);
    CREATE TABLE IF NOT EXISTS aggregates (key TEXT PRIMARY KEY, dimensions TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, cancelled INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, max_duration_ms INTEGER NOT NULL DEFAULT 0, outcomes TEXT NOT NULL DEFAULT '{}'); PRAGMA user_version=1;`);
    db.prepare("INSERT OR IGNORE INTO metadata VALUES ('instance', ?)").run(randomUUID());
    db.prepare("INSERT OR IGNORE INTO metadata VALUES ('collectionStart', ?)").run(new Date().toISOString());
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

let activeResolution: ((type: string, executor?: UsageCommand) => void) | undefined;
export function setResolvedUsageAssetType(type: string, executor?: UsageCommand): void {
  if (isKnownType(type)) activeResolution?.(type, executor);
}

export function startUsage(root: UsageCommand, raw: readonly string[], version: string): () => void {
  const started = Date.now();
  const id = randomUUID();
  let done = false;
  let key: string | undefined;
  let filename: string | undefined;
  let signal: string | undefined;
  let stored = false;
  let resolvedAssetType: string | undefined;
  let selectedExecutor: UsageCommand | undefined;
  let dimensions: Record<string, unknown> = {};
  let data: Record<string, unknown> = {};
  const source = CLI_USAGE_SOURCES.has(process.env.AKM_EVENT_SOURCE ?? "") ? process.env.AKM_EVENT_SOURCE! : "unknown";
  try {
    filename = usagePath();
    const db = openUsage(filename);
    try {
      const instance = (db.prepare("SELECT value FROM metadata WHERE key='instance'").get() as { value: string }).value;
      const ts = new Date(started).toISOString();
      const usage = describeUsage(root, raw);

      dimensions = { day: ts.slice(0, 10), version, source, instance, ...usage };
      data = { schemaVersion: 1, id, ts, version, source, instance, ...usage };
      key = JSON.stringify(dimensions);
      db.transaction(() => {
        db.prepare("INSERT INTO invocations(id,ts,aggregate_key,data) VALUES (?,?,?,?)").run(
          id,
          ts,
          key!,
          JSON.stringify(data),
        );
        db.prepare(
          "INSERT INTO aggregates(key,dimensions,attempts) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1",
        ).run(key!, key!);
        db.prepare("DELETE FROM invocations WHERE ts < ?").run(new Date(started - RETENTION_MS).toISOString());
      })();
      stored = true;
    } finally {
      db.close();
    }
  } catch {
    /* Collection never changes command behavior or prints user data. */
  }
  // A run's union schema cannot identify which flags are asset inputs. Once
  // dispatch selects an executor, move its pending attempt and aggregate count
  // together, retaining the same invocation id and redacted original argv.
  const checkpoint = (db: Database): string => {
    if (resolvedAssetType === undefined) return key!;
    const usage = selectedExecutor
      ? describeUsage({ ...root, subCommands: { ...root.subCommands, run: selectedExecutor } }, raw)
      : undefined;
    const nextDimensions = usage ? { ...dimensions, ...usage } : dimensions;
    const nextData = usage ? { ...data, ...usage } : data;
    const nextKey = JSON.stringify(nextDimensions);
    const updated = db
      .prepare("UPDATE invocations SET aggregate_key=?,data=?,asset_type=? WHERE id=? AND category IS NULL")
      .run(nextKey, JSON.stringify(nextData), resolvedAssetType ?? null, id);
    if (updated.changes && nextKey !== key) {
      db.prepare("UPDATE aggregates SET attempts=attempts-1 WHERE key=?").run(key!);
      db.prepare("DELETE FROM aggregates WHERE key=? AND attempts=0 AND completed=0").run(key!);
      db.prepare(
        "INSERT INTO aggregates(key,dimensions,attempts) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1",
      ).run(nextKey, nextKey);
    }
    return nextKey;
  };
  const resolve = (type: string, executor?: UsageCommand) => {
    resolvedAssetType = type;
    selectedExecutor = executor;
    if (!stored) return;
    try {
      const db = openUsage(filename!);
      try {
        key = db.transaction(() => checkpoint(db))();
      } finally {
        db.close();
      }
    } catch {
      // Finalization retries a contended checkpoint before recording outcome.
    }
  };
  activeResolution = resolve;
  const finish = () => {
    if (done) return;
    done = true;
    if (activeResolution === resolve) activeResolution = undefined;
    process.removeListener("exit", onExit);
    stopInt();
    stopTerm();
    if (!stored) return;
    const duration = Math.max(0, Date.now() - started);
    const exitCode = signal ? (signal === "SIGINT" ? 130 : 143) : Number(process.exitCode ?? 0);
    const category = signal
      ? "cancelled"
      : ((
          {
            0: "success",
            1: "general",
            2: "usage",
            4: "health-warning",
            70: "internal",
            75: "transient",
            78: "config",
          } as Record<number, string>
        )[exitCode] ?? "failure");
    try {
      const db = openUsage(filename!);
      try {
        const nextKey = db.transaction(() => {
          const resolvedKey = checkpoint(db);
          const updated = db
            .prepare(
              "UPDATE invocations SET duration_ms=?,exit_code=?,category=?,asset_type=?,signal=? WHERE id=? AND category IS NULL",
            )
            .run(duration, exitCode, category, resolvedAssetType ?? null, signal ?? null, id);
          if (!updated.changes) return resolvedKey;
          const row = db.prepare("SELECT outcomes FROM aggregates WHERE key=?").get(resolvedKey) as {
            outcomes: string;
          };
          const outcomes = JSON.parse(row.outcomes) as Record<string, number>;
          const outcome = `${category}:${exitCode}:${resolvedAssetType ?? "unresolved"}`;
          outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
          db.prepare(
            "UPDATE aggregates SET completed=completed+1, failures=failures+?,cancelled=cancelled+?,duration_ms=duration_ms+?,max_duration_ms=MAX(max_duration_ms,?),outcomes=? WHERE key=?",
          ).run(exitCode === 0 ? 0 : 1, signal ? 1 : 0, duration, duration, JSON.stringify(outcomes), resolvedKey);
          return resolvedKey;
        })();
        key = nextKey;
      } finally {
        db.close();
      }
    } catch {
      /* The pending attempt is a visible completion gap. */
    }
  };
  const onExit = (code: number) => {
    if (!signal) process.exitCode = code;
    finish();
  };
  const onSignal = (received: "SIGINT" | "SIGTERM") => {
    signal = received;
    const otherListeners = hasSignalOwner(received);
    finish();
    if (!otherListeners) process.kill(process.pid, received);
  };
  const onInt = () => onSignal("SIGINT");
  const onTerm = () => onSignal("SIGTERM");
  process.once("exit", onExit);
  const stopInt = observeSignal("SIGINT", onInt);
  const stopTerm = observeSignal("SIGTERM", onTerm);
  return finish;
}

export interface UsageFilter {
  since?: string;
  until?: string;
  version?: string;
  source?: string;
}
export function readUsage(filter: UsageFilter = {}) {
  const gaps = [
    "Before collectionStart is unmeasured; direct SDK calls and failures before the CLI module loads are not observed.",
    "SIGKILL, runtime crashes and power loss cannot be finalized; pending attempts are not successes.",
    "Unavailable storage can prevent recording an attempt; the number of completely unrecorded attempts is unknown.",
    "Aggregates use UTC days; window filters select whole days. Details expire after 30 days; aggregates are retained.",
  ];
  const empty = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    kind: "cli-usage",
    collectionStart: null as string | null,
    filters: filter,
    retentionDays: 30,
    gaps,
    aggregates: [] as Record<string, unknown>[],
    details: [] as Record<string, unknown>[],
  };
  if (!fs.existsSync(usagePath())) {
    gaps.push("Usage storage is absent: this is unmeasured, not zero usage.");
    return empty;
  }
  let db: Database | undefined;
  try {
    db = openDatabase(usagePath(), { readonly: true, create: false });
    db.exec("PRAGMA busy_timeout=250; PRAGMA query_only=ON;");
    if ((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version > 1) {
      gaps.push("Usage storage was written by a newer release; upgrade akm to read it.");
      return empty;
    }
    empty.collectionStart =
      (db.prepare("SELECT value FROM metadata WHERE key='collectionStart'").get() as { value: string } | undefined)
        ?.value ?? null;
    const selected = (dimensions: Record<string, unknown>) =>
      (!filter.since || String(dimensions.day) >= filter.since.slice(0, 10)) &&
      (!filter.until || String(dimensions.day) <= filter.until.slice(0, 10)) &&
      (!filter.version || dimensions.version === filter.version) &&
      (!filter.source || dimensions.source === filter.source);
    for (const row of db.prepare("SELECT * FROM aggregates ORDER BY key").all() as Array<Record<string, unknown>>) {
      const dimensions = JSON.parse(String(row.dimensions)) as Record<string, unknown>;
      if (selected(dimensions))
        empty.aggregates.push({
          ...row,
          dimensions,
          outcomes: JSON.parse(String(row.outcomes)),
          unfinished: Number(row.attempts) - Number(row.completed),
        });
    }
    for (const row of db.prepare("SELECT * FROM invocations ORDER BY ts,id").all() as Array<Record<string, unknown>>) {
      const data = JSON.parse(String(row.data)) as Record<string, unknown>;
      if (selected({ ...data, day: String(data.ts).slice(0, 10) }))
        empty.details.push({
          ...data,
          durationMs: row.duration_ms,
          exitCode: row.exit_code,
          category: row.category ?? "unfinished",
          assetType: row.asset_type,
          signal: row.signal,
        });
    }
  } catch {
    gaps.push("Usage storage could not be read; counts are unavailable.");
  } finally {
    db?.close();
  }
  return empty;
}
