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
 * Run the GitHub governance reconcile loop by delegating to the shared runner
 * with warden's diff (org login as scope id; `nowMs` defaulted for time-based
 * diffs) and member-aware guardrails wired in.
 */
export async function runReconcile<TScope = unknown>(
  opts: RunReconcileOptions<TScope>,
): Promise<ReconcileResult> {
  return coreRunReconcile<AppClient, OrgConfig, LiveOrgState, TScope>({
    client: opts.client,
    scopes: opts.config.orgs,
    cycles: opts.cycles,
    scope: opts.scope,
    mode: opts.mode,
    diff: (scopeId, desired, live, dopts) =>
      diff(scopeId, desired, live, { ...dopts, nowMs: dopts.nowMs ?? Date.now() }),
    guardrails: (changeSet, live) => runGuardrails(changeSet, live, opts.guardrails ?? {}),
    diffOptions: opts.diffOptions,
    allowGuardrailOverride: opts.allowGuardrailOverride,
    requestBudget: opts.requestBudget,
  });
}
