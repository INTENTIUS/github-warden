/**
 * Governance reconcile runner.
 *
 * Ties the primitives together into one reconcile run:
 *   load config → fetch live → diff → guardrails → dry-run or apply
 *
 * Dry-run is the default. In dry-run mode, no mutations are performed; the
 * computed ChangeSet is returned with a rendered summary. In apply mode, each
 * ChangeSet entry is forwarded to the cycle's `apply` handler, but only when
 * all guardrails pass (or `allowGuardrailOverride` is set).
 *
 * Rate budgeting: every API call (fetchLive + each apply) decrements a shared
 * request counter. When the counter hits zero the run stops cleanly and
 * records deferred cycles in the result. No silent truncation.
 */

import type { AppClient } from "../auth/app-client.js";
import type { GovernanceConfig, OrgConfig } from "../config/types.js";
import { diff, renderChangeSet } from "./diff.js";
import type { ChangeSet, ChangeSetEntry, LiveOrgState, DiffOptions } from "./diff.js";
import { runGuardrails } from "./guardrails.js";
import type { GuardrailConfig, GuardrailResult } from "./guardrails.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A governance cycle: knows how to fetch live state for one resource domain
 * (e.g. branch protection), build desired state from config, and apply a
 * single ChangeSet entry back to GitHub.
 *
 * Concrete cycle implementations live in separate modules (#455 onwards).
 * The runner is agnostic to what a cycle manages — it only drives the loop.
 *
 * ## Multi-org scope
 *
 * The runner iterates over every org in `config.orgs` and calls each method
 * once per org, passing the current `orgLogin` explicitly. Cycles MUST use
 * `orgLogin` (not `scope.org` or any org name embedded in `scope`) when
 * constructing GitHub API URLs. This ensures a config with two orgs applies
 * each org's rules to the correct org, not to whatever name appeared in the
 * caller-supplied `scope`.
 *
 * `scope` carries caller-supplied context that does NOT vary by org iteration —
 * e.g. a repo filter list or a pagination cursor. Org-varying data is passed
 * via `orgLogin`.
 */
export interface Cycle<TScope = unknown> {
  /** Human-readable name, e.g. "branch-protection". Used in run output. */
  name: string;

  /**
   * Fetch the live state for the given org + scope.
   *
   * `orgLogin` is the current org being iterated. Use it (not `scope`) for
   * any org-derived GitHub API path.
   *
   * Each GitHub API page call made inside this method MUST count against the
   * shared rate budget: call `budget.use(n)` (where `n` is the number of
   * requests consumed) and check `budget.exhausted` before paginating further.
   * When the budget is exhausted mid-fetch a cycle may either return the
   * partial state it has gathered or throw `BudgetExhaustedError`; either way
   * the runner records the cycle as deferred so nothing is silently truncated.
   */
  fetchLive(client: AppClient, orgLogin: string, scope: TScope, budget: RateBudget): Promise<LiveOrgState>;

  /**
   * Build the desired state from the governance config + scope.
   * Pure — must not perform any I/O.
   *
   * `orgLogin` is the current org being iterated.
   */
  buildDesired(config: OrgConfig, orgLogin: string, scope: TScope): OrgConfig;

  /**
   * Apply a single ChangeSet entry to GitHub.
   *
   * `orgLogin` is the current org being iterated. Use it (not `scope`) for
   * any org-derived GitHub API path.
   *
   * Called once per entry when mode is "apply" and guardrails pass.
   * Each network call made inside `apply` MUST count against the budget via
   * `budget.use(n)`.
   */
  apply(
    client: AppClient,
    entry: ChangeSetEntry,
    orgLogin: string,
    scope: TScope,
    budget: RateBudget,
  ): Promise<void>;
}

/** Controls how a Cycle tracks its API usage against the shared budget. */
export interface RateBudget {
  /** Remaining request capacity for this run. */
  readonly remaining: number;
  /** True once `remaining` has reached zero. */
  readonly exhausted: boolean;
  /**
   * Decrement the budget by `n` (default: 1).
   * Throws `BudgetExhaustedError` if the budget has already been exhausted.
   */
  use(n?: number): void;
}

/** Thrown when a cycle or apply step attempts to use an exhausted budget. */
export class BudgetExhaustedError extends Error {
  constructor(message = "rate budget exhausted") {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

/** Per-cycle outcome recorded in the run result. */
export interface CycleResult {
  /** Cycle name. */
  name: string;
  /** Org this result is for. */
  org: string;
  /** Number of entries per change kind in the ChangeSet. */
  counts: { create: number; update: number; delete: number };
  /** Guardrail outcome. */
  guardrails: GuardrailResult;
  /** Entries successfully applied (only populated in apply mode). */
  applied: ChangeSetEntry[];
  /** Entries that failed to apply with their error. */
  failed: Array<{ entry: ChangeSetEntry; error: string }>;
  /** Human-readable plan summary (always present). */
  plan: string;
  /** Whether this cycle was skipped because guardrails tripped and override was not set. */
  guardrailBlocked: boolean;
}

/**
 * A cycle that could not run because `fetchLive` or `buildDesired` threw a
 * non-budget error. Recorded per-cycle so the run can continue rather than
 * rejecting the whole `runReconcile` call.
 */
export interface CycleError {
  /** Cycle name. */
  name: string;
  /** Org this error is for. */
  org: string;
  /** The stage at which the cycle failed. */
  stage: "fetchLive" | "buildDesired";
  /** Error message. */
  error: string;
}

/** Summary of work that could not be completed due to rate budget exhaustion. */
export interface DeferredWork {
  /**
   * Cycles (by name) that were never started because the budget was exhausted
   * before they could run.
   */
  skippedCycles: string[];
  /**
   * In apply mode: entries that were not applied because the budget was
   * exhausted mid-cycle.
   */
  skippedEntries: Array<{ cycleName: string; entry: ChangeSetEntry }>;
}

/** Structured result from a single `runReconcile` call. */
export interface ReconcileResult {
  /** Run mode used. */
  mode: "dry-run" | "apply";
  /**
   * Whether the full run completed cleanly (false when budget was exhausted
   * early or any cycle errored).
   */
  completed: boolean;
  /** Per-cycle outcomes (only for cycles that were started). */
  cycles: CycleResult[];
  /**
   * Cycles that errored during `fetchLive`/`buildDesired` with a non-budget
   * error. The run continues past these; they are not silently dropped.
   */
  errored: CycleError[];
  /** Work deferred due to budget exhaustion (empty when `completed` is true). */
  deferred: DeferredWork;
  /** Remaining budget at the end of the run. */
  budgetRemaining: number;
}

/** Options for `runReconcile`. */
export interface RunReconcileOptions<TScope = unknown> {
  /**
   * Loaded governance config.
   */
  config: GovernanceConfig;

  /**
   * Authed GitHub App client (created by `createAppClient`).
   */
  client: AppClient;

  /**
   * Cycles to run. Each cycle is run against every org in `config.orgs`.
   */
  cycles: Cycle<TScope>[];

  /**
   * Scope forwarded to each cycle's `fetchLive`, `buildDesired`, and `apply`.
   * Typically an org-level filter or pagination cursor.
   * Defaults to `undefined` when omitted.
   */
  scope?: TScope;

  /**
   * Run mode. Defaults to "dry-run".
   * - "dry-run": compute + report the change set, mutate nothing.
   * - "apply": apply each entry after guardrails pass.
   */
  mode?: "dry-run" | "apply";

  /**
   * Guardrail configuration forwarded to `runGuardrails`.
   */
  guardrails?: GuardrailConfig;

  /**
   * Diff options forwarded to `diff()` (ownership predicate, etc.).
   */
  diffOptions?: DiffOptions;

  /**
   * When true, apply proceeds even when guardrails have tripped.
   * Use with caution — bypasses all safety checks.
   * Defaults to false.
   */
  allowGuardrailOverride?: boolean;

  /**
   * Maximum number of GitHub API requests for this run (across all cycles).
   *
   * GitHub App installations are subject to a per-installation rate ceiling.
   * The runner stops cleanly when the budget is exhausted and records deferred
   * work in the result so callers can resume or alert. No silent truncation.
   *
   * Defaults to 1000 (a conservative floor well under typical ceilings).
   */
  requestBudget?: number;
}

// ---------------------------------------------------------------------------
// RateBudget implementation
// ---------------------------------------------------------------------------

class MutableRateBudget implements RateBudget {
  private _remaining: number;

  constructor(initial: number) {
    this._remaining = initial;
  }

  get remaining(): number {
    return this._remaining;
  }

  get exhausted(): boolean {
    return this._remaining <= 0;
  }

  use(n = 1): void {
    if (this.exhausted) {
      throw new BudgetExhaustedError();
    }
    this._remaining = Math.max(0, this._remaining - n);
  }
}

// ---------------------------------------------------------------------------
// runReconcile
// ---------------------------------------------------------------------------

/**
 * Run the governance reconcile loop.
 *
 * For each org in `config.orgs` and each cycle in `cycles`:
 *   1. `fetchLive` — fetch live state from GitHub (counts against budget).
 *   2. `buildDesired` — build desired state from config (pure).
 *   3. `diff()` — compute the ChangeSet.
 *   4. `runGuardrails()` — check safety rules.
 *   5a. dry-run: render the plan, return without mutating.
 *   5b. apply: call `cycle.apply` for each entry (if guardrails pass or override).
 *
 * Returns a structured `ReconcileResult` with per-cycle outcomes and any
 * deferred work.
 */
export async function runReconcile<TScope = unknown>(
  opts: RunReconcileOptions<TScope>,
): Promise<ReconcileResult> {
  const {
    config,
    client,
    cycles,
    scope,
    mode = "dry-run",
    guardrails: guardrailConfig = {},
    diffOptions = {},
    allowGuardrailOverride = false,
    requestBudget = 1000,
  } = opts;

  const budget = new MutableRateBudget(requestBudget);
  const cycleResults: CycleResult[] = [];
  const erroredCycles: CycleError[] = [];
  const deferred: DeferredWork = { skippedCycles: [], skippedEntries: [] };

  const orgs = Object.entries(config.orgs);

  for (const cycle of cycles) {
    for (const [orgLogin, orgConfig] of orgs) {
      // Stop entirely if budget is exhausted before we start a new cycle.
      if (budget.exhausted) {
        deferred.skippedCycles.push(`${cycle.name}@${orgLogin}`);
        continue;
      }

      // Step 1: fetchLive — the cycle itself tracks budget usage internally.
      // We wrap in a try/catch so a BudgetExhaustedError mid-fetch is recorded
      // as a deferred skip rather than a hard crash.
      // orgLogin is passed explicitly so multi-org configs target the right org.
      let live: LiveOrgState;
      try {
        live = await cycle.fetchLive(client, orgLogin, scope as TScope, budget);
      } catch (err) {
        if (err instanceof BudgetExhaustedError) {
          deferred.skippedCycles.push(`${cycle.name}@${orgLogin}`);
          continue;
        }
        // Any other error: record this cycle as errored and move on so the
        // run isn't abandoned and remaining cycles/orgs still execute.
        erroredCycles.push({
          name: cycle.name,
          org: orgLogin,
          stage: "fetchLive",
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      // Step 2: buildDesired (pure).
      let desired: OrgConfig;
      try {
        desired = cycle.buildDesired(orgConfig, orgLogin, scope as TScope);
      } catch (err) {
        erroredCycles.push({
          name: cycle.name,
          org: orgLogin,
          stage: "buildDesired",
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      // Step 3: diff.
      const changeSet: ChangeSet = diff(orgLogin, desired, live, diffOptions);

      // Step 4: guardrails.
      const guardrailResult = runGuardrails(changeSet, live, guardrailConfig);

      // Counts.
      const counts = { create: 0, update: 0, delete: 0 };
      for (const e of changeSet.entries) counts[e.kind]++;

      // Plan summary.
      const plan = renderChangeSet(changeSet);

      const cycleResult: CycleResult = {
        name: cycle.name,
        org: orgLogin,
        counts,
        guardrails: guardrailResult,
        applied: [],
        failed: [],
        plan,
        guardrailBlocked: false,
      };

      // Step 5a: dry-run — nothing more to do.
      if (mode === "dry-run") {
        cycleResults.push(cycleResult);
        continue;
      }

      // Step 5b: apply.

      // If guardrails failed and override is not set, block the apply.
      if (!guardrailResult.ok && !allowGuardrailOverride) {
        cycleResult.guardrailBlocked = true;
        cycleResults.push(cycleResult);
        continue;
      }

      // Apply each entry.
      for (const entry of changeSet.entries) {
        if (budget.exhausted) {
          deferred.skippedEntries.push({ cycleName: cycle.name, entry });
          continue;
        }

        try {
          await cycle.apply(client, entry, orgLogin, scope as TScope, budget);
          cycleResult.applied.push(entry);
        } catch (err) {
          if (err instanceof BudgetExhaustedError) {
            deferred.skippedEntries.push({ cycleName: cycle.name, entry });
            continue;
          }
          cycleResult.failed.push({
            entry,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      cycleResults.push(cycleResult);
    }
  }

  const completed =
    deferred.skippedCycles.length === 0 &&
    deferred.skippedEntries.length === 0 &&
    erroredCycles.length === 0;

  return {
    mode,
    completed,
    cycles: cycleResults,
    errored: erroredCycles,
    deferred,
    budgetRemaining: budget.remaining,
  };
}
