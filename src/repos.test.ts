/**
 * `github-warden repos`: the written list reads back through chant's
 * `--forge-repos` parser, and against an org workspace it gives WSP014 for a
 * repository the declaration lacks and WSP015 for one the forge no longer
 * has. The GitHub client is mocked; no network.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseForgeRepos } from "@intentius/chant/workspace/checks/org";
import { runDeclarationChecks } from "@intentius/chant/workspace/checks";
import type { AppClient } from "./auth/app-client.js";
import { forgeRepoList, listAccountRepos, pickOrg } from "./repos.js";
import { parseReposArgs } from "./cli.js";

const WEB = "https://github.com";
const SHA = "0123456789abcdef0123456789abcdef01234567";

type Reply = unknown | (() => unknown);

/** A client answering `METHOD path` from the table; anything else is a 404. */
function makeClient(table: Record<string, Reply>): AppClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request<T>(method: string, path: string): Promise<T> {
      const key = `${method} ${path}`;
      calls.push(key);
      if (!(key in table)) throw new Error(`${method} ${path} returned 404: {"message":"Not Found"}`);
      const r = table[key];
      return (typeof r === "function" ? (r as () => unknown)() : r) as T;
    },
  };
}

const repo = (owner: string, name: string, archived = false) => ({
  name,
  full_name: `${owner}/${name}`,
  html_url: `${WEB}/${owner}/${name}`,
  archived,
  owner: { login: owner },
});

const ORG_PAGE = "GET /orgs/acme/repos?type=all&per_page=100&page=1";

/** acme is an organization with api, web and an archived legacy repo. */
const client = () =>
  makeClient({
    "GET /users/acme": { login: "acme", type: "Organization" },
    [ORG_PAGE]: [repo("acme", "web"), repo("acme", "legacy", true), repo("acme", "api")],
  });

/** What the CLI writes: the document as JSON text. */
const written = async () => `${JSON.stringify(await forgeRepoList(client(), "acme"), null, 2)}\n`;

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** An org workspace whose repo members name these URLs. */
function orgWorkspace(urls: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "gw-repos-"));
  roots.push(root);
  const members = Object.entries(urls).map(([name, url]) => ({ name, kind: "repo", repo: { url, rev: SHA } }));
  writeFileSync(join(root, "chant.workspace.json"), JSON.stringify({ name: "acme", schema: 1, scope: "org", members }));
  return root;
}

async function forgeFindings(root: string, text: string) {
  const report = await runDeclarationChecks(root, (f) => f, { forgeRepos: parseForgeRepos(text, "forge.json") });
  return report.diagnostics.filter((d) => d.ruleId === "WSP014" || d.ruleId === "WSP015");
}

describe("forgeRepoList", () => {
  it("writes { forge, org, repos } sorted by url, archived repos marked", async () => {
    expect(JSON.parse(await written())).toEqual({
      forge: "github",
      org: "acme",
      repos: [
        { url: `${WEB}/acme/api` },
        { url: `${WEB}/acme/legacy`, archived: true },
        { url: `${WEB}/acme/web` },
      ],
    });
  });

  it("reads back through chant's --forge-repos parser", async () => {
    expect(parseForgeRepos(await written(), "forge.json").repos).toEqual([
      { url: `${WEB}/acme/api`, archived: false },
      { url: `${WEB}/acme/legacy`, archived: true },
      { url: `${WEB}/acme/web`, archived: false },
    ]);
  });

  it("passes chant workspace check against an org workspace with the same repos", async () => {
    // Clone URLs in the declaration: chant compares by host, owner and name.
    const root = orgWorkspace({ api: `${WEB}/acme/api.git`, web: "git@github.com:acme/web.git" });
    expect(await forgeFindings(root, await written())).toEqual([]);
  });

  it("gives WSP014 for a repo the declaration lacks and WSP015 for one the forge no longer has", async () => {
    const root = orgWorkspace({ api: `${WEB}/acme/api.git`, gone: `${WEB}/acme/gone.git` });
    const findings = await forgeFindings(root, await written());
    expect(findings.map((d) => d.ruleId).sort()).toEqual(["WSP014", "WSP015"]);
    expect(findings.find((d) => d.ruleId === "WSP014")!.message).toContain(`${WEB}/acme/web`);
    expect(findings.find((d) => d.ruleId === "WSP015")!.entity).toBe("gone");
  });

  it("falls back to https://github.com/<full_name> when the API leaves out html_url", async () => {
    const c = makeClient({
      "GET /users/acme": { type: "Organization" },
      [ORG_PAGE]: [{ name: "api", full_name: "acme/api" }],
    });
    expect((await forgeRepoList(c, "acme")).repos).toEqual([{ url: `${WEB}/acme/api` }]);
  });
});

