/**
 * Secrets & variables cycle.
 *
 * Reconciles the PRESENCE/consistency of Actions secrets and the full state of
 * Actions variables, at org and repo scope.
 *
 *   Secrets  — GET list (names only) + DELETE. warden NEVER reads or writes a
 *              secret VALUE; values are provisioned out-of-band. A declared but
 *              missing secret is REPORTED (the apply path raises a clear error
 *              telling the operator to provision it); an undeclared live secret
 *              is removed only when ownership-gated.
 *   Variables — GET list (with values) + POST/PATCH/DELETE. Variable values are
 *              not secret, so they are reconciled fully.
 *
 *   GET    /orgs/{org}/actions/secrets|variables
 *   GET    /repos/{o}/{r}/actions/secrets|variables
 *   POST   …/actions/variables                 — create variable
 *   PATCH  …/actions/variables/{name}          — update variable value
 *   DELETE …/actions/secrets|variables/{name}  — remove
 *
 * Follows the four-part `Cycle` structure of the branch-protection template
 * (`src/cycles/branch-protection.ts`). See `src/cycles/README.md`.
 *
 * ## Scope note
 *
 * Org-level secrets/variables are fetched via `orgLogin` (tolerating a
 * permission/404 error as "nothing live"); repo-level for `scope.repos` that
 * declare them. Environment-level secrets/variables (the third GitHub scope)
 * are a documented follow-up — they need an environment dimension in the key.
 */

import type { AppClient } from "../auth/app-client.js";
import type { OrgConfig, RepoConfig, SecretConfig, VariableConfig } from "../config/types.js";
import type { ChangeSetEntry, LiveOrgState, LiveSecret, LiveVariable } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";

// ---------------------------------------------------------------------------
// Public scope type
// ---------------------------------------------------------------------------

/** Scope for the secrets/variables cycle. Pass `repos` (typically `orgConfig.repos`). */
export interface SecretsVariablesScope {
  repos?: Record<string, RepoConfig>;
}

const PER_PAGE = 100;

// ---------------------------------------------------------------------------
// Live-state fetch helpers
// ---------------------------------------------------------------------------

/** Page through a wrapped list endpoint (`{ <field>: [...] }`). */
async function listWrapped<T>(
  client: AppClient,
  makePath: (page: number) => string,
  field: string,
  budget: RateBudget,
): Promise<T[]> {
  const out: T[] = [];
  let page = 1;
  for (;;) {
    if (budget.exhausted) break;
    budget.use(1);
    const data = await client.request<Record<string, unknown>>("GET", makePath(page));
    const batch = (data?.[field] as T[] | undefined) ?? [];
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < PER_PAGE) break;
    page++;
  }
  return out;
}

/** Fetch secret names under a base path; tolerate 403/404 as "no access / none". */
async function fetchSecrets(client: AppClient, basePath: string, budget: RateBudget): Promise<LiveSecret[]> {
  try {
    const raw = await listWrapped<{ name: string }>(
      client,
      (page) => `${basePath}?per_page=${PER_PAGE}&page=${page}`,
      "secrets",
      budget,
    );
    return raw.filter((s) => typeof s.name === "string").map((s) => ({ name: s.name }));
  } catch (err) {
    if (err instanceof Error && (err.message.includes("404") || err.message.includes("403"))) return [];
    throw err;
  }
}

