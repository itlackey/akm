import fs from "node:fs";
import path from "node:path";

// Version: prefer compile-time define, then package.json, then fallback
export const pkgVersion: string = (() => {
  // Injected at compile time via `bun build --define`
  if (typeof AKM_VERSION !== "undefined") return AKM_VERSION;
  try {
    const pkgPath = path.resolve(import.meta.dir ?? __dirname, "../package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (typeof pkg.version === "string") return pkg.version;
    }
  } catch {
    // swallow — running as compiled binary without package.json
  }
  return "0.0.0-dev";
})();

// AKM_VERSION ambient type is declared in globals.d.ts
