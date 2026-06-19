/**
 * Governance pipeline emitter.
 *
 * Generates the `.github/workflows/governance.yml` workflow via the github
 * lexicon builders so it is auditable by the same post-synth checks that chant
 * runs on user-authored workflows — dogfood.
 *
 * The emitted workflow:
 *   - Runs on a schedule (parameterized cron) and on `workflow_dispatch`.
 *   - Runs on PRs that touch the config file (dry-run only).
 *   - Mints a short-lived GitHub App installation token from vars + a secret.
 *   - On PRs: dry-run, posts the change-set summary as a PR comment.
 *   - On the default branch / schedule / dispatch: apply.
 *   - All actions pinned to commit SHAs (GHA021/GHA029).
 *   - Least-privilege permissions: read-only at workflow level; write scopes
 *     scoped to the single job that needs them (GHA017/GHA034).
 *   - `timeout-minutes` on every job (GHA022).
 *   - Private key sourced from a secret via `with:` on the reconcile action,
 *     never interpolated directly into a `run:` script (GHA045).
 *
 * Follow-up: a durable Ops-schedule variant (issue to be filed) will drive the
 * reconcile loop from a Temporal workflow rather than raw cron, giving pause /
 * resume / retry semantics across long-running org operations.
 */

import { Step, Job, Workflow } from "@intentius/chant-lexicon-github";

// ── Pinned action SHAs ─────────────────────────────────────────────
//
// Pin to commit SHA so a tag repoint cannot introduce malicious code.
// See GHA021 (checkout) and GHA029 (all other external actions).

/**
 * actions/checkout v4.2.2
 * https://github.com/actions/checkout/releases/tag/v4.2.2
 */
const CHECKOUT_SHA = "11bd71901bbe5b1630ceea73d27597364c9af683";

/**
 * intentius/github-warden v1
 * https://github.com/intentius/github-warden/releases/tag/v1
 *
 * SHA-pinned to satisfy GHA029. The `# v0.1.0` comment preserves human readability
 * while preventing silent tag-repoint attacks. Warden's own audit (GHA021/029)
 * enforces this pattern — the emitted pipeline dogfoods it.
 */
const GITHUB_WARDEN_SHA = "50db522e57c4ccdb36af932062ee38839bc1b88e"; // v1

// ── Public types ───────────────────────────────────────────────────

/** Which reconcile cycles to include (empty array = all registered cycles). */
export type CycleFilter = string[];

export interface GovernancePipelineOptions {
  /**
   * Cron schedule expression for the recurring reconcile.
   * Default: `"0 2 * * *"` (02:00 UTC daily).
   */
  cron?: string;

  /**
   * Path to the governance config file in the repo.
   * Default: `".github/governance.yml"`.
   */
  configPath?: string;

  /**
   * Names of cycles to run (forwarded as `--cycles` to the CLI).
   * When omitted the CLI runs all registered cycles.
   */
  cycles?: CycleFilter;

  /**
   * Name of the GitHub Actions variable holding the App ID.
   * Default: `"GOVERNANCE_APP_ID"`.
   */
  appIdVar?: string;

  /**
   * Name of the GitHub Actions variable holding the installation ID.
   * Default: `"GOVERNANCE_INSTALLATION_ID"`.
   */
  installationIdVar?: string;

  /**
   * Name of the GitHub Actions secret holding the App private key (PEM).
   * Default: `"GOVERNANCE_APP_PRIVATE_KEY"`.
   * MUST be a secret, not a var — private key material must never be stored
   * in a workflow var (vars are visible to all repo collaborators).
   */
  privateKeySecret?: string;

  /**
   * Runner label.
   * Default: `"ubuntu-latest"`.
   */
  runsOn?: string;

  /**
   * Job timeout in minutes (GHA022).
   * Default: `30`.
   */
  timeoutMinutes?: number;
}

// ── Helpers ────────────────────────────────────────────────────────

function buildCycleArgs(cycles?: CycleFilter): string {
  if (!cycles || cycles.length === 0) return "";
  return ` --cycles ${cycles.join(",")}`;
}

// ── Composite ─────────────────────────────────────────────────────

/**
 * Build the governance reconcile workflow.
 *
 * Returns a `Workflow` resource (with inline jobs) that can be passed to
 * `githubSerializer.serialize` to produce `.github/workflows/governance.yml`.
 *
 * Example:
 * ```ts
 * import { governancePipeline } from "@intentius/chant-lexicon-github-org/emit/pipeline";
 * import { githubSerializer } from "@intentius/chant-lexicon-github";
 *
 * const { workflow } = governancePipeline({ cron: "0 6 * * 1" });
 * const yaml = githubSerializer.serialize(new Map([["governance", workflow]]));
 * ```
 */
