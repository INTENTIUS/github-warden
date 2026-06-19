/**
 * Dependency hygiene cycle.
 *
 * Reconciles each managed repo's `.github/dependabot.yml` so the file exists and
 * matches the declared content (encode cooldown / external-code-execution policy
 * etc. in that content). Uses the Contents API.
 *
 *   GET /repos/{o}/{r}/contents/.github/dependabot.yml  — live file + blob sha
 *   PUT /repos/{o}/{r}/contents/.github/dependabot.yml  — create / update commit
 *
 * Follows the four-part `Cycle` structure of the branch-protection template
 * (`src/cycles/branch-protection.ts`). See `src/cycles/README.md`.
 *
 * ## Apply model: direct commit (PR-based is a follow-up)
 *
 * This is a file-based cycle, not an API-state one. `apply` writes the file via
 * a direct Contents-API commit to the repo's default branch. Where the default
 * branch requires pull requests, that commit is rejected and surfaces as a
 * reported failed entry (the run continues). A PR-based apply variant — open a
 * branch + PR instead of committing directly — is a documented follow-up.
 *
 * ## Scope
 *
 * Live state is fetched for repos in `scope.repos` that declare `dependabot`
 * (the branch-protection scope pattern).
 */

import type { AppClient } from "../auth/app-client.js";
import type { OrgConfig, RepoConfig, DependabotConfig } from "../config/types.js";
import type { ChangeSetEntry, LiveOrgState, LiveDependabot } from "../reconcile/diff.js";
import type { Cycle, RateBudget } from "../reconcile/runner.js";

// ---------------------------------------------------------------------------
// Public scope type
// ---------------------------------------------------------------------------

/** Scope for the dependency-hygiene cycle. Pass `repos` (typically `orgConfig.repos`). */
export interface DependencyHygieneScope {
  repos?: Record<string, RepoConfig>;
}

const DEPENDABOT_PATH = ".github/dependabot.yml";

// ---------------------------------------------------------------------------
// GitHub REST API response shapes (only the fields we read)
// ---------------------------------------------------------------------------

interface GhContentsFile {
  content?: string;
  encoding?: string;
  sha?: string;
}

// ---------------------------------------------------------------------------
// base64 helpers
// ---------------------------------------------------------------------------

function decodeBase64(b64: string): string {
  return Buffer.from(b64.replace(/\s/g, ""), "base64").toString("utf-8");
}

function encodeBase64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

// ---------------------------------------------------------------------------
// Live-state fetch
// ---------------------------------------------------------------------------

/** Fetch the live `.github/dependabot.yml` for one repo (content + sha), or empty on 404. */
export async function fetchDependabot(
  client: AppClient,
  org: string,
  repo: string,
  budget: RateBudget,
): Promise<LiveDependabot> {
  budget.use(1);
  let data: GhContentsFile;
  try {
    data = await client.request<GhContentsFile>(
      "GET",
      `/repos/${org}/${repo}/contents/${DEPENDABOT_PATH}`,
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes("404")) return {};
    throw err;
  }
  const live: LiveDependabot = {};
  if (data.sha) live.sha = data.sha;
  if (typeof data.content === "string" && (data.encoding ?? "base64") === "base64") {
    live.content = decodeBase64(data.content);
  }
  return live;
}

// ---------------------------------------------------------------------------
// dependencyHygieneCycle — implements Cycle<DependencyHygieneScope>
// ---------------------------------------------------------------------------

export const dependencyHygieneCycle: Cycle<DependencyHygieneScope> = {
  name: "dependency-hygiene",

  // ── Part 2: fetchLive ──────────────────────────────────────────────────────

  async fetchLive(
    client: AppClient,
    orgLogin: string,
    scope: DependencyHygieneScope,
    budget: RateBudget,
  ): Promise<LiveOrgState> {
    if (budget.exhausted) {
      const { BudgetExhaustedError } = await import("../reconcile/runner.js");
      throw new BudgetExhaustedError();
    }

    const repos: NonNullable<LiveOrgState["repos"]> = {};
    for (const [name, repoConfig] of Object.entries(scope?.repos ?? {})) {
      if (repoConfig.dependabot === undefined) continue;
      if (budget.exhausted) break;
      repos[name] = { dependabot: await fetchDependabot(client, orgLogin, name, budget) };
    }

    return { repos };
  },

  // ── Part 3: buildDesired ───────────────────────────────────────────────────

  buildDesired(orgConfig: OrgConfig, _orgLogin: string, _scope: DependencyHygieneScope): OrgConfig {
    if (!orgConfig.repos) return {};
    const repos: Record<string, RepoConfig> = {};
    for (const [name, repoConfig] of Object.entries(orgConfig.repos)) {
      if (repoConfig.dependabot !== undefined) repos[name] = { dependabot: repoConfig.dependabot };
    }
    return { repos };
  },

  // ── Part 4: apply ──────────────────────────────────────────────────────────

  async apply(
    client: AppClient,
    entry: ChangeSetEntry,
    orgLogin: string,
    _scope: DependencyHygieneScope,
    budget: RateBudget,
  ): Promise<void> {
    if (entry.resourceType !== "dependabot") return;
    // Never deletes the file; the diff only emits create/update.
    if (entry.kind === "delete") return;

    const repo = entry.key;
    const desired = entry.after as DependabotConfig;

    const body: Record<string, unknown> = {
      message:
        entry.kind === "create"
          ? "chore(dependabot): add .github/dependabot.yml (github-warden)"
          : "chore(dependabot): update .github/dependabot.yml (github-warden)",
      content: encodeBase64(desired.content),
    };
    // Updates require the current blob sha (Contents API read-modify-write).
    if (entry.kind === "update") {
      const sha = (entry.before as LiveDependabot | undefined)?.sha;
      if (sha === undefined) {
        throw new Error(`dependency-hygiene: update for "${repo}" is missing the live file sha`);
      }
      body.sha = sha;
    }

    budget.use(1);
    await client.request("PUT", `/repos/${orgLogin}/${repo}/contents/${DEPENDABOT_PATH}`, body);
  },
};
