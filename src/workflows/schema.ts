/**
 * Validated JSON shape for a workflow asset.
 *
 * `parseWorkflow` (parser.ts) converts a workflow markdown file into a
 * `WorkflowDocument` plus a list of `WorkflowError`s. The document is the
 * single source of truth consumed by the renderer, the indexer (cached
 * into `workflow_documents` in `index.db`), and the run engine. Source
 * markdown is referenced by `SourceRef` line spans so editors and agents
 * can rewrite content in place without a full re-parse.
 */

export const WORKFLOW_SCHEMA_VERSION = 1;

/** 1-indexed inclusive line range in a markdown file. */
export interface LineSpan {
  start: number;
  end: number;
}

/** A line span anchored to a specific source file (relative to the source root). */
export interface SourceRef extends LineSpan {
  path: string;
}

export interface WorkflowParameter {
  name: string;
  description: string;
  source: SourceRef;
}

export interface WorkflowInstructionBlock {
  text: string;
  source: SourceRef;
}

export interface WorkflowCompletionCriterion {
  text: string;
  source: SourceRef;
}

export interface WorkflowStep {
  id: string;
  title: string;
  sequenceIndex: number;
  instructions: WorkflowInstructionBlock;
  completionCriteria?: WorkflowCompletionCriterion[];
  source: SourceRef;
}

export interface WorkflowDocument {
  schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
  title: string;
  description?: string;
  tags?: string[];
  parameters?: WorkflowParameter[];
  steps: WorkflowStep[];
  source: { path: string; lineCount: number };
}

/**
 * A single problem in the source markdown. CLI and indexer format these
 * uniformly as `path:line — message`. The fix is baked into the message
 * itself; there is no separate hint field, code, or severity.
 */
export interface WorkflowError {
  /** 1-indexed line in the source markdown the problem refers to. */
  line: number;
  /** Human-readable message including the offending value and how to fix it. */
  message: string;
}

export type WorkflowParseResult = { ok: true; document: WorkflowDocument } | { ok: false; errors: WorkflowError[] };
