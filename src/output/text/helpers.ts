// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure plain-text formatting helper functions shared across per-command
 * text formatter modules.
 *
 * This module is a re-export BARREL: the actual implementations live in
 * cohesive sibling modules (`show-format.ts`, `show-directives.ts`,
 * `workflow-format.ts`, `proposal-format.ts`, `command-format.ts`) split out
 * of what used to be a single 1418-line / 59-function file. Every name that
 * was previously importable from `"./helpers"` (directly, or transitively via
 * `../text.ts`) stays importable from here unchanged — no import site needed
 * to move.
 *
 * No registry imports — no circular dependencies.
 */

export {
  formatAddPlain,
  formatClonePlain,
  formatConfigPlain,
  formatCuratePlain,
  formatEnvCreatePlain,
  formatEnvExportPlain,
  formatEnvListPlain,
  formatEnvRemovePlain,
  formatEnvSetPlain,
  formatEnvUnsetPlain,
  formatEventLine,
  formatEventsPlain,
  formatFeedbackPlain,
  formatHistoryPlain,
  formatImportPlain,
  formatIndexPlain,
  formatInfoPlain,
  formatInitPlain,
  formatListPlain,
  formatRegistryAddPlain,
  formatRegistryBuildIndexPlain,
  formatRegistryListPlain,
  formatRegistryRemovePlain,
  formatRegistrySearchPlain,
  formatRememberPlain,
  formatRemovePlain,
  formatSavePlain,
  formatSearchPlain,
  formatToggleComponentPlain,
  formatUpdatePlain,
  formatUpgradePlain,
} from "./command-format";
export {
  formatDistillPlain,
  formatGateDecisionSummary,
  formatProposalAcceptPlain,
  formatProposalDiffPlain,
  formatProposalDrainPlain,
  formatProposalListPlain,
  formatProposalProducerPlain,
  formatProposalRejectPlain,
  formatProposalShowPlain,
} from "./proposal-format";
export { formatShowPlain } from "./show-format";
export {
  formatWorkflowBriefPlain,
  formatWorkflowCompleteRejectedPlain,
  formatWorkflowCreatePlain,
  formatWorkflowListPlain,
  formatWorkflowNextPlain,
  formatWorkflowResumePlain,
  formatWorkflowRunPlain,
  formatWorkflowStatusPlain,
  formatWorkflowValidatePlain,
} from "./workflow-format";
