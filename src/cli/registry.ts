/**
 * Cycle registry for the chant-governance CLI.
 *
 * Maps well-known cycle names (the strings passed to --cycles) to their
 * Cycle implementations. Add new cycles here as they are implemented.
 *
 * The registry is the single source of truth for what --cycles accepts.
 * The pipeline emitter in emit/pipeline.ts uses these same names.
 */

import type { Cycle } from "../reconcile/runner.js";
import { branchProtectionCycle } from "../cycles/branch-protection.js";
import { orgSettingsCycle } from "../cycles/org-settings.js";
import { repoSettingsCycle } from "../cycles/repo-settings.js";
import { membershipCycle } from "../cycles/membership.js";

/**
 * Registry of all available governance cycles, keyed by the name accepted by
 * `--cycles`.
 *
 * To add a new cycle: import it above and add an entry below. The key MUST
 * match `cycle.name` so that --cycles resolution and the run output agree.
 */
export const CYCLE_REGISTRY: Record<string, Cycle> = {
  [branchProtectionCycle.name]: branchProtectionCycle,
  [orgSettingsCycle.name]: orgSettingsCycle,
  [repoSettingsCycle.name]: repoSettingsCycle,
  [membershipCycle.name]: membershipCycle,
};
