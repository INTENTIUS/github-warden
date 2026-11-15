/**
 * `reconcile --plan-json`: the part a run writes reads back through chant's
 * `readChangeSetPartFile`, names the member and carries the planned change
 * sets, and its entries sit on the same graph nodes as the drift reader's
 * records (chant#5089). The GitHub client is not called: the cycles here
 * return their live state directly.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { parse } from "yaml";
import { composeChangeSet, readChangeSetPartFile } from "@intentius/chant/change-set";
import { graphNodeFor, mapChangeSetToGraph, type ChangeSetGraphNodes } from "@intentius/chant/change-set-graph";
import { readGovernance } from "../graph/reader.js";
import { driftAddress, governanceDrift } from "../drift/reader.js";
import { runReconcile, type Cycle } from "./runner.js";
import { defaultMemberName, planPart, PLAN_PART_LEXICON } from "./plan-part.js";
import type { AppClient } from "../auth/app-client.js";
import type { ChangeSet, LiveOrgState } from "./diff.js";
import type { GovernanceConfig, OrgConfig } from "../config/types.js";

const config: GovernanceConfig = {
  orgs: {
    acme: {
      owned: ["member"],
      members: [
        { login: "ada", role: "admin" },
        { login: "bob", role: "admin" },
      ],
    },
  },
};

const client: AppClient = {
  async request<T>(): Promise<T> {
    throw new Error("the client is not called in these tests");
  },
};

/** Live: ada and carol are admins, so the plan creates bob and deletes carol. */
const membership: Cycle = {
  name: "membership",
  async fetchLive(): Promise<LiveOrgState> {
    return {
      members: [
        { login: "ada", role: "admin" },
        { login: "carol", role: "admin" },
      ],
    };
  },
  buildDesired: (orgConfig: OrgConfig) => ({ members: orgConfig.members }),
  async apply() {},
};

const run = (cycles: Cycle[]) => runReconcile({ config, client, cycles, mode: "dry-run" });

/** What the CLI writes: the part as JSON text, parsed back. */
const roundTrip = (part: unknown): unknown => JSON.parse(`${JSON.stringify(part, null, 2)}\n`);

describe("planPart", () => {
  it("writes a part readChangeSetPartFile accepts, naming the member and carrying the plan", async () => {
    const result = await run([membership]);
    expect(result.changeSets).toHaveLength(1);

    const written = roundTrip(planPart({ member: "governance", changeSets: result.changeSets, errored: result.errored, deferred: result.deferred }));
    const part = readChangeSetPartFile(written, "warden", "governance", PLAN_PART_LEXICON);

    expect(part.member).toMatchObject({ member: "governance", lexicon: "github", planner: "warden", scope: "acme", status: "planned", holes: [] });
    expect(part.member.planDigest).toMatch(/\S/);
    const actions = part.entries.map((e) => [e.action, e.address, e.scope, e.lexicon, e.member]);
    expect(actions).toEqual(
      expect.arrayContaining([
        ["create", "org/acme#member[bob]", "acme", "github", "governance"],
        ["delete", "org/acme#member[carol]", "acme", "github", "governance"],
      ]),
    );
    expect(part.entries).toHaveLength(2);

    // It composes into a change-set document beside other members' parts.
    const doc = composeChangeSet([part]);
    expect(doc.summary.byMember.governance).toMatchObject({ create: 1, delete: 1 });
  });

  it("is deterministic: the same plan gives the same digest", async () => {
    const a = await run([membership]);
    const b = await run([membership]);
    expect(planPart({ member: "m", changeSets: a.changeSets }).member.planDigest).toBe(
      planPart({ member: "m", changeSets: b.changeSets }).member.planDigest,
    );
  });

  it("marks the member failed, with no digest, when a cycle errored", async () => {
    const broken: Cycle = {
      name: "broken",
      async fetchLive() {
        throw new Error("GET returned 500");
      },
      buildDesired: () => ({}),
      async apply() {},
    };
    const result = await run([membership, broken]);
    expect(result.errored).toHaveLength(1);

    const part = readChangeSetPartFile(
      roundTrip(planPart({ member: "governance", changeSets: result.changeSets, errored: result.errored, deferred: result.deferred })),
      "warden",
      "governance",
    );
    expect(part.member.status).toBe("failed");
    expect(part.member.planDigest).toBeNull();
    expect(part.member.error).toMatch(/broken @ acme errored in fetchLive/);
    // What the other cycles planned stays in the part.
    expect(part.entries).toHaveLength(2);
  });

  it("marks the member failed when the request budget deferred a cycle", () => {
    const part = planPart({ member: "governance", changeSets: [], deferred: { skippedCycles: ["teams"], skippedEntries: [] } });
    expect(part.member.status).toBe("failed");
    expect(part.member.error).toBe("teams was deferred by the request budget");
    expect(() => readChangeSetPartFile(roundTrip(part), "warden", "governance", PLAN_PART_LEXICON)).not.toThrow();
  });
});

