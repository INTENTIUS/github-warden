/**
 * Provider-agnostic reconcile core.
 *
 * The reusable machinery behind a declarative reconcile loop, with NO knowledge
 * of GitHub (or any specific provider): the change-set model, the generic
 * collection diff (selective-by-omission + ownership-gated deletes), the plan
 * renderer, and the guardrail framework (rename resolution + a removal cap +
 * a pluggable check runner).
 *
 * GitHub-specific resource diffing (`diff()` and the `diffTeams`/`diffMembers`/…
 * functions), the live-state types, and the member-aware guardrails build on
 * top of this in `diff.ts` / `guardrails.ts`. This module is the seam intended
 * to be lifted into a shared `@intentius/chant` reconcile primitive once a
 * second provider's warden exists (see issue #20); until then both layers live
 * here and the app consumes the core via these exports.
 *
 * Pure and deterministic: no I/O, no clock.
 */

// ---------------------------------------------------------------------------
// Change-set model
// ---------------------------------------------------------------------------

/** A single field-level change: what the old value was and what it will become. */
export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

/** The kind of operation this change represents. */
export type ChangeKind = "create" | "update" | "delete";

/** A single entry in the change set. */
export interface ChangeSetEntry {
  kind: ChangeKind;
  /**
   * High-level resource category (e.g. "org-settings", "team", "member",
   * "repo", "team-member", "team-repo", "branch-protection").
   */
  resourceType: string;
  /**
   * Unique key identifying this resource within its type.
   * - For top-level resources: a single name (team slug, member login, …).
   * - For nested resources: "<parent>/<child>" (e.g. "backend/alice").
   */
  key: string;
  /** The live value before the change (absent for creates). */
  before?: unknown;
  /** The desired value after the change (absent for deletes). */
  after?: unknown;
  /** Field-level diff, populated for `update` entries. */
  fields?: FieldChange[];
}

/** The full set of changes to reconcile for one scope (e.g. one org). */
export interface ChangeSet {
  /** Scope identifier this change set applies to (e.g. a GitHub org login). */
  org: string;
  /** All proposed changes, in stable order. */
  entries: ChangeSetEntry[];
}

/** Options controlling diff behaviour. */
export interface DiffOptions {
  /**
   * Ownership predicate for collection entries. The diff only emits a `delete`
   * for a live entry absent from desired when this returns `true`. Omitted →
   * deletes are never emitted ("assume nothing is owned").
   */
  isOwned?: (resourceType: string, key: string) => boolean;

  /**
   * Reference "now" in epoch milliseconds, used by time-based diffs. The runner
   * injects `Date.now()` when unset; tests pass an explicit value.
   */
  nowMs?: number;
}

// ---------------------------------------------------------------------------
// Generic field/value diffing
// ---------------------------------------------------------------------------

/** Deep value equality via JSON for plain data (config/live snapshots). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Diff fields of `desired` against `live`, returning one `FieldChange` per
 * differing field. When `keys` is given, only those keys are compared (and only
 * when present in `desired`); otherwise every key in `desired` is compared.
 * Selective-by-omission: keys absent from `desired` are never compared.
 */
