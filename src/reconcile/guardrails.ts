/**
 * Reconcile guardrails.
 *
 * Pure functions that inspect a computed ChangeSet and reject dangerous applies
 * before any mutation. Run between diff and apply; if any trips, the apply is
 * refused with a structured result.
 *
 * None of these functions throw. Every check returns structured diagnostics.
 *
 * ## Rename-without-loss
 * A member or resource may carry a `previously` alias field in the desired
 * config. When a delete+create pair is found where the created entry's
 * `previously` matches the deleted entry's key, the pair is treated as a
 * rename (update) rather than a mass-deletion signal.
 *
 * ## Configurable thresholds (defaults)
 * - `removalDeltaCap.maxFraction` — 0.25 (25 % of managed entries)
 * - `adminFloor.min`              — 2 (at least 2 admins must remain)
 */

import type { ChangeSet, ChangeSetEntry, LiveMemberConfig, LiveOrgState } from "./diff.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single tripped guardrail with a human-readable message. */
export interface GuardrailDiagnostic {
  /** Short identifier for the guardrail, e.g. "removalDeltaCap". */
  guardrail: string;
  /** Clear, actionable description of why the apply was refused. */
  message: string;
}

/** Aggregated result from `runGuardrails`. */
export type GuardrailResult =
  | { ok: true }
  | { ok: false; diagnostics: GuardrailDiagnostic[] };

/** Config for `removalDeltaCap`. */
export interface RemovalDeltaCapOptions {
  /**
   * Maximum fraction of managed entries that may be deleted in a single apply.
   * Must be in (0, 1]. Default: 0.25.
   */
  maxFraction?: number;
}

/** Config for `adminFloor`. */
export interface AdminFloorOptions {
  /**
   * Minimum number of org admins that must remain after the apply.
   * Default: 2.
   */
  min?: number;
}

/** Config for `requiredAdmins`. */
export interface RequiredAdminsOptions {
  /**
   * Logins that must remain as admins after the apply.
   */
  logins: string[];
}

/** Config for `requireSelf`. */
export interface RequireSelfOptions {
  /**
   * Login of the managing identity. The apply is refused if this user would
   * lose org membership or admin role.
   */
  selfLogin: string;
}

/** Full guardrail config passed to `runGuardrails`. */
export interface GuardrailConfig {
  removalDeltaCap?: RemovalDeltaCapOptions;
  adminFloor?: AdminFloorOptions;
  requiredAdmins?: RequiredAdminsOptions;
  requireSelf?: RequireSelfOptions;
}

// ---------------------------------------------------------------------------
// Rename-without-loss helper
// ---------------------------------------------------------------------------

/**
 * Resolve rename aliases before running guardrails.
 *
 * Desired config entries may include a `previously` field indicating a former
 * key. When the ChangeSet contains a delete whose key matches `previously` on
 * a create entry, the pair is collapsed into an update and removed from the
 * effective delete list.
 *
 * Returns a new ChangeSet with renames resolved as updates.
 */
export function resolveRenames(changeSet: ChangeSet): ChangeSet {
  // Build a map of delete keys
  const deleteEntries = new Map<string, ChangeSetEntry>();
  for (const e of changeSet.entries) {
    if (e.kind === "delete") deleteEntries.set(e.key, e);
  }

  // Find creates that carry a `previously` alias
  const resolvedDeletes = new Set<string>();
  const resolvedCreates = new Set<string>();
  const syntheticUpdates: ChangeSetEntry[] = [];

  for (const e of changeSet.entries) {
    if (e.kind !== "create") continue;
    const after = e.after as Record<string, unknown> | undefined;
    if (!after) continue;
    const previously = after["previously"];
    if (typeof previously !== "string") continue;

    const deleted = deleteEntries.get(previously);
    if (!deleted) continue;

    // Collapse delete(previously) + create(key) → update
    resolvedDeletes.add(previously);
    resolvedCreates.add(e.key);
    syntheticUpdates.push({
      kind: "update",
      resourceType: e.resourceType,
      key: e.key,
      before: deleted.before,
      after: e.after,
      fields: [{ field: "key", before: previously, after: e.key }],
    });
  }

  if (resolvedDeletes.size === 0) return changeSet;

  const filteredEntries = changeSet.entries.filter(
    (e) =>
      !(e.kind === "delete" && resolvedDeletes.has(e.key)) &&
      !(e.kind === "create" && resolvedCreates.has(e.key)),
  );

  return {
    org: changeSet.org,
    entries: [...filteredEntries, ...syntheticUpdates],
  };
}

