/**
 * Centralized registry provider registration.
 *
 * Import this module (side-effect import) to register all built-in registry
 * providers with the provider registry. This replaces the individual
 * side-effect imports that were duplicated in registry-search.ts.
 *
 * Mirrors the pattern used by `source-providers/index.ts`.
 */
import "./static-index";
import "./skills-sh";
