import * as workspace from "akm-cli/workspace";
import {
  AkmError,
  akmClone,
  type CloneOptions,
  type CloneResponse,
  classifyWorkspaceError,
  handleApiRequest,
  handleWorkspaceAction,
  handleWriteRequest,
  matchWorkspaceAction,
  matchWriteRoute,
  NO_SUCH_ROUTE,
  type ProposalActionError,
} from "akm-cli/workspace";

const options: CloneOptions = { sourceRef: "catalog//knowledge/reference", target: "stash" };
const copied: Promise<CloneResponse> = akmClone(options);
const read: Promise<unknown> = handleApiRequest("/api/search", new URLSearchParams());
const action = matchWorkspaceAction("/api/knowledge/create");
if (action) void handleWorkspaceAction(action, {});
const route = matchWriteRoute("/api/proposals/id/reject");
if (route) void handleWriteRequest(route, {});
const error: ProposalActionError = classifyWorkspaceError(new Error());
const symbol: symbol = NO_SUCH_ROUTE;
function classified(value: unknown): string | undefined {
  return value instanceof AkmError ? value.code : undefined;
}
void [copied, read, error, symbol, classified];

// Actual local-host helpers must remain usable from generated declarations,
// without source-checkout paths or Bun ambient types.
function organizer() {
  const config = workspace.loadConfig();
  const identity = workspace.parseRefInput("stash//knowledge/example");
  const target = workspace.prepareWriteTargetForMutation(workspace.resolveBundleWriteTarget(config, "stash"));
  workspace.assertAkmAssetWrite(target.source);
  const file: string = workspace.assetPathForName(identity.type, target.source.path, identity.name);
  const name: string | undefined = workspace.deriveCanonicalAssetName(identity.type, target.source.path, file);
  const dir = workspace.stashDirFor(identity.type);
  const contained: boolean = workspace.isWithin(file, target.source.path);
  workspace.writeFileAtomic(file, "content");
  workspace.withWriteTargetMutation(target, [file], { purpose: "test", message: "test" }, () => true);
  workspace.withEnvSecretWrite(target, { type: "env", name: "example" }, "Update", [file], () => {
    workspace.withSecretLock(file, () => workspace.writeEnv(file, "KEY=value"));
  });
  const removed: boolean = workspace.removeEnv(file);
  const marker: string = workspace.sensitiveMarkerPath(file, "env");
  void workspace.assertWriteLeaseFree("test");
  void workspace.withAssetMutationLease("test", async () => {
    const indexed: boolean = await workspace.indexWrittenAssets(target.source.path, [file], { bundleId: "stash" });
    return indexed;
  });
  void workspace.akmLint({ dir: target.source.path, fix: false });
  void workspace.renameBundle(
    "stash",
    "renamed",
    { dryRun: true },
    {
      syncTasks: (bundle, backend) => workspace.akmTasksSync({ backend }, bundle),
    },
  );
  const db = workspace.openReadonlyExistingDatabase();
  if (db) {
    const id: number | undefined = workspace.getEntryIdByFilePath(db, file);
    const count: number = workspace.getEntryCount(db);
    const entries = workspace.getAllEntries(db);
    const fingerprint: string | undefined = workspace.getMeta(db, "embeddingFingerprint");
    if (id !== undefined) {
      const entry = workspace.getEntryById(db, id);
      const stored: boolean = workspace.hasStoredEmbedding(db, id);
      const missing = workspace.getAllEntriesForEmbedding(db, [id], fingerprint);
      const neighbors = workspace.getNeighborsByEntryId(db, id, count);
      void [entry, stored, missing, neighbors];
    }
    workspace.closeDatabase(db);
    void entries;
  }
  const sources = workspace.resolveSourceEntries();
  const redacted: unknown = workspace.scrubUrlCredentials(file);
  const failure: ProposalActionError = workspace.classifyProposalError(new workspace.UsageError("test"));
  void [name, dir, contained, removed, marker, sources, redacted, failure];
}
void organizer;
