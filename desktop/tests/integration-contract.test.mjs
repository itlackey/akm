import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const desktop = path.join(root, "desktop");
const require = createRequire(import.meta.url);

test("Desktop runs the package built from this checkout, without changing the CLI package graph", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json")));
  const installed = path.dirname(require.resolve("akm-cli/package.json"));
  assert.equal(require("akm-cli/package.json").version, manifest.version);
  assert.equal(
    await readFile(path.join(installed, "dist/workspace-node.mjs"), "utf8"),
    await readFile(path.join(root, "dist/workspace-node.mjs"), "utf8"),
  );
  assert.ok(!(await readdir(path.join(desktop, ".core"))).includes("desktop"));
  for (const name of ["electron", "svelte", "@sveltejs/kit"])
    assert.ok(!manifest.dependencies[name] && !manifest.optionalDependencies[name]);
  assert.ok(!manifest.files.includes("desktop"));
});

test("application code uses only the approved workspace namespace and package metadata", async () => {
  for (const file of await readdir(path.join(desktop, "src"), { recursive: true })) {
    if (!/\.(?:ts|mjs|js|svelte)$/.test(file)) continue;
    const source = await readFile(path.join(desktop, "src", file), "utf8");
    for (const match of source.matchAll(/['"](akm-cli[^'"]*)['"]/g))
      assert.ok(["akm-cli/workspace", "akm-cli/package.json"].includes(match[1]), `${file}: ${match[1]}`);
  }
});

test("server code imports only akm-cli/workspace, Node, Electron and Desktop's own modules", async () => {
  const server = path.join(desktop, "src/lib/server");
  for (const file of await readdir(server, { recursive: true })) {
    if (!/\.(?:ts|mjs|js)$/.test(file)) continue;
    const source = await readFile(path.join(server, file), "utf8");
    for (const match of source.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier.startsWith("."))
        assert.ok(
          path.resolve(server, path.dirname(file), specifier).startsWith(desktop + path.sep),
          `${file}: ${specifier}`,
        );
      else
        assert.ok(
          !specifier.startsWith("akm-cli") || ["akm-cli/workspace", "akm-cli/package.json"].includes(specifier),
          `${file}: ${specifier}`,
        );
    }
  }
});

test("the renderer imports akm-cli only as types", async () => {
  for (const file of await readdir(path.join(desktop, "src/lib"), { recursive: true })) {
    if (!/\.(?:ts|js|svelte)$/.test(file) || file.startsWith(`server${path.sep}`)) continue;
    const source = await readFile(path.join(desktop, "src/lib", file), "utf8");
    for (const match of source.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s*['"]akm-cli[^'"]*['"]/gm))
      assert.fail(`${file}: ${match[0]}`);
  }
});
