// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The corpus's scenarios: cases the single shared sandbox of `corpusCases()` cannot hold, because each needs a fixture
 * of its own (a loose workflow, a symlink, a bundle with no adapter in config, stored proposals in more spellings, an
 * existing file to write over) or a different configuration (embeddings on). Each scenario runs in a fresh sandbox, so
 * it cannot disturb the main run or another scenario. See `harness.ts` for how they run and what is recorded.
 *
 * The behaviour reviews of the adapter refactor (`akm` at the working tree against `1f2e58c9`, by hand) found
 * differences the main corpus did not show; each scenario below is one of those checks made permanent, so a later phase
 * finds such a difference itself.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CorpusCase, Sandbox } from "./harness";

export interface Scenario {
  id: string;
  /** Write the scenario's own files. Runs in the fresh sandbox before anything else. */
  setup?: (sb: Sandbox) => void;
  /** akm commands that run before the recorded ones and are not recorded (an index, say). */
  prep?: string[][];
  /** Runs once `prep` has: a change to the sandbox that must come after those commands ran (a directory moved once state was filed). */
  afterPrep?: (sb: Sandbox) => void;
  cases: CorpusCase[];
  /** Bundles whose files each case's result records the changes to (the files that case wrote or removed). */
  track?: string[];
  /** Read after each case and recorded with it as `value`. */
  after?: (sb: Sandbox) => unknown;
  /** Read once, after the last case; each is recorded as the case `<scenario> :: <name>`. */
  finals?: Record<string, (sb: Sandbox) => unknown>;
  /** Run with a fake embeddings server and `semanticSearchMode: auto`. */
  embeddings?: boolean;
}

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const workflowDoc = (title: string, extra = "") =>
  `---\ntype: workflow\ndescription: ${title}\n${extra}steps:\n  - id: only\n    unit:\n      exec:\n        command: ["true"]\n---\n\n# ${title}\n\n## only\n\nDo it.\n`;

function indexFile(sb: Sandbox): string | undefined {
  return [sb.env.XDG_CACHE_HOME, sb.env.XDG_DATA_HOME]
    .map((dir) => path.join(dir as string, "akm", "index.db"))
    .find((file) => fs.existsSync(file));
}

/** The index's layout: what another binary needs to find to read it. */
function indexLayout(sb: Sandbox): unknown {
  const file = indexFile(sb);
  if (!file) return "<no index.db>";
  const db = new Database(file, { readonly: true });
  try {
    const tables = (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
    )
      .map((r) => r.name)
      .filter((name) => !/_fts_|_vec_/.test(name));
    const columns: Record<string, string[]> = {};
    for (const table of tables) {
      columns[table] = (
        db.query(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>
      ).map((r) => r.name);
    }
    return {
      userVersion: (db.query("PRAGMA user_version").get() as { user_version: number }).user_version,
      metaVersion: (db.query("SELECT value FROM index_meta WHERE key = 'version'").get() as { value: string } | null)
        ?.value,
      columns,
    };
  } finally {
    db.close();
  }
}

/** The index's entries: which ref each file is filed under. */
function indexRows(sb: Sandbox): unknown {
  const file = indexFile(sb);
  if (!file) return "<no index.db>";
  const db = new Database(file, { readonly: true });
  try {
    return db.query("SELECT item_ref, type, file_path FROM entries ORDER BY item_ref").all();
  } finally {
    db.close();
  }
}

/** The assets an embeddings scenario creates, and whether each has a vector in the index yet. */
const CREATED = [
  "memories/remembered",
  "knowledge/doc",
  "knowledge/guide-copy",
  "knowledge/new-note",
  "tasks/newtask",
  "tasks/imported-task",
  "env/newone",
  "secrets/newsec",
  "workflows/newflow",
];

function embeddingPresence(sb: Sandbox): unknown {
  const file = indexFile(sb);
  if (!file) return "<no index.db>";
  const db = new Database(file, { readonly: true });
  try {
    const out: Record<string, string> = {};
    for (const ref of CREATED) {
      const row = db.query("SELECT id FROM entries WHERE item_ref = ? OR item_ref = ?").get(ref, `main//${ref}`) as {
        id: number;
      } | null;
      if (!row) out[ref] = "not indexed";
      else if (db.query("SELECT 1 AS v FROM embeddings WHERE id = ?").get(row.id)) out[ref] = "vector";
      else out[ref] = "no vector";
    }
    return out;
  } finally {
    db.close();
  }
}

/** Store proposals for the asset refs in `refs`, each a copy of fixture proposal 0002 with that ref (and its bundle's directory). */
function storeProposals(sb: Sandbox, refs: string[]): void {
  const db = new Database(sb.stateDb);
  try {
    const row = db.query("SELECT * FROM proposals WHERE id = '00000000-0000-4000-8000-000000000002'").get() as Record<
      string,
      unknown
    >;
    const columns = Object.keys(row);
    const insert = db.query(
      `INSERT INTO proposals (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    );
    for (const [i, ref] of refs.entries()) {
      const copy: Record<string, unknown> = {
        ...row,
        id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`,
        ref,
      };
      if (ref.startsWith("team//")) copy.stash_dir = String(copy.stash_dir).replace("/main", "/team");
      insert.run(...columns.map((c) => copy[c] as never));
    }
  } finally {
    db.close();
  }
}

