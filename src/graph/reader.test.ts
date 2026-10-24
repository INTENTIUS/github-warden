import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { parse } from "yaml";
import { readGovernance } from "./reader.js";
import read from "./entry.js";

const POLICY = `
orgs:
  acme:
    settings: { defaultRepositoryPermission: read }
    teams:
      backend:
        members: [{ login: alice }]
        repos:
          - { name: api, permission: push }
          - { name: ghost, permission: pull }
      leads:
        parentTeamSlug: backend
    repos:
      api:
        private: true
        branchProtection:
          - { pattern: main, requirePullRequestReviews: true }
        rulesets:
          - name: tags
            target: tag
            bypassActors: [{ actor_id: 7, actor_type: Integration, bypass_mode: always }]
      web: {}
      docs-site: {}
    rulesets:
      - name: org-default
        enforcement: active
        conditions: { repository_name: { include: ["~ALL"], exclude: ["docs-*"] } }
`;

const edge = (g: ReturnType<typeof readGovernance>, from: string, to: string) => g.edges.find((e) => e.from === from && e.to === to);

describe("readGovernance", () => {
  const g = readGovernance(parse(POLICY), "governance.yml");

  test("nodes for the org, repos, teams, rulesets, protection and apps", () => {
    expect(g.nodes.map((n) => n.id).sort()).toEqual([
      "app/acme/7",
      "org/acme",
      "protection/acme/api/main",
      "repo/acme/api",
      "repo/acme/docs-site",
      "repo/acme/web",
      "ruleset/acme/api/tags",
      "ruleset/acme/org-default",
      "team/acme/backend",
      "team/acme/leads",
    ]);
    expect(g.nodes.find((n) => n.id === "repo/acme/api")?.attrs).toMatchObject({ private: true });
    expect(g.groups.byStack.acme).toHaveLength(g.nodes.length);
  });

  test("team access, ruleset reach, protection and bypass edges", () => {
    expect(edge(g, "team/acme/backend", "repo/acme/api")?.viaAttr).toBe("access:push");
    expect(edge(g, "team/acme/leads", "team/acme/backend")?.viaAttr).toBe("parentTeamSlug");
    expect(edge(g, "protection/acme/api/main", "repo/acme/api")).toBeDefined();
    expect(edge(g, "ruleset/acme/api/tags", "repo/acme/api")).toBeDefined();
    expect(edge(g, "app/acme/7", "ruleset/acme/api/tags")?.viaAttr).toBe("bypass:always");
    // The org ruleset reaches every repo its condition names, less the excluded ones.
    expect(edge(g, "ruleset/acme/org-default", "repo/acme/api")).toBeDefined();
    expect(edge(g, "ruleset/acme/org-default", "repo/acme/web")).toBeDefined();
    expect(edge(g, "ruleset/acme/org-default", "repo/acme/docs-site")).toBeUndefined();
  });

  test("a team's repo the policy does not declare is dangling, not a node", () => {
    expect(g.dangling).toEqual([{ from: "team/acme/backend", kind: "ref", path: "repos", value: "ghost" }]);
    expect(g.nodes.some((n) => n.id.endsWith("ghost"))).toBe(false);
  });

  test("every edge ends at a node", () => {
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
  });

  test("a document with no orgs is an empty graph", () => {
    expect(readGovernance(null).nodes).toEqual([]);
  });
});

describe("the reader module", () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-graph-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("reads governance.yml from the member's directory", () => {
    mkdirSync(join(dir, "m"));
    writeFileSync(join(dir, "m", "governance.yml"), POLICY);
    const ir = read({ dir: join(dir, "m"), config: {} });
    expect(ir.nodes.length).toBeGreaterThan(5);
    expect(ir.nodes[0].sourceLoc).toEqual({ file: "governance.yml" });
  });
});
