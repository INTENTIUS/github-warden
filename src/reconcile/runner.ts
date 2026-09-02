/**
 * GitHub reconcile runner.
 *
 * A thin adapter over the provider-agnostic `runReconcile` /  `Cycle` harness in
 * `@intentius/chant/reconcile` (consumed via `./core.js`). It wires warden's
 * GitHub-specific pieces into the shared loop — the `diff` (which injects
 * `nowMs` for time-based diffs), the member-aware `runGuardrails`, and each org
 * in `config.orgs` as a reconcile scope — and re-exports the harness types so
 * the in-repo import surface (`./runner.js`) is unchanged.
 */

import type { AppClient } from "../auth/app-client.js";
import type { GovernanceConfig, OrgConfig } from "../config/types.js";
import { diff } from "./diff.js";
import type { LiveOrgState, DiffOptions } from "./diff.js";
import { runGuardrails } from "./guardrails.js";
import type { GuardrailConfig } from "./guardrails.js";
import { drainNotes } from "../cycles/notes.js";
import { runReconcile as coreRunReconcile } from "./core.js";
import type {
  Cycle as CoreCycle,
  ReconcileResult,
} from "./core.js";

// Re-export the shared harness types/values so existing imports from
// "./runner.js" keep resolving.
export { BudgetExhaustedError } from "./core.js";
export type {
  RateBudget,
  CycleResult,
  CycleError,
  DeferredWork,
  ReconcileResult,
} from "./core.js";

/**
 * A GitHub governance cycle — the shared `Cycle` specialized to warden's types
 * (GitHub `AppClient`, `OrgConfig`, `LiveOrgState`). Cycle implementations are
 * unchanged; this alias just keeps `Cycle<TScope>` working.
 */
export type Cycle<TScope = unknown> = CoreCycle<AppClient, OrgConfig, LiveOrgState, TScope>;

/** Options for warden's `runReconcile` (config-based — same shape as before). */
export interface RunReconcileOptions<TScope = unknown> {
  /** Loaded governance config. */
  config: GovernanceConfig;
  /** Authed GitHub App client. */
  client: AppClient;
  /** Cycles to run; each runs against every org in `config.orgs`. */
  cycles: Cycle<TScope>[];
  /** Scope forwarded to each cycle (filter/cursor); does not vary by org. */
  scope?: TScope;
  /** "dry-run" (default) or "apply". */
  mode?: "dry-run" | "apply";
  /** Member-aware guardrail config. */
  guardrails?: GuardrailConfig;
  /** Diff options (ownership predicate, etc.). */
  diffOptions?: DiffOptions;
  /** Apply even when guardrails trip. Default false. */
  allowGuardrailOverride?: boolean;
  /** Max GitHub API requests for the run. Default 1000. */
  requestBudget?: number;
}

/**
 * Derive an ownership predicate from a scope's `owned` declaration.
 * Absent/`false` → `undefined` (no deletes are planned — the default);
 * `true` → every resource type warden reconciles in the scope is owned;
 * a string[] → only the listed change-set resource types are owned.
 */
function ownedPredicate(
  owned: boolean | string[] | undefined,
): ((resourceType: string, key: string) => boolean) | undefined {
  if (owned === undefined || owned === false) return undefined;
  return (type: string, _key: string) =>
    owned === true || (Array.isArray(owned) && owned.includes(type));
}

/**
 * Run the GitHub governance reconcile loop by delegating to the shared runner
 * with warden's diff (org login as scope id; `nowMs` defaulted for time-based
 * diffs) and member-aware guardrails wired in.
 *
 * Ownership: when the caller supplies `diffOptions.isOwned` it is used
 * unchanged for every scope. Otherwise each org's `owned` declaration from the
 * config derives the per-scope predicate (see `OrgConfig.owned`), so deletes
 * become plannable from a policy file alone. Guardrails (including
 * `removalDeltaCap`) still apply to owned deletes.
 */
export async function runReconcile<TScope = unknown>(
  opts: RunReconcileOptions<TScope>,
): Promise<ReconcileResult> {
  // Clear notes a previous (crashed/errored) run may have left behind.
  drainNotes();

  const result = await coreRunReconcile<AppClient, OrgConfig, LiveOrgState, TScope>({
    client: opts.client,
    scopes: opts.config.orgs,
    cycles: opts.cycles,
    scope: opts.scope,
    mode: opts.mode,
    // The diff stamps `managedCounts` (per-type live denominators for
    // removalDeltaCap) on each change set it returns, so every guardrail
    // evaluation carries its own live counts — no side channel between the
    // diff and guardrail callbacks.
    diff: (scopeId, desired, live, dopts) =>
      diff(scopeId, desired, live, {
        ...dopts,
        isOwned: dopts.isOwned ?? ownedPredicate(opts.config.orgs[scopeId]?.owned),
        nowMs: dopts.nowMs ?? Date.now(),
      }),
    guardrails: (changeSet, live) =>
      runGuardrails(changeSet, live, opts.guardrails ?? {}),
    diffOptions: opts.diffOptions,
    allowGuardrailOverride: opts.allowGuardrailOverride,
    requestBudget: opts.requestBudget,
  });

  // Permission-gated (403) read notes: cycles push them during fetchLive; the
  // shared loop has already rendered each plan (renderChangeSet), so append
  // every note to its cycle×org's plan here. Draining also clears notes whose
  // cycle produced no result (e.g. fetchLive errored later), so nothing leaks
  // into a subsequent run.
  for (const n of drainNotes()) {
    const cr = result.cycles.find((c) => c.name === n.cycle && c.org === n.org);
    if (cr) cr.plan = `${cr.plan}\n${n.note}`;
  }

  return result;
}
