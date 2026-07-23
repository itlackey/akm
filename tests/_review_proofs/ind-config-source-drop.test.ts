// Independent probe: does migrateConfigSourcesToBundles silently drop a source
// whose descriptor cannot be built (malformed source entry)?
import { test, expect } from "bun:test";
import { migrateConfigSourcesToBundles } from "../../src/migrate/legacy/config-source-migration";

test("a filesystem source missing `path` is SILENTLY DROPPED from the migrated bundles", () => {
  const raw = {
    configVersion: "0.9.0",
    stashDir: "/home/u/stash",
    sources: [
      // A well-formed named source.
      { type: "filesystem", path: "/home/u/team", name: "team", writable: true },
      // A malformed filesystem source: no `path`. sourceEntryDescriptor -> undefined.
      { type: "filesystem", name: "ghost", writable: true },
    ],
  };
  const out = migrateConfigSourcesToBundles(raw) as Record<string, any>;
  const bundleIds = Object.keys(out.bundles);
  // The malformed "ghost" source vanished with NO error and NO trace.
  expect(bundleIds).not.toContain("ghost");
  // Only the primary stash + the good "team" source survive.
  expect(bundleIds.sort()).toEqual(["stash", "team"].sort());
  // No error was raised, no warning surfaced to the user.
  console.log("migrated bundle ids:", JSON.stringify(bundleIds));
});

test("a git source missing `url` is SILENTLY DROPPED", () => {
  const raw = {
    configVersion: "0.9.0",
    stashDir: "/home/u/stash",
    sources: [{ type: "git", name: "myrepo", writable: false }],
  };
  const out = migrateConfigSourcesToBundles(raw) as Record<string, any>;
  const ids = Object.keys(out.bundles);
  expect(ids).not.toContain("myrepo");
  console.log("git-drop migrated bundle ids:", JSON.stringify(ids));
});
