import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { handleApiRequest, handleWorkspaceAction, loadConfig, resolveBundleWriteTarget, assertAkmAssetWrite,
  prepareWriteTargetForMutation, withWriteTargetMutation, withAssetMutationLease, assertWriteLeaseFree,
  isWithin, writeFileAtomic, assetPathForName, stashDirFor, parseRefInput, scrubUrlCredentials,
  openReadonlyExistingDatabase, closeDatabase, getAllEntries, indexWrittenAssets, akmLint, UsageError } from 'akm-cli/workspace';

export const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export function safeFile(root: string, file: string) {
  if (!isWithin(file, root) || path.resolve(file) === path.resolve(root)) throw new Error('The file must stay inside its bundle.');
  let current = root;
  for (const part of path.relative(root, file).split(path.sep)) {
    current = path.join(current, part);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Use the real file, not a symbolic link.');
  }
}
export function textFile(file: string) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 8 * 1048576) throw new Error('Choose a text file smaller than 8 MiB.');
  const bytes = fs.readFileSync(file), text = bytes.toString('utf8');
  if (text.includes('\0') || !bytes.equals(Buffer.from(text))) throw new Error('This is not a UTF-8 text file.');
  if (scrubUrlCredentials(text) !== text) throw new Error('Edit this file outside Desktop to preserve hidden URL credentials.');
  return text;
}
export async function assetSource(ref: string) {
  const shown = await handleApiRequest('/api/asset', new URLSearchParams({ ref })) as {
    durableRef: string; redacted: boolean; asset: { path?: string; type: string }
  };
  if (shown.redacted || !shown.durableRef || !shown.asset.path || ['env', 'secret', 'session'].includes(shown.asset.type))
    throw new Error('Choose an indexed, editable AKM asset.');
  const identity = parseRefInput(shown.durableRef), target = resolveBundleWriteTarget(loadConfig(), identity.origin!);
  assertAkmAssetWrite(target.source);
  const typeDir = stashDirFor(identity.type);
  if (!typeDir) throw new Error('This asset does not use AKM file conventions.');
  const file = assetPathForName(identity.type, path.join(target.source.path, typeDir), identity.name);
  safeFile(target.source.path, file);
  if (path.resolve(file) !== path.resolve(shown.asset.path)) throw new Error('Refresh the index before editing this asset.');
  const content = textFile(file);
  return { ref: shown.durableRef, type: identity.type, content, revision: digest(content), markdown: file.endsWith('.md'),
    file, target };
}

/** A support file is editable only inside an indexed skill package, not anywhere in a bundle. */
export async function skillSource(bundle: string, relative: string) {
  const target = resolveBundleWriteTarget(loadConfig(), bundle);
  assertAkmAssetWrite(target.source);
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part.startsWith('.') || ['env', 'secrets', 'node_modules'].includes(part)))
    throw new Error('Choose a visible skill text file, not configuration, credentials or dependencies.');
  const file = path.join(target.source.path, relative); safeFile(target.source.path, file);
  const db = openReadonlyExistingDatabase();
  if (!db) throw new Error('Index the skill before editing its files.');
  let owner;
  try { owner = getAllEntries(db).filter(entry => entry.bundleId === bundle && entry.entry.type === 'skill')
    .sort((a, b) => b.filePath.length - a.filePath.length)
    .find(entry => isWithin(file, path.dirname(entry.filePath))); } finally { closeDatabase(db); }
  if (!owner) throw new Error('This file is not inside an indexed skill.');
  await assetSource(owner.itemRef);
  const content = textFile(file);
  return { ref: owner.itemRef, type: 'skill', content, revision: digest(content), markdown: file.endsWith('.md'), file, target };
}
export async function sourceResponse(ref: string, bundle = '', file = '') {
  const source = file ? await skillSource(bundle, file) : await assetSource(ref);
  return { ref: source.ref, type: source.type, content: source.content, revision: source.revision, markdown: source.markdown };
}
export async function saveSource(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Provide the file, revision and text.');
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(key => !['ref', 'bundle', 'file', 'revision', 'content'].includes(key)) ||
    typeof value.content !== 'string' || typeof value.revision !== 'string' ||
    (value.file ? typeof value.file !== 'string' || typeof value.bundle !== 'string' : typeof value.ref !== 'string'))
    throw new Error('Provide the file, revision and text.');
  const ref = typeof value.ref === 'string' ? value.ref : '';
  if (!value.file && ['knowledge', 'memory'].includes(parseRefInput(ref).type))
    return handleWorkspaceAction('document-save', body);
  await assertWriteLeaseFree('desktop-file-edit');
  return withAssetMutationLease('desktop-file-edit', async () => {
    const source = value.file ? await skillSource(value.bundle as string, value.file as string) : await assetSource(ref);
    if (source.revision !== value.revision) throw new UsageError('The file changed. Review the newer version before saving.', 'ASSET_CONTENT_CHANGED');
    const content = value.content as string;
    if (content.includes('\0')) throw new Error('Only text can be saved here.');
    if (source.content === content) return { ref: source.ref, unchanged: true };
    const target = prepareWriteTargetForMutation(source.target);
    const backup = path.join(target.source.path, '.akm', 'desktop-edits', randomUUID());
    safeFile(target.source.path, backup);
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(backup, 'original'), source.content, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(backup, 'path.txt'), source.file, { flag: 'wx', mode: 0o600 });
    withWriteTargetMutation(target, [source.file], { purpose: 'desktop-file-edit', message: `Edit ${source.ref}` },
      () => writeFileAtomic(source.file, content, fs.statSync(source.file).mode & 0o777));
    const indexed = await indexWrittenAssets(target.source.path, [source.file], { bundleId: target.source.name });
    const lint = await akmLint({ dir: target.source.path, fix: false });
    const warnings = [...lint.flagged, ...lint.warnings].filter(issue => path.resolve(target.source.path, issue.file) === source.file)
      .map(issue => issue.detail);
    if (!indexed) warnings.push('The file was saved, but the index could not be refreshed. Run akm index.');
    return { ref: source.ref, unchanged: false, indexed, warnings, recovery: backup };
  });
}
