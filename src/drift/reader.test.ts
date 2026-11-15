/**
 * The forge-governance drift reader (INTENTIUS/github-warden#76): what it
 * returns passes chant's drift-reader schema and chant's own check
 * (`checkDriftReaderOutput`, which runs every line through `decodeDriftLine`),
 * reports drift for a policy GitHub does not match and none for one it does,
 * names each record by a graph node id, and never writes. The GitHub client is
 * mocked: listed routes answer, any other list is empty, anything else 404s.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { decodeDriftLine, type DriftLine, type DriftRecordLine, type ReadDriftResult } from "@intentius/chant/drift-record";
import { checkDriftReaderOutput, type DriftReaderInput } from "@intentius/chant/workspace/drift-reader";
import type { AppClient } from "../auth/app-client.js";
import type { GovernanceConfig } from "../config/types.js";
import { readGovernance } from "../graph/reader.js";
import type { Cycle } from "../reconcile/runner.js";
import { driftAuth, readMemberDrift } from "./entry.js";
import { declaredNodes, driftAddress, driftAttributes, governanceDrift, planEntryAddress } from "./reader.js";

const require = createRequire(import.meta.url);
const schemaDir = dirname(require.resolve("@intentius/chant/workspace/drift-reader.schema.json"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, "drift.schema.json"), "utf-8")));
const validate = ajv.compile(JSON.parse(readFileSync(join(schemaDir, "drift-reader.schema.json"), "utf-8")));

const AT = "2026-11-14T12:00:00.000Z";

/** chant's checks, all of them: the schema, then its own reader check, then each line through the codec. */
function expectValid(out: ReadDriftResult): void {
  const wire = JSON.parse(JSON.stringify(out));
  expect(validate(wire), JSON.stringify(validate.errors)).toBe(true);
  expect(checkDriftReaderOutput(wire)).not.toHaveProperty("error");
  if ("lines" in wire) for (const l of wire.lines) expect(() => decodeDriftLine(JSON.stringify(l))).not.toThrow();
}

const lines = (out: ReadDriftResult): DriftLine[] => {
  if (!("lines" in out)) throw new Error(`refused: ${JSON.stringify(out)}`);
  return out.lines;
};
const records = (out: ReadDriftResult) => lines(out).filter((l): l is DriftRecordLine => l.type === "drift-record");
const byAddress = (out: ReadDriftResult) => Object.fromEntries(records(out).map((r) => [r.address, r]));

const POLICY = `
orgs:
  acme:
    owned:
      - member
    members:
      - login: ada
        role: admin
    repos:
      api:
        hasWiki: false
        branchProtection:
          - pattern: main
            allowForcePushes: false
    secrets:
      - name: DEPLOY_KEY
`;
const config = (): GovernanceConfig => parse(POLICY) as GovernanceConfig;

interface MockClient extends AppClient {
  calls: string[];
}

/** GitHub as routes: a listed GET answers, any other list (per_page) is empty, anything else is a 404. Writes throw. */
function github(routes: Record<string, unknown>): MockClient {
  const calls: string[] = [];
  return {
    calls,
    async request<T>(method: string, path: string): Promise<T> {
      calls.push(`${method} ${path}`);
      if (method !== "GET") throw new Error(`the drift reader wrote: ${method} ${path}`);
      if (path in routes) {
        const v = routes[path];
        if (v instanceof Error) throw v;
        return v as T;
      }
      if (path.includes("per_page=")) return [] as T;
      throw Object.assign(new Error(`${method} ${path} returned 404`), { statusCode: 404 });
    },
  };
}

const REPO = "/repos/acme/api";
const ADMINS = "/orgs/acme/members?role=admin&per_page=100&page=1";
const PROTECTION = "/repos/acme/api/branches/main/protection";
const SECRETS = "/orgs/acme/actions/secrets?per_page=100&page=1";

/** GitHub as the policy declares it. */
const matching = (): MockClient =>
  github({
    [REPO]: { name: "api", has_wiki: false },
    [ADMINS]: [{ login: "ada" }],
    [PROTECTION]: { allow_force_pushes: { enabled: false } },
    [SECRETS]: { total_count: 1, secrets: [{ name: "DEPLOY_KEY" }] },
  });

