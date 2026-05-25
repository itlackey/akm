// Output shape registration for `akm history` — paired with the text renderer in text.ts.

import { shapeHistoryOutput } from "./helpers";
import { registerOutputShape } from "./registry";

registerOutputShape("history", (result, detail) => shapeHistoryOutput(result as Record<string, unknown>, detail));