// ---------------------------------------------------------------------------
// Individual guardrails
// ---------------------------------------------------------------------------

/**
 * Refuse if deletes exceed `maxFraction` of the pre-existing managed entries.
 *
 * The denominator is the count of pre-existing entries (deletes + updates),
 * deliberately EXCLUDING creates. Including creates would let a flood of new
 * entries dilute the delete fraction (e.g. 5 deletes + 100 creates ≈ 4.7%,
 * which would sneak under a 25% cap and defeat a mass-deletion typo). Measuring
 * deletes against only what already exists keeps the cap meaningful.
 *
 * This guards against a typo wiping the entire config in one apply.
 *
 * Default `maxFraction`: 0.25 (25 %).
 *
 * CONTRACT: `changeSet` must be RENAME-RESOLVED before passing to this
 * function. `runGuardrails` calls `resolveRenames` once and passes the result
 * here. Callers that invoke `removalDeltaCap` standalone MUST call
 * `resolveRenames(changeSet)` first so that a delete+create rename pair is not
 * counted as a deletion.
 */
export function removalDeltaCap(
  changeSet: ChangeSet,
  opts: RemovalDeltaCapOptions = {},
): GuardrailDiagnostic | null {
  const maxFraction = opts.maxFraction ?? 0.25;

  // Pre-existing entries only (deletes + updates); creates excluded. If nothing
  // pre-exists, no deletes are possible → pass (also avoids divide-by-zero/NaN).
  const total = changeSet.entries.filter((e) => e.kind !== "create").length;
  if (total === 0) return null;

  const deletes = changeSet.entries.filter((e) => e.kind === "delete").length;
  const fraction = deletes / total;

  if (fraction > maxFraction) {
    return {
      guardrail: "removalDeltaCap",
      message:
        `${deletes} of ${total} managed entries (${Math.round(fraction * 100)}%) would be deleted, ` +
        `exceeding the ${Math.round(maxFraction * 100)}% threshold. ` +
        `Check for typos in config or raise maxFraction to proceed.`,
    };
  }

  return null;
}

/**
 * Refuse if the apply would leave fewer than `min` org admins.
 *
 * Computes the post-apply admin count from the live snapshot and the ChangeSet.
 *
 * Default `min`: 2.
 */
export function adminFloor(
  changeSet: ChangeSet,
  live: LiveOrgState,
  opts: AdminFloorOptions = {},
): GuardrailDiagnostic | null {
  const min = opts.min ?? 2;
  const liveMembers = live.members ?? [];

  // Build effective post-apply admin set
  const postApplyAdmins = computePostApplyAdmins(changeSet, liveMembers);
  const count = postApplyAdmins.size;

  if (count < min) {
    return {
      guardrail: "adminFloor",
      message:
        `Apply would leave ${count} org admin(s), below the required minimum of ${min}. ` +
        `Ensure at least ${min} admin(s) remain in the desired config.`,
    };
  }

  return null;
}

/**
 * Refuse if any of the required admin logins would be removed or demoted.
 */
export function requiredAdmins(
  changeSet: ChangeSet,
  live: LiveOrgState,
  opts: RequiredAdminsOptions,
): GuardrailDiagnostic | null {
  if (opts.logins.length === 0) return null;

  const liveMembers = live.members ?? [];
  const postApplyAdmins = computePostApplyAdmins(changeSet, liveMembers);

  const missing = opts.logins.filter((login) => !postApplyAdmins.has(login));

  if (missing.length > 0) {
    return {
      guardrail: "requiredAdmins",
      message:
        `The following required admin(s) would be removed or demoted: ${missing.join(", ")}. ` +
        `These logins must remain as org admins after the apply.`,
    };
  }

  return null;
}

/**
 * Refuse if the managing identity (`selfLogin`) would lose org access.
 *
 * Trips when the ChangeSet would delete or demote the self login from any org
 * member role. The managing bot must not lock itself out.
 */
