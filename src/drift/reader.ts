/**
 * The drift reader for a forge-governance member (INTENTIUS/chant#5068,
 * INTENTIUS/github-warden#76).
 *
 * `chant workspace drift --member <name>` imports `dist/drift-reader.mjs`
 * (`./entry.ts`) for a member of the `forge-governance` kind and calls it
 * with the member's directory. The reader loads the member's policy, runs
 * every registered cycle in dry-run against GitHub, and answers with drift
 * stream lines: a start naming every node the policy declares, one record per
 * node, and a settle. It never applies anything.
 *
 * A record is one graph node (chant places a `warden` record by its address,
 * and keys records by member, address and read, so the address is the graph
 * reader's node id): `in-sync` when no planned change falls under it,
 * `drifted` when some do, each planned change one attribute. A change under a
 * node the policy does not declare (an owned delete of an undeclared repo or
 * team) is a record of its own.
 *
 * `reconcile --drift-issue` builds its records with {@link governanceDrift}
 * too, so the drift issue and `chant workspace drift` report the same thing.
 */

import {
  driftRecord,
  driftRecordLine,
  driftSettle,
  driftStart,
  type DriftAttribute,
  type DriftEvidence,
  type DriftLine,
  type DriftRecord,
  type DriftStartLine,
  type DriftUnobserved,
} from "@intentius/chant/drift-record";
import type { CycleError, DeferredWork } from "@intentius/chant/reconcile";
import type { GovernanceConfig } from "../config/types.js";
import type { ChangeSet, ChangeSetEntry } from "../reconcile/diff.js";
import { wardenVersion } from "../version.js";

/** The engine a warden's records name. */
export const DRIFT_ENGINE = "warden" as const;
/** The read a warden answers: its own read of the forge, compared with the policy. */
export const DRIFT_READ = "live-read" as const;

/** What every record and the start line say produced them. */
export function driftEvidence(): DriftEvidence {
  return { tool: "github-warden", version: wardenVersion(), command: "reconcile --mode dry-run" };
}

/** The first segment of a child entry's key, which names its parent (`core/alice` is team `core`'s, `api/main` repo `api`'s). */
const parentOf = (key: string): string => key.split("/")[0]!;

/**
 * The graph node a planned change falls under: the graph reader's id
 * (`../graph/reader.ts`) for the org, a repo, a team, a ruleset or a branch
 * protection rule. Org-level collections and token grants go on the org, a
 * team's members and repos on the team, a repo's security settings,
 * dependabot file, environments, secrets and variables on the repo.
 */
export function driftAddress(org: string, entry: Pick<ChangeSetEntry, "resourceType" | "key">): string {
  switch (entry.resourceType) {
    case "org-settings":
    case "member":
    case "org-secret":
    case "org-variable":
    case "token-grant":
    case "token-request":
      return `org/${org}`;
    case "team":
      return `team/${org}/${entry.key}`;
    case "team-member":
    case "team-repo":
      return `team/${org}/${parentOf(entry.key)}`;
    case "repo":
    case "repo-baseline":
    case "repo-security":
    case "dependabot":
      return `repo/${org}/${entry.key}`;
    case "environment":
    case "repo-secret":
    case "repo-variable":
      return `repo/${org}/${parentOf(entry.key)}`;
    case "org-ruleset":
    case "repo-ruleset":
      // An org ruleset's key is its name, a repo ruleset's `<repo>/<name>`.
      return `ruleset/${org}/${entry.key}`;
    case "branch-protection":
      return `protection/${org}/${entry.key}`;
    default:
      return `${entry.resourceType}/${org}/${entry.key}`;
  }
}

/**
 * The resource types that are a graph node's own: a change of one of these
 * changes the node itself, so its plan address is the bare node id. One per
 * node kind (two for rulesets, which an org or a repo can own).
 */
const NODE_OWN_TYPES = new Set(["org-settings", "team", "repo", "org-ruleset", "repo-ruleset", "branch-protection"]);

/**
 * A planned change's address in a `--plan-json` part (INTENTIUS/chant#5089):
 * the node id {@link driftAddress} gives when the change is of the node's own
 * type (`repo/acme/api` for a `repo` entry), and
 * `<node id>#<resourceType>[<key>]` for a change under the node
 * (`repo/acme/api#repo-secret[api/TOKEN]`). chant places a `warden` entry on
 * the address, then on the part before the first `#`, so plan entries land on
 * the same nodes as the drift records. The node id carries the org, so two
 * orgs with a same-named repo give distinct addresses.
 */
export function planEntryAddress(org: string, entry: Pick<ChangeSetEntry, "resourceType" | "key">): string {
  const node = driftAddress(org, entry);
  return NODE_OWN_TYPES.has(entry.resourceType) ? node : `${node}#${entry.resourceType}[${entry.key}]`;
}

/**
 * Resource types whose values could hold a secret: their attributes carry
 * none. github-warden diffs secrets by name only; Actions variables are not
 * secret by GitHub's own definition and keep their values.
 */
const SENSITIVE_TYPES = new Set(["org-secret", "repo-secret"]);

/** Single-object slices: their attribute path is the type alone. */
const SINGLE_TYPES = new Set(["org-settings"]);

/**
 * A planned change as attributes, in the drift record's direction (`before`
 * the declared value, `after` the live one): an update gives one per field
 * (`repo[#api].hasWiki`), a create its declared value, a delete its live one.
 */
