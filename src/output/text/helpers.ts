// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure plain-text formatting helper functions shared across per-command
 * text formatter modules.
 *
 * This module is a re-export BARREL: the actual implementations live in
 * cohesive sibling modules (`show-format.ts`, `show-directives.ts`,
 * `workflow-format.ts`, `proposal-format.ts`, `command-format.ts`,
 * `health-format.ts`, `lint-format.ts`). Every name is importable from `"./helpers"` (directly,
 * or transitively via `../text.ts`).
 *
 * No registry imports — no circular dependencies.
 */

export {
  formatConfigPlain,
  formatCuratePlain,
  formatEnvCreatePlain,
  formatEnvExportPlain,
  formatEnvListPlain,
  formatEnvRemovePlain,
  formatEventLine,
  formatEventsPlain,
  formatFeedbackPlain,
  formatImportPlain,
  formatInfoPlain,
  formatRegistryAddPlain,
  formatRegistryListPlain,
  formatRegistryRemovePlain,
  formatRememberPlain,
  formatSearchPlain,
  formatSyncPlain,
} from "./command-format";
export { formatHealthPlain } from "./health-format";
export {
  formatAddPlain,
  formatBundleRenamePlain,
  formatBundleShowPlain,
  formatClonePlain,
  formatIndexPlain,
  formatInitPlain,
  formatListPlain,
  formatModelsPlain,
  formatModelsSetPlain,
  formatRemovePlain,
  formatUpdatePlain,
  formatUpgradePlain,
} from "./lifecycle-format";
export { formatLintPlain } from "./lint-format";
export {
  formatGateDecisionSummary,
  formatProposalAcceptPlain,
  formatProposalDiffPlain,
  formatProposalDrainPlain,
  formatProposalListPlain,
  formatProposalProducerPlain,
  formatProposalRejectPlain,
  formatProposalReopenBatchPlain,
  formatProposalReopenPlain,
  formatProposalShowPlain,
} from "./proposal-format";
export { formatShowPlain } from "./show-format";
export {
  formatWorkflowCreatePlain,
  formatWorkflowListPlain,
  formatWorkflowPlanPlain,
  formatWorkflowResumePlain,
  formatWorkflowRunPlain,
  formatWorkflowStatusPlain,
} from "./workflow-format";
