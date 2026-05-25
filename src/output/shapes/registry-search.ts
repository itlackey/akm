import { shapeRegistrySearchOutput } from "./helpers";
import { registerOutputShape } from "./registry";

registerOutputShape("registry-search", (result, detail) =>
  shapeRegistrySearchOutput(result as Record<string, unknown>, detail),
);
