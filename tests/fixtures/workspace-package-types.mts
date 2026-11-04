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

// The env/secret operations a host composes, usable from the declarations alone.
function secrets() {
  const found = workspace.resolveSecretPath("stash//secrets/example");
  const written = workspace.resolveSecretWriteTarget("stash//secrets/example", "stash");
  const marker: string = workspace.sensitiveMarkerPath(found.absPath, "secret");
  const name: string | undefined = workspace.deriveCanonicalAssetName("env", "env", "env/example.env");
  const bundle: string = written.target.source.name;
  const removed: boolean = workspace.withEnvSecretWrite(
    written.target,
    { type: "secret", name: written.name },
    "Remove",
    [written.absPath, marker],
    () => workspace.removeSecret(written.absPath),
  );
  workspace.withEnvSecretWrite(
    written.target,
    { type: "secret", name: written.name },
    "Update",
    [written.absPath],
    () => {
      workspace.setSecret(written.absPath, Buffer.from("value"));
      workspace.writeEnv(workspace.resolveEnvPath("stash//env/example").absPath, "KEY=value");
      return workspace.removeEnv(written.absPath);
    },
  );
  const redacted: unknown = workspace.scrubUrlCredentials(found.source.path);
  const failure: ProposalActionError = workspace.classifyProposalError(
    new workspace.UsageError("test", "RESOURCE_ALREADY_EXISTS"),
  );
  void [name, bundle, removed, redacted, failure];
}
void secrets;
