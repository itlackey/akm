import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { handleApiRequest, loadConfig, resolveBundleWriteTarget, assertAkmAssetWrite, prepareWriteTargetForMutation,
  withWriteTargetMutation, withAssetMutationLease, assertWriteLeaseFree, isWithin, writeFileAtomic,
  assetPathForName, stashDirFor, parseRefInput, openReadonlyExistingDatabase, closeDatabase, getAllEntries,
  indexWrittenAssets, akmLint, scrubUrlCredentials } from 'akm-cli/workspace';
import { assetSource, safeFile as safe } from './asset-source.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Target = ReturnType<typeof resolveBundleWriteTarget>;
type Change = { from: string; to: string; before: string; after: string; mode: number; bundle: string; binary?: boolean };
type Mapping = { from: string; to: string; oldRef?: string; newRef?: string };
const bytes = (change: Change, field: 'before' | 'after') => Buffer.from(change[field], change.binary ? 'base64' : 'utf8');
type Input = { ref: string; bundle: string; name: string; fixLinks: boolean; revision?: string };
function input(body: unknown): Input {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Provide the source and destination.');
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(key => !['ref', 'bundle', 'name', 'fixLinks', 'revision'].includes(key)) ||
    !['ref', 'bundle', 'name'].every(key => typeof value[key] === 'string' && (value[key] as string).trim()) || typeof value.fixLinks !== 'boolean')
    throw new Error('Provide an asset ref, destination bundle, name and link-repair choice.');
  return value as unknown as Input;
}
function read(file: string) {
  const bytes = fs.readFileSync(file), text = bytes.toString('utf8');
  if (!bytes.equals(Buffer.from(text)) || scrubUrlCredentials(text) !== text) throw new Error('This file requires editing outside Desktop to preserve its bytes or hidden URL credentials.');
  return text;
}
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A conservative textual repair: exact qualified refs, and simple Markdown file links.
 * Unsupported syntax is left intact and exposed by the native lint check, never guessed. */
function repairTextLinks(content: string, from: string, to: string, mappings: Mapping[], indexed: Map<string, string>, sameBundle: boolean) {
  let next = content;
  for (const move of mappings) if (move.oldRef && move.newRef) next = next.replace(new RegExp(`(?<![\\w./-])${escaped(move.oldRef)}(?![\\w./-])`, 'g'), () => move.newRef!);
  next = next.replace(/(?<!!)\[([^\]\n]+)\]\(([^\s()]+)\)/g, (original, label: string, url: string) => {
    if (/^(?:[a-z]+:|\/|#)/i.test(url)) return original;
    const [raw, fragment] = url.split('#');
    let decoded: string;
    try { decoded = decodeURIComponent(raw); } catch { return original; }
    const resolved = path.resolve(path.dirname(from), decoded), moved = mappings.find(item => item.from === resolved);
    if (!moved && from === to) return original;
    const destination = moved?.to ?? resolved;
    if (sameBundle || (moved && mappings.some(item => item.from === from))) return `[${label}](${path.relative(path.dirname(to), destination).split(path.sep).map(encodeURIComponent).join('/')}${fragment ? '#' + fragment : ''})`;
    const ref = moved?.newRef ?? indexed.get(resolved);
    // Native AKM wiki refs stay portable between bundles. Fragment-bearing and non-asset links need manual review.
    return ref && !fragment && !label.includes('|') ? `[[${ref}|${label}]]` : original;
  });
  return next;
}

function repairLinks(content: string, from: string, to: string, mappings: Mapping[], indexed: Map<string, string>, sameBundle: boolean) {
  let fence = '';
  return content.split(/(?<=\n)/).map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = '';
      return line;
    }
    if (marker) { fence = marker[1]; return line; }
    // Conservatively leave a line containing inline code alone.
    return line.includes('`') ? line : repairTextLinks(line, from, to, mappings, indexed, sameBundle);
  }).join('');
}

