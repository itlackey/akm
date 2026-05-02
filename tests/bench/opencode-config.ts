/**
 * opencode-config.ts — config-driven opencode provider materialisation.
 *
 * Loads the operator's bench provider file (committed fixture or
 * gitignored `.local.json` overlay), validates it for safety (no hard-coded
 * credentials, no extra top-level keys), and writes a minimal
 * `opencode.json` into the per-run isolated `OPENCODE_CONFIG` directory.
 *
 * Design: `tests/bench/BENCH.md` §"Config-driven opencode provider".
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Error class for bench provider-config problems.
 *
 * `isUsageError: true`  → the caller should exit 2 (USAGE).
 * `isUsageError: false` → the caller should exit 78 (CONFIG).
 */
export class BenchConfigError extends Error {
  readonly code = "BENCH_CONFIG";
  readonly isUsageError: boolean;

  constructor(message: string, isUsageError: boolean) {
    super(message);
    this.name = "BenchConfigError";
    this.isUsageError = isUsageError;
  }
}

/** Wire-format of the committed providers JSON file. */
export interface BenchOpencodeProvidersFile {
  schemaVersion: 1;
  defaultModel?: string;
  providers: Record<string, unknown>;
}

/** Parsed + validated result returned by `loadOpencodeProviders`. */
export interface LoadedOpencodeProviders {
  /** Absolute path of the file that was loaded. */
  source: string;
  /** Provider map, ready to splice into opencode.json. */
  providers: Record<string, unknown>;
  /** Default model ID from the file, if present. */
  defaultModel?: string;
}

/**
 * Top-level keys that belong in a full opencode user-config but are FORBIDDEN
 * in the bench provider file. The bench file is intentionally minimal — it
 * only specifies provider entries. Any of these keys in the file means the
 * operator has pasted a full opencode config into the bench slot, which could
 * contain credentials, plugins, or permission overrides that the bench MUST
 * NOT inherit.
 */
const FORBIDDEN_TOPLEVEL_KEYS = new Set([
  "plugin",
  "mcp",
  "permission",
  "disabled_providers",
  "small_model",
  "snapshot",
]);

/**
 * Regex that an `apiKey` string value MUST match when present. The only
 * allowed form is an env-ref placeholder: `{env:VAR_NAME}`.
 */
const ENV_REF_RE = /^\{env:[A-Z_][A-Z0-9_]*\}$/;

/** Heuristic to detect literal API credentials accidentally pasted into the file. */
const CREDENTIAL_RE = /^sk-[A-Za-z0-9_-]{20,}$/;

/**
 * Recursively scan `node` for credential heuristic violations and literal
 * `apiKey` values that are not env-refs. Throws `BenchConfigError` on the
 * first violation found.
 *
 * @param node   The value to scan (any JSON value).
 * @param jspath JSON-path-like string for error messages, e.g. `providers.myProvider.apiKey`.
 */
function scanForCredentials(node: unknown, jspath: string): void {
  if (typeof node === "string") {
    // Heuristic: reject anything that looks like an OpenAI/Anthropic-style key.
    if (CREDENTIAL_RE.test(node)) {
      throw new BenchConfigError(
        `bench provider file: credential heuristic triggered at "${jspath}" — literal API key detected; use {env:VAR_NAME} instead`,
        false,
      );
    }
    return;
  }

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      scanForCredentials(node[i], `${jspath}[${i}]`);
    }
    return;
  }

  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const childPath = `${jspath}.${key}`;

      // apiKey must be an env-ref if present as a string.
      if (key === "apiKey" && typeof value === "string") {
        if (!ENV_REF_RE.test(value)) {
          throw new BenchConfigError(
            `bench provider file: "${childPath}" must be an env-ref (e.g. {env:MY_API_KEY}), not a literal value`,
            false,
          );
        }
        // An env-ref is fine — don't recurse further into it.
        continue;
      }

      scanForCredentials(value, childPath);
    }
  }
}

