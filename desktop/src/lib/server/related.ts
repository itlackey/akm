import fs from 'node:fs';
import { handleApiRequest, openReadonlyExistingDatabase, closeDatabase, getEntryIdByFilePath,
  getEntryById, getEntryCount, getNeighborsByEntryId, hasStoredEmbedding, getAllEntriesForEmbedding, getMeta, resolveSourceEntries, isWithin } from 'akm-cli/workspace';
import type { AssetRead } from '../library-model';

/** Core owns vector storage, model compatibility and distance calculation. No query embedding or network. */
export async function related(ref: string, scope: string) {
  const asset = await handleApiRequest('/api/asset', new URLSearchParams({ ref })) as AssetRead;
  const unavailable = (note: string) => ({ available: false, note, matches: [] });
  if (asset.redacted || !asset.asset.path) return unavailable('This asset has no comparable indexed content.');
  const db = openReadonlyExistingDatabase();
  if (!db) return unavailable('No index is available. Build the AKM index to compare stored embeddings.');
  try {
    const id = getEntryIdByFilePath(db, asset.asset.path);
    if (id === undefined || !hasStoredEmbedding(db, id)) return unavailable('No stored embedding for this asset. Run AKM indexing with embeddings enabled; browsing here never calls a provider.');
    if (getAllEntriesForEmbedding(db, [id], getMeta(db, 'embeddingFingerprint')).length) return unavailable('This asset’s embedding belongs to an older model. Refresh the index before comparing it.');
    const sources = resolveSourceEntries().filter(source => !source.unresolved);
    const matches = [];
    // Request enough candidates before filtering disabled bundles and protected content.
    for (const match of getNeighborsByEntryId(db, id, getEntryCount(db))) {
      if (match.id === id || !Number.isFinite(match.distance)) continue;
      const row = getEntryById(db, match.id);
      if (!row || ['secret', 'env', 'session'].includes(row.entry.type) || !fs.existsSync(row.filePath)) continue;
      if (!sources.some(source => source.registryId === row.bundleId && isWithin(row.filePath, source.path))) continue;
      if (scope === 'bundle' && row.bundleId !== asset.bundle) continue;
      matches.push({ ref: row.itemRef, title: row.entry.toc?.find(heading => heading.level === 1)?.text || row.entry.name, type: row.entry.type,
        cosine: Math.max(-1, Math.min(1, 1 - match.distance ** 2 / 2)) });
      if (matches.length === 20) break;
    }
    return { available: true, matches, note: 'Up to 20 nearest stored embeddings. Scores describe indexed content; refresh the index after external edits.' };
  } finally { closeDatabase(db); }
}
