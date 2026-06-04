// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { formatToggleComponentPlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("enable", (r) => formatToggleComponentPlain("enable", r));
registerTextFormatter("disable", (r) => formatToggleComponentPlain("disable", r));