/** One proposal's stored status and `metadata_json`, as the record (the string, so what akm stamped is normalised). */
function proposalMetadata(sb: Sandbox, id: string): unknown {
  const db = new Database(sb.stateDb, { readonly: true });
  try {
    const row = db.query("SELECT status, metadata_json FROM proposals WHERE id = ?").get(id) as {
      status: string;
      metadata_json: string;
    } | null;
    return row ?? "<no such proposal>";
  } finally {
    db.close();
  }
}

/** Insert one proposal row in the shape an older akm stored it (files, not refs). */
function insertOldProposal(
  sb: Sandbox,
  row: { id: string; ref: string; source: string; content: string; meta: unknown },
): void {
  const db = new Database(sb.stateDb);
  try {
    db.query(
      `INSERT INTO proposals (id, stash_dir, ref, status, source, created_at, updated_at, content, frontmatter_json, metadata_json)
       VALUES (?, ?, ?, 'pending', ?, '2026-01-30T10:00:00.000Z', '2026-01-30T10:00:00.000Z', ?, NULL, ?)`,
    ).run(row.id, path.join(sb.fixture, "main"), row.ref, row.source, row.content, JSON.stringify(row.meta));
  } finally {
    db.close();
  }
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** A pending human retire of `memories/deploy-note` (its `.derived` twin goes with it); `intent`: an accept begun and not finished. */
function retireProposal(sb: Sandbox, id: string, options: { intent?: boolean }): void {
  const file = path.join(sb.fixture, "main/memories/deploy-note.md");
  const bytes = fs.readFileSync(file, "utf8");
  insertOldProposal(sb, {
    id,
    ref: "main//memories/deploy-note",
    source: "propose",
    content: "",
    meta: {
      changes: [{ path: "memories/deploy-note.md", op: "delete" }],
      proposedTarget: { source: "main", root: path.join(sb.fixture, "main") },
      beforeHash: sha256(bytes),
      ...(options.intent ? { retireAcceptIntent: { assetPath: file, backupContent: bytes } } : {}),
    },
  });
}

/** A pending consolidate promotion of `memories/deploy-note` into `knowledge/promoted`; accepting it retires the source. */
function promotionProposal(sb: Sandbox, id: string): void {
  const source = fs.readFileSync(path.join(sb.fixture, "main/memories/deploy-note.md"), "utf8");
  const body = source.replace(/^---[\s\S]*?---\n/, "").trim();
  insertOldProposal(sb, {
    id,
    ref: "main//knowledge/promoted",
    source: "consolidate",
    content: "---\ndescription: Promoted deploy note\n---\n\nWarm the cache first.\n",
    meta: {
      changes: [{ path: "knowledge/promoted.md", op: "create" }],
      proposedTarget: { source: "main", root: path.join(sb.fixture, "main") },
      promotionSource: "main//memories/deploy-note",
      promotionSourceHash: sha256(body),
    },
  });
}

const config = (sb: Sandbox) => JSON.parse(fs.readFileSync(sb.configFile, "utf8")) as Record<string, unknown>;

const c = (id: string, args: string[], extra: Partial<CorpusCase> = {}): CorpusCase => ({ id, args, ...extra });

/** Store one proposal (a copy of fixture proposal 0002 with this id and ref) in the queue filed under `stashDir`. */
function storeProposalIn(sb: Sandbox, id: string, ref: string, stashDir: string): void {
  const db = new Database(sb.stateDb);
  try {
    const row = db.query("SELECT * FROM proposals WHERE id = '00000000-0000-4000-8000-000000000002'").get() as Record<
      string,
      unknown
    >;
    const columns = Object.keys(row);
    const copy: Record<string, unknown> = { ...row, id, ref, stash_dir: stashDir };
    db.query(`INSERT INTO proposals (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(
      ...columns.map((column) => copy[column] as never),
    );
  } finally {
    db.close();
  }
}

/** Two git bundles whose checkouts are in the cache (a bundle's checkout is `<cache>/registry-index/git-<sha256 of its url, 16 hex>/repo`). */
function gitBundles(sb: Sandbox): string[] {
  const cfg = config(sb) as { bundles: Record<string, unknown> };
  const checkouts: string[] = [];
  for (const name of ["alpha", "beta"]) {
    const url = `https://example.test/${name}-notes`;
    const checkout = path.join(
      sb.env.XDG_CACHE_HOME as string,
      "akm",
      "registry-index",
      `git-${createHash("sha256").update(url).digest("hex").slice(0, 16)}`,
      "repo",
    );
    write(path.join(checkout, "knowledge", "note.md"), `---\ndescription: ${name}\n---\n\n${name} note.\n`);
    cfg.bundles[name] = { git: url, writable: true };
    checkouts.push(checkout);
  }
  fs.writeFileSync(sb.configFile, JSON.stringify(cfg, null, 2));
  return checkouts;
}

/** Move the `main` bundle's directory and point its config entry at the new place (the bundle keeps its name). */
function moveMainBundle(sb: Sandbox): string {
  const moved = path.join(sb.fixture, "main-moved");
  fs.renameSync(path.join(sb.fixture, "main"), moved);
  const cfg = config(sb) as { bundles: Record<string, { path: string }> };
  (cfg.bundles.main as { path: string }).path = moved;
  fs.writeFileSync(sb.configFile, JSON.stringify(cfg, null, 2));
  return moved;
}

/** Rename the `main` bundle to `primary` by hand in config: the key, the default and the write target. */
function renameMainBundleByHand(sb: Sandbox): void {
  const cfg = config(sb) as Record<string, unknown> & { bundles: Record<string, unknown> };
  cfg.bundles = Object.fromEntries(
    Object.entries(cfg.bundles).map(([key, entry]) => [key === "main" ? "primary" : key, entry]),
  );
  cfg.defaultBundle = "primary";
  cfg.defaultWriteTarget = "primary";
  fs.writeFileSync(sb.configFile, JSON.stringify(cfg, null, 2));
}

/** What `akm doctor` says about state filed under a bundle name no configured bundle has: the one finding, its status and evidence. */
function doctorUnknownBundle(sb: Sandbox): unknown {
  const proc = Bun.spawnSync(
    [process.execPath, path.join(sb.tree, "src", "cli.ts"), "doctor", "--no-probe", "--format", "json"],
    {
      cwd: path.join(sb.root, "work"),
      env: sb.env,
      stdin: "ignore",
      timeout: 120_000,
    },
  );
  const report = JSON.parse(proc.stdout.toString()) as {
    advisories?: Array<{ name: string; status: string; evidence?: unknown }>;
  };
  const found = (report.advisories ?? []).find((entry) => entry.name === "state-unknown-bundle");
  return found ? { status: found.status, evidence: found.evidence } : "<no state-unknown-bundle finding>";
}

export const SCENARIOS: Scenario[] = [
  {
    // A `.md` with `type: workflow` outside workflows/: base indexes it as a workflow, refuses it (WORKFLOW_SOURCE_INVALID)
    // and lint never asks it for `updated`.
    id: "loose workflow",
    setup: (sb) => write(path.join(sb.fixture, "main/notes/loose-flow.md"), workflowDoc("Loose flow")),
    prep: [["index", "--quiet"]],
    cases: [
      c("show", ["show", "notes/loose-flow"]),
      c("search", ["search", "loose"]),
      c("workflow plan", ["workflow", "plan", "notes/loose-flow"]),
      c("workflow run", ["workflow", "run", "notes/loose-flow"]),
      c("workflow status", ["workflow", "status", "notes/loose-flow"]),
      c("run", ["run", "notes/loose-flow"]),
      c("task add", ["task", "add", "lf", "--schedule", "@daily", "--workflow", "notes/loose-flow"]),
      c("lint", ["lint", "--format", "json"]),
      c("lint type workflows", ["lint", "--type", "workflows"]),
    ],
  },
  {
    // A workflow that is a symlink to a file with another extension: `show` and `index` warn that it resolves through one.
    id: "symlinked workflow",
    setup: (sb) => {
      write(path.join(sb.root, "work/real.txt"), workflowDoc("Linked"));
      fs.mkdirSync(path.join(sb.fixture, "main/workflows"), { recursive: true });
      fs.symlinkSync("../../../work/real.txt", path.join(sb.fixture, "main/workflows/linked.md"));
    },
    cases: [
      c("show before index", ["show", "workflows/linked"]),
      c("index", ["index"]),
      c("show", ["show", "workflows/linked"]),
      c("workflow plan", ["workflow", "plan", "workflows/linked"]),
      c("workflow run", ["workflow", "run", "workflows/linked"]),
      c("lint", ["lint", "--format", "json"]),
      c("index --full", ["index", "--full"]),
    ],
  },
  {
    // A bundle holding workflows that config gives no adapter: it is detected as akm-workflow, and `workflow plan` and `run`
    // must work before and after the index writes the detected adapter to config.
    id: "workflow bundle with no adapter",
    setup: (sb) => {
      write(path.join(sb.fixture, "wf/deploy.md"), workflowDoc("Deploy"));
      const cfg = config(sb);
      (cfg.bundles as Record<string, unknown>).wf = { path: path.join(sb.fixture, "wf") };
      fs.writeFileSync(sb.configFile, JSON.stringify(cfg, null, 2));
    },
    cases: [
      c("workflow plan", ["workflow", "plan", "wf//deploy"]),
      c("run", ["run", "wf//deploy"]),
      c("show", ["show", "wf//deploy"]),
      c("index", ["index"]),
      c("workflow run", ["workflow", "run", "wf//deploy"]),
    ],
    finals: { "config.json": config },
  },
  {
    // `index --verbose` prints a line per directory: the lines' ORDER is compared (stderr is an ordered list), full and
    // incremental. The same fresh index is then read for its layout: the schema version and the columns a base binary needs.
    id: "index verbose",
    cases: [
      c("index --full --verbose", ["index", "--full", "--verbose", "--format", "text"]),
      c("index --verbose", ["index", "--verbose", "--format", "text"]),
    ],
    finals: { "index layout": indexLayout },
  },
  {
    // The proposal `--ref` filters against refs stored in the spellings users and older releases wrote: file spellings,
    // outdated heads, another case, and a bundle this config does not have.
    id: "proposal refs",
    setup: (sb) =>
      storeProposals(sb, [
        "main//knowledge/guide.md",
        "main//Knowledge/Guide",
        "main//knowledge/reports/quarterly",
        "main//reports/quarterly.md",
        "main//skills/deploy/SKILL.md",
        "main//tasks/nightly.yml",
        "stash//knowledge/guide.md",
        "knowledge/guide.md",
        "knowledge:guide",
      ]),
    cases: [
      ...[
        "knowledge/guide",
        "knowledge/guide.md",
        "main//knowledge/guide",
        "stash//knowledge/guide.md",
        "reports/quarterly",
        "knowledge/reports/quarterly",
        "skills/deploy",
        "tasks/nightly",
        "Knowledge/GUIDE",
        "Knowledge/Guide",
        "knowledge:guide",
        "nosuch//knowledge/guide",
        "knowledge/new-note",
      ].map((ref) => c(`list --ref ${ref}`, ["proposal", "list", "--ref", ref])),
      c("list", ["proposal", "list"]),
      c("diff knowledge/guide", ["proposal", "diff", "knowledge/guide"]),
      c("show knowledge/guide.md", ["proposal", "show", "knowledge/guide.md"]),
      c("show Knowledge/Guide", ["proposal", "show", "Knowledge/Guide"]),
    ],
  },
  {
    // Writing over an asset that exists, with and without --force, under the spelling it was written in: the bytes on disk,
    // and which file they land in (an off-case `memories/mm.MD` must not gain a `mm.md` beside it, N19).
    id: "create over existing",
    setup: (sb) => {
      write(path.join(sb.fixture, "main/memories/mm.MD"), "---\ndescription: old mm\n---\n\nthe old mm\n");
      write(path.join(sb.fixture, "main/knowledge/kk.MD"), "---\ndescription: old kk\n---\n\nthe old kk\n");
      write(path.join(sb.fixture, "main/knowledge/doc.md"), "---\ndescription: old doc\n---\n\nthe old doc\n");
      write(path.join(sb.fixture, "main/workflows/Shipped.MD"), workflowDoc("Old shipped"));
      fs.copyFileSync(path.join(sb.fixture, "main/tasks/nightly.yml"), path.join(sb.fixture, "main/tasks/tt.YML"));
      write(
        path.join(sb.root, "work/doc.md"),
        "---\ndescription: imported doc\n---\n# Imported\n\nSome imported text.\n",
      );
      write(path.join(sb.root, "work/kk.md"), "---\ndescription: imported kk\n---\n# KK\n\nNew kk text.\n");
      fs.copyFileSync(path.join(sb.fixture, "main/tasks/nightly.yml"), path.join(sb.root, "work/t.yml"));
    },
    prep: [["index", "--quiet"]],
    track: ["main"],
    cases: [
      c("remember new", ["remember", "a new fact", "--name", "dupmem"]),
      c("remember existing", ["remember", "another fact", "--name", "dupmem"]),
      c("remember existing --force", ["remember", "forced fact", "--name", "dupmem", "--force"]),
      c("remember off-case existing", ["remember", "second fact", "--name", "mm"]),
      c("remember off-case existing --force", ["remember", "forced second fact", "--name", "mm", "--force"]),
      c("remember standard spelling existing", ["remember", "third fact", "--name", "deploy-note"]),
      c("remember standard spelling existing --force", [
        "remember",
        "forced third fact",
        "--name",
        "deploy-note",
        "--force",
      ]),
      c("import existing", ["import", "doc.md"]),
      c("import existing --force", ["import", "doc.md", "--force"]),
      c("import off-case existing", ["import", "kk.md"]),
      c("import off-case existing --force", ["import", "kk.md", "--force"]),
      c("import task existing", ["import", "t.yml", "--type", "task", "--name", "nightly"]),
      c("import task existing --force", ["import", "t.yml", "--type", "task", "--name", "nightly", "--force"]),
      c("task add existing", ["task", "add", "nightly", "--schedule", "@daily", "--command", "echo again"]),
      c("task add existing --force", [
        "task",
        "add",
        "nightly",
        "--schedule",
        "@daily",
        "--command",
        "echo again",
        "--force",
      ]),
      c("task add off-case existing", ["task", "add", "tt", "--schedule", "@daily", "--command", "echo x"]),
      c("task add off-case existing --force", [
        "task",
        "add",
        "tt",
        "--schedule",
        "@daily",
        "--command",
        "echo x",
        "--force",
      ]),
      c("task add new", ["task", "add", "newt", "--schedule", "@daily", "--command", "echo new"]),
      c("workflow create existing", ["workflow", "create", "ship"]),
      c("workflow create existing --force", ["workflow", "create", "ship", "--force"]),
      c("workflow create off-case existing", ["workflow", "create", "Shipped"]),
      c("workflow create off-case existing --force", ["workflow", "create", "Shipped", "--force"]),
      c("workflow create new", ["workflow", "create", "shipnew"]),
      // refused before anything is written (N12)
      c("remember index", ["remember", "x", "--name", "index"]),
      c("secret set x.lock", ["secret", "set", "secrets/x.lock"], { stdin: "value" }),
      c("env create x.lock", ["env", "create", "env/x.lock"]),
    ],
  },
  {
    // `env create` over an env that exists under another spelling (N20), and a new one.
    id: "env create",
    setup: (sb) => {
      write(path.join(sb.fixture, "main/env/Odd.ENV"), "ODD=1\n");
      write(path.join(sb.fixture, "main/env/default.env"), "DEFAULT=1\n");
    },
    prep: [["index", "--quiet"]],
    track: ["main", "team"],
    cases: [
      c("env/app", ["env", "create", "env/app"]),
      c("env/app.env", ["env", "create", "env/app.env"]),
      c("env/App", ["env", "create", "env/App"]),
      c("main//env/app", ["env", "create", "main//env/app"]),
      c("env/odd", ["env", "create", "env/Odd"]),
      c("env/app from stdin", ["env", "create", "env/app", "--from-stdin"], { stdin: "REPLACED=1\n" }),
      c("env list before", ["env", "list"]),
      c("main//env/default", ["env", "create", "main//env/default"]),
      c("env/default", ["env", "create", "env/default"]),
      c("env/team", ["env", "create", "env/team"]),
      c("env/brandnew", ["env", "create", "env/brandnew"]),
    ],
  },
  {
    // `env create` of the default env under the file spelling `env/default.env` while `env/.env` holds it (N20: refused,
    // nothing written; `1f2e58c9` wrote a twin `env/default.env`), with and without content, and over a symlinked env.
    id: "env create default",
    setup: (sb) => {
      write(path.join(sb.fixture, "main/env/.env"), "KEEP=1\n");
      write(path.join(sb.root, "work/new.env"), "REPLACED=1\n");
      fs.symlinkSync("app.env", path.join(sb.fixture, "main/env/lnk.env"));
    },
    prep: [["index", "--quiet"]],
    track: ["main"],
    cases: [
      // with content first: `1f2e58c9` wrote `env/default.env` for it, which the later cases then find
      c("env/default.env --from-file", ["env", "create", "env/default.env", "--from-file", "new.env"]),
      c("env/default --from-file", ["env", "create", "env/default", "--from-file", "new.env"]),
      c("env/default", ["env", "create", "env/default"]),
      c("env/default.env", ["env", "create", "env/default.env"]),
      c("main//env/default.env", ["env", "create", "main//env/default.env"]),
      c("env/lnk", ["env", "create", "env/lnk"]),
      c("env/lnk.env", ["env", "create", "env/lnk.env"]),
    ],
  },
  {
    // A task held in an off-case file with no `.yml` of its id (F5): `1f2e58c9` found it at neither enable nor sync.
    id: "task in an off-case file",
    setup: (sb) => {
      fs.copyFileSync(path.join(sb.fixture, "main/tasks/nightly.yml"), path.join(sb.fixture, "main/tasks/Up.YML"));
    },
    prep: [["index", "--quiet"]],
    cases: [
      c("task enable tasks/Up", ["task", "enable", "tasks/Up"]),
      c("task enable Up", ["task", "enable", "Up"]),
      c("doctor scheduler sync --dry-run", ["doctor", "scheduler", "sync", "--dry-run"]),
      c("task disable tasks/Up", ["task", "disable", "tasks/Up"]),
    ],
  },
  {
    // The events log after an env or secret is used through a file spelling (N21).
    id: "log after use",
    cases: [
      c("run --env env/app.env", ["run", "--env", "env/app.env", "scripts/printenv.sh"]),
      c("run --secret secrets/api-token.", ["run", "--secret", "secrets/api-token:MYTOK", "scripts/printenv.sh"]),
      c("log", ["log"]),
      c("log --ref env/app", ["log", "--ref", "env/app"]),
      c("log --ref env/app.env", ["log", "--ref", "env/app.env"]),
    ],
  },
  {
    // Two bundles, one inside the other (`a` at st/, `s` at st/team/): what each command lists, shows and indexes.
    id: "nested bundles",
    setup: (sb) => {
      write(path.join(sb.fixture, "st/knowledge/outer.md"), "---\ndescription: outer note\n---\n\nOuter.\n");
      write(path.join(sb.fixture, "st/env/outer.env"), "OUTER=1\n");
      write(path.join(sb.fixture, "st/team/knowledge/inner.md"), "---\ndescription: inner note\n---\n\nInner.\n");
      write(path.join(sb.fixture, "st/team/env/inner.env"), "INNER=1\n");
      const cfg = config(sb);
      const bundles = cfg.bundles as Record<string, unknown>;
      bundles.a = { path: path.join(sb.fixture, "st"), writable: true };
      bundles.s = { path: path.join(sb.fixture, "st/team"), writable: true };
      fs.writeFileSync(sb.configFile, JSON.stringify(cfg, null, 2));
    },
    finals: { "index rows": indexRows },
    cases: [
      c("index", ["index", "--full"]),
      c("env list", ["env", "list"]),
      c("show outer", ["show", "knowledge/outer"]),
      c("show inner", ["show", "knowledge/inner"]),
      c("show s//inner", ["show", "s//knowledge/inner"]),
      c("search note", ["search", "note"]),
      c("feedback inner", ["feedback", "s//knowledge/inner", "--positive"]),
      c("index again", ["index"]),
      c("search note after", ["search", "note"]),
    ],
  },
  {
    // With embeddings on, which created assets have a vector in the index after each command.
    id: "embeddings",
    embeddings: true,
    setup: (sb) => {
      write(
        path.join(sb.root, "work/doc.md"),
        "---\ndescription: imported doc\n---\n# Imported\n\nSome imported text.\n",
      );
      fs.copyFileSync(path.join(sb.fixture, "main/tasks/nightly.yml"), path.join(sb.root, "work/t.yml"));
    },
    after: embeddingPresence,
    cases: [
      c("index --full", ["index", "--full", "--quiet"]),
      c("remember", ["remember", "a remembered fact about deploys", "--name", "remembered"]),
      c("import", ["import", "doc.md"]),
      c("clone", ["clone", "knowledge/guide", "--name", "guide-copy"]),
      c("proposal accept", ["proposal", "accept", "00000000-0000-4000-8000-000000000002"]),
      c("task add", ["task", "add", "newtask", "--schedule", "@daily", "--command", "echo hi"]),
      c("import task", ["import", "t.yml", "--type", "task", "--name", "imported-task"]),
      c("env create", ["env", "create", "env/newone"]),
      c("secret set", ["secret", "set", "secrets/newsec"], { stdin: "s3cret" }),
      c("workflow create", ["workflow", "create", "newflow"]),
      c("index", ["index", "--quiet"]),
    ],
  },
  {
    // The fixture's stored proposals are in the shape an older akm wrote: they name files (`changes[].path`,
    // `proposedTarget.root`, `acceptedTarget.root/path`). They are read as before, say so once with a warning naming
    // `akm migrate apply` (§0.2 P5), `migrate apply` rewrites them, and no command warns after it. The records are
    // read back from state.db at the end.
    id: "old-shape proposal records",
    cases: [
      c("proposal list", ["proposal", "list"]),
      c("proposal show", ["proposal", "show", "00000000-0000-4000-8000-000000000002"]),
      c("migrate status", ["migrate", "status", "--read-only"]),
      c("migrate apply", ["migrate", "apply"]),
      c("proposal list after migrate", ["proposal", "list"]),
      c("proposal show after migrate", ["proposal", "show", "00000000-0000-4000-8000-000000000002"]),
      c("proposal list accepted after migrate", ["proposal", "list", "--status", "accepted"]),
    ],
    finals: {
      "proposal records": (sb) => {
        const db = new Database(sb.stateDb, { readonly: true });
        try {
          return db.query("SELECT id, ref, status, metadata_json FROM proposals ORDER BY id").all();
        } finally {
          db.close();
        }
      },
    },
  },
  {
    // The fixture's accepted retire (proposal 5) is in the shape an older akm wrote: `retiredArchive.dirs`, and a
    // tombstone whose ref is bundle-qualified. `show` prints the record (P7: `retired: [{ ref, handle }]` for `dirs`),
    // revert reads the tombstone and restores the file, and `migrate apply` rewrites the record (P5).
    id: "old-shape retire record",
    track: ["main"],
    cases: [
      c("proposal show full", ["proposal", "show", "00000000-0000-4000-8000-000000000005", "--detail", "full"]),
      c("proposal list accepted full", ["proposal", "list", "--status", "accepted", "--detail", "full"]),
      c("proposal revert", ["proposal", "revert", "00000000-0000-4000-8000-000000000005", "--detail", "full"]),
      c("proposal show full after revert", [
        "proposal",
        "show",
        "00000000-0000-4000-8000-000000000005",
        "--detail",
        "full",
      ]),
    ],
    finals: { "retire record": (sb) => proposalMetadata(sb, "00000000-0000-4000-8000-000000000005") },
  },
  {
    // The same record after `migrate apply`: reverts as it did, and prints the same.
    id: "old-shape retire record after migrate",
    track: ["main"],
    prep: [["migrate", "apply"]],
    cases: [
      c("proposal show full", ["proposal", "show", "00000000-0000-4000-8000-000000000005", "--detail", "full"]),
      c("proposal revert", ["proposal", "revert", "00000000-0000-4000-8000-000000000005", "--detail", "full"]),
    ],
    finals: { "retire record": (sb) => proposalMetadata(sb, "00000000-0000-4000-8000-000000000005") },
  },
  {
    // A retire accepted, shown, accepted again and reverted: a pending retire proposal as an older akm stored it
    // (`changes[].path`, `proposedTarget.root`). Accept archives the memory and its `.derived` twin; the tombstones
    // (track) name the retirement by concept id (N11), the receipt lists the archives by handle (P7).
    id: "retire accept and revert",
    setup: (sb) => retireProposal(sb, "00000000-0000-4000-8000-000000000031", {}),
    track: ["main"],
    cases: [
      c("proposal accept", ["proposal", "accept", "00000000-0000-4000-8000-000000000031", "--detail", "full"]),
      c("proposal show full", ["proposal", "show", "00000000-0000-4000-8000-000000000031", "--detail", "full"]),
      c("proposal accept again", ["proposal", "accept", "00000000-0000-4000-8000-000000000031"]),
      c("lint", ["lint", "--format", "json"]),
      c("proposal revert", ["proposal", "revert", "00000000-0000-4000-8000-000000000031", "--detail", "full"]),
    ],
    finals: { "retire record": (sb) => proposalMetadata(sb, "00000000-0000-4000-8000-000000000031") },
  },
  {
    // A retire accept an older akm began (`retireAcceptIntent.assetPath`, the file still in place) and never finished.
    id: "retire accept resumed",
    setup: (sb) => retireProposal(sb, "00000000-0000-4000-8000-000000000032", { intent: true }),
    track: ["main"],
    cases: [
      c("proposal accept", ["proposal", "accept", "00000000-0000-4000-8000-000000000032", "--detail", "full"]),
      c("proposal show full", ["proposal", "show", "00000000-0000-4000-8000-000000000032", "--detail", "full"]),
      c("proposal revert", ["proposal", "revert", "00000000-0000-4000-8000-000000000032", "--detail", "full"]),
    ],
    finals: { "retire record": (sb) => proposalMetadata(sb, "00000000-0000-4000-8000-000000000032") },
  },
  {
    // Accepting a consolidate promotion retires its source memory (O1) into the archive: the tombstone's refs.
    id: "promotion retires its source",
    setup: (sb) => promotionProposal(sb, "00000000-0000-4000-8000-000000000033"),
    track: ["main"],
    cases: [c("proposal accept", ["proposal", "accept", "00000000-0000-4000-8000-000000000033", "--detail", "full"])],
    finals: { "retire record": (sb) => proposalMetadata(sb, "00000000-0000-4000-8000-000000000033") },
  },
  {
    // A created asset is found by `search` before the next `index` (N14).
    id: "created assets are searchable",
    prep: [["index", "--quiet"]],
    cases: [
      c("env create", ["env", "create", "env/newone"]),
      c("secret set", ["secret", "set", "secrets/newsec"], { stdin: "s3cret" }),
      c("task add", ["task", "add", "newtask", "--schedule", "@daily", "--command", "echo hi"]),
      c("workflow create", ["workflow", "create", "newflow"]),
      c("search newone", ["search", "newone"]),
      c("search newsec", ["search", "newsec"]),
      c("search newtask", ["search", "newtask"]),
      c("search newflow", ["search", "newflow"]),
      c("env list", ["env", "list"]),
    ],
  },
  {
    // The `main` bundle's directory moves and its config `path` is edited (its name stays), after a command has run: an
    // older akm filed proposals, the ledger and runs under the directory, so they stay with the old one (empty queue
    // here); now they follow the name and the queue is the one it was (§0.2 P8).
    id: "bundle directory moved",
    prep: [["proposal", "list"]],
    afterPrep: moveMainBundle,
    cases: [
      c("proposal list", ["proposal", "list"]),
      c("proposal list pending", ["proposal", "list", "--status", "pending"]),
      c("proposal list rejected", ["proposal", "list", "--status", "rejected"]),
      c("proposal show 1", ["proposal", "show", "00000000-0000-4000-8000-000000000001"]),
      c("proposal show 2", ["proposal", "show", "00000000-0000-4000-8000-000000000002"]),
      c("proposal list --queue team", ["proposal", "list", "--queue", "team"]),
      c("improve report", ["improve", "report"]),
      c("improve dry-run", ["improve", "--dry-run", "--format", "json"]),
    ],
    finals: { "doctor state-unknown-bundle": doctorUnknownBundle },
  },
  {
    // The `main` bundle is renamed by hand in config (`primary`), after a command has run: its proposals, ledger and runs
    // stay under the directory for an older akm, so its queue is as it was; now they follow the name and are left behind
    // under `main`, which `akm doctor` reports (`state-unknown-bundle`, §0.2 P8, N10).
    id: "bundle renamed by hand",
    prep: [["proposal", "list"]],
    afterPrep: renameMainBundleByHand,
    cases: [
      c("proposal list", ["proposal", "list"]),
      c("proposal list pending", ["proposal", "list", "--status", "pending"]),
      c("proposal show 1", ["proposal", "show", "00000000-0000-4000-8000-000000000001"]),
      c("proposal list --queue team", ["proposal", "list", "--queue", "team"]),
      c("improve report", ["improve", "report"]),
    ],
    finals: { "doctor state-unknown-bundle": doctorUnknownBundle },
  },
  {
    // Two git bundles, each with a proposal in its own queue: the queues are separate (a checkout is a directory of its
    // own, not "repo"), under an older akm and now.
    id: "two git bundles",
    setup: (sb) => {
      const [alpha, beta] = gitBundles(sb);
      storeProposalIn(sb, "00000000-0000-4000-8000-000000000041", "alpha//knowledge/only-in-alpha", alpha as string);
      storeProposalIn(sb, "00000000-0000-4000-8000-000000000042", "beta//knowledge/only-in-beta", beta as string);
    },
    cases: [
      c("proposal list --queue alpha", ["proposal", "list", "--queue", "alpha"]),
      c("proposal list --queue beta", ["proposal", "list", "--queue", "beta"]),
      c("proposal show 41 --queue alpha", [
        "proposal",
        "show",
        "00000000-0000-4000-8000-000000000041",
        "--queue",
        "alpha",
      ]),
      c("proposal show 41 --queue beta", [
        "proposal",
        "show",
        "00000000-0000-4000-8000-000000000041",
        "--queue",
        "beta",
      ]),
      c("proposal list", ["proposal", "list"]),
    ],
  },
  {
    // Two directories with the same name, neither a configured bundle, each used as the working directory with its own
    // proposal: the queues are separate, as they were filed by directory.
    id: "two unconfigured directories with one name",
    setup: (sb) => {
      for (const side of ["a", "b"])
        write(path.join(sb.fixture, side, "akm", "knowledge", "note.md"), "---\ndescription: n\n---\n\nNote.\n");
      storeProposalIn(
        sb,
        "00000000-0000-4000-8000-000000000051",
        "akm//knowledge/in-a",
        path.join(sb.fixture, "a", "akm"),
      );
      storeProposalIn(
        sb,
        "00000000-0000-4000-8000-000000000052",
        "akm//knowledge/in-b",
        path.join(sb.fixture, "b", "akm"),
      );
    },
    cases: [
      c("proposal list in a", ["proposal", "list"], { env: { AKM_BUNDLE_DIR: "{FIXTURE}/a/akm" } }),
      c("proposal list in b", ["proposal", "list"], { env: { AKM_BUNDLE_DIR: "{FIXTURE}/b/akm" } }),
      c("proposal show 51 in b", ["proposal", "show", "00000000-0000-4000-8000-000000000051"], {
        env: { AKM_BUNDLE_DIR: "{FIXTURE}/b/akm" },
      }),
    ],
  },
];
