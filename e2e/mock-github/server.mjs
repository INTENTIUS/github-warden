#!/usr/bin/env node
/**
 * Stateful mock GitHub API for the hermetic compose smoke test.
 *
 * A single dependency-free node HTTP server implementing the endpoints the 13
 * warden cycles touch, with in-memory state so applies are visible to later
 * reads: org and repo settings, members, teams (create/update/delete plus
 * member and repo attachments), classic branch protection, rulesets (org +
 * repo, with GitHub's `exclude: []` conditions echo), security features,
 * environments, Actions secrets and variables, dependabot file contents, repo
 * listing/creation (template generate included), and the App-only
 * fine-grained-PAT endpoints. Pagination follows per_page/page with Link
 * headers on list endpoints the client pages through.
 *
 * Auth mirrors the App flow: POST /app/installations/{id}/access_tokens
 * accepts any Bearer JWT and returns MOCK_TOKEN; every API endpoint then
 * requires `Authorization: Bearer <MOCK_TOKEN>`.
 *
 * Test controls (no auth):
 *   GET  /__mock/health                          — liveness probe
 *   POST /__mock/reset {"org": "mock-org"}       — wipe state, seed one org
 *   POST /__mock/forbid {"prefix": "/orgs/..."}  — 403 any request whose path
 *                                                  starts with the prefix
 *   POST /__mock/allow                            — clear all forbids
 *   POST /__mock/orgs/{org}/token-grants   [..]  — seed PAT grants
 *   POST /__mock/orgs/{org}/token-requests [..]  — seed pending PAT requests
 *
 * Run standalone (no docker):  node e2e/mock-github/server.mjs
 * Run via compose:             just e2e-up  (e2e/docker-compose.yml)
 */

import { createServer } from "node:http";
import { createHash } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8188);
const MOCK_TOKEN = process.env.MOCK_TOKEN ?? "mock-installation-token";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let state;
let nextId;

function freshOrg() {
  return {
    settings: {
      description: null,
      email: null,
      blog: null,
      default_repository_permission: "read",
      members_can_create_public_repositories: true,
      members_can_create_private_repositories: true,
      members_can_create_internal_repositories: false,
      two_factor_requirement_enabled: false,
    },
    // login -> "admin" | "member"
    members: new Map(),
    // slug -> team
    teams: new Map(),
    // id -> ruleset
    rulesets: new Map(),
    // name -> {}
    secrets: new Map(),
    // name -> { value, visibility }
    variables: new Map(),
    // id -> grant
    tokenGrants: new Map(),
    // id -> request
    tokenRequests: new Map(),
    // name -> repo
    repos: new Map(),
  };
}

function freshRepo(name, priv) {
  return {
    name,
    description: null,
    homepage: null,
    private: priv,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    default_branch: "main",
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    delete_branch_on_merge: false,
    topics: [],
    security_and_analysis: {},
    vulnerability_alerts: false,
    automated_security_fixes: false,
    // branch -> protection body
    branchProtection: new Map(),
    // id -> ruleset
    rulesets: new Map(),
    // env name -> config
    environments: new Map(),
    secrets: new Map(),
    variables: new Map(),
    // path -> { content (utf-8), sha }
    files: new Map(),
  };
}

function reset(orgLogin) {
  state = {
    orgs: new Map([[orgLogin, freshOrg()]]),
    forbidden: [],
  };
  nextId = 1000;
}

reset("mock-org");

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function json(res, status, body, headers = {}) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(text);
}

function notFound(res) {
  json(res, 404, { message: "Not Found" });
}