/** GitHub that differs: the wiki is on, carol is an admin and ada is not, force pushes are allowed, the secret is missing. */
const drifted = (): MockClient =>
  github({
    [REPO]: { name: "api", has_wiki: true },
    [ADMINS]: [{ login: "carol" }],
    [PROTECTION]: { allow_force_pushes: { enabled: true } },
    [SECRETS]: { total_count: 0, secrets: [] },
  });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** A member directory holding the given files. */
const member = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "gw-drift-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
};
const input = (dir: string, extra: Partial<DriftReaderInput> = {}): DriftReaderInput => ({ dir, config: { dir, file: "governance.yml" }, member: "governance", observedAt: AT, ...extra });

/** The module chant loads, over a member holding POLICY, with GitHub mocked. */
const read = (client: AppClient, extra: Partial<DriftReaderInput> = {}, deps: { cycles?: Cycle[] } = {}) =>
  readMemberDrift(input(member({ "governance.yml": POLICY }), extra), { env: { GH_TOKEN: "t0ken" }, client: () => client, ...deps });

describe("the drift reader", () => {
  it("reports every declared node in-sync when GitHub matches the policy", async () => {
    const out = await read(matching());
    expectValid(out);
    const ls = lines(out);
    expect(ls[0]).toMatchObject({ type: "drift-start", member: "governance", engine: "warden", read: "live-read", at: AT });
    expect(ls[0]).toMatchObject({ evidence: { tool: "github-warden", version: expect.any(String), command: "reconcile --mode dry-run" } });
    expect((ls[0] as { expected: unknown[] }).expected).toEqual(["org/acme", "repo/acme/api", "protection/acme/api/main"]);
    expect(ls.at(-1)).toMatchObject({ type: "drift-settle" });
    expect(records(out).map((r) => [r.address, r.status, r.node])).toEqual([
      ["org/acme", "in-sync", null],
      ["protection/acme/api/main", "in-sync", null],
      ["repo/acme/api", "in-sync", null],
    ]);
  });

  it("reports drift on the nodes GitHub differs at, each planned change an attribute", async () => {
    const out = await read(drifted());
    expectValid(out);
    const at = byAddress(out);
    expect(Object.values(at).every((r) => r.status === "drifted")).toBe(true);

    expect(at["repo/acme/api"]!.attributes).toEqual([{ path: "repo[#api].hasWiki", before: false, after: true }]);
    expect(at["protection/acme/api/main"]!.attributes).toEqual([{ path: "branch-protection[#api/main].allowForcePushes", before: false, after: true }]);

    const org = at["org/acme"]!.attributes!;
    // An owned delete (carol) and a create (ada) fall under the org node.
    expect(org).toContainEqual({ path: "member[#ada]", before: { login: "ada", role: "admin" } });
    expect(org).toContainEqual({ path: "member[#carol]", after: expect.objectContaining({ login: "carol" }) });
    // A secret keeps its path and loses its values.
    expect(org).toContainEqual({ path: "org-secret[#DEPLOY_KEY]", sensitive: true });
  });

  it("never writes to GitHub", async () => {
    const client = drifted();
    await read(client);
    expect(client.calls.length).toBeGreaterThan(0);
    expect(client.calls.every((c) => c.startsWith("GET "))).toBe(true);
  });

  it("names nodes by the graph reader's ids, so chant places each record on a node", async () => {
    const out = await read(drifted());
    const graph = new Set(readGovernance(config()).nodes.map((n) => n.id));
    for (const r of records(out)) expect(graph.has(r.address), r.address).toBe(true);
  });

  it("marks an org's nodes not-observed when a cycle errors there, and keeps the drift it did find", async () => {
    const client = github({
      [REPO]: { name: "api", has_wiki: true },
      [ADMINS]: Object.assign(new Error("GET members returned 500"), { statusCode: 500 }),
      [PROTECTION]: { allow_force_pushes: { enabled: false } },
      [SECRETS]: { total_count: 1, secrets: [{ name: "DEPLOY_KEY" }] },
    });
    const out = await read(client);
    expectValid(out);
    const at = byAddress(out);
    expect(at["org/acme"]).toMatchObject({ status: "not-observed", unobserved: { reason: "read-failed", detail: expect.stringContaining("membership errored in fetchLive") } });
    expect(at["protection/acme/api/main"]).toMatchObject({ status: "not-observed", unobserved: { reason: "read-failed" } });
    expect(at["repo/acme/api"]).toMatchObject({ status: "drifted", attributesUnobserved: { reason: "read-failed" } });
    expect(records(out).some((r) => r.status === "in-sync")).toBe(false);
  });

  it("marks every node not-observed when the request budget defers a cycle", () => {
    const { start, records: recs } = governanceDrift({
      member: "m",
      observedAt: AT,
      policy: config(),
      changeSets: [{ org: "acme", entries: [{ kind: "update", resourceType: "repo", key: "api", fields: [{ field: "hasWiki", before: true, after: false }] }] }] as never,
      deferred: { skippedCycles: ["teams@acme"], skippedEntries: [] },
    });
    expect(start.expected).toHaveLength(3);
    for (const r of recs) expect(r).toMatchObject({ status: "not-observed", unobserved: { reason: "not-reached", detail: "deferred by the request budget: teams@acme" } });
  });

  it("reads one declared node alone with --resource, reconciling its org only", async () => {
    const out = await read(drifted(), { resource: "repo/acme/api" });
    expectValid(out);
    expect(lines(out)[0]).toMatchObject({ resource: "repo/acme/api", expected: ["repo/acme/api"] });
    expect(records(out).map((r) => [r.address, r.status])).toEqual([["repo/acme/api", "drifted"]]);
  });

  it("refuses a --resource the policy does not declare", async () => {
    const out = await read(matching(), { resource: "repo/acme/nope" });
    expectValid(out);
    expect(out).toMatchObject({ refused: { code: "no-drift-read" } });
  });

  it("reads the policy with the token from GH_TOKEN and the default API base", async () => {
    const dir = member({ "governance.yml": POLICY });
    let seen: unknown;
    const out = await readMemberDrift(input(dir), { env: { GH_TOKEN: "t0ken" }, client: (auth) => ((seen = auth), drifted()) });
    expectValid(out);
    expect(seen).toEqual({ token: "t0ken", baseUrl: "https://api.github.com" });
    expect(records(out).filter((r) => r.status === "drifted")).toHaveLength(3);
  });

  it("refuses no-drift-read without a token, without calling GitHub", async () => {
    const dir = member({ "governance.yml": POLICY });
    const client = matching();
    const out = await readMemberDrift(input(dir), { env: { GH_TOKEN: " " }, client: () => client });
    expectValid(out);
    expect(out).toMatchObject({ refused: { code: "no-drift-read", message: expect.stringContaining("GH_TOKEN is not set") } });
    expect(client.calls).toEqual([]);
  });

  it("refuses no-drift-read for a member with no policy", async () => {
    const out = await readMemberDrift(input(member({})), { env: { GH_TOKEN: "t" }, client: () => matching() });
    expectValid(out);
    expect(out).toMatchObject({ refused: { code: "no-drift-read" } });
  });

  it("refuses reads other than live-read, and stacks", async () => {
    for (const extra of [{ read: "plan" as const }, { stack: "prod" }]) {
      const out = await read(matching(), extra);
      expectValid(out);
      expect(out).toMatchObject({ refused: { code: "read-unsupported" } });
    }
  });

  it("throws for a policy that does not load, which chant reports as a failed read", async () => {
    const dir = member({ "governance.yml": "orgs:\n  - 1\n" });
    await expect(readMemberDrift(input(dir), { env: { GH_TOKEN: "t" }, client: () => matching() })).rejects.toThrow();
  });
});

