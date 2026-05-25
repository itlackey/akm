// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output text formatters for all `akm workflow *` commands.

import {
  formatWorkflowCreatePlain,
  formatWorkflowListPlain,
  formatWorkflowNextPlain,
  formatWorkflowResumePlain,
  formatWorkflowStatusPlain,
  formatWorkflowValidatePlain,
} from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("workflow-start", (r) => formatWorkflowStatusPlain(r));
registerTextFormatter("workflow-status", (r) => formatWorkflowStatusPlain(r));
registerTextFormatter("workflow-complete", (r) => formatWorkflowStatusPlain(r));
registerTextFormatter("workflow-next", (r) => formatWorkflowNextPlain(r));
registerTextFormatter("workflow-list", (r) => formatWorkflowListPlain(r));
registerTextFormatter("workflow-create", (r) => formatWorkflowCreatePlain(r));
registerTextFormatter("workflow-validate", (r) => formatWorkflowValidatePlain(r));
registerTextFormatter("workflow-resume", (r) => formatWorkflowResumePlain(r));
