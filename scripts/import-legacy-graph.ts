import fs from "node:fs";
import path from "node:path";
import { closeDatabase, openDatabase } from "../src/indexer/db";
import { replaceStoredGraph } from "../src/indexer/db/graph-db";
import type { GraphFile } from "../src/indexer/graph/graph-extraction";

function usage(): never {
  throw new Error(
    "Usage: bun scripts/import-legacy-graph.ts --graph <path/to/graph.json> [--db <path/to/index.db>]",
  );
}

function parseArgs(argv: string[]): { graphPath: string; dbPath?: string } {
  let graphPath: string | undefined;
  let dbPath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--graph") {
      graphPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--db") {
      dbPath = argv[i + 1];
      i += 1;
      continue;
    }
  }

  if (!graphPath) usage();
  return { graphPath, ...(dbPath ? { dbPath } : {}) };
}

function isGraphFile(value: unknown): value is GraphFile {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.schemaVersion !== "number") return false;
  if (typeof obj.generatedAt !== "string") return false;
  if (typeof obj.stashRoot !== "string") return false;
  if (!Array.isArray(obj.files)) return false;
  return obj.files.every((file) => {
    if (typeof file !== "object" || file === null) return false;
    const node = file as Record<string, unknown>;
    if (typeof node.path !== "string") return false;
    if (typeof node.type !== "string") return false;
    if (!Array.isArray(node.entities) || !node.entities.every((entity) => typeof entity === "string")) return false;
    if (!Array.isArray(node.relations)) return false;
    return node.relations.every((relation) => {
      if (typeof relation !== "object" || relation === null) return false;
      const rel = relation as Record<string, unknown>;
      return typeof rel.from === "string" && typeof rel.to === "string";
    });
  });
}

const { graphPath, dbPath } = parseArgs(process.argv.slice(2));
const resolvedGraphPath = path.resolve(graphPath);
const raw = fs.readFileSync(resolvedGraphPath, "utf8");
const parsed = JSON.parse(raw) as unknown;

if (!isGraphFile(parsed)) {
  throw new Error(`Invalid legacy graph file: ${resolvedGraphPath}`);
}

const db = openDatabase(dbPath ? path.resolve(dbPath) : undefined);
try {
  replaceStoredGraph(db, parsed);

  // Query the actual row count imported (may be less than input if some files
  // are orphans with no matching entries row).
  const importedCount = (
    db.prepare("SELECT COUNT(*) AS cnt FROM graph_files WHERE stash_root = ?").get(parsed.stashRoot) as {
      cnt: number;
    }
  ).cnt;

  console.log(
    JSON.stringify(
      {
        ok: true,
        importedFrom: resolvedGraphPath,
        stashRoot: parsed.stashRoot,
        filesInSource: parsed.files.length,
        filesImported: importedCount,
        filesSkipped: parsed.files.length - importedCount,
        entityCount: parsed.entities?.length ?? null,
        relationCount: parsed.relations?.length ?? null,
      },
      null,
      2,
    ),
  );
} finally {
  closeDatabase(db);
}
