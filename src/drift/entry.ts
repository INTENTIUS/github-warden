/**
 * The module a `drift.reader` in workspace-kinds.json names
 * (INTENTIUS/chant#5068). `chant workspace drift --member <name>` imports it
 * in its own process and calls the default export with the member's
 * directory and the kind's `drift.config`; it reads the policy there, runs a
 * dry-run reconcile against GitHub and returns the drift stream
 * (`./reader.ts`).
 *
 * Credentials come from the environment. The token is read from `GH_TOKEN`
 * (the variable the docs pass to `--token-env`), or from the variable
 * `drift.config.tokenEnv` names. When no token is set, the reader mints an
 * installation token from the App ID in `GOVERNANCE_APP_ID`, the installation
 * ID in `GOVERNANCE_INSTALLATION_ID` and the private key in
 * `GOVERNANCE_APP_PRIVATE_KEY` (or `GITHUB_APP_PRIVATE_KEY`), as the CLI's App
 * auth does; `drift.config.appIdEnv` and `installationIdEnv` name other
 * variables. chant reads `drift.config` only from this package's
 * workspace-kinds.json, so the defaults are what a workspace gets. The API base is
 * `GITHUB_API_URL` when set (GitHub Actions sets it, and it points at a GHES
 * instance there), else https://api.github.com; `drift.config.baseUrlEnv`
 * names another variable. Missing credentials or a missing policy are a
 * refusal (`no-drift-read`), never a throw.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DriftReaderInput, DriftReaderOutput } from "@intentius/chant/workspace/drift-reader";
import { createAppClient, type AppClient } from "../auth/app-client.js";
import { createTokenClient, GITHUB_API_URL } from "../auth/token-client.js";
import { CYCLE_REGISTRY } from "../cli/registry.js";
import { POLICY_FILE, TS_POLICY_FILE } from "../config/policy-path.js";
import { loadGovernancePolicy } from "../config/policy.js";
import { runReconcile, type Cycle } from "../reconcile/runner.js";
import { declaredNodes, DRIFT_READ, driftLines, governanceDrift } from "./reader.js";

export const DEFAULT_TOKEN_ENV = "GH_TOKEN";
export const DEFAULT_BASE_URL_ENV = "GITHUB_API_URL";
export const DEFAULT_APP_ID_ENV = "GOVERNANCE_APP_ID";
export const DEFAULT_INSTALLATION_ID_ENV = "GOVERNANCE_INSTALLATION_ID";
const PRIVATE_KEY_ENVS = ["GOVERNANCE_APP_PRIVATE_KEY", "GITHUB_APP_PRIVATE_KEY"];

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** How the reader authenticates: a token, or a GitHub App installation. */
export type DriftAuth =
  | { token: string; baseUrl: string }
  | { appId: string; installationId: string; privateKeyPem: string; baseUrl: string };

export interface DriftEntryDeps {
  env?: NodeJS.ProcessEnv;
  /** Build the client; tests pass a mock. */
  client?: (auth: DriftAuth) => AppClient;
  /** The cycles to run. Default every registered cycle. */
  cycles?: Cycle[];
}

function defaultClient(auth: DriftAuth): AppClient {
  return "token" in auth ? createTokenClient({ token: auth.token, baseUrl: auth.baseUrl }) : createAppClient(auth);
}

/** The policy in `dir`: `config.file` (default governance.yml), or governance.ts when the default YAML is absent. */
export function memberPolicyPath(dir: string, file: string | undefined): string | undefined {
  const given = join(dir, file ?? POLICY_FILE);
  if (existsSync(given)) return given;
  if (file !== undefined && file !== POLICY_FILE) return undefined;
  const ts = join(dir, TS_POLICY_FILE);
  return existsSync(ts) ? ts : undefined;
}

/** The credentials the environment gives, or why there are none. */
export function driftAuth(config: Record<string, unknown>, env: NodeJS.ProcessEnv): DriftAuth | { missing: string } {
  const baseUrl = env[str(config.baseUrlEnv) ?? DEFAULT_BASE_URL_ENV] || GITHUB_API_URL;
  const tokenEnv = str(config.tokenEnv) ?? DEFAULT_TOKEN_ENV;
  const token = env[tokenEnv]?.trim();
  if (token) return { token, baseUrl };

  const appIdEnv = str(config.appIdEnv) ?? DEFAULT_APP_ID_ENV;
  const installationIdEnv = str(config.installationIdEnv) ?? DEFAULT_INSTALLATION_ID_ENV;
  const unset = [appIdEnv, installationIdEnv].filter((v) => !env[v]);
  const keyEnv = PRIVATE_KEY_ENVS.find((v) => env[v]);
  if (!keyEnv) unset.push(PRIVATE_KEY_ENVS.join(" or "));
  if (unset.length > 0) return { missing: `${tokenEnv} is not set, and for App auth ${unset.join(", ")} ${unset.length === 1 ? "is" : "are"} not set` };
  return { appId: env[appIdEnv]!, installationId: env[installationIdEnv]!, privateKeyPem: env[keyEnv!]!, baseUrl };
}

/** The reader with its environment, client and cycles injectable, for tests. */
export async function readMemberDrift(input: DriftReaderInput, deps: DriftEntryDeps = {}): Promise<DriftReaderOutput> {
  const env = deps.env ?? process.env;
  if (input.read !== undefined && input.read !== DRIFT_READ) {
    return { refused: { code: "read-unsupported", message: `github-warden answers the ${DRIFT_READ} read only (a reconcile dry run), not ${input.read}` } };
  }
  if (input.stack !== undefined) {
    return { refused: { code: "read-unsupported", message: "github-warden has no stacks; a governance member is read whole" } };
  }

  const config = input.config ?? {};
  const auth = driftAuth(config, env);
  if ("missing" in auth) {
    return { refused: { code: "no-drift-read", message: `${auth.missing}, so github-warden cannot read GitHub for ${input.member}'s drift` } };
  }

  const file = str(config.file);
  const path = memberPolicyPath(resolve(input.dir), file);
  if (!path) {
    return { refused: { code: "no-drift-read", message: `${input.member} has no governance policy: no ${file ?? `${POLICY_FILE} or ${TS_POLICY_FILE}`} in ${input.dir}` } };
  }
  const { config: policy } = await loadGovernancePolicy(path, "fold");

  let scope = policy;
  if (input.resource !== undefined) {
    const org = Object.entries(declaredNodes(policy)).find(([, ids]) => ids.includes(input.resource!))?.[0];
    if (org === undefined) return { refused: { code: "no-drift-read", message: `${input.member}'s policy declares no ${input.resource}` } };
    // A node's drift is its org's: reconcile that org alone.
    scope = { ...policy, orgs: { [org]: policy.orgs[org]! } };
  }

  const client = (deps.client ?? defaultClient)(auth);
  const result = await runReconcile({ config: scope, client, cycles: deps.cycles ?? Object.values(CYCLE_REGISTRY), mode: "dry-run" });
  const { start, records } = governanceDrift({
    member: input.member,
    observedAt: input.observedAt,
    policy: scope,
    changeSets: result.changeSets,
    errored: result.errored,
    deferred: result.deferred,
    ...(input.resource !== undefined ? { resource: input.resource } : {}),
  });
  return { lines: driftLines(start, records, input.observedAt) };
}

export default function readDrift(input: DriftReaderInput): Promise<DriftReaderOutput> {
  return readMemberDrift(input);
}