/** Fetch variables (name + value) under a base path; tolerate 403/404. */
async function fetchVariables(client: AppClient, basePath: string, budget: RateBudget): Promise<LiveVariable[]> {
  try {
    const raw = await listWrapped<{ name: string; value?: string }>(
      client,
      (page) => `${basePath}?per_page=${PER_PAGE}&page=${page}`,
      "variables",
      budget,
    );
    return raw
      .filter((v) => typeof v.name === "string")
      .map((v) => ({ name: v.name, value: v.value }));
  } catch (err) {
    if (err instanceof Error && (err.message.includes("404") || err.message.includes("403"))) return [];
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Apply helpers
// ---------------------------------------------------------------------------

/** Split a "<repo>/<name>" key. */
function splitRepoKey(key: string, resourceType: string): [string, string] {
  const idx = key.indexOf("/");
  if (idx === -1) {
    throw new Error(`secrets-variables: malformed ${resourceType} key "${key}" — expected "<repo>/<name>"`);
  }
  return [key.slice(0, idx), key.slice(idx + 1)];
}

async function applySecret(
  client: AppClient,
  entry: ChangeSetEntry,
  org: string,
  budget: RateBudget,
): Promise<void> {
  const isRepo = entry.resourceType === "repo-secret";
  let basePath: string;
  let name: string;
  if (isRepo) {
    const [repo, secretName] = splitRepoKey(entry.key, "repo-secret");
    basePath = `/repos/${org}/${repo}/actions/secrets`;
    name = secretName;
  } else {
    basePath = `/orgs/${org}/actions/secrets`;
    name = entry.key;
  }

  if (entry.kind === "delete") {
    budget.use(1);
    await client.request("DELETE", `${basePath}/${encodeURIComponent(name)}`);
    return;
  }

  // create/update: warden never writes secret values. Report so the operator
  // provisions the value out-of-band rather than silently doing nothing.
  throw new Error(
    `secret "${name}" is declared but absent — provision its value out-of-band; ` +
      `warden never reads or writes secret values`,
  );
}

async function applyVariable(
  client: AppClient,
  entry: ChangeSetEntry,
  org: string,
  budget: RateBudget,
): Promise<void> {
  const isRepo = entry.resourceType === "repo-variable";
  let basePath: string;
  let name: string;
  if (isRepo) {
    const [repo, varName] = splitRepoKey(entry.key, "repo-variable");
    basePath = `/repos/${org}/${repo}/actions/variables`;
    name = varName;
  } else {
    basePath = `/orgs/${org}/actions/variables`;
    name = entry.key;
  }

  if (entry.kind === "delete") {
    budget.use(1);
    await client.request("DELETE", `${basePath}/${encodeURIComponent(name)}`);
    return;
  }

  const desired = entry.after as VariableConfig;

  if (entry.kind === "create") {
    if (desired.value === undefined) {
      throw new Error(`variable "${name}" is declared without a value — set a value to create it`);
    }
    const body: Record<string, unknown> = { name, value: desired.value };
    // Org variables require a visibility on create; repo variables ignore it.
    if (!isRepo) body.visibility = desired.visibility ?? "all";
    budget.use(1);
    await client.request("POST", basePath, body);
    return;
  }

  // update — value only.
  if (desired.value === undefined) return; // presence-only; nothing to update
  budget.use(1);
  await client.request("PATCH", `${basePath}/${encodeURIComponent(name)}`, { value: desired.value });
}

// ---------------------------------------------------------------------------
// secretsVariablesCycle — implements Cycle<SecretsVariablesScope>
// ---------------------------------------------------------------------------

export const secretsVariablesCycle: Cycle<SecretsVariablesScope> = {
  name: "secrets-variables",

  // ── Part 2: fetchLive ──────────────────────────────────────────────────────

  async fetchLive(
    client: AppClient,
    orgLogin: string,
    scope: SecretsVariablesScope,
    budget: RateBudget,
  ): Promise<LiveOrgState> {
    if (budget.exhausted) {
      const { BudgetExhaustedError } = await import("../reconcile/runner.js");
      throw new BudgetExhaustedError();
    }

    const secrets = await fetchSecrets(client, `/orgs/${orgLogin}/actions/secrets`, budget);
    const variables = budget.exhausted
      ? []
      : await fetchVariables(client, `/orgs/${orgLogin}/actions/variables`, budget);

    const repos: NonNullable<LiveOrgState["repos"]> = {};
    for (const [name, repoConfig] of Object.entries(scope?.repos ?? {})) {
      const wantsSecrets = repoConfig.secrets !== undefined;
      const wantsVariables = repoConfig.variables !== undefined;
      if (!wantsSecrets && !wantsVariables) continue;
      if (budget.exhausted) break;

      const repoLive: { secrets?: LiveSecret[]; variables?: LiveVariable[] } = {};
      if (wantsSecrets) {
        repoLive.secrets = await fetchSecrets(client, `/repos/${orgLogin}/${name}/actions/secrets`, budget);
      }
      if (wantsVariables && !budget.exhausted) {
        repoLive.variables = await fetchVariables(client, `/repos/${orgLogin}/${name}/actions/variables`, budget);
      }
      repos[name] = repoLive;
    }

    return { secrets, variables, repos };
  },

  // ── Part 3: buildDesired ───────────────────────────────────────────────────

  buildDesired(orgConfig: OrgConfig, _orgLogin: string, _scope: SecretsVariablesScope): OrgConfig {
    const out: OrgConfig = {};
    if (orgConfig.secrets) out.secrets = orgConfig.secrets;
    if (orgConfig.variables) out.variables = orgConfig.variables;

    if (orgConfig.repos) {
      const repos: Record<string, RepoConfig> = {};
      for (const [name, repoConfig] of Object.entries(orgConfig.repos)) {
        const stripped: RepoConfig = {};
        if (repoConfig.secrets !== undefined) stripped.secrets = repoConfig.secrets;
        if (repoConfig.variables !== undefined) stripped.variables = repoConfig.variables;
        if (stripped.secrets !== undefined || stripped.variables !== undefined) {
          repos[name] = stripped;
        }
      }
      out.repos = repos;
    }

    return out;
  },

  // ── Part 4: apply ──────────────────────────────────────────────────────────

  async apply(
    client: AppClient,
    entry: ChangeSetEntry,
    orgLogin: string,
    _scope: SecretsVariablesScope,
    budget: RateBudget,
  ): Promise<void> {
    switch (entry.resourceType) {
      case "org-secret":
      case "repo-secret":
        return applySecret(client, entry, orgLogin, budget);
      case "org-variable":
      case "repo-variable":
        return applyVariable(client, entry, orgLogin, budget);
      default:
        return;
    }
  },
};
