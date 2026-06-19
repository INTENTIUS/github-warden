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
 *   - Private key sourced from a secret via `with:` on the token-minting action,
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
 * actions/create-github-app-token v1.11.6
 * https://github.com/actions/create-github-app-token/releases/tag/v1.11.6
 */
const CREATE_APP_TOKEN_SHA = "df432ceedc7162edd81cf1e418309514dbf04a74";

/**
 * actions/setup-node v4.4.0
 * https://github.com/actions/setup-node/releases/tag/v4.4.0
 */
const SETUP_NODE_SHA = "49933ea5288caeca8642d1e84afbd3f7d6820020";

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
   * Node.js version to use when running the reconcile.
   * Default: `"22"`.
   */
  nodeVersion?: string;

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
    nodeVersion = "22",
    runsOn = "ubuntu-latest",
    timeoutMinutes = 30,
  } = opts;

  const cycleFlag = buildCycleArgs(cycles);

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

  const mintTokenStep = new Step({
    name: "Mint GitHub App token",
    id: "app-token",
    // SHA-pinned to satisfy GHA029. The private key is supplied via `with:` on
    // a `uses:` step — it is never interpolated into a `run:` script (GHA045).
    uses: `actions/create-github-app-token@${CREATE_APP_TOKEN_SHA}`,
    with: {
      "app-id": `\${{ vars.${appIdVar} }}`,
      "private-key": `\${{ secrets.${privateKeySecret} }}`,
    },
  });

  const setupNodeStep = new Step({
    name: "Setup Node.js",
    // SHA-pinned to satisfy GHA029.
    uses: `actions/setup-node@${SETUP_NODE_SHA}`,
    with: { "node-version": nodeVersion },
  });

  const installStep = new Step({
    name: "Install governance CLI",
    run: "npm install --global github-warden",
  });

  // ── Dry-run job (PR) ────────────────────────────────────────────
  //
  // Fires only on `pull_request` events that touch the config file.
  // Computes the change-set and posts the plan as a PR comment.

  const dryRunStep = new Step({
    name: "Dry-run reconcile + post PR comment",
    // GHA045: secrets never appear inside `run:`. The minted token is an
    // ephemeral installation token (not the private key) passed via env.
    env: {
      GH_TOKEN: "${{ steps.app-token.outputs.token }}",
      GOVERNANCE_INSTALLATION_ID: `\${{ vars.${installationIdVar} }}`,
    },
    run: [
      `OUTPUT=$(npx github-warden reconcile \\`,
      `  --config "${configPath}" \\`,
      `  --token-env GH_TOKEN \\`,
      `  --installation-id-env GOVERNANCE_INSTALLATION_ID \\`,
      `  --mode dry-run${cycleFlag} 2>&1) || true`,
      ``,
      `gh pr comment "\${{ github.event.pull_request.number }}" \\`,
      `  --repo "\${{ github.repository }}" \\`,
      `  --body "## Governance dry-run plan\\n\\n\`\`\`\\n\${OUTPUT}\\n\`\`\`"`,
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
    steps: [checkoutStep, mintTokenStep, setupNodeStep, installStep, dryRunStep],
  });

  // ── Apply job (schedule / dispatch) ─────────────────────────────
  //
  // Fires on schedule and on `workflow_dispatch`. Applies the change-set after
  // guardrails pass. Does not run on `pull_request` events.

  const applyStep = new Step({
    name: "Apply reconcile",
    env: {
      GH_TOKEN: "${{ steps.app-token.outputs.token }}",
      GOVERNANCE_INSTALLATION_ID: `\${{ vars.${installationIdVar} }}`,
    },
    run: [
      `npx github-warden reconcile \\`,
      `  --config "${configPath}" \\`,
      `  --token-env GH_TOKEN \\`,
      `  --installation-id-env GOVERNANCE_INSTALLATION_ID \\`,
      `  --mode apply${cycleFlag}`,
    ].join("\n"),
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
    steps: [checkoutStep, mintTokenStep, setupNodeStep, installStep, applyStep],
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
