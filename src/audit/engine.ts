/**
 * Posture-audit engine for github-warden.
 *
 * Wires chant's audit pipeline (fetchRepoFiles → classifyFiles → auditFiles →
 * buildReportModel) over the warden App token, so managed repos — including
 * private ones — are audited with the same token used for reconcile cycles.
 *
 * All chant imports are lazy (dynamic `import()`) so the module can be loaded
 * in any Node.js environment: the audit engine only runs when actually called,
 * not at module initialisation time.
 *
 * DETECT-AND-REPORT only. No mutations.
 */

// ---------------------------------------------------------------------------
// Public types (no chant imports at the top level — keep module loadable)
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
  // Lazy-load chant's audit pipeline and all lexicon imports.
  const pipeline = await loadPipeline();

  const concurrency = opts.concurrency ?? 3;
  const maxFiles = opts.maxFiles ?? 50;
  const fetchImpl = opts.fetchImpl;

  const results: RepoAuditResult[] = [];

  // Process in batches of `concurrency`.
  for (let i = 0; i < repoUrls.length; i += concurrency) {
    const batch = repoUrls.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      batch.map((url) => auditOneRepo(url, token, { maxFiles, fetchImpl }, pipeline)),
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
          model: pipeline.buildReportModel([]),
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

/** Shape of the lazily-loaded audit pipeline. */
interface AuditPipeline {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetchRepoFiles: (url: string, opts?: any) => Promise<Array<{ path: string; content: string }>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  classifyFiles: (files: any[], plugins: any[]) => any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  auditFiles: (inputs: any[], opts?: any) => Promise<any[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildReportModel: (findings: any[], opts?: any) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  DETECTORS: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checksProvider: (lexicon: string) => Promise<any[]>;
}

/** Lazy-loaded audit pipeline. Resolved once and cached. */
let _pipeline: AuditPipeline | null = null;

/**
 * Dynamically import everything the audit engine needs from chant and the
 * lexicon packages. Called once per process; result is cached.
 *
 * Dynamic imports keep the module-load-time surface to zero — no chant `.ts`
 * files are resolved until the first `auditRepos()` call.
 */
async function loadPipeline(): Promise<AuditPipeline> {
  if (_pipeline) return _pipeline;

  const [
    { fetchRepoFiles },
    { classifyFiles },
    { auditFiles },
    { buildReportModel },
    { detectTemplate: detectK8s },
    { detectTemplate: detectDocker },
    { detectTemplate: detectAws },
    { detectTemplate: detectAzure },
    { detectTemplate: detectGcp },
    { detectTemplate: detectHelm },
    { postSynthChecks: githubChecks },
    { postSynthChecks: gitlabChecks },
    { postSynthChecks: forgejoChecks },
    { postSynthChecks: k8sChecks },
    { postSynthChecks: dockerChecks },
    { postSynthChecks: awsChecks },
    { postSynthChecks: azureChecks },
    { postSynthChecks: gcpChecks },
    { postSynthChecks: helmChecks },
  ] = await Promise.all([
    import("@intentius/chant/audit/fetch"),
    import("@intentius/chant/audit/discover"),
    import("@intentius/chant/audit/core"),
    import("@intentius/chant/audit/report-model"),
    import("@intentius/chant-lexicon-k8s/detect"),
    import("@intentius/chant-lexicon-docker/detect"),
    import("@intentius/chant-lexicon-aws/detect"),
    import("@intentius/chant-lexicon-azure/detect"),
    import("@intentius/chant-lexicon-gcp/detect"),
    import("@intentius/chant-lexicon-helm/detect"),
    import("@intentius/chant-lexicon-github/lint/post-synth"),
    import("@intentius/chant-lexicon-gitlab/lint/post-synth"),
    import("@intentius/chant-lexicon-forgejo/lint/post-synth"),
    import("@intentius/chant-lexicon-k8s/lint/post-synth"),
    import("@intentius/chant-lexicon-docker/lint/post-synth"),
    import("@intentius/chant-lexicon-aws/lint/post-synth"),
    import("@intentius/chant-lexicon-azure/lint/post-synth"),
    import("@intentius/chant-lexicon-gcp/lint/post-synth"),
    import("@intentius/chant-lexicon-helm/lint/post-synth"),
  ]);

  /** Mirrors blacklight's DETECTORS list. */
  const DETECTORS = [
    { name: "github" },
    { name: "gitlab" },
    { name: "forgejo" },
    { name: "k8s", detectTemplate: detectK8s },
    { name: "docker", detectTemplate: detectDocker },
    { name: "aws", detectTemplate: detectAws },
    { name: "azure", detectTemplate: detectAzure },
    { name: "gcp", detectTemplate: detectGcp },
    { name: "helm", detectTemplate: detectHelm },
  ];

  /** Mirrors blacklight's CHECKS map. */
  const CHECKS: Record<string, unknown[]> = {
    github: githubChecks,
    gitlab: gitlabChecks,
    forgejo: [...forgejoChecks, ...githubChecks],
    k8s: k8sChecks,
    docker: dockerChecks,
    aws: awsChecks,
    azure: azureChecks,
    gcp: gcpChecks,
    helm: helmChecks,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const checksProvider = async (lexicon: string): Promise<any[]> => CHECKS[lexicon] ?? [];

  _pipeline = { fetchRepoFiles, classifyFiles, auditFiles, buildReportModel, DETECTORS, checksProvider };
  return _pipeline;
}

async function auditOneRepo(
  repoUrl: string,
  token: string | undefined,
  opts: { maxFiles: number; fetchImpl?: typeof fetch },
  pipeline: AuditPipeline,
): Promise<RepoAuditResult> {
  const slug = slugFromUrl(repoUrl);
  const { fetchRepoFiles, classifyFiles, auditFiles, buildReportModel, DETECTORS, checksProvider } = pipeline;
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
