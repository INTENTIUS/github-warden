/**
 * Where the governance policy lives.
 *
 * `--config` names the policy file, read as given. Without it, the CLI reads
 * `governance.yml` in the working directory, the name all three wardens read,
 * and `governance.ts` when there is no `governance.yml`. A YAML policy wins
 * when both are present.
 */

import { existsSync } from "node:fs";

export const POLICY_FILE = "governance.yml";
export const TS_POLICY_FILE = "governance.ts";

/**
 * Resolve the policy path. `given` is `--config`, read as given whether or not
 * it exists. Without it, `governance.yml` then `governance.ts` in the working
 * directory; undefined when neither is there, so the caller can say so.
 */
export function resolvePolicyPath(
  given: string | undefined,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  if (given !== undefined) return given;
  return [POLICY_FILE, TS_POLICY_FILE].find((name) => exists(name));
}

/** The message for a run with no `--config` and no default policy file. */
export const NO_POLICY_MESSAGE = `no --config given and no ${POLICY_FILE} or ${TS_POLICY_FILE} in the working directory`;
