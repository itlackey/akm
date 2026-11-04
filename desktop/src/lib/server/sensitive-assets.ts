import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, resolveBundleWriteTarget, deriveCanonicalAssetName, UsageError, withAssetMutationLease, assertWriteLeaseFree,
  resolveEnvPath, resolveSecretPath, resolveEnvWriteTarget, resolveSecretWriteTarget,
  withEnvSecretWrite, writeEnv, removeEnv, setSecret, sensitiveMarkerPath } from 'akm-cli/workspace';
import { safeFile, digest } from './asset-source.js';

type Selector = { ref?: string; bundle?: string; file?: string };
type Kind = 'env' | 'secret';
const REF = /^(?:([^/]+)\/\/)?(env|secrets)\//;
export function isSensitiveRef(ref: string) { return REF.test(ref); }

/** The ref AKM's env/secret operations take, from a ref or a bundle-relative file. */
function selection(input: Selector) {
  const match = input.ref ? REF.exec(input.ref) : null;
  const type: Kind | '' = match ? (match[2] === 'env' ? 'env' : 'secret') : input.file?.startsWith('env/') ? 'env' : input.file?.startsWith('secrets/') ? 'secret' : '';
  if (!type) throw new UsageError('Choose an environment file or secret.');
  const bundle = match?.[1] || input.bundle || loadConfig().defaultBundle;
  if (!bundle) throw new UsageError('Choose the bundle containing this file.');
  const dir = type === 'env' ? 'env' : 'secrets';
  if (input.ref) return { type, bundle, ref: input.ref.includes('//') ? input.ref : bundle + '//' + input.ref };
  const root = resolveBundleWriteTarget(loadConfig(), bundle, { requireWritable: false }).source.path;
  const name = deriveCanonicalAssetName(type, path.join(root, dir), path.resolve(root, input.file!));
  if (!name) throw new UsageError('Use an .env filename for an environment file, or a filename under secrets/.');
  return { type, bundle, ref: bundle + '//' + dir + '/' + name };
}

/** Existing env/secrets only, resolved by AKM's own read-side resolvers. This is a local read, not a secret engine. */
function locate(input: Selector) {
  const { type, bundle, ref } = selection(input);
  const found = type === 'env' ? resolveEnvPath(ref) : resolveSecretPath(ref);
  const root = found.source.path, file = found.absPath;
  try { safeFile(root, file); }
  catch { throw new UsageError('Choose a regular env/secret file inside this bundle, not a symbolic link or outside path.'); }
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { throw new UsageError('This file is unavailable. Check its location and filesystem permissions.'); }
  if (!stat.isFile()) throw new UsageError('Choose a file, not a folder.');
  return { bundle, file, type, relative: path.relative(root, file).split(path.sep).join('/'), ref };
}

export function sensitiveMetadata(input: Selector) {
  const selected = locate(input);
  let writable = false;
  try { (selected.type === 'env' ? resolveEnvWriteTarget : resolveSecretWriteTarget)(selected.ref, selected.bundle); writable = true; } catch { /* readable bundle */ }
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
    const chosen = selection(value as Selector);
    const { name, absPath: file, target, ref } = (chosen.type === 'env' ? resolveEnvWriteTarget : resolveSecretWriteTarget)(chosen.ref, chosen.bundle);
    const type = chosen.type, bundle = target.source.name, root = target.source.path;
    const marker = sensitiveMarkerPath(file, type);
    safeFile(root, file); safeFile(root, marker);
    const markerStat = action === 'delete' ? fs.lstatSync(marker, { throwIfNoEntry: false }) : undefined;
    if (markerStat && !markerStat.isFile()) throw new UsageError('The sensitive marker is not a regular file. Resolve it before deleting this asset.');
    if (action === 'create') {
      if (fs.existsSync(file)) throw new UsageError('A file already exists at this path. Choose a different name.', 'RESOURCE_ALREADY_EXISTS');
    } else {
      let bytes: Buffer;
      try { bytes = fs.readFileSync(file); } catch { throw new UsageError('This file is unavailable. Check its location and filesystem permissions.'); }
      if (digest(bytes) !== value.revision) throw new UsageError('This file changed. Reopen it before saving or deleting; your edit has not been applied.', 'ASSET_CONTENT_CHANGED');
    }
    let changed = false;
    const warnings: string[] = [];
    try {
      withEnvSecretWrite(target, { type, name }, action === 'delete' ? 'Remove' : 'Update', action === 'delete' ? [file, marker] : [file], () => {
        if (action === 'delete') {
          if (type === 'env') removeEnv(file);
          else { fs.unlinkSync(file); if (fs.existsSync(marker)) fs.unlinkSync(marker); }
        } else if (type === 'env') writeEnv(file, value.content as string);
        else setSecret(file, Buffer.from(value.content as string));
        changed = true;
      });
    } catch (error) {
      if (!changed) throw error;
      warnings.push('The file changed, but Git synchronization failed. Check this bundle’s Git status.');
    }
    return { deleted: action === 'delete', bundle, file: path.relative(root, file).split(path.sep).join('/'), ref: bundle + '//' + (type === 'env' ? 'env/' : 'secrets/') + name, warnings };
  });
}
