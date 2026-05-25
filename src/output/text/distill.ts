// Output text formatter for `akm distill <ref>` (#228).

import { formatDistillPlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("distill", (r) => formatDistillPlain(r));
