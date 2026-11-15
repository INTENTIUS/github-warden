/**
 * Where the governance policy lives.
 *
 * `--config` names the policy file. Without it, the CLI reads
 * `governance.yml` in the working directory, the name all three wardens read.
 */

import { existsSync } from "node:fs";

export const POLICY_FILE = "governance.yml";

/**
 * Resolve the policy path. `given` is `--config`, read as given whether or not
 * it exists. Without it, `governance.yml` in the working directory; undefined
 * when that file is absent, so the caller can say so.
 */
export function resolvePolicyPath(
  given: string | undefined,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  if (given !== undefined) return given;
  return exists(POLICY_FILE) ? POLICY_FILE : undefined;
}

/** The message for a run with no `--config` and no default policy file. */
export const NO_POLICY_MESSAGE = `no --config given and no ${POLICY_FILE} in the working directory`;
