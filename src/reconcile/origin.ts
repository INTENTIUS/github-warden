/**
 * Where a drifted field was written.
 *
 * When a `.ts` policy is folded, `@intentius/tsad-reference` reports, for every
 * leaf of the folded value, which writer produced it (F-Obs-Provenance, spec
 * 2.2): the policy itself (`direct`), a parameter of a project function such
 * as a preset (`composite-parameter`), a literal in that function's body
 * (`composite-literal`), or nothing it can name (`unknown`). This module maps
 * a plan's field change back to its path in the policy, looks that path up,
 * and writes the answer under the field line of the plan, so a drifted field
 * points at the argument or line to edit.
 *
 * A YAML or JSON policy, or a `.ts` policy loaded in `run` mode, has no
 * provenance; the plan is then printed exactly as before.
 */

import type { GovernanceConfig } from "../config/types.js";
import type { ChangeSet } from "./diff.js";

/** A position in the policy source, 1-based. `file` is relative to the working directory. */
export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

/**
 * What produced one field of a folded policy. The same shape as the
 * reference implementation's `FoldFieldOrigin`, restated here so warden's
 * public types do not depend on the evaluator's.
 */
export type FieldOrigin =
  | { kind: "direct" }
  | {
      kind: "composite-parameter";
      composite: string;
      instance?: string;
      parameters: string[];
      call?: SourceLocation;
      arguments?: Record<string, SourceLocation>;
    }
  | {
      kind: "composite-literal";
      composite: string;
      instance?: string;
      call?: SourceLocation;
      literal?: SourceLocation;
    }
  | { kind: "unknown"; reason: string };

/** Every leaf of the policy, by accessor path from the policy root (`orgs["my-org"].repos.api.hasWiki`), to its origin. */
export interface PolicyProvenance {
  paths: Record<string, FieldOrigin>;
}

