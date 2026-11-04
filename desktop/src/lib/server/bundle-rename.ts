import { renameBundle, akmTasksSync, UsageError, assertWriteLeaseFree, withAssetMutationLease } from 'akm-cli/workspace';

export async function rename(input: unknown, preview: boolean) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UsageError('Choose the bundle and its new name.');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['bundle', 'name'].includes(key)) || typeof value.bundle !== 'string' || typeof value.name !== 'string')
    throw new UsageError('Choose the bundle and its new name.');
  const run = () => renameBundle(value.bundle as string, value.name as string, { dryRun: preview }, {
    syncTasks: (name, backend) => akmTasksSync({ backend }, name)
  });
  if (preview) return run();
  await assertWriteLeaseFree('desktop-bundle-rename');
  return withAssetMutationLease('desktop-bundle-rename', run);
}
