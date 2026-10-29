import fs from "node:fs";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";

const root = process.env.AKM_CHANNEL_FIXTURE!;
const command = path.basename(process.argv[1]!);
const args = process.argv.slice(2);
const stateFile = path.join(root, "state.json");
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
fs.appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify({ command, args }) + "\n");
const output = (x: unknown) => console.log(JSON.stringify(x));
const native = (channel: string) => state.versions[channel];
if (state.fail === command + " " + args.join(" ")) {
  console.error("fixture refresh failed");
  process.exit(1);
}
if (command === "git") {
  const checkout = args.at(-1)!;
  const channel = args.includes("next") ? "next" : "latest";
  fs.mkdirSync(path.join(checkout, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(checkout, ".agents", "plugins"), { recursive: true });
  fs.mkdirSync(path.join(checkout, "claude", ".codex-plugin"), { recursive: true });
  fs.mkdirSync(path.join(checkout, "claude", ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(checkout, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ plugins: [{ name: "akm", source: "./claude" }] }),
  );
  fs.writeFileSync(
    path.join(checkout, "claude", ".claude-plugin", "plugin.json"),
    JSON.stringify({ version: native(channel) }),
  );
  fs.writeFileSync(
    path.join(checkout, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({ plugins: [{ name: "akm", source: { source: "local", path: "./claude" } }] }),
  );
  fs.writeFileSync(
    path.join(checkout, "claude", ".codex-plugin", "plugin.json"),
    JSON.stringify({ version: state.codexTargetVersion ?? native(channel) }),
  );
} else if (command === "claude") {
  const known = JSON.parse(fs.readFileSync(path.join(root, "claude/plugins/known_marketplaces.json"), "utf8"));
  const ref = known["akm-plugins"].source.ref;
  if (args.join(" ") === "plugin marketplace list --json") output([{ name: "akm-plugins", ...(ref ? { ref } : {}) }]);
  else if (args.join(" ") === "plugin list --json")
    output(
      state.claudeInstalled === false
        ? []
        : (state.claudeInstallations ?? [{ id: "akm@akm-plugins", version: state.claudeVersion }]),
    );
  else if (args[1] === "update") {
    state.claudeVersion = native(ref === "next" ? "next" : "latest");
    for (const row of state.claudeInstallations ?? [])
      if (row.scope === args[args.indexOf("--scope") + 1]) row.version = state.claudeVersion;
  }
} else if (command === "codex") {
  if (args[1] === "list")
    output({
      installed: state.codexInstalled === false ? [] : [{ pluginId: "akm@akm-plugins", version: state.codexVersion }],
    });
  else if (args[2] === "upgrade") {
    const config = parseToml(fs.readFileSync(path.join(root, "codex/config.toml"), "utf8")) as {
      marketplaces: Record<string, { ref?: string }>;
    };
    state.codexVersion = native(config.marketplaces["akm-plugins"]?.ref === "next" ? "next" : "latest");
  } else process.exit(2);
} else if (command === "npm") {
  const channel = args[1]!.endsWith("@next") ? "next" : "latest";
  output({ version: native(channel), "dependencies.akm-cli": native(channel) });
} else if (command === "pgrep") {
  process.exit(1);
} else if (command === "opencode") {
  if (args[0] === "--version") console.log("1.5.0");
  else {
    const config = parseJsonc(fs.readFileSync(path.join(root, "config/opencode/opencode.jsonc"), "utf8"));
    const entry = config.plugin.find((e: unknown) => (Array.isArray(e) ? e[0] : e).startsWith("akm-opencode"));
    const spec = Array.isArray(entry) ? entry[0] : entry;
    const channel = spec.endsWith("@next") ? "next" : "latest";
    const folder = path.join(root, "cache/opencode/packages", `akm-opencode@${channel}`, "node_modules/akm-opencode");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "package.json"), JSON.stringify({ version: native(channel) }));
  }
} else if (command === "trash-put") fs.rmSync(args[0]!, { recursive: true });
else process.exit(2);
fs.writeFileSync(stateFile, JSON.stringify(state));