export function requireSelf(
  changeSet: ChangeSet,
  live: LiveOrgState,
  opts: RequireSelfOptions,
): GuardrailDiagnostic | null {
  const { selfLogin } = opts;
  const liveMembers = live.members ?? [];

  // Compute post-apply membership (any role) for selfLogin
  const liveByLogin = new Map(liveMembers.map((m) => [m.login, m]));
  let role: string | null = liveByLogin.get(selfLogin)?.role ?? null;

  for (const e of changeSet.entries) {
    if (e.resourceType !== "member" || e.key !== selfLogin) continue;
    if (e.kind === "delete") {
      role = null;
    } else if (e.kind === "create" || e.kind === "update") {
      const after = e.after as { role?: string } | undefined;
      role = after?.role ?? role;
    }
  }

  if (role === null) {
    return {
      guardrail: "requireSelf",
      message:
        `The managing identity "${selfLogin}" would be removed from the org. ` +
        `Self-lockout is not allowed. Add "${selfLogin}" back to the desired config.`,
    };
  }

  // Stricter than membership alone: also refuse if self would be demoted out of
  // admin. The managing bot must keep admin access, not merely org membership.
  if (role !== "admin") {
    return {
      guardrail: "requireSelf",
      message:
        `The managing identity "${selfLogin}" would be demoted from admin to "${role}". ` +
        `Self-lockout is not allowed. Keep "${selfLogin}" as an org admin in the desired config.`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Aggregate runner
// ---------------------------------------------------------------------------

/**
 * Run all configured guardrails against the ChangeSet and live snapshot.
 *
 * Returns `{ ok: true }` when no guardrail trips, or
 * `{ ok: false, diagnostics }` with every tripped guardrail's message.
 *
 * Rename aliases are resolved ONCE here before any check runs. All individual
 * guardrail functions (`removalDeltaCap`, `adminFloor`, etc.) receive the
 * pre-resolved ChangeSet and MUST NOT call `resolveRenames` themselves.
 * This guarantees a single traversal and a consistent view of renames across
 * all checks — a rename is collapsed to an update exactly once.
 */
export function runGuardrails(
  changeSet: ChangeSet,
  live: LiveOrgState,
  config: GuardrailConfig = {},
): GuardrailResult {
  // Resolve renames once; all checks receive the pre-resolved set.
  const resolved = resolveRenames(changeSet);

  const diagnostics: GuardrailDiagnostic[] = [];

  const cap = removalDeltaCap(resolved, config.removalDeltaCap);
  if (cap) diagnostics.push(cap);

  const floor = adminFloor(resolved, live, config.adminFloor);
  if (floor) diagnostics.push(floor);

  if (config.requiredAdmins) {
    const req = requiredAdmins(resolved, live, config.requiredAdmins);
    if (req) diagnostics.push(req);
  }

  if (config.requireSelf) {
    const self = requireSelf(resolved, live, config.requireSelf);
    if (self) diagnostics.push(self);
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute the set of admin logins that would exist after applying the ChangeSet.
 */
function computePostApplyAdmins(
  changeSet: ChangeSet,
  liveMembers: LiveMemberConfig[],
): Set<string> {
  const liveAdmins = new Map<string, string>(
    liveMembers.filter((m) => m.role === "admin").map((m) => [m.login, m.role]),
  );

  const result = new Set(liveAdmins.keys());

  for (const e of changeSet.entries) {
    if (e.resourceType !== "member") continue;

    if (e.kind === "delete") {
      result.delete(e.key);
    } else if (e.kind === "create" || e.kind === "update") {
      const after = e.after as { login?: string; role?: string } | undefined;
      const login = after?.login ?? e.key;

      // A rename is collapsed into an update whose resulting login differs from
      // the prior login (carried in `before`/`key`). Drop the prior login so a
      // renamed-away admin no longer counts as surviving — otherwise the ghost
      // would keep adminFloor/requiredAdmins fail-open.
      if (e.kind === "update") {
        const before = e.before as { login?: string } | undefined;
        const priorLogin = before?.login ?? e.key;
        if (priorLogin !== login) result.delete(priorLogin);
      }

      if (after?.role === "admin") {
        result.add(login);
      } else {
        // create/update to member role → not an admin
        result.delete(login);
      }
    }
  }

  return result;
}
