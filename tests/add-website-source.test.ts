import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(__dirname, "..", "src", "cli.ts");
const tempDirs: string[] = [];
const servers: Array<{ stop: (force: boolean) => void }> = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createWorkingStash(): string {
  const dir = makeTempDir("akm-add-website-stash-");
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

function serveWebsite(): string {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/") {
        return new Response(
          "<html><head><title>Example Docs</title></head><body><h1>Example Docs</h1><p>Welcome to the docs.</p><a href='/getting-started'>Getting started</a></body></html>",
          {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          },
        );
      }
      if (url.pathname === "/getting-started") {
        return new Response("<html><body><h1>Getting started</h1><p>Run setup first.</p></body></html>", {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

describe("akm add website", () => {
  test(
    "adds a website stash source, caches markdown, and indexes it",
    async () => {
      const stashDir = createWorkingStash();
      const xdgCache = makeTempDir("akm-add-website-cache-");
      const xdgConfig = makeTempDir("akm-add-website-config-");
      const websiteUrl = serveWebsite();
      const configDir = path.join(xdgConfig, "akm");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        `${JSON.stringify({ semanticSearchMode: "off" }, null, 2)}\n`,
      );

      const child = spawn("bun", [CLI, "add", websiteUrl, "--name", "docs-site", "--format=json"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          AKM_STASH_DIR: stashDir,
          XDG_CACHE_HOME: xdgCache,
          XDG_CONFIG_HOME: xdgConfig,
        },
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });

      const exitCode = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("CLI website add timed out"));
        }, 30_000);
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve(code ?? 1);
        });
      });

      expect(exitCode).toBe(0);
      expect(stderr.trim()).toBe("");
      const parsed = JSON.parse(stdout.trim()) as {
        stashSource?: { type?: string; url?: string; name?: string; stashRoot?: string };
        index?: { totalEntries?: number };
      };
      const normalizedWebsiteUrl = `${websiteUrl}/`;
      expect(parsed.stashSource).toBeDefined();
      expect(parsed.stashSource?.type).toBe("website");
      expect(parsed.stashSource?.url).toBe(normalizedWebsiteUrl);
      expect(parsed.stashSource?.name).toBe("docs-site");
      expect(parsed.index?.totalEntries).toBeGreaterThanOrEqual(2);

      const configPath = path.join(xdgConfig, "akm", "config.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        stashes?: Array<{ type?: string; url?: string; name?: string }>;
      };
      expect(config.stashes).toContainEqual({
        type: "website",
        url: normalizedWebsiteUrl,
        name: "docs-site",
      });

      expect(parsed.stashSource?.stashRoot).toBeDefined();
      const knowledgeFiles = fs.readdirSync(path.join(parsed.stashSource?.stashRoot as string, "knowledge")).sort();
      expect(knowledgeFiles).toHaveLength(2);
      const homeDoc = fs.readFileSync(
        path.join(parsed.stashSource?.stashRoot as string, "knowledge", knowledgeFiles[0]),
        "utf8",
      );
      expect(homeDoc).toContain("Example Docs");
    },
    { timeout: 60_000 },
  );
});
