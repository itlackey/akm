// Output text formatter for `akm history` — paired with the shape in shapes/history.ts.

import { formatHistoryPlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("history", (r) => formatHistoryPlain(r));