describe("listAccountRepos, organization", () => {
  it("pages until a short page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => repo("acme", `r${i}`));
    const c = makeClient({
      "GET /users/acme": { type: "Organization" },
      [ORG_PAGE]: page1,
      "GET /orgs/acme/repos?type=all&per_page=100&page=2": [repo("acme", "r100")],
    });
    expect(await listAccountRepos(c, "acme")).toHaveLength(101);
    expect(c.calls).toHaveLength(3);
  });

  it("throws on a 404 instead of reading a missing account as empty", async () => {
    await expect(listAccountRepos(makeClient({}), "ghost")).rejects.toThrow(/no organization or user named ghost/);
  });

  it("passes on other API errors", async () => {
    const c = makeClient({
      "GET /users/acme": { type: "Organization" },
      [ORG_PAGE]: () => {
        throw new Error("GET /orgs/acme/repos returned 500");
      },
    });
    await expect(listAccountRepos(c, "acme")).rejects.toThrow(/500/);
  });
});

describe("listAccountRepos, personal account", () => {
  const user = { "GET /users/alice": { login: "alice", type: "User" } };

  it("lists the installation's repositories owned by the account", async () => {
    const c = makeClient({
      ...user,
      "GET /installation/repositories?per_page=100&page=1": {
        total_count: 3,
        repositories: [repo("alice", "app"), repo("alice", "old", true), repo("bob", "fork")],
      },
    });
    expect(await forgeRepoList(c, "alice")).toEqual({
      forge: "github",
      org: "alice",
      repos: [{ url: `${WEB}/alice/app` }, { url: `${WEB}/alice/old`, archived: true }],
    });
  });

  it("refuses when the installation reaches none of the account's repositories", async () => {
    const c = makeClient({
      ...user,
      "GET /installation/repositories?per_page=100&page=1": { total_count: 1, repositories: [repo("acme", "api")] },
    });
    await expect(listAccountRepos(c, "alice")).rejects.toThrow(/install the App on alice/);
  });

  it("uses the token's own repos when the token is the account's and not an installation token", async () => {
    const c = makeClient({
      ...user,
      "GET /installation/repositories?per_page=100&page=1": () => {
        throw new Error("GET /installation/repositories returned 403: not an installation token");
      },
      "GET /user": { login: "Alice" },
      "GET /user/repos?affiliation=owner&per_page=100&page=1": [repo("alice", "app")],
    });
    expect((await forgeRepoList(c, "alice")).repos).toEqual([{ url: `${WEB}/alice/app` }]);
  });

  it("refuses another user's token", async () => {
    const c = makeClient({
      ...user,
      "GET /installation/repositories?per_page=100&page=1": () => {
        throw new Error("GET /installation/repositories returned 401");
      },
      "GET /user": { login: "bob" },
    });
    await expect(listAccountRepos(c, "alice")).rejects.toThrow(/this token is bob's/);
  });
});

describe("pickOrg", () => {
  it("takes the policy's only org, or the --org the policy governs", () => {
    expect(pickOrg(["acme"], undefined)).toBe("acme");
    expect(pickOrg(["acme", "beta"], "beta")).toBe("beta");
  });
  it("refuses several orgs without --org, an --org the policy lacks, and no orgs", () => {
    expect(() => pickOrg(["acme", "beta"], undefined)).toThrow(/--org/);
    expect(() => pickOrg(["acme"], "other")).toThrow(/not an org the policy governs/);
    expect(() => pickOrg([], undefined)).toThrow(/no org/);
  });
});

describe("parseReposArgs", () => {
  const base = ["--config", "g.yml", "--token-env", "T"];
  it("parses --org and --out, both optional", () => {
    expect(parseReposArgs(base)).toMatchObject({ config: "g.yml", org: undefined, out: undefined, configMode: "fold" });
    expect(parseReposArgs([...base, "--org", "acme", "--out", "repos.json"])).toMatchObject({ org: "acme", out: "repos.json" });
    expect(
      parseReposArgs(["--config", "g.ts", "--app-id-env", "A", "--installation-id-env", "I", "--config-mode", "run"]),
    ).toMatchObject({ appIdEnv: "A", installationIdEnv: "I", configMode: "run" });
  });
  it("leaves config undefined when --config is omitted", () => {
    expect(parseReposArgs(["--token-env", "T"]).config).toBeUndefined();
  });
  it("throws code 2 on missing auth, reconcile flags and empty values", () => {
    const bad = (argv: string[]) => expect(() => parseReposArgs(argv)).toThrow(expect.objectContaining({ code: 2 }));
    bad(["--config", "g.yml"]);
    bad(["--config", "g.yml", "--app-id-env", "A"]);
    bad([...base, "--mode", "apply"]);
    bad([...base, "--cycles", "teams"]);
    bad([...base, "--out"]);
    bad([...base, "--org", ""]);
    bad([...base, "--config-mode", "eval"]);
    bad([...base, "stray"]);
  });
});