export function driftAttributes(entry: ChangeSetEntry): DriftAttribute[] {
  const base = SINGLE_TYPES.has(entry.resourceType) ? entry.resourceType : `${entry.resourceType}[#${entry.key}]`;
  const sensitive = SENSITIVE_TYPES.has(entry.resourceType);
  const attr = (path: string, before: unknown, after: unknown): DriftAttribute =>
    sensitive
      ? { path, sensitive: true }
      : { path, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) };
  if (entry.kind === "update" && entry.fields?.length) return entry.fields.map((f) => attr(`${base}.${f.field}`, f.after, f.before));
  if (entry.kind === "delete") return [attr(base, undefined, entry.before)];
  return [attr(base, entry.after, undefined)];
}

/**
 * The nodes the policy declares, by org: the graph reader's ids for the org,
 * its repos, teams, rulesets and branch protection rules, in its order. The
 * graph's app nodes (GitHub Apps named as ruleset bypass actors) are left
 * out: no cycle reads an app, so the read could not say one is in sync.
 */
export function declaredNodes(policy: GovernanceConfig): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [org, oc] of Object.entries(policy.orgs ?? {})) {
    const ids = new Set<string>([`org/${org}`]);
    const repos = oc?.repos ?? {};
    for (const name of Object.keys(repos)) ids.add(`repo/${org}/${name}`);
    for (const slug of Object.keys(oc?.teams ?? {})) ids.add(`team/${org}/${slug}`);
    for (const [name, repo] of Object.entries(repos)) {
      for (const rs of repo?.rulesets ?? []) if (typeof rs?.name === "string") ids.add(`ruleset/${org}/${name}/${rs.name}`);
      for (const bp of repo?.branchProtection ?? []) if (typeof bp?.pattern === "string") ids.add(`protection/${org}/${name}/${bp.pattern}`);
    }
    for (const rs of oc?.rulesets ?? []) if (typeof rs?.name === "string") ids.add(`ruleset/${org}/${rs.name}`);
    out[org] = [...ids];
  }
  return out;
}

export interface GovernanceDriftInput {
  member: string;
  /** RFC 3339, given to every record. */
  observedAt: string;
  /** The policy the run reconciled, for the nodes it declares. */
  policy: GovernanceConfig;
  /** Every change set the run diffed, one per cycle and org. */
  changeSets: readonly ChangeSet[];
  /** Cycles that failed before they could plan. */
  errored?: readonly CycleError[];
  /** Cycles the request budget skipped. */
  deferred?: DeferredWork;
  /** One node to read alone (`--resource`); its record is the only one. */
  resource?: string;
}

/**
 * The read as a start line and its records: every declared node in-sync,
 * drifted (each planned change under it an attribute) or not-observed (a
 * cycle errored in its org, or the budget deferred one).
 */
export function governanceDrift(input: GovernanceDriftInput): { start: DriftStartLine; records: DriftRecord[] } {
  const evidence = driftEvidence();
  const base = { member: input.member, engine: DRIFT_ENGINE, node: null, observedAt: input.observedAt, read: DRIFT_READ, evidence };
  const byOrg = declaredNodes(input.policy);
  const declared = Object.values(byOrg).flat();
  const orgOf = new Map(Object.entries(byOrg).flatMap(([org, ids]) => ids.map((id) => [id, org] as const)));

  const attributes = new Map<string, DriftAttribute[]>();
  for (const cs of input.changeSets) {
    for (const entry of cs.entries) {
      const address = driftAddress(cs.org, entry);
      if (!orgOf.has(address)) orgOf.set(address, cs.org);
      attributes.set(address, [...(attributes.get(address) ?? []), ...driftAttributes(entry)]);
    }
  }

  const failedIn = new Map<string, string[]>();
  for (const e of input.errored ?? []) failedIn.set(e.org, [...(failedIn.get(e.org) ?? []), `${e.name} errored in ${e.stage}: ${e.error}`]);
  const deferred = input.deferred?.skippedCycles ?? [];
  const deferredWhy: DriftUnobserved | undefined = deferred.length
    ? { reason: "not-reached", detail: `deferred by the request budget: ${deferred.join(", ")}` }
    : undefined;

  const addresses = [...new Set([...declared, ...attributes.keys()])].filter((a) => input.resource === undefined || a === input.resource);
  const records = addresses.map((address) => {
    const attrs = attributes.get(address);
    const failed = failedIn.get(orgOf.get(address) ?? "");
    const unobserved: DriftUnobserved | undefined = deferredWhy ?? (failed ? { reason: "read-failed", detail: failed.join("; ") } : undefined);
    if (unobserved && (deferredWhy || !attrs)) return driftRecord({ ...base, address, status: "not-observed", unobserved });
    if (attrs) return driftRecord({ ...base, address, status: "drifted", attributes: attrs, ...(unobserved ? { attributesUnobserved: unobserved } : {}) });
    return driftRecord({ ...base, address, status: "in-sync" });
  });

  const start = driftStart({
    member: input.member,
    engine: DRIFT_ENGINE,
    read: DRIFT_READ,
    ...(input.resource !== undefined ? { resource: input.resource } : {}),
    at: input.observedAt,
    expected: input.resource !== undefined ? [input.resource] : declared,
    evidence,
  });
  return { start, records };
}

/** The stream for one read: start, the records, settle. */
export function driftLines(start: DriftStartLine, records: readonly DriftRecord[], at: string): DriftLine[] {
  const settled = driftSettle(start, records, at);
  return [start, ...settled.records.map(driftRecordLine), settled.line];
}
