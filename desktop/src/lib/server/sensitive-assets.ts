import fs from 'node:fs';
import path from 'node:path';
import { parseRefInput, assetPathForName, stashDirFor, loadConfig, resolveBundleWriteTarget, UsageError,
  openReadonlyExistingDatabase, closeDatabase, getAllEntries, deriveCanonicalAssetName,
  prepareWriteTargetForMutation, assertAkmAssetWrite, withAssetMutationLease, assertWriteLeaseFree,
  withEnvSecretWrite, withSecretLock, writeEnv, removeEnv, writeFileAtomic, sensitiveMarkerPath, indexWrittenAssets } from 'akm-cli/workspace';
import { safeFile, digest } from './asset-source.js';

type Selector = { ref?: string; bundle?: string; file?: string };
export function isSensitiveRef(ref: string) {
  try { return ['env', 'secret'].includes(parseRefInput(ref).type); } catch { return false; }
}

/** Resolve only env/secrets inside a registered bundle. This is a local read, not a secret engine. */
function locate(input: Selector, create = false, writable = false) {
  const identity = input.ref ? parseRefInput(input.ref) : null;
  const bundle = identity?.origin || input.bundle || loadConfig().defaultBundle;
  if (!bundle) throw new UsageError('Choose the bundle containing this file.');
  const target = resolveBundleWriteTarget(loadConfig(), bundle, { requireWritable: writable });
  if (writable) assertAkmAssetWrite(target.source);
  const type = identity?.type || (input.file?.startsWith('env/') ? 'env' : input.file?.startsWith('secrets/') ? 'secret' : '');
  if (type !== 'env' && type !== 'secret') throw new UsageError('Choose an environment file or secret.');
  let file = identity ? assetPathForName(type, path.join(target.source.path, stashDirFor(type)!), identity.name) : path.resolve(target.source.path, input.file!);
  if (identity) {
    const db = openReadonlyExistingDatabase();
    if (db) try {
      // Native index resolves alternate file spellings (for example env/default.env).
      const row = getAllEntries(db).find(row => row.itemRef === bundle + '//' + input.ref!.split('//').at(-1));
      if (row && row.entry.type === type) file = row.filePath;
    } finally { closeDatabase(db); }
  }
  const directory = path.join(target.source.path, type === 'env' ? 'env' : 'secrets');
  try { safeFile(target.source.path, file); safeFile(directory, file); }
  catch { throw new UsageError('Choose a regular env/secret file inside this bundle, not a symbolic link or outside path.'); }
  if (create) {
    if (fs.existsSync(file)) throw new UsageError('A file already exists at this path. Choose a different name.', 'RESOURCE_ALREADY_EXISTS');
  } else {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { throw new UsageError('This file is unavailable. Check its location and filesystem permissions.'); }
    if (!stat.isFile()) throw new UsageError('Choose a file, not a folder.');
  }
  const relative = path.relative(target.source.path, file).split(path.sep).join('/');
  const name = deriveCanonicalAssetName(type, directory, file);
  if (!name) throw new UsageError('Use an .env filename for an environment file, or a filename under secrets/.');
  return { bundle, file, type: type as 'env' | 'secret', relative, name, target, ref: bundle + '//' + (type === 'env' ? 'env/' : 'secrets/') + name };
}

export function sensitiveMetadata(input: Selector) {
  const selected = locate(input);
  let writable = false;
  try { assertAkmAssetWrite(resolveBundleWriteTarget(loadConfig(), selected.bundle).source); writable = true; } catch { /* readable bundle */ }
  return { redacted: true, durableRef: selected.ref, bundle: selected.bundle,
    writable, revision: digest(fs.readFileSync(selected.file)),
    asset: { ref: selected.ref, type: selected.type, name: path.basename(selected.file), path: selected.file, editable: false },
    location: { bundle: selected.bundle, path: selected.relative, parent: path.posix.dirname(selected.relative) },
    note: 'Values are masked until you choose Show.' };
}