async function plan(value: Input) {
  const source = await assetSource(value.ref);
  const review = await handleApiRequest('/api/asset/improve', new URLSearchParams({ ref: source.ref })) as { proposals: Array<{ status: string }> };
  if (review.proposals.some(proposal => proposal.status === 'pending')) throw new Error('Review pending proposals before moving this asset. Their targets do not follow a rename.');
  const identity = parseRefInput(source.ref), config = loadConfig();
  const original = resolveBundleWriteTarget(config, identity.origin!), destination = resolveBundleWriteTarget(config, value.bundle);
  assertAkmAssetWrite(original.source); assertAkmAssetWrite(destination.source);
  const extension = path.extname(source.file), skill = identity.type === 'skill';
  const name = identity.type === 'script' || skill ? value.name.trim() : value.name.trim().replace(new RegExp(escaped(extension) + '$', 'i'), '');
  if (!name || /[\\#?\u0000]/.test(name) || name.split('/').some(part => !part || part.startsWith('.') || part === '..')) throw new Error('Use a file name or folder/name without hidden or parent directories.');
  const directory = stashDirFor(identity.type)!;
  const from = assetPathForName(identity.type, path.join(original.source.path, directory), identity.name);
  // Preserve the actual extension; a YAML task must not become Markdown.
  const to = skill ? assetPathForName(identity.type, path.join(destination.source.path, directory), name)
    : path.join(destination.source.path, directory, identity.type === 'script' ? name : name + extension);
  if (identity.type === 'script' && path.extname(to) !== extension) throw new Error('Keep the script’s existing extension.');
  if (skill && (name !== identity.name || identity.origin === value.bundle)) throw new Error('Move the complete skill to a different bundle, keeping its folder name.');
  if (from === to) throw new Error('Choose a different name or destination bundle.');
  const newRef = `${value.bundle}//${directory}/${name}`;
  const mappings: Mapping[] = [{ from, to, oldRef: source.ref, newRef }];
  const directories: Array<{ from: string; to: string; mode: number }> = [];
  if (skill) {
    const root = path.dirname(from), dest = path.dirname(to);
    if (fs.lstatSync(dest, { throwIfNoEntry: false })) throw new Error('The destination skill folder already exists.');
    const walk = (folder: string) => {
      safe(original.source.path, folder);
      directories.push({ from: folder, to: path.join(dest, path.relative(root, folder)), mode: fs.statSync(folder).mode & 0o777 });
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name); safe(original.source.path, file);
        if (entry.isDirectory()) walk(file);
        else if (!entry.isFile()) throw new Error('Skill moves require regular files and folders; symbolic links and special files need manual review.');
        else if (file !== from) mappings.push({ from: file, to: path.join(dest, path.relative(root, file)) });
      }
    };
    walk(root);
  }
  if (identity.type === 'memory' && fs.existsSync(from.replace(/\.md$/, '.derived.md'))) mappings.push({
    from: from.replace(/\.md$/, '.derived.md'), to: to.replace(/\.md$/, '.derived.md'), oldRef: source.ref + '.derived', newRef: newRef + '.derived'
  });
  for (const move of mappings) {
    safe(original.source.path, move.from); safe(destination.source.path, move.to);
    if (fs.lstatSync(move.to, { throwIfNoEntry: false })) throw new Error('A destination file already exists. Nothing will be overwritten.');
  }
  const db = openReadonlyExistingDatabase();
  if (!db) throw new Error('Index the bundle before moving files.');
  let entries: ReturnType<typeof getAllEntries>;
  try { entries = getAllEntries(db, undefined, ['secret', 'env', 'session']); } finally { closeDatabase(db); }
  const indexed = new Map(entries.map(entry => [entry.filePath, entry.itemRef]));
  const targets = new Map<string, Target>([[identity.origin!, original], [value.bundle, destination]]);
  const changes: Change[] = [], warnings = new Set<string>();
  const files = [...new Set([...mappings.map(move => move.from), ...entries.filter(entry => entry.filePath.endsWith('.md')).map(entry => entry.filePath)])];
  for (const file of files) {
    const moving = mappings.find(move => move.from === file), row = entries.find(entry => entry.filePath === file);
    if (!moving && (!row || !fs.existsSync(file))) continue;
    const bundle = moving ? identity.origin! : row!.bundleId;
    let target: Target;
    try { target = targets.get(bundle) ?? resolveBundleWriteTarget(config, bundle, { requireWritable: false }); safe(target.source.path, file); }
    catch { continue; }
    let before: string, binary = false;
    if (skill && moving) {
      const content = fs.readFileSync(file), text = content.toString('utf8');
      binary = text.includes('\0') || !content.equals(Buffer.from(text)) || scrubUrlCredentials(text) !== text;
      before = binary ? content.toString('base64') : text;
    } else {
      try { before = read(file); } catch { warnings.add(`Not scanned: ${row?.itemRef ?? source.ref}.`); if (moving) throw new Error('A source file cannot be safely moved.'); continue; }
    }
    const newPath = moving?.to ?? file;
    const sameBundle = identity.origin === value.bundle;
    let after = value.fixLinks && !binary && file.endsWith('.md') ? repairLinks(before, file, newPath, mappings, indexed, sameBundle) : before;
    // A derived twin's parent is structural metadata, not an optional convenience link.
    if (moving && file.endsWith('.derived.md')) after = after.replace(
      new RegExp(`^(derivedFrom:[ \\t]*["']?)(?:${escaped(source.ref)}|${escaped(source.ref.split('//')[1])})(["']?[ \\t]*)$`, 'm'), `$1${newRef}$2`);
    if (moving || after !== before) {
      try { target = resolveBundleWriteTarget(config, bundle); assertAkmAssetWrite(target.source); }
      catch { if (moving) throw new Error('The source is no longer writable.'); warnings.add(`Needs manual link repair: ${row?.itemRef} (read-only or unsupported source).`); continue; }
      targets.set(bundle, target);
      changes.push({ from: file, to: newPath, before, after, mode: fs.statSync(file).mode & 0o777, bundle, binary });
    }
  }
  if (changes.filter(change => change.from !== change.to).length !== mappings.length) throw new Error('The source is no longer writable.');
  if (identity.origin !== value.bundle) warnings.add('Cross-bundle relative links to attachments, heading fragments, and unindexed files may need manual repair.');
  if (['task', 'workflow', 'command', 'script', 'skill'].includes(identity.type)) warnings.add('Installed schedules and external callers are not rewritten. Review their references; task schedule changes require akm task sync.');
  warnings.add('Only indexed Markdown files were scanned. Short refs, code, unusual Markdown links, and external references may need manual updates.');
  const revision = hash(JSON.stringify({ mappings, changes, directories, warnings: [...warnings], fixLinks: value.fixLinks }));
  return { changes, directories, targets, revision, newRef, location: { bundle: value.bundle, path: path.relative(destination.source.path, to).split(path.sep).join('/'), parent: path.relative(destination.source.path, path.dirname(to)).split(path.sep).join('/') }, warnings: [...warnings] };
}

