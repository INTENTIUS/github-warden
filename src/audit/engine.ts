/**
 * Posture-audit engine for github-warden.
 *
 * Wires chant's audit pipeline (fetchRepoFiles → classifyFiles → auditFiles →
 * buildReportModel) over the warden App token, so managed repos — including
 * private ones — are audited with the same token used for reconcile cycles.
 *
 * SCOPE: github-warden governs GitHub, so the audit is GitHub-only. It uses the
 * `github` CI lexicon (path-detected `.github/workflows/*`, audited with the
 * github `postSynthChecks`). Multi-domain IaC auditing (aws/azure/k8s/etc.) is
 * the job of the separate `blacklight` app, not warden.
 *
 * chant imports are bundled by esbuild at build time (see package.json `build`),
 * so the produced `dist/cli.js` runs under plain Node with no `.ts` source load.
 *
 * DETECT-AND-REPORT only. No mutations.
 */

import { fetchRepoFiles } from "@intentius/chant/audit/fetch";
import { classifyFiles } from "@intentius/chant/audit/discover";
import { auditFiles } from "@intentius/chant/audit/core";
import { buildReportModel } from "@intentius/chant/audit/report-model";
import { postSynthChecks as githubChecks } from "@intentius/chant-lexicon-github/lint/post-synth";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The result of auditing a single repo. */
export interface RepoAuditResult {
  /** Full repo URL (e.g. "https://github.com/INTENTIUS/github-warden"). */
  repoUrl: string;
  /** Short slug (owner/name). */
  slug: string;
  /** Number of files scanned. */
  scanned: number;
  /** The structured report model (typed loosely to avoid top-level chant import). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any;
  /** Error message if the repo fetch failed (network error, 404, etc.). */
  error?: string;
}

/** Aggregated posture report across all audited repos. */
export interface PostureReport {
  repos: RepoAuditResult[];
  /** Total findings across all repos, by tier. */
  totals: {
    quickWin: number;
    needsReview: number;
    reportOnly: number;
    total: number;
  };
}

export interface AuditReposOptions {
  /**
   * Rate-limit: max concurrent fetches (GitHub tree-walks). Defaults to 3.
   * Honor the same budget spirit as reconcile cycles.
   */
  concurrency?: number;
  /** Max files per repo passed to fetchRepoFiles (default: 50). */
  maxFiles?: number;
  /**
   * Injectable fetch implementation for testing. When provided, all
   * fetchRepoFiles calls use it — allowing a fixture-based offline test.
   */
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Audit each of the given repo URLs using the provided token, then aggregate
 * results into a PostureReport.
 *
 * The token should be the warden App installation token — this is what allows
 * warden to audit private repos that blacklight (public-only, no token) cannot.
 *
 * Each repo is fetched with `fetchRepoFiles`, which uses the token for auth.
 * Errors on individual repos are recorded but do not abort the rest of the run.
 */
export async function auditRepos(
  repoUrls: string[],
  token: string | undefined,
  opts: AuditReposOptions = {},
): Promise<PostureReport> {
  const concurrency = opts.concurrency ?? 3;
  const maxFiles = opts.maxFiles ?? 50;
  const fetchImpl = opts.fetchImpl;

  const results: RepoAuditResult[] = [];

  // Process in batches of `concurrency`.
  for (let i = 0; i < repoUrls.length; i += concurrency) {
    const batch = repoUrls.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      batch.map((url) => auditOneRepo(url, token, { maxFiles, fetchImpl })),
    );
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        results.push(outcome.value);
      } else {
        // Should not happen: auditOneRepo catches internally, but belt+suspenders.
        results.push({
          repoUrl: "unknown",
          slug: "unknown",
          scanned: 0,
          model: buildReportModel([]),
          error: String(outcome.reason),
        });
      }
    }
  }

  const totals = results.reduce(
    (acc, r) => {
      if (!r.error) {
        acc.quickWin += (r.model.counts?.quickWin ?? 0);
        acc.needsReview += (r.model.counts?.needsReview ?? 0);
        acc.reportOnly += (r.model.counts?.reportOnly ?? 0);
        acc.total += (r.model.counts?.total ?? 0);
      }
      return acc;
    },
    { quickWin: 0, needsReview: 0, reportOnly: 0, total: 0 },
  );

  return { repos: results, totals };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Extract "owner/repo" from a GitHub URL. Falls back to the raw URL. */
function slugFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/^\//, "").replace(/\.git$/, "");
  } catch {
    return url;
  }
}

/**
 * Detectors for classifyFiles. github-warden audits GitHub posture only, so the
 * single detector is the `github` CI lexicon — path-detected (`.github/workflows/*`,
 * name only, no detectTemplate).
 */
const DETECTORS = [{ name: "github" }];

/**
 * Checks provider for auditFiles. Only the `github` lexicon's post-synth checks
 * are wired; any other lexicon name yields no checks.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const checksProvider = async (lexicon: string): Promise<any[]> =>
  lexicon === "github" ? githubChecks : [];

async function auditOneRepo(
  repoUrl: string,
  token: string | undefined,
  opts: { maxFiles: number; fetchImpl?: typeof fetch },
): Promise<RepoAuditResult> {
  const slug = slugFromUrl(repoUrl);
  try {
    const files = await fetchRepoFiles(repoUrl, {
      token,
      maxFiles: opts.maxFiles,
      fetchImpl: opts.fetchImpl,
    });
    const inputs = classifyFiles(files, DETECTORS);
    const findings = await auditFiles(inputs, { checksProvider });
    const model = buildReportModel(findings, {
      files: inputs.map((i: { path: string; content: string }) => ({ path: i.path, content: i.content })),
    });
    return { repoUrl, slug, scanned: files.length, model };
  } catch (err) {
    return {
      repoUrl,
      slug,
      scanned: 0,
      model: buildReportModel([]),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