export function revealSensitive(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UsageError('Choose a file to show.');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['ref', 'bundle', 'file'].includes(key)) ||
      Object.values(value).some(entry => typeof entry !== 'string') ||
      !(typeof value.ref === 'string' && value.ref || typeof value.bundle === 'string' && typeof value.file === 'string'))
    throw new UsageError('Choose a file to show.');
  const selected = locate(value as Selector);
  let bytes: Buffer;
  try { bytes = fs.readFileSync(selected.file); } catch { throw new UsageError('The file could not be read. Check filesystem permissions.'); }
  const content = bytes.toString('utf8');
  if (bytes.includes(0) || !Buffer.from(content).equals(bytes)) throw new UsageError('This is a binary file. Open it with a suitable local application.');
  return { content, revision: digest(bytes) };
}

/** Whole-file editing: keep bytes in the request, never in argv, drafts or receipts. */
export async function mutateSensitive(action: 'create' | 'save' | 'delete', input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UsageError('Choose a file.');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['ref', 'bundle', 'file', 'content', 'revision'].includes(key)) ||
      Object.values(value).some(entry => typeof entry !== 'string') ||
      !(value.ref || value.bundle && value.file) ||
      (action !== 'delete' && (typeof value.content !== 'string' || value.content.includes('\0'))) ||
      (action !== 'create' && typeof value.revision !== 'string')) throw new UsageError('Provide the file, text and current revision.');
  await assertWriteLeaseFree('desktop-sensitive-file');
  return withAssetMutationLease('desktop-sensitive-file', async () => {
    const selected = locate(value as Selector, action === 'create', true);
    const target = prepareWriteTargetForMutation(selected.target);
    const marker = sensitiveMarkerPath(selected.file, selected.type);
    safeFile(target.source.path, marker);
    const paths = action === 'delete' ? [selected.file, marker] : [selected.file];
    let changed = false;
    const warnings: string[] = [];
    withSecretLock(selected.file, () => {
      safeFile(target.source.path, selected.file); safeFile(target.source.path, marker);
      const markerStat = action === 'delete' ? fs.lstatSync(marker, { throwIfNoEntry: false }) : undefined;
      if (markerStat && !markerStat.isFile()) throw new UsageError('The sensitive marker is not a regular file. Resolve it before deleting this asset.');
      if (action === 'create') {
        if (fs.existsSync(selected.file)) throw new UsageError('This file now exists. Choose another name.', 'RESOURCE_ALREADY_EXISTS');
      } else if (digest(fs.readFileSync(selected.file)) !== value.revision) {
        throw new UsageError('This file changed. Reopen it before saving or deleting; your edit has not been applied.', 'ASSET_CONTENT_CHANGED');
      }
      try {
        withEnvSecretWrite(target, { type: selected.type, name: selected.name }, action === 'delete' ? 'Remove' : 'Update', paths, () => {
          if (action === 'delete') {
            if (selected.type === 'env') removeEnv(selected.file);
            else { fs.unlinkSync(selected.file); if (fs.existsSync(marker)) fs.unlinkSync(marker); }
          } else if (selected.type === 'env') writeEnv(selected.file, value.content as string);
          else {
            fs.mkdirSync(path.dirname(selected.file), { recursive: true, mode: 0o700 });
            writeFileAtomic(selected.file, value.content as string, 0o600);
          }
          changed = true;
        });
      } catch (error) {
        if (!changed) throw error;
        warnings.push('The file changed, but Git synchronization failed. Check this bundle’s Git status.');
      }
    });
    if (!await indexWrittenAssets(target.source.path, [selected.file], { bundleId: selected.bundle }))
      warnings.push('The file changed, but the index could not refresh. Run akm index.');
    return { deleted: action === 'delete', bundle: selected.bundle, file: selected.relative, ref: selected.ref, warnings };
  });
}
