// Output shape registration for `akm distill <ref>` (#228). The shape is
// simple — outcome + ids + optional payload — so `brief` strips the full
// proposal blob, `normal` keeps the headline fields, and `full` projects
// everything for downstream automation.

import { shapeDistillOutput } from "./helpers";
import { registerOutputShape } from "./registry";

registerOutputShape("distill", (result, detail) => shapeDistillOutput(result as Record<string, unknown>, detail));