/** One drifted field and where it was written. `origins` is empty when the fold reported nothing for its path. */
export interface DriftOrigin {
  resourceType: string;
  key: string;
  field: string;
  /** The field's path in the policy, as the provenance writes it. */
  path: string;
  origins: FieldOrigin[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A path segment the way the reference writes it: `.key`, `["key"]`, or `[n]`. */
export function seg(key: string | number): string {
  if (typeof key === "number") return `[${key}]`;
  return IDENT.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

function join(...keys: Array<string | number>): string {
  return keys.map(seg).join("").replace(/^\./, "");
}

/** Split a plan key `<parent>/<child>` at the first slash (repo and team names have none; a branch pattern may). */
function splitKey(key: string): [string, string] {
  const i = key.indexOf("/");
  return i === -1 ? ["", key] : [key.slice(0, i), key.slice(i + 1)];
}

/**
 * The policy path of a field in a plan entry, or undefined when the entry has
 * no field-level counterpart in the policy (token grants and requests, which
 * the diff derives from a rule rather than a declared field). Field names in a
 * change set are already the policy's (the cycles map GitHub's API names onto
 * them when they read live state); list members are found by the key the diff
 * joins on.
 */
export function configPath(
  config: GovernanceConfig,
  org: string,
  resourceType: string,
  key: string,
  field: string,
): string | undefined {
  const oc = config.orgs[org];
  if (!oc) return undefined;
  const index = <T>(list: T[] | undefined, match: (t: T) => boolean): number | undefined => {
    const i = list?.findIndex(match) ?? -1;
    return i === -1 ? undefined : i;
  };
  const inRepo = (list: "branchProtection" | "rulesets" | "environments" | "secrets" | "variables", match: (name: string) => (t: { pattern?: string; name?: string }) => boolean) => {
    const [repo, child] = splitKey(key);
    const items = oc.repos?.[repo]?.[list] as Array<{ pattern?: string; name?: string }> | undefined;
    const i = index(items, match(child));
    return i === undefined ? undefined : join("orgs", org, "repos", repo, list, i, field);
  };
  const byName = (name: string) => (t: { name?: string }) => t.name === name;
  switch (resourceType) {
    case "org-settings":
      return join("orgs", org, "settings", field);
    case "team":
      return join("orgs", org, "teams", key, field);
    case "team-member": {
      const [team, login] = splitKey(key);
      const i = index(oc.teams?.[team]?.members, (m) => m.login === login);
      return i === undefined ? undefined : join("orgs", org, "teams", team, "members", i, field);
    }
    case "team-repo": {
      const [team, repo] = splitKey(key);
      const i = index(oc.teams?.[team]?.repos, (r) => r.name === repo);
      return i === undefined ? undefined : join("orgs", org, "teams", team, "repos", i, field);
    }
    case "member": {
      const i = index(oc.members, (m) => m.login === key);
      return i === undefined ? undefined : join("orgs", org, "members", i, field);
    }
    case "repo":
      return join("orgs", org, "repos", key, field);
    case "branch-protection":
      return inRepo("branchProtection", (pattern) => (b) => b.pattern === pattern);
    case "repo-ruleset":
      return inRepo("rulesets", byName);
    case "environment":
      return inRepo("environments", byName);
    case "repo-variable":
      return inRepo("variables", byName);
    case "org-ruleset": {
      const i = index(oc.rulesets, (r) => r.name === key);
      return i === undefined ? undefined : join("orgs", org, "rulesets", i, field);
    }
    case "org-variable": {
      const i = index(oc.variables, (v) => v.name === key);
      return i === undefined ? undefined : join("orgs", org, "variables", i, field);
    }
    case "repo-security":
      return join("orgs", org, "repos", key, "security", field);
    case "dependabot":
      return join("orgs", org, "repos", key, "dependabot", field);
    default:
      return undefined;
  }
}

/**
 * The origins of the value at `path`. The reference reports leaves only, so a
 * scalar field is an exact hit; a list field such as `topics` is the distinct
 * origins of its elements; a path under a reported leaf takes that leaf's.
 */
export function originAt(prov: PolicyProvenance, path: string): FieldOrigin[] {
  const exact = prov.paths[path];
  if (exact) return [exact];

  const seen = new Set<string>();
  const below: FieldOrigin[] = [];
  for (const [p, o] of Object.entries(prov.paths)) {
    if (p.startsWith(`${path}.`) || p.startsWith(`${path}[`)) {
      const id = JSON.stringify(o);
      if (!seen.has(id)) {
        seen.add(id);
        below.push(o);
      }
    }
  }
  if (below.length > 0) return below;

  // Nearest reported ancestor: strip one trailing segment at a time.
  let at = path;
  for (;;) {
    const m = /(\.[A-Za-z_$][A-Za-z0-9_$]*|\[\d+\]|\["(?:[^"\\]|\\.)*"\])$/.exec(at);
    if (!m || m.index === 0) return [];
    at = at.slice(0, m.index);
    const o = prov.paths[at];
    if (o) return [o];
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const loc = (at: SourceLocation): string => `${at.file}:${at.line}:${at.column}`;

/** One origin as the plan prints it after `<- `. */
export function formatOrigin(o: FieldOrigin): string {
  switch (o.kind) {
    case "direct":
      return "direct";
    case "composite-parameter": {
      const parts = o.parameters.map((p) => {
        const at = o.arguments?.[p];
        if (at) return `argument ${p} at ${loc(at)}`;
        return `parameter ${p} (default applied)${o.call ? `, called at ${loc(o.call)}` : ""}`;
      });
      return `${o.composite}(...) ${parts.join(", ")}`;
    }
    case "composite-literal": {
      const lit = o.literal ? ` at ${loc(o.literal)}` : "";
      const call = o.call ? `, called at ${loc(o.call)}` : "";
      return `${o.composite}(...) sets it in its body${lit}${call}`;
    }
    case "unknown":
      return `unknown (${o.reason})`;
  }
}

/** The text after `<- ` for a field: every distinct origin, or `unknown (not reported)` when the fold named none. */
export function formatOrigins(origins: FieldOrigin[]): string {
  if (origins.length === 0) return "unknown (not reported)";
  return origins.map(formatOrigin).join("; ");
}

/** The origin of every drifted field in a change set, in entry order. Only `update` entries carry field changes. */
export function driftOrigins(
  changeSet: ChangeSet,
  config: GovernanceConfig,
  prov: PolicyProvenance,
): DriftOrigin[] {
  const out: DriftOrigin[] = [];
  for (const e of changeSet.entries) {
    if (e.kind !== "update") continue;
    for (const f of e.fields ?? []) {
      const path = configPath(config, changeSet.org, e.resourceType, e.key, f.field);
      if (path === undefined) continue;
      out.push({ resourceType: e.resourceType, key: e.key, field: f.field, path, origins: originAt(prov, path) });
    }
  }
  return out;
}

/**
 * Write each drifted field's origin under its line in a rendered plan:
 *
 *     [branch-protection] my-repo/main
 *       requiredApprovingReviewCount: 2 → 1
 *         <- reviewPreset(...) argument approvals at examples/governance.ts:31:40
 *
 * The plan is chant's `renderChangeSet` output: an entry line `  [type] key`
 * followed by its field lines `    field: before → after`.
 */
export function annotatePlan(plan: string, drift: DriftOrigin[]): string {
  if (drift.length === 0) return plan;
  const byField = new Map(drift.map((d) => [`${d.resourceType}\0${d.key}\0${d.field}`, d]));
  let entry: string | undefined;
  const out: string[] = [];
  for (const line of plan.split("\n")) {
    out.push(line);
    const head = /^ {2}\[([^\]]+)\] (.+)$/.exec(line);
    if (head) {
      entry = `${head[1]}\0${head[2]}`;
      continue;
    }
    const field = /^ {4}([^\s:]+): /.exec(line);
    if (field && entry !== undefined) {
      const d = byField.get(`${entry}\0${field[1]}`);
      if (d) out.push(`      <- ${formatOrigins(d.origins)}`);
    }
  }
  return out.join("\n");
}