describe("addresses and attributes", () => {
  it("declares the org, repos, teams, rulesets and branch protection rules, not apps", () => {
    const c = {
      orgs: {
        acme: {
          teams: { core: {} },
          repos: { api: { rulesets: [{ name: "r1", bypassActors: [{ actor_type: "Integration", actor_id: 7 }] }], branchProtection: [{ pattern: "release/*" }] } },
          rulesets: [{ name: "org-r" }],
        },
      },
    } as unknown as GovernanceConfig;
    expect(declaredNodes(c)).toEqual({
      acme: ["org/acme", "repo/acme/api", "team/acme/core", "ruleset/acme/api/r1", "protection/acme/api/release/*", "ruleset/acme/org-r"],
    });
    const graph = readGovernance(c).nodes.map((n) => n.id);
    expect(graph.filter((id) => !id.startsWith("app/")).sort()).toEqual([...declaredNodes(c).acme!].sort());
  });

  it("is the graph reader's node id each planned change falls under", () => {
    const at = (resourceType: string, key: string) => driftAddress("acme", { resourceType, key });
    expect(at("org-settings", "org-settings")).toBe("org/acme");
    expect(at("member", "ada")).toBe("org/acme");
    expect(at("token-grant", "17")).toBe("org/acme");
    expect(at("repo", "api")).toBe("repo/acme/api");
    expect(at("repo-security", "api")).toBe("repo/acme/api");
    expect(at("dependabot", "api")).toBe("repo/acme/api");
    expect(at("environment", "api/prod")).toBe("repo/acme/api");
    expect(at("repo-variable", "api/REGION")).toBe("repo/acme/api");
    expect(at("team", "core")).toBe("team/acme/core");
    expect(at("team-member", "core/ada")).toBe("team/acme/core");
    expect(at("team-repo", "core/api")).toBe("team/acme/core");
    expect(at("org-ruleset", "base")).toBe("ruleset/acme/base");
    expect(at("repo-ruleset", "api/r1")).toBe("ruleset/acme/api/r1");
    expect(at("branch-protection", "api/release/*")).toBe("protection/acme/api/release/*");
  });

  it("gives a plan entry its node id for the node's own type, and <node id>#<type>[<key>] for a change under the node", () => {
    const at = (resourceType: string, key: string, org = "acme") => planEntryAddress(org, { resourceType, key });
    // One type per node kind is the node's own.
    expect(at("org-settings", "org-settings")).toBe("org/acme");
    expect(at("repo", "api")).toBe("repo/acme/api");
    expect(at("team", "core")).toBe("team/acme/core");
    expect(at("org-ruleset", "base")).toBe("ruleset/acme/base");
    expect(at("repo-ruleset", "api/r1")).toBe("ruleset/acme/api/r1");
    expect(at("branch-protection", "api/release/*")).toBe("protection/acme/api/release/*");
    // Everything else sits under the node it falls on.
    expect(at("member", "ada")).toBe("org/acme#member[ada]");
    expect(at("org-secret", "NPM")).toBe("org/acme#org-secret[NPM]");
    expect(at("token-grant", "17")).toBe("org/acme#token-grant[17]");
    expect(at("repo-baseline", "api")).toBe("repo/acme/api#repo-baseline[api]");
    expect(at("repo-security", "api")).toBe("repo/acme/api#repo-security[api]");
    expect(at("dependabot", "api")).toBe("repo/acme/api#dependabot[api]");
    expect(at("environment", "api/prod")).toBe("repo/acme/api#environment[api/prod]");
    expect(at("repo-secret", "api/TOKEN")).toBe("repo/acme/api#repo-secret[api/TOKEN]");
    expect(at("team-member", "core/ada")).toBe("team/acme/core#team-member[core/ada]");
    expect(at("team-repo", "core/api")).toBe("team/acme/core#team-repo[core/api]");
    // The part before the first `#` is always the drift reader's node.
    for (const [t, k] of [["member", "ada"], ["repo-secret", "api/TOKEN"], ["team-repo", "core/api"], ["repo", "api"]] as const) {
      expect(at(t, k).split("#")[0]).toBe(driftAddress("acme", { resourceType: t, key: k }));
    }
    // The org is in the address, so two orgs' same-named repos differ.
    expect(at("repo", "api", "acme")).not.toBe(at("repo", "api", "globex"));
    expect(at("repo-secret", "api/TOKEN", "acme")).not.toBe(at("repo-secret", "api/TOKEN", "globex"));
  });

  it("an update gives one attribute per field, declared before and live after; a create the declared value, a delete the live one", () => {
    expect(driftAttributes({ kind: "update", resourceType: "repo", key: "api", fields: [{ field: "hasWiki", before: true, after: false }] } as never)).toEqual([
      { path: "repo[#api].hasWiki", before: false, after: true },
    ]);
    expect(driftAttributes({ kind: "update", resourceType: "org-settings", key: "org-settings", fields: [{ field: "description", before: "a", after: "b" }] } as never)).toEqual([
      { path: "org-settings.description", before: "b", after: "a" },
    ]);
    expect(driftAttributes({ kind: "create", resourceType: "team", key: "core", after: { privacy: "closed" } } as never)).toEqual([{ path: "team[#core]", before: { privacy: "closed" } }]);
    expect(driftAttributes({ kind: "delete", resourceType: "team", key: "old", before: { slug: "old" } } as never)).toEqual([{ path: "team[#old]", after: { slug: "old" } }]);
    expect(driftAttributes({ kind: "create", resourceType: "repo-secret", key: "api/TOKEN", after: { name: "TOKEN" } } as never)).toEqual([{ path: "repo-secret[#api/TOKEN]", sensitive: true }]);
  });

  it("a change under a node the policy does not declare is a record of its own", () => {
    const { records: recs } = governanceDrift({
      member: "m",
      observedAt: AT,
      policy: config(),
      changeSets: [{ org: "acme", entries: [{ kind: "delete", resourceType: "repo", key: "legacy", before: { name: "legacy" } }] }] as never,
    });
    expect(recs.map((r) => [r.address, r.status])).toEqual([
      ["org/acme", "in-sync"],
      ["repo/acme/api", "in-sync"],
      ["protection/acme/api/main", "in-sync"],
      ["repo/acme/legacy", "drifted"],
    ]);
  });
});

