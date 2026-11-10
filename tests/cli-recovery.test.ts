import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { formatHelp } from "../src/cli/help-format";
import { akmSearch } from "../src/commands/read/search";
import { akmIndex } from "../src/indexer/indexer";
import { runCliCapture } from "./_helpers/cli";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "./_helpers/sandbox";

let stashDir = "";
let cleanup: Cleanup = () => {};

beforeEach(() => {
  const data = sandboxXdgDataHome();
  const cache = sandboxXdgCacheHome(data.cleanup);
  const cfg = sandboxXdgConfigHome(cache.cleanup);
  const stash = sandboxStashDir(cfg.cleanup);
  stashDir = stash.dir;
  cleanup = stash.cleanup;
});
afterEach(() => cleanup());

function hintOf(stderr: string): string {
  return JSON.parse(stderr.trim()).hint as string;
}

describe("recovery hints", () => {
  test("`task list` names the real routes, and each one runs", async () => {
    const r = await runCliCapture(["task", "list"]);
    expect(r.code).toBe(2);
    const hint = hintOf(r.stderr);
    expect(hint).toContain("`akm search --type task`");
    expect(hint).toContain("`akm task doctor`");
    const search = await runCliCapture(["search", "--type", "task"]);
    expect(search.code).toBe(0);
  });

  test("`config get` without a key gives a valid example key", async () => {
    const r = await runCliCapture(["config", "get"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stderr.trim()).code).toBe("MISSING_REQUIRED_ARGUMENT");
    const hint = hintOf(r.stderr);
    expect(hint).toContain("`akm config get --help`");
    const example = /`akm (config get \w+)`/.exec(hint)?.[1];
    expect(example).toBeDefined();
    const run = await runCliCapture((example as string).split(" "));
    expect(run.code).toBe(0);
  });
});

describe("empty search with a misspelled --type", () => {
  beforeEach(async () => {
    fs.mkdirSync(path.join(stashDir, "knowledge"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "knowledge", "a.md"), "---\ndescription: deploy notes\n---\n\nbody\n");
    await akmIndex({ stashDir, full: true });
  });
  const tipFor = async (type: string) =>
    (await akmSearch({ query: "x", type: type as never, source: "local", skipLogging: true })).tip ?? "";

  test("a near type is suggested, without the word stash", async () => {
    const tip = await tipFor("knowlege");
    expect(tip).toContain("--type knowledge");
    expect(tip).not.toContain("stash");
    const r = await akmSearch({ query: "deploy", type: "knowledge", source: "local", skipLogging: true });
    expect(r.results.length).toBeGreaterThan(0);
  });

  test("an unrelated type keeps the generic tip", async () => {
    const tip = await tipFor("zzzzzzzz");
    expect(tip).not.toContain("Did you mean");
    expect(tip).not.toContain("stash");
  });

  test("a valid type with no match keeps the generic tip", async () => {
    expect(await tipFor("skill")).not.toContain("Did you mean");
  });
});

describe("help formatting", () => {
  const long = `  --name=<name>${" ".repeat(20)}${"word ".repeat(40)}`;
  const withTty = (isTTY: boolean, run: () => void) => {
    const original = process.stdout.isTTY;
    process.stdout.isTTY = isTTY;
    try {
      run();
    } finally {
      process.stdout.isTTY = original;
    }
  };

  test("wraps to 80 columns when the width is unknown", () => {
    const saved = process.env.COLUMNS;
    delete process.env.COLUMNS;
    try {
      withTty(true, () => {
        for (const line of formatHelp(long).split("\n")) expect(line.length).toBeLessThanOrEqual(80);
      });
    } finally {
      if (saved !== undefined) process.env.COLUMNS = saved;
    }
  });

  test("piped help has no ANSI and no column padding", () => {
    withTty(false, () => {
      const out = formatHelp(`\x1b[36m      add\x1b[39m    Register a task${" ".repeat(30)}`);
      expect(out).toBe("  add Register a task");
    });
  });

  test("workflow and task --help teach the order and the objects", async () => {
    const wf = (await runCliCapture(["workflow", "--help"])).stdout;
    expect(wf).toMatch(/plan[\s\S]*run[\s\S]*status[\s\S]*resume[\s\S]*abandon/);
    expect(wf).toContain("run id");
    const task = (await runCliCapture(["task", "--help"])).stdout;
    for (const s of ["search --type task", "task doctor", "task explain", "task history"]) expect(task).toContain(s);
  });
});
