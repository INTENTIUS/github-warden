/**
 * The chant/lifecycle branch, read from chant's read contract.
 *
 * `chant workspace status <env> --json` names the branch (`lifecycle.ref`) and,
 * for each member, where its release ledger and gate ledger sit on it. The
 * warden reads those, and builds the ruleset that protects the branch.
 */

import type { RulesetConfig } from "../config/types.js";
import { READ_CONTRACT, runChantJson, WorkspaceReadError, type CommandRunner, defaultRunner } from "./members.js";

export interface LedgerPath {
  /** Path on the lifecycle branch. */
  path: string;
  layout: "members" | "flat";
}

export interface MemberLifecycle {
  name: string;
  /** One release ledger per environment the command showed. */
  releases: (LedgerPath & { env: string })[];
  /** The gate ledger directory, or null when the document gives none. */
  gates: LedgerPath | null;
}

export interface Lifecycle {
  /** The branch, as the contract names it (`lifecycle.ref`). */
  ref: string;
  /** The local branch tip chant read, null when the checkout has no such branch. */
  commit: string | null;
  members: MemberLifecycle[];
}

function ledger(o: unknown): LedgerPath | null {
  if (!o || typeof o !== "object") return null;
  const l = o as Record<string, unknown>;
  if (typeof l["path"] !== "string") return null;
  return { path: l["path"], layout: l["layout"] === "members" ? "members" : "flat" };
}

/** Parse one `chant workspace status --json` document. */
export function parseStatusDocument(stdout: string): Lifecycle {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    throw new WorkspaceReadError("`chant workspace status --json` did not print JSON");
  }
  const d = (doc ?? {}) as Record<string, unknown>;
  if (d["contract"] !== READ_CONTRACT) {
    throw new WorkspaceReadError(
      `read contract ${String(d["contract"])} is not supported, this warden reads contract ${READ_CONTRACT}`,
    );
  }
  if (d["error"] && typeof d["error"] === "object") {
    const e = d["error"] as { code?: unknown; message?: unknown };
    throw new WorkspaceReadError(`chant could not read the workspace: ${String(e.code)}: ${String(e.message)}`);
  }
  const lc = d["lifecycle"] as Record<string, unknown> | undefined;
  if (!lc || typeof lc["ref"] !== "string" || !Array.isArray(d["members"])) {
    throw new WorkspaceReadError("`chant workspace status --json` document lacks lifecycle or members");
  }
  const members: MemberLifecycle[] = (d["members"] as Record<string, unknown>[]).map((m, i) => {
    if (typeof m["name"] !== "string") throw new WorkspaceReadError(`members[${i}] lacks a name`);
    const envs = Array.isArray(m["environments"]) ? (m["environments"] as Record<string, unknown>[]) : [];
    const releases: MemberLifecycle["releases"] = [];
    for (const e of envs) {
      const l = ledger(e["ledger"]);
      if (l && typeof e["env"] === "string") releases.push({ env: e["env"], ...l });
    }
    return { name: m["name"], releases, gates: ledger(m["gateLedger"]) };
  });
  return { ref: lc["ref"], commit: typeof lc["commit"] === "string" ? lc["commit"] : null, members };
}

/** Run `chant workspace status <env> --json` in `dir` and read the lifecycle from it. */
export async function readLifecycle(dir: string, env: string, run: CommandRunner = defaultRunner): Promise<Lifecycle> {
  const out = await runChantJson(dir, ["workspace", "status", env, "--json"], `chant workspace status ${env} --json`, run);
  return parseStatusDocument(out);
}

/**
 * The ruleset that protects the lifecycle branch: it can't be deleted and its
 * history can't be rewritten. Appending commits, which is how releases and
 * gate facts are recorded, stays allowed. The result goes under
 * `repos.<repo>.rulesets` in the governance config, and the rulesets cycle
 * reconciles it.
 */
export function lifecycleRuleset(ref: string, name = "chant-lifecycle"): RulesetConfig {
  return {
    name,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: [`refs/heads/${ref}`], exclude: [] } },
    rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
  };
}