describe("driftAuth", () => {
  it("takes the token variable and API base the config names", () => {
    expect(driftAuth({ tokenEnv: "ORG_TOKEN", baseUrlEnv: "GHES_API" }, { ORG_TOKEN: "x", GHES_API: "https://ghe.example.com/api/v3" })).toEqual({ token: "x", baseUrl: "https://ghe.example.com/api/v3" });
    expect(driftAuth({}, { GH_TOKEN: "x", GITHUB_API_URL: "https://ghe.example.com/api/v3" })).toEqual({ token: "x", baseUrl: "https://ghe.example.com/api/v3" });
  });

  it("falls back to App auth when the config names its variables", () => {
    const cfg = { appIdEnv: "APP_ID", installationIdEnv: "INSTALL_ID" };
    expect(driftAuth(cfg, { APP_ID: "1", INSTALL_ID: "2", GOVERNANCE_APP_PRIVATE_KEY: "pem" })).toEqual({ appId: "1", installationId: "2", privateKeyPem: "pem", baseUrl: "https://api.github.com" });
    expect(driftAuth(cfg, { APP_ID: "1" })).toEqual({ missing: expect.stringContaining("INSTALL_ID, GOVERNANCE_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY are not set") });
  });

  it("reads App auth from the GOVERNANCE_* variables by default, since a workspace cannot set drift.config", () => {
    expect(driftAuth({}, { GOVERNANCE_APP_ID: "1", GOVERNANCE_INSTALLATION_ID: "2", GITHUB_APP_PRIVATE_KEY: "pem" })).toEqual({ appId: "1", installationId: "2", privateKeyPem: "pem", baseUrl: "https://api.github.com" });
    expect(driftAuth({}, {})).toEqual({ missing: "GH_TOKEN is not set, and for App auth GOVERNANCE_APP_ID, GOVERNANCE_INSTALLATION_ID, GOVERNANCE_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY are not set" });
  });
});