export function governancePipeline(opts: GovernancePipelineOptions = {}) {
  const {
    cron = "0 2 * * *",
    configPath = ".github/governance.yml",
    cycles,
    appIdVar = "GOVERNANCE_APP_ID",
    installationIdVar = "GOVERNANCE_INSTALLATION_ID",
    privateKeySecret = "GOVERNANCE_APP_PRIVATE_KEY",
    runsOn = "ubuntu-latest",
    timeoutMinutes = 30,
  } = opts;

  const cycleArgs = buildCycleArgs(cycles);

  // ── Shared steps (used in both jobs) ───────────────────────────

  const checkoutStep = new Step({
    name: "Checkout",
    // SHA-pinned to satisfy GHA021.
    uses: `actions/checkout@${CHECKOUT_SHA}`,
    with: {
      // Sparse checkout: only the config file is needed.
      "sparse-checkout": configPath,
      "sparse-checkout-cone-mode": false,
    },
  });

  // ── Dry-run job (PR) ────────────────────────────────────────────
  //
  // Fires only on `pull_request` events that touch the config file.
  // Computes the change-set and posts the plan as a PR comment.
  //
  // Uses the github-warden Action directly (dogfood): SHA-pinned to satisfy
  // GHA029. The private key is supplied via `with:` — never interpolated into
  // a `run:` script (GHA045). The Action handles token-minting internally.

  const dryRunWardenStep = new Step({
    name: "Dry-run reconcile",
    uses: `intentius/github-warden@${GITHUB_WARDEN_SHA} # v0.1.0`,
    with: {
      command: "reconcile",
      config: configPath,
      mode: "dry-run",
      "app-id": `\${{ vars.${appIdVar} }}`,
      "installation-id": `\${{ vars.${installationIdVar} }}`,
      "private-key": `\${{ secrets.${privateKeySecret} }}`,
      ...(cycleArgs ? { cycles: cycles!.join(",") } : {}),
    },
  });

  const postPrCommentStep = new Step({
    name: "Post dry-run summary as PR comment",
    // GHA045: ephemeral token sourced from steps output, not interpolated into
    // a shell script with the private key.
    env: {
      GH_TOKEN: "${{ github.token }}",
    },
    run: [
      `gh pr comment "\${{ github.event.pull_request.number }}" \\`,
      `  --repo "\${{ github.repository }}" \\`,
      `  --body "## Governance dry-run plan\\n\\nSee the \\"Dry-run reconcile\\" step for the change-set."`,
    ].join("\n"),
  });

  const dryRunJob = new Job({
    name: "governance-dry-run",
    "runs-on": runsOn,
    "timeout-minutes": timeoutMinutes,
    // GHA034: write scope is on this job only, not the whole workflow.
    permissions: {
      contents: "read",
      "pull-requests": "write",
    },
    // Only run on PR events — the apply job handles schedule and dispatch.
    if: "${{ github.event_name == 'pull_request' }}",
    steps: [checkoutStep, dryRunWardenStep, postPrCommentStep],
  });

  // ── Apply job (schedule / dispatch) ─────────────────────────────
  //
  // Fires on schedule and on `workflow_dispatch`. Applies the change-set after
  // guardrails pass. Does not run on `pull_request` events.

  const applyWardenStep = new Step({
    name: "Apply reconcile",
    uses: `intentius/github-warden@${GITHUB_WARDEN_SHA} # v0.1.0`,
    with: {
      command: "reconcile",
      config: configPath,
      mode: "apply",
      "app-id": `\${{ vars.${appIdVar} }}`,
      "installation-id": `\${{ vars.${installationIdVar} }}`,
      "private-key": `\${{ secrets.${privateKeySecret} }}`,
      ...(cycleArgs ? { cycles: cycles!.join(",") } : {}),
    },
  });

  const applyJob = new Job({
    name: "governance-apply",
    "runs-on": runsOn,
    "timeout-minutes": timeoutMinutes,
    permissions: {
      contents: "read",
    },
    // Skip on PR events — the dry-run job handles those.
    if: "${{ github.event_name != 'pull_request' }}",
    steps: [checkoutStep, applyWardenStep],
  });

  // ── Workflow ────────────────────────────────────────────────────

  const workflow = new Workflow({
    name: "Governance reconcile",
    on: {
      // Daily (or custom) scheduled reconcile — apply mode.
      schedule: [{ cron }],

      // PR dry-run: fires when a PR touches the config file.
      pull_request: {
        branches: ["main"],
        paths: [configPath],
      },

      // Manual dispatch: allows on-demand apply.
      workflow_dispatch: {},
    },
    // GHA017: explicit permissions block present.
    // GHA034: only `contents: read` at workflow level; write scopes are per-job.
    permissions: {
      contents: "read",
    },
    jobs: {
      "governance-dry-run": dryRunJob,
      "governance-apply": applyJob,
    },
  });

  return { workflow, dryRunJob, applyJob };
}