function forbidden(res) {
  json(res, 403, { message: "Resource not accessible by integration" });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (data === "") return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/** Paginate `items` by ?per_page/?page; sets a Link rel="next" header when more remain. */
function paginate(items, url, res) {
  const perPage = Math.min(Number(url.searchParams.get("per_page") ?? 30), 100);
  const page = Math.max(Number(url.searchParams.get("page") ?? 1), 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers = {};
  if (start + perPage < items.length) {
    const next = new URL(url);
    next.searchParams.set("page", String(page + 1));
    headers["Link"] = `<${next.pathname}${next.search}>; rel="next"`;
  }
  return { slice, headers };
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sha1(text) {
  return createHash("sha1").update(text).digest("hex");
}

/** Serve a ruleset the way GitHub does: absent ref_name.exclude echoes as []. */
function rulesetDetail(rs) {
  const out = { ...rs };
  if (out.conditions && out.conditions.ref_name && !("exclude" in out.conditions.ref_name)) {
    out.conditions = {
      ...out.conditions,
      ref_name: { ...out.conditions.ref_name, exclude: [] },
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { message: "invalid JSON body" });
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  try {
    handle(req, res, method, path, url, body);
  } catch (err) {
    json(res, 500, { message: String(err && err.stack ? err.stack : err) });
  }
});

function handle(req, res, method, path, url, body) {
  const seg = path.split("/").filter(Boolean).map(decodeURIComponent);

  // ── Test controls (no auth) ───────────────────────────────────────────────
  if (seg[0] === "__mock") {
    if (method === "GET" && seg[1] === "health") return json(res, 200, { ok: true });
    if (method === "POST" && seg[1] === "reset") {
      reset(body.org ?? "mock-org");
      return json(res, 200, { ok: true });
    }
    if (method === "POST" && seg[1] === "forbid") {
      state.forbidden.push({ prefix: String(body.prefix), methods: body.methods });
      return json(res, 200, { ok: true });
    }
    if (method === "POST" && seg[1] === "allow") {
      state.forbidden = [];
      return json(res, 200, { ok: true });
    }
    if (method === "POST" && seg[1] === "orgs" && seg[3] === "token-grants") {
      const org = state.orgs.get(seg[2]);
      if (!org) return notFound(res);
      for (const g of body) org.tokenGrants.set(g.id ?? nextId++, g);
      return json(res, 200, { ok: true });
    }
    if (method === "POST" && seg[1] === "orgs" && seg[3] === "token-requests") {
      const org = state.orgs.get(seg[2]);
      if (!org) return notFound(res);
      for (const r of body) org.tokenRequests.set(r.id ?? nextId++, r);
      return json(res, 200, { ok: true });
    }
    return notFound(res);
  }

  // ── App token exchange (any Bearer JWT accepted) ──────────────────────────
  if (method === "POST" && seg[0] === "app" && seg[1] === "installations" && seg[3] === "access_tokens") {
    if (!(req.headers.authorization ?? "").startsWith("Bearer ")) {
      return json(res, 401, { message: "A JSON web token could not be decoded" });
    }
    const expires = new Date(Date.now() + 3600_000).toISOString();
    return json(res, 201, { token: MOCK_TOKEN, expires_at: expires });
  }

  // ── Installation-token auth for everything else ───────────────────────────
  if (req.headers.authorization !== `Bearer ${MOCK_TOKEN}`) {
    return json(res, 401, { message: "Bad credentials" });
  }

  // ── Injected 403s ─────────────────────────────────────────────────────────
  for (const f of state.forbidden) {
    if (path.startsWith(f.prefix) && (!f.methods || f.methods.includes(method))) {
      return forbidden(res);
    }
  }

  // ── /orgs/{org}/... ───────────────────────────────────────────────────────
  if (seg[0] === "orgs") {
    const org = state.orgs.get(seg[1]);
    if (!org) return notFound(res);
    return handleOrg(res, method, seg.slice(2), url, body, org, seg[1]);
  }

  // ── /repos/{owner}/{repo}/... ─────────────────────────────────────────────
  if (seg[0] === "repos") {
    const org = state.orgs.get(seg[1]);
    if (!org) return notFound(res);

    // Template generate creates a repo in body.owner's org.
    if (method === "POST" && seg[3] === "generate" && seg.length === 4) {
      const target = state.orgs.get(body.owner);
      if (!target || !org.repos.has(seg[2])) return notFound(res);
      target.repos.set(body.name, freshRepo(body.name, body.private ?? true));
      return json(res, 201, { name: body.name });
    }

    const repo = org.repos.get(seg[2]);
    if (!repo) return notFound(res);
    return handleRepo(res, method, seg.slice(3), url, body, org, repo, seg[1]);
  }

  return notFound(res);
}

// ---------------------------------------------------------------------------
// /orgs/{org}/** handlers — `rest` is the path after the org login
// ---------------------------------------------------------------------------

function handleOrg(res, method, rest, url, body, org, orgLogin) {
  // GET/PATCH /orgs/{org}
  if (rest.length === 0) {
    if (method === "GET") return json(res, 200, { login: orgLogin, ...org.settings });
    if (method === "PATCH") {
      const allowed = [
        "description", "email", "blog", "default_repository_permission",
        "members_can_create_public_repositories", "members_can_create_private_repositories",
        "members_can_create_internal_repositories", "two_factor_requirement_enabled",
      ];
      for (const k of allowed) if (k in body) org.settings[k] = body[k];
      return json(res, 200, { login: orgLogin, ...org.settings });
    }
    return notFound(res);
  }

  // Members
  if (rest[0] === "members" && rest.length === 1 && method === "GET") {
    const role = url.searchParams.get("role");
    const items = [...org.members.entries()]
      .filter(([, r]) => (role ? r === role : true))
      .map(([login]) => ({ login }));
    const { slice, headers } = paginate(items, url, res);
    return json(res, 200, slice, headers);
  }
  if (rest[0] === "memberships" && rest.length === 2) {
    const login = rest[1];
    if (method === "PUT") {
      org.members.set(login, body.role === "admin" ? "admin" : "member");
      return json(res, 200, { role: org.members.get(login), state: "active" });
    }
    if (method === "DELETE") {
      if (!org.members.delete(login)) return notFound(res);
      return json(res, 204);
    }
    return notFound(res);
  }

  // Teams
  if (rest[0] === "teams") return handleTeams(res, method, rest.slice(1), url, body, org, orgLogin);

  // Rulesets (org scope)
  if (rest[0] === "rulesets") {
    return handleRulesets(res, method, rest.slice(1), url, body, org.rulesets);
  }

  // Actions secrets & variables (org scope)
  if (rest[0] === "actions") {
    return handleActions(res, method, rest.slice(1), url, body, org);
  }

  // Repo list / create
  if (rest[0] === "repos" && rest.length === 1) {
    if (method === "GET") {
      const items = [...org.repos.keys()].map((name) => ({ name }));
      const { slice, headers } = paginate(items, url, res);
      return json(res, 200, slice, headers);
    }
    if (method === "POST") {
      if (org.repos.has(body.name)) return json(res, 422, { message: "name already exists" });
      org.repos.set(body.name, freshRepo(body.name, body.private ?? true));
      return json(res, 201, { name: body.name });
    }
  }

  // Fine-grained PAT grants
  if (rest[0] === "personal-access-tokens") {
    if (rest.length === 1 && method === "GET") {
      const items = [...org.tokenGrants.entries()].map(([id, g]) => ({
        id,
        owner: { login: g.owner_login },
        token_expired: g.token_expired ?? false,
        token_expires_at: g.token_expires_at ?? null,
        token_last_used_at: g.token_last_used_at ?? null,
        access_granted_at: g.access_granted_at ?? null,
      }));
      const { slice, headers } = paginate(items, url, res);
      return json(res, 200, slice, headers);
    }
    if (rest.length === 2 && method === "POST") {
      const id = Number(rest[1]);
      if (!org.tokenGrants.has(id)) return notFound(res);
      if (body.action === "revoke") {
        org.tokenGrants.delete(id);
        return json(res, 204);
      }
      return json(res, 422, { message: "unknown action" });
    }
  }

  // Fine-grained PAT requests
  if (rest[0] === "personal-access-token-requests") {
    if (rest.length === 1 && method === "GET") {
      const items = [...org.tokenRequests.entries()].map(([id, r]) => ({
        id,
        owner: { login: r.owner_login },
        permissions: r.permissions ?? {},
      }));
      const { slice, headers } = paginate(items, url, res);
      return json(res, 200, slice, headers);
    }
    if (rest.length === 2 && method === "POST") {
      const id = Number(rest[1]);
      if (!org.tokenRequests.has(id)) return notFound(res);
      if (body.action === "approve" || body.action === "deny") {
        org.tokenRequests.delete(id);
        return json(res, 204);
      }
      return json(res, 422, { message: "unknown action" });
    }
  }

  return notFound(res);
}

// ---------------------------------------------------------------------------
// Teams — `rest` is the path after /orgs/{org}/teams
// ---------------------------------------------------------------------------

function teamSummary(t) {
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    description: t.description ?? null,
    privacy: t.privacy ?? "secret",
    parent: t.parentSlug ? { slug: t.parentSlug } : null,
  };
}

function handleTeams(res, method, rest, url, body, org, orgLogin) {
  // List / create
  if (rest.length === 0) {
    if (method === "GET") {
      const items = [...org.teams.values()].map(teamSummary);
      const { slice, headers } = paginate(items, url, res);
      return json(res, 200, slice, headers);
    }
    if (method === "POST") {
      const slug = slugify(body.name);
      if (org.teams.has(slug)) return json(res, 422, { message: "team exists" });
      const team = {
        id: nextId++,
        slug,
        name: body.name,
        description: body.description,
        privacy: body.privacy,
        parentSlug: resolveParentSlug(org, body.parent_team_id),
        members: new Map(),
        repos: new Map(),
      };
      org.teams.set(slug, team);
      return json(res, 201, teamSummary(team));
    }
    return notFound(res);
  }

  const team = org.teams.get(rest[0]);
  if (!team) return notFound(res);

  // Single team
  if (rest.length === 1) {
    if (method === "GET") return json(res, 200, teamSummary(team));
    if (method === "PATCH") {
      if ("description" in body) team.description = body.description;
      if ("privacy" in body) team.privacy = body.privacy;
      if ("parent_team_id" in body) {
        team.parentSlug = body.parent_team_id === null ? undefined : resolveParentSlug(org, body.parent_team_id);
      }
      if ("name" in body) team.name = body.name;
      return json(res, 200, teamSummary(team));
    }
    if (method === "DELETE") {
      org.teams.delete(rest[0]);
      return json(res, 204);
    }
    return notFound(res);
  }

  // Team members
  if (rest[1] === "members" && rest.length === 2 && method === "GET") {
    const role = url.searchParams.get("role");
    const items = [...team.members.entries()]
      .filter(([, r]) => (role ? r === role : true))
      .map(([login]) => ({ login }));
    const { slice, headers } = paginate(items, url, res);
    return json(res, 200, slice, headers);
  }
  if (rest[1] === "memberships" && rest.length === 3) {
    if (method === "PUT") {
      team.members.set(rest[2], body.role === "maintainer" ? "maintainer" : "member");
      return json(res, 200, { role: team.members.get(rest[2]), state: "active" });
    }
    if (method === "DELETE") {
      if (!team.members.delete(rest[2])) return notFound(res);
      return json(res, 204);
    }
  }

  // Team repos
  if (rest[1] === "repos") {
    if (rest.length === 2 && method === "GET") {
      const items = [...team.repos.entries()].map(([name, permission]) => ({
        name,
        role_name: permission,
      }));
      const { slice, headers } = paginate(items, url, res);
      return json(res, 200, slice, headers);
    }
    // PUT/DELETE /orgs/{org}/teams/{slug}/repos/{owner}/{repo}
    if (rest.length === 4 && rest[2] === orgLogin) {
      if (method === "PUT") {
        team.repos.set(rest[3], body.permission ?? "pull");
        return json(res, 204);
      }
      if (method === "DELETE") {
        if (!team.repos.delete(rest[3])) return notFound(res);
        return json(res, 204);
      }
    }
  }

  return notFound(res);
}

function resolveParentSlug(org, parentTeamId) {
  if (parentTeamId == null) return undefined;
  for (const t of org.teams.values()) if (t.id === parentTeamId) return t.slug;
  return undefined;
}

// ---------------------------------------------------------------------------
// Rulesets — shared between org and repo scope. `rest` is after /rulesets.
// ---------------------------------------------------------------------------

function handleRulesets(res, method, rest, url, body, rulesets) {
  if (rest.length === 0) {
    if (method === "GET") {
      const items = [...rulesets.values()].map((r) => ({ id: r.id, name: r.name }));
      const { slice, headers } = paginate(items, url, res);
      return json(res, 200, slice, headers);
    }
    if (method === "POST") {
      const id = nextId++;
      rulesets.set(id, { id, ...body });
      return json(res, 201, rulesetDetail(rulesets.get(id)));
    }
    return notFound(res);
  }
  const id = Number(rest[0]);
  const rs = rulesets.get(id);
  if (!rs) return notFound(res);
  if (method === "GET") return json(res, 200, rulesetDetail(rs));
  if (method === "PUT") {
    rulesets.set(id, { id, name: rs.name, ...body });
    return json(res, 200, rulesetDetail(rulesets.get(id)));
  }
  if (method === "DELETE") {
    rulesets.delete(id);
    return json(res, 204);
  }
  return notFound(res);
}

// ---------------------------------------------------------------------------
// Actions secrets & variables — shared between org and repo scope.
// `rest` is after /actions; `holder` has .secrets and .variables Maps.
// ---------------------------------------------------------------------------

function handleActions(res, method, rest, url, body, holder) {
  if (rest[0] === "secrets") {
    if (rest.length === 1 && method === "GET") {
      const items = [...holder.secrets.keys()].map((name) => ({ name }));
      const { slice, headers } = paginate(items, url, res);
      return json(res, 200, { total_count: items.length, secrets: slice }, headers);
    }
    if (rest.length === 2) {
      if (method === "PUT") {
        // Real GitHub takes an encrypted value; the mock records presence only.
        const created = !holder.secrets.has(rest[1]);
        holder.secrets.set(rest[1], {});
        return created ? json(res, 201, {}) : json(res, 204);
      }
      if (method === "DELETE") {
        if (!holder.secrets.delete(rest[1])) return notFound(res);
        return json(res, 204);
      }
    }
  }

  if (rest[0] === "variables") {
    if (rest.length === 1) {
      if (method === "GET") {
        const items = [...holder.variables.entries()].map(([name, v]) => ({
          name,
          value: v.value,
        }));
        const { slice, headers } = paginate(items, url, res);
        return json(res, 200, { total_count: items.length, variables: slice }, headers);
      }
      if (method === "POST") {
        if (holder.variables.has(body.name)) return json(res, 409, { message: "already exists" });
        holder.variables.set(body.name, { value: body.value, visibility: body.visibility });
        return json(res, 201, {});
      }
    }
    if (rest.length === 2) {
      const v = holder.variables.get(rest[1]);
      if (method === "PATCH") {
        if (!v) return notFound(res);
        if ("value" in body) v.value = body.value;
        return json(res, 204);
      }
      if (method === "DELETE") {
        if (!holder.variables.delete(rest[1])) return notFound(res);
        return json(res, 204);
      }
    }
  }

  return notFound(res);
}

// ---------------------------------------------------------------------------
// /repos/{owner}/{repo}/** handlers — `rest` is the path after the repo name
// ---------------------------------------------------------------------------

function repoDetail(repo) {
  return {
    name: repo.name,
    description: repo.description,
    homepage: repo.homepage,
    private: repo.private,
    has_issues: repo.has_issues,
    has_projects: repo.has_projects,
    has_wiki: repo.has_wiki,
    default_branch: repo.default_branch,
    allow_squash_merge: repo.allow_squash_merge,
    allow_merge_commit: repo.allow_merge_commit,
    allow_rebase_merge: repo.allow_rebase_merge,
    delete_branch_on_merge: repo.delete_branch_on_merge,
    topics: repo.topics,
    security_and_analysis: repo.security_and_analysis,
  };
}

function handleRepo(res, method, rest, url, body, org, repo, orgLogin) {
  // GET/PATCH /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === "GET") return json(res, 200, repoDetail(repo));
    if (method === "PATCH") {
      const allowed = [
        "description", "homepage", "private", "has_issues", "has_projects", "has_wiki",
        "default_branch", "allow_squash_merge", "allow_merge_commit", "allow_rebase_merge",
        "delete_branch_on_merge",
      ];
      for (const k of allowed) if (k in body) repo[k] = body[k];
      if (body.security_and_analysis) {
        repo.security_and_analysis = {
          ...repo.security_and_analysis,
          ...body.security_and_analysis,
        };
      }
      return json(res, 200, repoDetail(repo));
    }
    if (method === "DELETE") {
      org.repos.delete(repo.name);
      return json(res, 204);
    }
    return notFound(res);
  }

  // Topics
  if (rest[0] === "topics" && rest.length === 1 && method === "PUT") {
    repo.topics = body.names ?? [];
    return json(res, 200, { names: repo.topics });
  }

  // Branch protection
  if (rest[0] === "branches" && rest[2] === "protection" && rest.length === 3) {
    const branch = rest[1];
    if (method === "GET") {
      const bp = repo.branchProtection.get(branch);
      if (!bp) return notFound(res);
      return json(res, 200, {
        required_pull_request_reviews: bp.required_pull_request_reviews ?? null,
        required_status_checks: bp.required_status_checks ?? null,
        restrictions: bp.restrictions ?? null,
        enforce_admins: { enabled: !!bp.enforce_admins },
        allow_force_pushes: { enabled: !!bp.allow_force_pushes },
        allow_deletions: { enabled: !!bp.allow_deletions },
        required_linear_history: { enabled: !!bp.required_linear_history },
      });
    }
    if (method === "PUT") {
      repo.branchProtection.set(branch, body);
      return json(res, 200, {});
    }
    if (method === "DELETE") {
      if (!repo.branchProtection.delete(branch)) return notFound(res);
      return json(res, 204);
    }
  }

  // Repo rulesets
  if (rest[0] === "rulesets") {
    return handleRulesets(res, method, rest.slice(1), url, body, repo.rulesets);
  }

  // Security feature toggles
  if (rest[0] === "vulnerability-alerts" && rest.length === 1) {
    if (method === "GET") return repo.vulnerability_alerts ? json(res, 204) : notFound(res);
    if (method === "PUT") {
      repo.vulnerability_alerts = true;
      return json(res, 204);
    }
    if (method === "DELETE") {
      repo.vulnerability_alerts = false;
      return json(res, 204);
    }
  }
  if (rest[0] === "automated-security-fixes" && rest.length === 1) {
    if (method === "GET") return json(res, 200, { enabled: repo.automated_security_fixes });
    if (method === "PUT") {
      repo.automated_security_fixes = true;
      return json(res, 204);
    }
    if (method === "DELETE") {
      repo.automated_security_fixes = false;
      return json(res, 204);
    }
  }

  // Environments
  if (rest[0] === "environments") {
    if (rest.length === 1 && method === "GET") {
      const environments = [...repo.environments.entries()].map(([name, e]) => {
        const protection_rules = [];
        if (e.wait_timer != null) protection_rules.push({ type: "wait_timer", wait_timer: e.wait_timer });
        if (e.reviewers != null || e.prevent_self_review != null) {
          protection_rules.push({
            type: "required_reviewers",
            prevent_self_review: !!e.prevent_self_review,
            reviewers: (e.reviewers ?? []).map((r) => ({ type: r.type, reviewer: { id: r.id } })),
          });
        }
        return {
          name,
          protection_rules,
          deployment_branch_policy: e.deployment_branch_policy ?? null,
        };
      });
      return json(res, 200, { total_count: environments.length, environments });
    }
    if (rest.length === 2) {
      if (method === "PUT") {
        repo.environments.set(rest[1], body);
        return json(res, 200, { name: rest[1] });
      }
      if (method === "DELETE") {
        if (!repo.environments.delete(rest[1])) return notFound(res);
        return json(res, 204);
      }
    }
  }

  // Actions secrets & variables (repo scope)
  if (rest[0] === "actions") {
    return handleActions(res, method, rest.slice(1), url, body, repo);
  }

  // Contents API (dependabot file)
  if (rest[0] === "contents") {
    const filePath = rest.slice(1).join("/");
    if (method === "GET") {
      const f = repo.files.get(filePath);
      if (!f) return notFound(res);
      return json(res, 200, {
        content: Buffer.from(f.content, "utf-8").toString("base64"),
        encoding: "base64",
        sha: f.sha,
      });
    }
    if (method === "PUT") {
      const existing = repo.files.get(filePath);
      if (existing && body.sha !== existing.sha) {
        return json(res, 409, { message: "sha mismatch" });
      }
      if (!existing && body.sha) {
        return json(res, 422, { message: "sha given for a new file" });
      }
      const content = Buffer.from(String(body.content ?? ""), "base64").toString("utf-8");
      const f = { content, sha: sha1(content) };
      repo.files.set(filePath, f);
      return json(res, existing ? 200 : 201, { content: { sha: f.sha } });
    }
  }

  return notFound(res);
}

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`mock-github listening on http://localhost:${PORT} (token: ${MOCK_TOKEN})`);
});