/**
 * Load and validate a bench opencode providers JSON file.
 *
 * Throws:
 * - `BenchConfigError(isUsageError: true)` if the file does not exist.
 * - `BenchConfigError(isUsageError: false)` if JSON parse fails or the file
 *   fails validation (bad schema version, forbidden top-level keys, detected
 *   credentials).
 */
export function loadOpencodeProviders(absPath: string): LoadedOpencodeProviders {
  // ── File existence ────────────────────────────────────────────────────────
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch (err) {
    const isEnoent = (err as NodeJS.ErrnoException).code === "ENOENT";
    if (isEnoent) {
      throw new BenchConfigError(
        `bench provider file not found: ${absPath}`,
        true, // isUsageError → exit 2
      );
    }
    throw new BenchConfigError(
      `bench provider file: could not read "${absPath}": ${err instanceof Error ? err.message : String(err)}`,
      false,
    );
  }

  // ── JSON parse ────────────────────────────────────────────────────────────
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BenchConfigError(
      `bench provider file: JSON parse error in "${absPath}": ${err instanceof Error ? err.message : String(err)}`,
      false, // isUsageError: false → exit 78 (config error)
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BenchConfigError(
      `bench provider file: root must be a JSON object (got ${Array.isArray(parsed) ? "array" : typeof parsed})`,
      false,
    );
  }

  const obj = parsed as Record<string, unknown>;

  // ── Forbidden top-level keys ──────────────────────────────────────────────
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_TOPLEVEL_KEYS.has(key)) {
      throw new BenchConfigError(
        `bench provider file: forbidden top-level key "${key}" — the bench provider file must contain only "schemaVersion", "defaultModel", and "providers"`,
        false,
      );
    }
  }

  // ── schemaVersion ─────────────────────────────────────────────────────────
  if (obj.schemaVersion !== 1) {
    throw new BenchConfigError(
      `bench provider file: unsupported schemaVersion ${JSON.stringify(obj.schemaVersion)}; expected 1`,
      false,
    );
  }

  // ── providers ─────────────────────────────────────────────────────────────
  if (obj.providers === null || typeof obj.providers !== "object" || Array.isArray(obj.providers)) {
    throw new BenchConfigError(`bench provider file: "providers" must be an object`, false);
  }

  const providers = obj.providers as Record<string, unknown>;

  // ── Credential scan ───────────────────────────────────────────────────────
  scanForCredentials(providers, "providers");

  return {
    source: absPath,
    providers,
    ...(typeof obj.defaultModel === "string" ? { defaultModel: obj.defaultModel } : {}),
  };
}

/**
 * Given a model ID (e.g. `"don/mlx-community/qwen3.6-35b-a3b"`), split on
 * the first `/` to get the provider key and look it up in `loaded.providers`.
 *
 * Throws `BenchConfigError` if the provider key is not found.
 */
export function selectProviderForModel(
  loaded: LoadedOpencodeProviders,
  modelId: string,
): { providerKey: string; entry: unknown } {
  const slashIdx = modelId.indexOf("/");
  const providerKey = slashIdx === -1 ? modelId : modelId.slice(0, slashIdx);

  if (!(providerKey in loaded.providers)) {
    throw new BenchConfigError(
      `bench provider file: model ID "${modelId}" maps to provider key "${providerKey}", which is not present in ${loaded.source}; available: ${Object.keys(loaded.providers).join(", ") || "(none)"}`,
      false,
    );
  }

  return { providerKey, entry: loaded.providers[providerKey] };
}

/**
 * Write a minimal `opencode.json` into `opencodeConfigDir` for the given
 * provider selection. The file contains exactly two top-level keys:
 * `$schema` and `provider`.
 *
 * Written with mode `0o600` so the file is not world-readable (it may
 * contain env-ref placeholders that hint at secret variable names).
 */
export function materializeOpencodeConfig(
  opencodeConfigDir: string,
  selected: { providerKey: string; entry: unknown },
): void {
  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [selected.providerKey]: selected.entry,
    },
  };

  const outPath = path.join(opencodeConfigDir, "opencode.json");
  fs.writeFileSync(outPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}
