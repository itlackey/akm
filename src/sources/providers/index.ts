/**
 * Centralized source provider registration.
 *
 * Import this module (side-effect import) to register all built-in source
 * providers with the provider registry. This replaces the individual
 * side-effect imports that were duplicated in source-search.ts and source-show.ts.
 */
import "./filesystem";
import "./git";
import "./npm";
import "./website";
