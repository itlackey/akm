import { resolveStashDir } from "../../core/common";
import type { SourceConfigEntry } from "../../core/config";
import { ConfigError } from "../../core/errors";
import type { ProviderContext, SourceProvider } from "../source-provider";
import { registerSourceProvider } from "../source-provider-factory";

/**
 * Filesystem source — points at a directory the user already manages.
 *
 * Implements the v1 {@link SourceProvider} interface (spec §2.1, §2.4):
 * just `{ name, kind, init, path }`. No `sync()` — content is the user's
 * own directory, never refreshed by akm.
 */
class FilesystemSourceProvider implements SourceProvider {
  readonly kind = "filesystem" as const;
  readonly name: string;
  readonly #stashDir: string;

  constructor(entry: SourceConfigEntry) {
    if (entry.type !== "filesystem") {
      throw new ConfigError(`FilesystemSourceProvider invoked with type="${entry.type}"`);
    }
    this.#stashDir = entry.path ?? resolveStashDir();
    if (!this.#stashDir) {
      throw new ConfigError("filesystem source requires a `path`");
    }
    this.name = entry.name ?? this.#stashDir;
  }

  async init(_ctx: ProviderContext): Promise<void> {
    // Filesystem sources resolve their path eagerly in the constructor;
    // init has nothing to do beyond letting the registry know we're ready.
  }

  path(): string {
    return this.#stashDir;
  }
}

// ── Self-register ───────────────────────────────────────────────────────────

registerSourceProvider("filesystem", (config) => new FilesystemSourceProvider(config));

export { FilesystemSourceProvider };
