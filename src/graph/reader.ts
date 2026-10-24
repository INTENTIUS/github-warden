/**
 * The graph reader for a forge-governance member (INTENTIUS/chant#4413,
 * #3180): the governance YAML as graph IR. It reads the document and nothing
 * else, so it takes no GitHub call and writes nothing, and it draws the policy
 * as declared. A node is an org, a repo, a team, a ruleset, a branch
 * protection rule or an app (a GitHub App named as a ruleset bypass actor).
 * An edge is a team's access to a repo, a ruleset's reach over a repo, a rule's
 * repo, an app's bypass of a ruleset, or a team under its parent.
 */

type Obj = Record<string, unknown>;

export interface IRNode {
  id: string;
  kind: string;
  lexicon: string;
  attrs: Record<string, unknown>;
  sourceLoc?: { file: string };
}
export interface IREdge {
  from: string;
  to: string;
  kind: "ref";
  viaAttr?: string;
}
export interface IRDangling {
  from: string;
  kind: "ref";
  path: string;
  value: string;
}
export interface GraphIR {
  nodes: IRNode[];
  edges: IREdge[];
  groups: { byLexicon: Record<string, string[]>; byStack: Record<string, string[]> };
  dangling?: IRDangling[];
}

const LEXICON = "github-warden";

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const objs = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The attributes of `from` that are set, so a node carries what the policy states and no more. */
function pick(from: Obj, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (from[k] !== undefined) out[k] = from[k];
  return out;
}

/** A GitHub repository-name pattern (`*` matches any run), or `~ALL`, against a repo name. */
function matches(pattern: string, name: string): boolean {
  if (pattern === "~ALL") return true;
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return re.test(name);
}

export function readGovernance(doc: unknown, file?: string): GraphIR {
  const nodes: IRNode[] = [];
  const edges: IREdge[] = [];
  const dangling: IRDangling[] = [];
  const byStack: Record<string, string[]> = {};
  const sourceLoc = file ? { sourceLoc: { file } } : {};

  const orgs = isObj(doc) && isObj(doc.orgs) ? doc.orgs : {};
  for (const [orgName, rawOrg] of Object.entries(orgs)) {
    const org = isObj(rawOrg) ? rawOrg : {};
    const stack: string[] = (byStack[orgName] = []);
    const add = (id: string, kind: string, attrs: Record<string, unknown>) => {
      if (nodes.some((n) => n.id === id)) return;
      nodes.push({ id, kind, lexicon: LEXICON, attrs, ...sourceLoc });
      stack.push(id);
    };
    const orgId = `org/${orgName}`;
    add(orgId, "Org", { name: orgName, ...(isObj(org.settings) ? { settings: org.settings } : {}) });

    const repos = isObj(org.repos) ? org.repos : {};
    const repoNames = Object.keys(repos);
    const repoId = (name: string) => `repo/${orgName}/${name}`;
    for (const name of repoNames) {
      const repo = isObj(repos[name]) ? (repos[name] as Obj) : {};
      add(repoId(name), "Repo", { name, org: orgName, ...pick(repo, ["private", "defaultBranch", "topics", "hasWiki", "deleteBranchOnMerge"]) });
    }

    // Teams: access to repos, and the parent team.
    const teams = isObj(org.teams) ? org.teams : {};
    for (const [slug, rawTeam] of Object.entries(teams)) {
      const team = isObj(rawTeam) ? rawTeam : {};
      const id = `team/${orgName}/${slug}`;
      add(id, "Team", { name: slug, org: orgName, ...pick(team, ["description", "privacy"]), memberCount: objs(team.members).length });
    }
    for (const [slug, rawTeam] of Object.entries(teams)) {
      const team = isObj(rawTeam) ? rawTeam : {};
      const id = `team/${orgName}/${slug}`;
      for (const r of objs(team.repos)) {
        if (typeof r.name !== "string") continue;
        if (repoNames.includes(r.name)) edges.push({ from: id, to: repoId(r.name), kind: "ref", viaAttr: `access:${String(r.permission ?? "pull")}` });
        else dangling.push({ from: id, kind: "ref", path: "repos", value: r.name });
      }
      if (typeof team.parentTeamSlug === "string") {
        if (team.parentTeamSlug in teams) edges.push({ from: id, to: `team/${orgName}/${team.parentTeamSlug}`, kind: "ref", viaAttr: "parentTeamSlug" });
        else dangling.push({ from: id, kind: "ref", path: "parentTeamSlug", value: team.parentTeamSlug });
      }
    }

    // Rulesets: a repo's own, and the org's, which reach the repos their conditions name.
    const ruleset = (scope: string, rs: Obj): string | undefined => {
      if (typeof rs.name !== "string") return undefined;
      const id = `ruleset/${scope}/${rs.name}`;
      add(id, "Ruleset", { name: rs.name, scope, ...pick(rs, ["target", "enforcement"]), ruleCount: objs(rs.rules).length });
      // A GitHub App that may bypass the ruleset is an app of the org.
      for (const actor of objs(rs.bypassActors)) {
        if (actor.actor_type !== "Integration" || actor.actor_id === undefined) continue;
        const appId = `app/${orgName}/${String(actor.actor_id)}`;
        add(appId, "App", { appId: actor.actor_id, org: orgName });
        edges.push({ from: appId, to: id, kind: "ref", viaAttr: `bypass:${String(actor.bypass_mode ?? "always")}` });
      }
      return id;
    };
    for (const name of repoNames) {
      const repo = isObj(repos[name]) ? (repos[name] as Obj) : {};
      for (const rs of objs(repo.rulesets)) {
        const id = ruleset(`${orgName}/${name}`, rs);
        if (id) edges.push({ from: id, to: repoId(name), kind: "ref", viaAttr: "ruleset" });
      }
      for (const bp of objs(repo.branchProtection)) {
        if (typeof bp.pattern !== "string") continue;
        const id = `protection/${orgName}/${name}/${bp.pattern}`;
        add(id, "BranchProtection", {
          pattern: bp.pattern,
          ...pick(bp, ["requirePullRequestReviews", "requiredApprovingReviewCount", "requireStatusChecks", "requireCodeOwnerReviews", "allowForcePushes", "allowDeletions"]),
        });
        edges.push({ from: id, to: repoId(name), kind: "ref", viaAttr: "branchProtection" });
      }
    }
    for (const rs of objs(org.rulesets)) {
      const id = ruleset(orgName, rs);
      if (!id) continue;
      const cond = isObj(rs.conditions) && isObj(rs.conditions.repository_name) ? rs.conditions.repository_name : undefined;
      const include = strs(cond?.include);
      const exclude = strs(cond?.exclude);
      const reached = repoNames.filter((n) => include.some((p) => matches(p, n)) && !exclude.some((p) => matches(p, n)));
      const node = nodes.find((n) => n.id === id)!;
      node.attrs.repoConditions = include.length ? "repository_name" : "none";
      for (const n of reached) edges.push({ from: id, to: repoId(n), kind: "ref", viaAttr: "ruleset" });
    }
  }

  const ids = nodes.map((n) => n.id);
  return {
    nodes,
    edges,
    groups: { byLexicon: { [LEXICON]: ids }, byStack },
    ...(dangling.length ? { dangling } : {}),
  };
}
