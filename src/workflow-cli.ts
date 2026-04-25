import { UsageError } from "./errors";
import type { WorkflowRunStepStatus } from "./source-types";

export const WORKFLOW_STEP_STATES: Array<Exclude<WorkflowRunStepStatus, "pending">> = [
  "completed",
  "blocked",
  "failed",
  "skipped",
];

export const WORKFLOW_SUBCOMMANDS = new Set([
  "start",
  "next",
  "complete",
  "status",
  "list",
  "create",
  "template",
  "resume",
]);

export function parseWorkflowJsonObject(
  raw: string | undefined,
  flagName: "--params" | "--evidence",
): Record<string, unknown> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError(`${flagName} must be valid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`${flagName} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

export function parseWorkflowStepState(value: string | undefined): Exclude<WorkflowRunStepStatus, "pending"> {
  if (!value) return "completed";
  if (WORKFLOW_STEP_STATES.includes(value as Exclude<WorkflowRunStepStatus, "pending">)) {
    return value as Exclude<WorkflowRunStepStatus, "pending">;
  }
  throw new UsageError(`Invalid workflow step state "${value}". Expected one of: ${WORKFLOW_STEP_STATES.join(", ")}`);
}

export function hasWorkflowSubcommand(args: Record<string, unknown>): boolean {
  const command = Array.isArray(args._) ? args._[0] : undefined;
  return typeof command === "string" && WORKFLOW_SUBCOMMANDS.has(command);
}
