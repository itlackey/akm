import { normalizeAssetType } from "./common";
import { loadConfig } from "./config";
import { NotFoundError, UsageError } from "./errors";
import { buildFileContext, buildRenderContext, getRenderer, runMatchers } from "./file-context";
import { resolveSourcesForOrigin } from "./origin-resolve";
import { parseAssetRef } from "./stash-ref";
import { resolveAssetPath } from "./stash-resolve";
import { buildEditHint, findSourceForPath, isEditable, resolveStashSources } from "./stash-source";
import type { KnowledgeView, ShowResponse } from "./stash-types";

export async function agentikitShow(input: { ref: string; view?: KnowledgeView }): Promise<ShowResponse> {
  const parsed = parseAssetRef(input.ref);
  const displayType = normalizeAssetType(parsed.type);
  const config = loadConfig();
  const allSources = resolveStashSources();
  const searchSources = resolveSourcesForOrigin(parsed.origin, allSources);

  const allStashDirs = searchSources.map((s) => s.path);

  let assetPath: string | undefined;
  let lastError: Error | undefined;
  for (const dir of allStashDirs) {
    try {
      assetPath = resolveAssetPath(dir, parsed.type, parsed.name);
      break;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (!assetPath && parsed.origin && searchSources.length === 0) {
    const installCmd = `akm add ${parsed.origin}`;
    throw new NotFoundError(
      `Stash asset not found for ref: ${displayType}:${parsed.name}. ` +
        `Kit "${parsed.origin}" is not installed. Run: ${installCmd}`,
    );
  }

  if (!assetPath) {
    throw lastError ?? new NotFoundError(`Stash asset not found for ref: ${displayType}:${parsed.name}`);
  }

  const source = findSourceForPath(assetPath, allSources);
  const sourceStashDir = source?.path ?? allStashDirs[0];

  if (!sourceStashDir) {
    throw new UsageError(`Could not determine stash root for asset: ${displayType}:${parsed.name}`);
  }

  const fileCtx = buildFileContext(sourceStashDir, assetPath);
  const match = runMatchers(fileCtx);
  if (!match) {
    throw new UsageError(
      `Could not display asset "${displayType}:${parsed.name}" — unsupported file type or unrecognized layout`,
    );
  }

  match.meta = { ...match.meta, name: parsed.name, view: input.view };
  const renderer = getRenderer(match.renderer);
  if (!renderer) {
    throw new UsageError(`Renderer "${match.renderer}" not found for asset: ${displayType}:${parsed.name}`);
  }

  const renderCtx = buildRenderContext(fileCtx, match, allStashDirs);
  const response = renderer.buildShowResponse(renderCtx);
  const editable = isEditable(assetPath, config);
  return {
    ...response,
    registryId: source?.registryId,
    editable,
    ...(!editable ? { editHint: buildEditHint(assetPath, parsed.type, parsed.name, source?.registryId) } : {}),
  };
}
