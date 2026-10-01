/**
 * Required status checks per member pipeline.
 *
 * The check names come from the generated pipelines' job names that chant
 * publishes on `chant workspace ls --json` (`members[].generated[].jobs`,
 * chant 0.101.0 and newer). Only GitHub workflow files count, since the
 * warden manages GitHub.
 */

import type { RulesetConfig } from "../config/types.js";
import type { Workspace } from "./members.js";

export interface MemberChecks {
  member: string;
  /** The workflow files the names came from. */
  files: string[];
  contexts: string[];
}

export interface RequiredChecks {
  members: MemberChecks[];
  /** Members asked for that have no usable GitHub pipeline, with why. */
  skipped: { member: string; reason: string }[];
}

const GITHUB_WORKFLOW = /^\.github\/workflows\/[^/]+$/;

/**
 * The job names of each member's GitHub pipelines. `only` limits it to the
 * named members; a name the workspace doesn't have throws.
 */
export function memberChecks(ws: Workspace, only?: string[]): RequiredChecks {
  const known = new Set(ws.members.map((m) => m.name));
  for (const name of only ?? []) {
    if (!known.has(name)) throw new Error(`[checks] workspace "${ws.name}" has no member "${name}" (members: ${[...known].join(", ")})`);
  }
  const members: MemberChecks[] = [];
  const skipped: RequiredChecks["skipped"] = [];
  for (const m of ws.members) {
    if (only && !only.includes(m.name)) continue;
    const files = m.generated.filter((g) => GITHUB_WORKFLOW.test(g.path));
    if (files.length === 0) {
      skipped.push({ member: m.name, reason: "no generated GitHub workflow (chant older than 0.101 lists none)" });
      continue;
    }
    const unknown = files.filter((g) => g.jobs === null);
    const known = files.filter((g) => g.jobs !== null);
    if (known.length === 0) {
      skipped.push({ member: m.name, reason: `job names unreadable in ${unknown.map((g) => g.path).join(", ")}` });
      continue;
    }
    members.push({
      member: m.name,
      files: known.map((g) => g.path),
      contexts: [...new Set(known.flatMap((g) => g.jobs!))],
    });
  }
  return { members, skipped };
}

/**
 * A ruleset that requires every named check on `branch`
 * (`~DEFAULT_BRANCH` for the default branch). It goes under
 * `repos.<repo>.rulesets` and the rulesets cycle reconciles it.
 */
export function requiredChecksRuleset(checks: RequiredChecks, branch = "~DEFAULT_BRANCH", name = "chant-required-checks"): RulesetConfig {
  const contexts = [...new Set(checks.members.flatMap((m) => m.contexts))];
  const ref = branch === "~DEFAULT_BRANCH" || branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
  return {
    name,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: [ref], exclude: [] } },
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: contexts.map((context) => ({ context })),
        },
      },
    ],
  };
}
