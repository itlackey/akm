import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import { codexChannelEdit, codexMarketplace } from "../../src/commands/sources/plugin-channels";
import { makeSandboxDir } from "../_helpers/sandbox";

let file: string;
let cleanup: () => void;
beforeEach(() => {
  const sandbox = makeSandboxDir("akm-toml-channel");
  file = path.join(sandbox.dir, "config.toml");
  cleanup = sandbox.cleanup;
});
afterEach(() => cleanup());

test.each([
  '[marketplaces."akm-plugins"]\nsource_type="git"\nsource="repo"\nref="old" # keep comment\n',
  '[marketplaces]\n"akm-plugins" = { source_type="git", source="repo", ref="old" }\n',
  '[other]\nakm-plugins = { ref="preserved" }\n[marketplaces]\nakm-plugins = { ref="old", source_type="git", source="repo" }\n',
])("edits quoted and inline TOML without changing other settings: %s", (content) => {
  fs.writeFileSync(file, content);
  expect(codexMarketplace(file)?.ref).toBe("old");
  const next = codexChannelEdit(file, "next");
  fs.writeFileSync(file, next.content);
  expect(codexMarketplace(file)?.ref).toBe("next");
  if (content.includes("# keep comment")) expect(next.content).toContain("# keep comment");
  const latest = codexChannelEdit(file, "latest");
  fs.writeFileSync(file, latest.content);
  expect(codexMarketplace(file)?.ref).toBeUndefined();
  const expected = parse(content) as { marketplaces: Record<string, { ref?: string }> };
  delete expected.marketplaces["akm-plugins"]!.ref;
  expect(parse(latest.content)).toEqual(expected);
});
