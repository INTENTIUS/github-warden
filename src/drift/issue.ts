/**
 * `reconcile --drift-issue`: one GitHub issue tracking the governance drift a
 * dry run finds (INTENTIUS/github-warden#77).
 *
 * chant's `keepDriftIssue` (`@intentius/chant/drift-issue`) does the work:
 * it opens the issue when the run finds drift, updates it when the drift
 * changes, leaves it alone when the drift is the same or the read was
 * incomplete, and closes it when GitHub matches the policy again. The
 * records are the drift reader's (`./reader.ts`), so the issue and
 * `chant workspace drift` report the same thing: a node with planned
 * changes is `drifted`, which is drift under keepDriftIssue's default
 * statuses.
 */

import { keepDriftIssue, type DriftIssueResult, type DriftIssueWords } from "@intentius/chant/drift-issue";
import type { DriftRecord } from "@intentius/chant/drift-record";
import { forgeClient, type ForgeFetch, type PrForge } from "@intentius/chant/pr-forge";
import { GITHUB_API_URL } from "../auth/token-client.js";

/** The product name on the marker and the fingerprint. */
export const DRIFT_ISSUE_PRODUCT = "github-warden";

/** The host the CLI governs: it always calls https://api.github.com. */
export const GITHUB_HOST = "github.com";

type Env = Record<string, string | undefined>;

const pick = (env: Env, ...names: string[]): string | undefined =>
  names.map((n) => env[n]?.trim()).find((v): v is string => v !== undefined && v !== "");

/** `owner/name`: what GitHub calls a repository by. */
export const isRepoName = (v: string): boolean => /^[^/\s]+\/[^/\s]+$/.test(v);

/** The repository the issue lives in: the flag, else the Actions variable. Undefined when neither is set. */
export function driftIssueRepo(flag: string | undefined, env: Env = process.env): string | undefined {
  return flag ?? pick(env, "GITHUB_REPOSITORY");
}

/** The run's URL on a GitHub Actions runner, when the job says it. */
export function driftIssueRunUrl(env: Env = process.env): string | undefined {
  const server = pick(env, "GITHUB_SERVER_URL")?.replace(/\/+$/, "");
  const repo = pick(env, "GITHUB_REPOSITORY");
  const run = pick(env, "GITHUB_RUN_ID");
  return server && repo && run ? `${server}/${repo}/actions/runs/${run}` : undefined;
}

/** What the issue is for: the host and the policy's orgs, `github.com/acme`. Keys the marker. */
export function driftIssueEnvironment(orgs: readonly string[], host: string = GITHUB_HOST): string {
  return `${host.toLowerCase()}/${[...orgs].sort().join(",")}`;
}

/** github-warden's words for its drift issue. */
export const DRIFT_ISSUE_WORDS: DriftIssueWords = {
  product: DRIFT_ISSUE_PRODUCT,
  title: (facts) => `Governance drift on ${facts.environment}`,
  values: { before: "declared", after: "live" },
  advice: () =>
    "Run `github-warden reconcile --mode apply` to bring the forge back to the policy, or change the policy to match. This issue closes on the first dry run that finds no drift.",
};

export interface DriftIssueForgeOptions {
  /** `owner/name`. */
  repo: string;
  token: string;
  /** Where the token came from, for messages. Never the token. */
  tokenSource: string;
  runUrl?: string;
  fetch?: ForgeFetch;
}

/** chant's GitHub client for the issue repository, with the warden's own credential. */
export function driftIssueForge(opts: DriftIssueForgeOptions): PrForge {
  return forgeClient(
    {
      kind: "github",
      apiBase: GITHUB_API_URL,
      repo: opts.repo,
      host: GITHUB_HOST,
      token: opts.token,
      tokenSource: opts.tokenSource,
      ...(opts.runUrl ? { runUrl: opts.runUrl } : {}),
    },
    opts.fetch,
  );
}

export interface KeepGovernanceDriftIssueInput {
  environment: string;
  records: readonly DriftRecord[];
  runUrl?: string;
  observedAt?: string;
}

/** Bring the environment's one drift issue in line with the run. Throws what the forge throws. */
export function keepGovernanceDriftIssue(forge: Pick<PrForge, "trackIssue">, input: KeepGovernanceDriftIssueInput): Promise<DriftIssueResult> {
  return keepDriftIssue(forge, {
    words: DRIFT_ISSUE_WORDS,
    environment: input.environment,
    records: input.records,
    ...(input.runUrl ? { runUrl: input.runUrl } : {}),
    ...(input.observedAt ? { observedAt: input.observedAt } : {}),
  });
}

/** One line for the job log: `Drift issue: opened #4 <url>`. */
export function describeDriftIssue(r: DriftIssueResult): string {
  return [`Drift issue: ${r.action}`, r.number !== undefined ? `#${r.number}` : "", r.url ?? "", r.why ? `(${r.why})` : ""].filter(Boolean).join(" ");
}
