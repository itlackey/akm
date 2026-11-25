import { createWorkflowAsset } from "../../src/workflows/authoring/authoring";

const [mode] = process.argv.slice(2);

if (mode === "workflow") {
  createWorkflowAsset({ name: "leased" });
} else {
  throw new Error("Invalid write-mutation lease worker arguments.");
}
