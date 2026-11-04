import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { UsageError, assets, bundles, indexWrittenAssets } from "akm-cli/workspace";
import { fields } from "../input.js";

/**
 * Plain file editing for the human owner: any text file inside a configured bundle (an asset, a skill's support
 * file, a file that is no asset). Desktop reads and writes the file itself and asks akm to refresh the index for it.
 * The only restrictions are real safety: stay inside the bundle root (realpath, so no link can leave it), write only
 * to a bundle akm may write to (an installed bundle's update would replace the edit), refuse a save over bytes that
 * changed since they were read, and write atomically. Asset-level operations (retire, copy, proposals, env/secret)
 * stay akm's. The save leaves Git alone, as any editor would.
 */

const MAX_BYTES = 8 * 1_048_576;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Bundle = {
  name: string;
  enabled: boolean;
  writable: boolean;
  path: string | null;
  components: Array<{ adapter: string }>;
};
type Selector = { ref?: string; bundle?: string; file?: string };

async function selection(input: Selector) {
  const listing = (await bundles.list()) as { bundles: Bundle[] };
  let bundle = input.bundle,
    file = input.file,
    ref: string | undefined,
    type: string | undefined;
  if (input.ref) {
    const shown = (await assets.show({ ref: input.ref })) as {
      redacted?: boolean;
      durableRef?: string;
      asset?: { type?: string };
      location?: { bundle: string; path: string } | null;
    };
    if (shown.redacted) throw new UsageError("Protected files are shown and edited from the protected-file view.");
    if (!shown.location) throw new UsageError("This asset has no file in a local bundle.");
    bundle = shown.location.bundle;
    file = shown.location.path;
    ref = shown.durableRef ?? input.ref;
    type = shown.asset?.type;
  }
  const found = listing.bundles.find((entry) => entry.name === bundle && entry.enabled && entry.path);
  if (!bundle || !file || !found) throw new UsageError("Choose a file in an enabled bundle.");
  if (path.isAbsolute(file) || file.includes("\0")) throw new UsageError("Use a path relative to the bundle.");
  const root = found.path!;
  const physicalRoot = fs.realpathSync(root);
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(physicalRoot, file));
  } catch {
    throw new UsageError("This file is unavailable. Check its location and filesystem permissions.");
  }
  const inside = path.relative(physicalRoot, real);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside))
    throw new UsageError("The file must stay inside its bundle.");
  // Checked on the real path, so neither `knowledge/../env/x.env` nor a link into env/ or secrets/ gets past it.
  if (/^(?:env|secrets)(?:\/|$)/.test(inside.split(path.sep).join("/")))
    throw new UsageError("Protected files are shown and edited from the protected-file view.");
  if (!fs.statSync(real).isFile()) throw new UsageError("Choose a file, not a folder.");
  return {
    bundle,
    file,
    ref,
    type,
    real,
    indexable: path.join(root, inside),
    root,
    writable: found.writable === true,
    akm: found.components.some((component) => component.adapter === "akm"),
  };
}

function text(bytes: Buffer) {
  const content = bytes.toString("utf8");
  if (bytes.length > MAX_BYTES || bytes.includes(0) || !Buffer.from(content).equals(bytes))
    throw new UsageError("Choose a UTF-8 text file smaller than 8 MiB.");
  return content;
}

export async function readFile(query: Selector) {
  const chosen = await selection(query);
  const bytes = fs.readFileSync(chosen.real);
  return {
    ref: chosen.ref,
    type: chosen.type,
    bundle: chosen.bundle,
    file: chosen.file,
    content: text(bytes),
    revision: digest(bytes),
    writable: chosen.writable,
    markdown: /\.(?:md|markdown)$/i.test(chosen.real) && !["script", "task"].includes(chosen.type ?? ""),
  };
}

export async function saveFile(body: unknown) {
  const value = fields(body, ["ref", "bundle", "file", "revision", "content"], "file save");
  if (
    typeof value.content !== "string" ||
    typeof value.revision !== "string" ||
    value.content.includes("\0") ||
    !(typeof value.ref === "string" || (typeof value.bundle === "string" && typeof value.file === "string"))
  )
    throw new UsageError("Provide the file, revision and text.");
  const chosen = await selection(value as Selector);
  if (!chosen.writable)
    throw new UsageError(
      `Bundle ${chosen.bundle} is read-only: akm does not write to it, and an update would replace the edit.`,
    );
  // From this read to the rename everything is synchronous, so no other Desktop request can interleave. Another
  // process could still write in that instant; akm's lease is not taken here, as an external editor would not take it.
  const live = fs.readFileSync(chosen.real);
  if (digest(live) !== value.revision)
    throw new UsageError(
      "The file changed after it was opened. Review the newer version before saving.",
      "ASSET_CONTENT_CHANGED",
    );
  const next = Buffer.from(value.content);
  if (live.equals(next)) return { ref: chosen.ref, unchanged: true };
  const temporary = path.join(path.dirname(chosen.real), `.${path.basename(chosen.real)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, next, { flag: "wx", mode: fs.statSync(chosen.real).mode & 0o777 });
    fs.renameSync(temporary, chosen.real);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  const indexed =
    !chosen.akm || (await indexWrittenAssets(chosen.root, [chosen.indexable], { bundleId: chosen.bundle }));
  return {
    ref: chosen.ref,
    bundle: chosen.bundle,
    file: chosen.file,
    unchanged: false,
    indexed,
    warnings: indexed ? [] : ["The file was saved, but the index could not be refreshed. Run akm index."],
  };
}
