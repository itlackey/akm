import { AkmError, CONFLICT_CODES, documents, proposals, sensitive, UsageError } from "akm-cli/workspace";

const copied = documents.copy({ sourceRef: "catalog//knowledge/reference", target: "stash" });
const source = documents.readSource({ ref: "stash//knowledge/note" });
const saved = documents.save({ ref: "stash//knowledge/note", content: "x", revision: "r" });
const accepted = proposals.accept({ id: "id" });
const info = sensitive.describe({ ref: "stash//env/example" });
const created = sensitive.save({ bundle: "stash", file: "env/example.env", content: "KEY=value" });
const removed = sensitive.remove({ ref: "stash//env/example", revision: info.revision });
function conflict(value: unknown): boolean {
  return value instanceof AkmError && CONFLICT_CODES.has(value.code);
}
const failure: AkmError = new UsageError("test", "PROPOSAL_STALE");
void [copied, source, saved, accepted, created, removed, conflict, failure];
