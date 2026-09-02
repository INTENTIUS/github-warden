/**
 * Plan-note collector for permission-gated (403) reads.
 *
 * Cross-warden principle: a 403 on a declared slice's READ is tolerated — the
 * slice is skipped (treated as "nothing live", so declared entries surface as
 * plan creates) and a NOTE is appended to that cycle's plan. A gated read is
 * never an errored cycle and never exits the run with code 3.
 *
 * Cycles push notes here during `fetchLive` (tagging themselves with cycle
 * name + scope id); the runner drains the collector after the shared reconcile
 * loop finishes and appends each note to the matching cycle result's rendered
 * plan. The collector is module-level per-process state: chant's loop runs
 * strictly sequentially, and the runner drains everything at the end of each
 * run, so notes never leak between runs that are awaited in sequence.
 *
 * The note wording is shared across the wardens (GitLab says "tier-gated" for
 * its tier-limited reads; GitHub says "permission-gated" — same shape):
 *
 *   NOTE: <slice>: read was permission-gated (403); planned entries may fail on apply
 */

/** One pending plan note, tagged with the cycle and scope it belongs to. */
export interface CycleNote {
  /** Cycle name (matches `CycleResult.name`). */
  cycle: string;
  /** Scope id, i.e. the org login (matches `CycleResult.org`). */
  org: string;
  /** The full rendered NOTE line. */
  note: string;
}

const pending: CycleNote[] = [];

/**
 * Record that a declared slice's read came back 403. `slice` names what was
 * being read (e.g. "members", "org-rulesets", "repos/api").
 */
export function notePermissionGated(cycle: string, org: string, slice: string): void {
  pending.push({
    cycle,
    org,
    note: `NOTE: ${slice}: read was permission-gated (403); planned entries may fail on apply`,
  });
}

/** Drain (return and clear) every pending note. Called by the runner per run. */
export function drainNotes(): CycleNote[] {
  return pending.splice(0, pending.length);
}

/**
 * True when the error looks like an HTTP 403 from the GitHub client (the
 * client embeds the status code in the error message; `AppAuthError` also
 * carries `statusCode`).
 */
export function isForbidden(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as { statusCode?: unknown }).statusCode;
  if (status === 403) return true;
  return err.message.includes("403");
}

/**
 * True for an HTTP 404 (absent resource — silently treated as "nothing live",
 * no note).
 */
export function isNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as { statusCode?: unknown }).statusCode;
  if (status === 404) return true;
  return err.message.includes("404");
}
