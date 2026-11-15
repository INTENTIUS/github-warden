/**
 * `github-warden repos`: the account's repository list in the format
 * `chant workspace check --forge-repos <file>` reads (chant#3168).
 *
 * chant never asks the forge itself. An org workspace (`scope: "org"`) holds
 * one `repo` member per repository, and chant compares those members with
 * this list: a repository the forge lists that no member names is WSP014, a
 * member naming one the forge no longer lists is WSP015. Archived
 * repositories are listed with `archived: true`; chant does not ask for them
 * to be declared, and a member naming one is not a drop.
 *
 * The policy's `orgs` keys are GitHub logins, and a login can be an
 * organization or a personal account (POLICY.md, "Repos owned by a personal
 * account"). An organization is listed with `GET /orgs/{org}/repos?type=all`.
 * A personal account has no endpoint that lists its private repositories for
 * an arbitrary credential, so its list comes from the repositories the App
 * installation can reach (`GET /installation/repositories`), or, for a token
 * that is not an installation token, from `GET /user/repos?affiliation=owner`
 * when the token belongs to that account. Anything else is an error: a
 * partial list would read as members dropped.
 *
 * The output shape is shared by the three wardens (chant#5069); only the
 * `forge` value differs.
 */

import type { AppClient } from "./auth/app-client.js";

/** The `forge` value github-warden writes. */
export const FORGE = "github";

/** Web host for the fallback URL when the API leaves out `html_url`. */
const WEB_BASE = "https://github.com";

/** One repository, as `--forge-repos` reads it. `archived` is present only when true. */
export interface ForgeRepoEntry {
  url: string;
  archived?: true;
}

/** The document `repos` writes. `org` is the login as the policy declares it. */
export interface ForgeRepoListFile {
  forge: typeof FORGE;
  org: string;
  repos: ForgeRepoEntry[];
}

/** The fields of GitHub's repository object the list reads. */
interface GitHubRepo {
  name: string;
  full_name?: string;
  html_url?: string;
  archived?: boolean;
  owner?: { login?: string };
}

const PER_PAGE = 100;

/** Whether an error from the client is an HTTP status in `codes`. Both clients put "returned <status>" in the message. */
function isStatus(err: unknown, codes: number[]): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return codes.some((c) => msg.includes(`returned ${c}`));
}

/** Every page of a list endpoint; `pick` takes the array out of a page. */
async function allPages<T>(client: AppClient, path: string, pick: (page: unknown) => T[] | undefined): Promise<T[]> {
  const out: T[] = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let page = 1; ; page++) {
    const chunk = pick(await client.request<unknown>("GET", `${path}${sep}per_page=${PER_PAGE}&page=${page}`));
    if (!Array.isArray(chunk)) throw new Error(`GET ${path} did not return a list`);
    out.push(...chunk);
    if (chunk.length < PER_PAGE) return out;
  }
}

const asList = (page: unknown) => (Array.isArray(page) ? (page as GitHubRepo[]) : undefined);
const sameLogin = (a: string | undefined, b: string) => a !== undefined && a.toLowerCase() === b.toLowerCase();

/**
 * Every repository of `login`, archived ones included. `GET /users/{login}`
 * says whether the login is an organization or a personal account; a 404
 * there is an error, never an empty list, since chant would read an empty
 * list as every member dropped.
 */
export async function listAccountRepos(client: AppClient, login: string): Promise<GitHubRepo[]> {
  const enc = encodeURIComponent(login);
  let account: { type?: string };
  try {
    account = await client.request<{ type?: string }>("GET", `/users/${enc}`);
  } catch (err) {
    if (isStatus(err, [404])) throw new Error(`GitHub has no organization or user named ${login} (GET /users/${login} returned 404)`);
    throw err;
  }
  if (account.type !== "User") {
    return allPages(client, `/orgs/${enc}/repos?type=all`, asList);
  }
  return listUserRepos(client, login);
}

/**
 * A personal account's repositories: the ones an App installation on the
 * account can reach, else, for a token that is not an installation token,
 * the ones the token's own user owns when that user is `login`.
 */
async function listUserRepos(client: AppClient, login: string): Promise<GitHubRepo[]> {
  let reachable: GitHubRepo[] | undefined;
  try {
    reachable = await allPages(client, "/installation/repositories", (p) =>
      (p as { repositories?: GitHubRepo[] } | undefined)?.repositories,
    );
  } catch (err) {
    // 401/403: not an installation token. Try the token's own user.
    if (!isStatus(err, [401, 403])) throw err;
  }
  if (reachable !== undefined) {
    const own = reachable.filter((r) => sameLogin(r.owner?.login, login));
    if (own.length === 0) {
      throw new Error(
        `${login} is a personal account and the App installation reaches none of its repositories; install the App on ${login}`,
      );
    }
    return own;
  }
  const me = await client.request<{ login?: string }>("GET", "/user");
  if (!sameLogin(me.login, login)) {
    throw new Error(
      `${login} is a personal account; list it with an App installation on ${login} or ${login}'s own token (this token is ${me.login ?? "unknown"}'s)`,
    );
  }
  return allPages(client, "/user/repos?affiliation=owner", asList);
}

/**
 * The repository's web URL: GitHub's `html_url`, or, when the API leaves it
 * out, `https://github.com/<full_name>`. chant compares URLs by host, owner
 * and name, so a declaration's clone URL (https, ssh or scp-style, with or
 * without `.git`) matches it.
 */
function repoUrl(repo: GitHubRepo, login: string): string {
  if (repo.html_url) return repo.html_url;
  return `${WEB_BASE}/${repo.full_name ?? `${login}/${repo.name}`}`;
}

/** The `--forge-repos` document for `login`, sorted by URL so a re-run with no change writes the same bytes. */
export async function forgeRepoList(client: AppClient, login: string): Promise<ForgeRepoListFile> {
  const repos = (await listAccountRepos(client, login))
    .map((r): ForgeRepoEntry => ({ url: repoUrl(r, login), ...(r.archived === true ? { archived: true as const } : {}) }))
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return { forge: FORGE, org: login, repos };
}

/**
 * The org `repos` lists: `--org` when given, which must be one of the
 * policy's orgs, else the policy's only org. Throws a message for the CLI's
 * exit 2 otherwise.
 */
export function pickOrg(policyOrgs: string[], requested: string | undefined): string {
  if (requested !== undefined) {
    if (!policyOrgs.includes(requested)) {
      throw new Error(`--org ${requested} is not an org the policy governs (${policyOrgs.join(", ") || "none"})`);
    }
    return requested;
  }
  if (policyOrgs.length === 1) return policyOrgs[0]!;
  if (policyOrgs.length === 0) throw new Error("the policy governs no org");
  throw new Error(`the policy governs ${policyOrgs.length} orgs (${policyOrgs.join(", ")}); pick one with --org <name>`);
}