export async function previewMove(body: unknown) {
  const value = input(body), result = await plan(value);
  return { revision: result.revision, ref: result.newRef, location: result.location, warnings: result.warnings,
    changes: result.changes.map(change => ({ ...change,
      before: change.binary ? '[Binary or protected file — copied byte-for-byte]' : change.before,
      after: change.binary ? '[Binary or protected file — copied byte-for-byte]' : change.after,
      from: path.relative(result.targets.get(change.bundle)!.source.path, change.from),
      to: path.relative(result.targets.get(change.from === change.to ? change.bundle : value.bundle)!.source.path, change.to) })) };
}

export async function applyMove(body: unknown) {
  const value = input(body);
  if (!value.revision) throw new Error('Preview this move before confirming it.');
  await assertWriteLeaseFree('desktop-asset-move');
  return withAssetMutationLease('desktop-asset-move', async () => {
    const result = await plan(value);
    if (result.revision !== value.revision) throw new Error('Files or destinations changed since the preview. Review a fresh preview.');
    const changes = result.changes, recoveries: string[] = [], warnings: string[] = [], stamp = randomUUID();
    const groups = [...result.targets].filter(([bundle]) => changes.some(change => change.bundle === bundle) || bundle === value.bundle)
      .map(([bundle, target]) => ({ bundle, target: prepareWriteTargetForMutation(target), paths: [...new Set(changes.flatMap(change =>
        [change.from, change.to].filter(file => isWithin(file, target.source.path))))] }));
    let changed = false;
    try {
      const mutate = () => {
        for (const change of changes) if (!fs.readFileSync(change.from).equals(bytes(change, 'before')))
          throw new Error('A file changed during preparation. Review a fresh preview.');
        // Backups precede every mutation. They are outside AKM's searchable trees.
        for (const group of groups) {
          const backup = path.join(group.target.source.path, '.akm', 'desktop-moves', stamp);
          safe(group.target.source.path, backup); fs.mkdirSync(backup, { recursive: true, mode: 0o700 }); recoveries.push(backup);
          const originals = changes.filter(change => change.bundle === group.bundle);
          originals.forEach((change, index) => fs.writeFileSync(path.join(backup, `${index}.md`), bytes(change, 'before'), { flag: 'wx', mode: 0o600 }));
          fs.writeFileSync(path.join(backup, 'restore.json'), JSON.stringify(originals.map((change, index) => ({ file: `${index}.md`, from: change.from, to: change.to, mode: change.mode })), null, 2), { flag: 'wx', mode: 0o600 });
        }
        // Copy before removal, including cross-filesystem moves. Never overwrite a destination.
        for (const directory of result.directories) fs.mkdirSync(directory.to, { recursive: true, mode: directory.mode });
        for (const change of changes.filter(change => change.from !== change.to)) {
          fs.mkdirSync(path.dirname(change.to), { recursive: true });
          fs.writeFileSync(change.to, bytes(change, 'after'), { flag: 'wx', mode: change.mode }); changed = true;
        }
        for (const change of changes.filter(change => change.from === change.to)) { writeFileAtomic(change.from, change.after, change.mode); changed = true; }
        for (const change of changes.filter(change => change.from !== change.to)) {
          if (!fs.readFileSync(change.from).equals(bytes(change, 'before')) || !fs.readFileSync(change.to).equals(bytes(change, 'after')))
            throw new Error('A source or destination changed during the move. Original files were not removed.');
        }
        for (const change of changes.filter(change => change.from !== change.to)) fs.unlinkSync(change.from);
        for (const directory of [...result.directories].reverse()) fs.rmdirSync(directory.from);
      };
      const boundary = (index: number): void => { const group = groups[index]; if (!group) return mutate();
        withWriteTargetMutation(group.target, group.paths, { purpose: 'desktop-asset-move', message: `Move ${value.ref} to ${result.newRef}` }, () => boundary(index + 1)); };
      boundary(0);
    } catch (error) {
      if (!changed) throw error;
      warnings.push(`The file operation or Git publication did not finish cleanly: ${(error as Error).message}. Do not repeat it blindly; inspect the recovery copies.`);
    }
    for (const group of groups) {
      if (!await indexWrittenAssets(group.target.source.path, group.paths, { bundleId: group.bundle })) warnings.push(`Run akm index to refresh ${group.bundle}.`);
    }
    const checks = [];
    for (const group of groups) {
      try {
        const lint = await akmLint({ dir: group.target.source.path, fix: false });
        checks.push({ bundle: group.bundle, issues: [...lint.flagged, ...lint.warnings]
          .filter(issue => ['missing-ref', 'stale-path', 'broken-xref', 'broken-source', 'lint-failed'].includes(issue.issue)) });
      }
      catch (error) { warnings.push(`Link check unavailable for ${group.bundle}: ${(error as Error).message}`); }
    }
    return { ref: result.newRef, location: result.location, warnings: [...result.warnings, ...warnings], recoveries, checks,
      complete: warnings.length === 0, changedFiles: changes.length };
  });
}
