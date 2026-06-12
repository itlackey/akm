// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output text formatters for all `akm workflow *` commands.

import {
  formatWorkflowCompleteRejectedPlain,
  formatWorkflowCreatePlain,
  formatWorkflowListPlain,
  formatWorkflowNextPlain,
  formatWorkflowResumePlain,
  formatWorkflowStatusPlain,
  formatWorkflowValidatePlain,
} from "./helpers";
import type { TextFormatterEntry } from "./registry";

export const workflowFormatters: TextFormatterEntry[] = [
  { command: "workflow-start", handler: (r) => formatWorkflowStatusPlain(r) },
  { command: "workflow-status", handler: (r) => formatWorkflowStatusPlain(r) },
  { command: "workflow-complete", handler: (r) => formatWorkflowStatusPlain(r) },
  { command: "workflow-complete-rejected", handler: (r) => formatWorkflowCompleteRejectedPlain(r) },
  { command: "workflow-next", handler: (r) => formatWorkflowNextPlain(r) },
  { command: "workflow-list", handler: (r) => formatWorkflowListPlain(r) },
  { command: "workflow-create", handler: (r) => formatWorkflowCreatePlain(r) },
  { command: "workflow-validate", handler: (r) => formatWorkflowValidatePlain(r) },
  { command: "workflow-resume", handler: (r) => formatWorkflowResumePlain(r) },
];