export function diffFields(
  desired: Record<string, unknown>,
  live: Record<string, unknown>,
  keys?: string[],
): FieldChange[] {
  const fields: FieldChange[] = [];
  const compareKeys = keys ?? Object.keys(desired);
  for (const key of compareKeys) {
    if (keys && !Object.prototype.hasOwnProperty.call(desired, key)) continue;
    const dv = desired[key];
    const lv = live[key];
    if (!deepEqual(dv, lv)) fields.push({ field: key, before: lv, after: dv });
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Generic collection diff
// ---------------------------------------------------------------------------

/** Parameters for {@link diffCollection}. */
export interface DiffCollectionParams<D, L> {
  /** Resource type stamped on emitted entries. */
  resourceType: string;
  /** Prefix prepended to each entry key (e.g. "<parent>/"). Default "". */
  keyPrefix?: string;
  /** Desired entries, keyed by logical key. */
  desired: Map<string, D>;
  /** Live entries, keyed by logical key. */
  live: Map<string, L>;
  /** Fields that differ → an update. Return `[]` for "no change". */
  compareFields: (desired: D, live: L) => FieldChange[];
  /** `after` value for a create entry. Defaults to the desired value. */
  createAfter?: (key: string, desired: D) => unknown;
  /** `after` value for an update entry. Defaults to the desired value. */
  updateAfter?: (key: string, desired: D, live: L) => unknown;
  opts: DiffOptions;
  out: ChangeSetEntry[];
}

/**
 * The generic managed-collection diff: creates for desired-not-live, updates
 * when `compareFields` reports differences, and ownership-gated deletes for
 * live-not-desired. This is the selective-by-omission + ownership-gated-delete
 * pattern shared by every keyed-collection diff.
 */
export function diffCollection<D, L>(params: DiffCollectionParams<D, L>): void {
  const {
    resourceType,
    keyPrefix = "",
    desired,
    live,
    compareFields,
    createAfter,
    updateAfter,
    opts,
    out,
  } = params;

  for (const [key, d] of desired) {
    const entryKey = `${keyPrefix}${key}`;
    const l = live.get(key);
    if (l === undefined) {
      out.push({
        kind: "create",
        resourceType,
        key: entryKey,
        after: createAfter ? createAfter(key, d) : d,
      });
      continue;
    }
    const fields = compareFields(d, l);
    if (fields.length > 0) {
      out.push({
        kind: "update",
        resourceType,
        key: entryKey,
        before: l,
        after: updateAfter ? updateAfter(key, d, l) : d,
        fields,
      });
    }
  }

  for (const [key, l] of live) {
    if (desired.has(key)) continue;
    const entryKey = `${keyPrefix}${key}`;
    if (opts.isOwned?.(resourceType, entryKey)) {
      out.push({ kind: "delete", resourceType, key: entryKey, before: l });
    }
  }
}

// ---------------------------------------------------------------------------
// Summary / rendering
// ---------------------------------------------------------------------------

/** Count entries per change kind. */
export function summarizeChangeSet(cs: ChangeSet): Record<ChangeKind, number> {
  const counts: Record<ChangeKind, number> = { create: 0, update: 0, delete: 0 };
  for (const e of cs.entries) counts[e.kind]++;
  return counts;
}

/** Human-readable plan summary for dry-run output. Pure. */
export function renderChangeSet(cs: ChangeSet): string {
  const counts = summarizeChangeSet(cs);
  const header = `Plan for ${cs.org}: ${counts.create} to create, ${counts.update} to update, ${counts.delete} to delete`;

  if (cs.entries.length === 0) return `${header}\nNo changes.`;

  const lines: string[] = [header];
  const byKind: Record<ChangeKind, ChangeSetEntry[]> = { create: [], update: [], delete: [] };
  for (const e of cs.entries) byKind[e.kind].push(e);

  const ORDER: ChangeKind[] = ["create", "update", "delete"];
  for (const kind of ORDER) {
    const group = byKind[kind];
    if (group.length === 0) continue;
    lines.push(`\n${kind.toUpperCase()}:`);
    for (const e of group) {
      lines.push(`  [${e.resourceType}] ${e.key}`);
      for (const f of e.fields ?? []) {
        lines.push(`    ${f.field}: ${fmt(f.before)} → ${fmt(f.after)}`);
      }
    }
  }
  return lines.join("\n");
}

function fmt(v: unknown): string {
  if (v === undefined) return "<unset>";
  if (typeof v === "string") return v.length > 60 ? `${v.slice(0, 57)}...` : v;
  const json = JSON.stringify(v);
  return json.length > 60 ? `${json.slice(0, 57)}...` : json;
}

// ---------------------------------------------------------------------------
// Guardrail framework
// ---------------------------------------------------------------------------

/** A single tripped guardrail with a human-readable message. */
export interface GuardrailDiagnostic {
  /** Short identifier, e.g. "removalDeltaCap". */
  guardrail: string;
  /** Clear, actionable description of why the apply was refused. */
  message: string;
}

/** Aggregated guardrail result. */
export type GuardrailResult = { ok: true } | { ok: false; diagnostics: GuardrailDiagnostic[] };

/** A guardrail check over a (rename-resolved) change set. Returns null when it passes. */
export type GuardrailCheck = (resolved: ChangeSet) => GuardrailDiagnostic | null;

/** Config for `removalDeltaCap`. */
export interface RemovalDeltaCapOptions {
  /** Max fraction of pre-existing entries that may be deleted. Must be in (0,1]. Default 0.25. */
  maxFraction?: number;
}

/**
 * Resolve rename aliases. A create entry carrying a `previously` key matching a
 * delete entry's key is collapsed into an update, removing the delete. Returns a
 * new ChangeSet with renames resolved. Provider-agnostic — works on any entry
 * whose `after.previously` is a string.
 */
export function resolveRenames(changeSet: ChangeSet): ChangeSet {
  const deleteEntries = new Map<string, ChangeSetEntry>();
  for (const e of changeSet.entries) {
    if (e.kind === "delete") deleteEntries.set(e.key, e);
  }

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

  return { org: changeSet.org, entries: [...filteredEntries, ...syntheticUpdates] };
}

/**
 * Refuse if deletes exceed `maxFraction` of the pre-existing managed entries
 * (deletes + updates; creates excluded so a flood of new entries can't dilute
 * the delete fraction). Guards against a typo wiping the config in one apply.
 *
 * CONTRACT: pass a RENAME-RESOLVED change set (see {@link resolveRenames}).
 */
export function removalDeltaCap(
  changeSet: ChangeSet,
  opts: RemovalDeltaCapOptions = {},
): GuardrailDiagnostic | null {
  const maxFraction = opts.maxFraction ?? 0.25;
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
 * Run a set of guardrail checks against a change set. Resolves renames ONCE,
 * then runs every check on the resolved set, aggregating any diagnostics. The
 * caller composes provider-specific checks (e.g. an admin floor) as closures.
 */
export function runGuardrailChecks(changeSet: ChangeSet, checks: GuardrailCheck[]): GuardrailResult {
  const resolved = resolveRenames(changeSet);
  const diagnostics: GuardrailDiagnostic[] = [];
  for (const check of checks) {
    const d = check(resolved);
    if (d) diagnostics.push(d);
  }
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true };
}