/** Two orgs, each with a repo named api; acme also has a team. */
const GRAPH_POLICY = `
orgs:
  acme:
    teams:
      core: {}
    repos:
      api: {}
  globex:
    repos:
      api: {}
`;

/** A change of a node itself, changes under nodes, the same-named repo in both orgs, and a delete of a repo the policy does not declare. */
const GRAPH_CHANGES: ChangeSet[] = [
  {
    org: "acme",
    entries: [
      { kind: "update", resourceType: "repo", key: "api", before: { hasWiki: true }, after: { hasWiki: false }, fields: [{ field: "hasWiki", before: true, after: false }] },
      { kind: "create", resourceType: "repo-secret", key: "api/TOKEN", after: { name: "TOKEN" } },
      { kind: "create", resourceType: "team-member", key: "core/ada", after: { role: "member" } },
      { kind: "update", resourceType: "org-settings", key: "org-settings", before: { description: "a" }, after: { description: "b" }, fields: [{ field: "description", before: "a", after: "b" }] },
      { kind: "delete", resourceType: "repo", key: "old", before: { name: "old" } },
    ],
  },
  {
    org: "globex",
    entries: [{ kind: "update", resourceType: "repo", key: "api", before: { hasWiki: true }, after: { hasWiki: false }, fields: [{ field: "hasWiki", before: true, after: false }] }],
  },
];

describe("plan entries on the graph", () => {
  const policy = parse(GRAPH_POLICY) as GovernanceConfig;
  const graph: ChangeSetGraphNodes = { member: "governance", at: null, ids: readGovernance(policy).nodes.map((n) => n.id) };
  const part = readChangeSetPartFile(roundTrip(planPart({ member: "governance", changeSets: GRAPH_CHANGES })), "warden", "governance", PLAN_PART_LEXICON);
  const mapped = mapChangeSetToGraph(composeChangeSet([part]), graph);
  const drift = governanceDrift({ member: "governance", observedAt: "2026-11-15T00:00:00.000Z", policy, changeSets: GRAPH_CHANGES });

  it("gives every entry a distinct address, the org in each", () => {
    const addresses = part.entries.map((e) => e.address);
    expect(new Set(addresses).size).toBe(addresses.length);
    expect(addresses).toEqual(expect.arrayContaining(["repo/acme/api", "repo/globex/api", "repo/acme/api#repo-secret[api/TOKEN]", "team/acme/core#team-member[core/ada]", "org/acme"]));
  });

  it("puts each entry on the node the drift reader's record for that change is on", () => {
    expect(mapped.entries).toHaveLength(6);
    for (const e of mapped.entries) {
      const address = driftAddress(e.scope!, { resourceType: e.type!, key: e.name! });
      const record = drift.records.find((r) => r.address === address);
      expect(record, address).toBeDefined();
      expect(e.node, e.address).toBe(graphNodeFor({ member: "governance", planner: "warden", address: record!.address }, graph).node);
    }
    const nodeOf = (address: string) => mapped.entries.find((e) => e.address === address)?.node;
    expect(nodeOf("repo/acme/api")).toBe("governance/repo/acme/api");
    expect(nodeOf("repo/globex/api")).toBe("governance/repo/globex/api");
    expect(nodeOf("repo/acme/api#repo-secret[api/TOKEN]")).toBe("governance/repo/acme/api");
    expect(nodeOf("team/acme/core#team-member[core/ada]")).toBe("governance/team/acme/core");
    expect(nodeOf("org/acme")).toBe("governance/org/acme");
    // A repo the policy does not declare is on no node, for the plan and the drift record alike.
    expect(nodeOf("repo/acme/old")).toBeNull();
  });
});

describe("defaultMemberName", () => {
  it("is the name of the policy file's directory", () => {
    expect(defaultMemberName("members/governance/governance.yml")).toBe("governance");
    expect(defaultMemberName(join(process.cwd(), "governance.ts"))).toBe(join(process.cwd()).split("/").pop());
  });
  it("is undefined for a policy at the filesystem root", () => {
    expect(defaultMemberName("/governance.yml")).toBeUndefined();
  });
});
