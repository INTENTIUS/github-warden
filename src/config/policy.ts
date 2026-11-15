/**
 * The governance policy, loaded from YAML, JSON, or TypeScript.
 *
 * A `.ts` policy is data: an object literal typed by `GovernanceConfig`,
 * exported as `default`. By default it is *folded*, reduced to its value by
 * `@intentius/tsad-reference` without being run, so the plan is a function of
 * the file and nothing else and no code executes to produce it. `run` mode
 * imports the file instead, for a user who wants typed JSON and does not care
 * how it was evaluated; `check` mode does both and refuses if they differ,
 * which is the guarantee folding provides made visible.
 *
 * Selective-by-omission survives either way: an `undefined`-valued property
 * is treated as absent, the same as JSON would leave it.
 *
 * Every form goes through `loadGovernanceConfig`, so a `.ts` policy gets the
 * same validation errors as a YAML one.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { GovernanceConfig } from "./types.js";
import { GovernanceConfigError, loadGovernanceConfig } from "./load.js";
import { parseConfigFile } from "./parse.js";
import type { FieldOrigin, PolicyProvenance } from "../reconcile/origin.js";

export type ConfigMode = "fold" | "run" | "check";

export const CONFIG_MODES: readonly ConfigMode[] = ["fold", "run", "check"];

/** Every `.ts` file under the policy's directory, keyed relative to it, so the policy may import siblings. */
function projectFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts")) {
        files.set(relative(root, abs).split("\\").join("/"), readFileSync(abs, "utf-8"));
      }
    }
  };
  walk(root);
  return files;
}

function policyOf(exports: Record<string, unknown>, where: string): unknown {
  // `export default` is the idiom and folds under the data-host profile
  // (spec 1.2, S-ExportDefault); `export const policy` is accepted too.
  if ("default" in exports) return exports.default;
  if ("policy" in exports) return exports.policy;
  throw new GovernanceConfigError(where, "must export the policy as `export default`");
}

/**
 * Where the fold says each field came from, keyed by its path in the policy
 * (`orgs["my-org"].repos.api.hasWiki`). Locations are rewritten from project
 * paths to paths relative to the working directory (absolute when the policy
 * is outside it), so a plan line points at a file the reader can open.
 */
function policyProvenance(
  exportName: string,
  paths: Record<string, FieldOrigin> | undefined,
  root: string,
): PolicyProvenance | undefined {
  if (!paths) return undefined;
  const display = (file: string): string => {
    const abs = resolve(root, file);
    const rel = relative(process.cwd(), abs);
    return (rel.startsWith("..") ? abs : rel).split("\\").join("/");
  };
  const relocate = <T extends { file: string }>(at: T | undefined): T | undefined => (at ? { ...at, file: display(at.file) } : undefined);
  const out: Record<string, FieldOrigin> = {};
  for (const [path, origin] of Object.entries(paths)) {
    // The reference writes paths from the export name: `default.orgs...`.
    if (!path.startsWith(exportName)) continue;
    const rest = path.slice(exportName.length).replace(/^\./, "");
    let o: FieldOrigin = origin;
    if (o.kind === "composite-parameter") {
      o = {
        ...o,
        call: relocate(o.call),
        arguments: o.arguments
          ? Object.fromEntries(Object.entries(o.arguments).map(([k, at]) => [k, relocate(at)!]))
          : undefined,
      };
    } else if (o.kind === "composite-literal") {
      o = { ...o, call: relocate(o.call), literal: relocate(o.literal) };
    }
    out[rest] = JSON.parse(JSON.stringify(o)) as FieldOrigin;
  }
  return { paths: out };
}

/** Fold the policy with the reference evaluator: no execution, a located refusal if the file is not data. */
async function foldPolicy(path: string): Promise<{ value: unknown; provenance?: PolicyProvenance }> {
  // The data-host profile (spec 1.2, F-Profile-DataHost): no runtime, and a
  // default export is the declarator named `default`, which is the idiom.
  const { foldProject, EMPTY_HOST } = await import("@intentius/tsad-reference");
  const root = dirname(resolve(path));
  const key = relative(root, resolve(path)).split("\\").join("/");
  const verdicts = foldProject(projectFiles(root), { ...EMPTY_HOST, profile: "data-host" }).verdicts;
  const verdict = verdicts.get(key);
  if (!verdict) throw new GovernanceConfigError(path, "not found among the project's files");
  if (verdict.kind === "run") {
    throw new GovernanceConfigError(path, `the policy is not data (${verdict.rule}): ${verdict.reason}`);
  }
  const exports = Object.fromEntries(verdict.exports);
  const value = policyOf(exports, path);
  const exportName = "default" in exports ? "default" : "policy";
  const reported = (verdict as { provenance?: Map<string, Record<string, FieldOrigin>> }).provenance;
  return { value, provenance: policyProvenance(exportName, reported?.get(exportName), dirname(path)) };
}

/** Import the policy: whatever the file does, its export is the policy. */
async function runPolicy(path: string): Promise<unknown> {
  const mod = (await import(pathToFileURL(resolve(path)).href)) as Record<string, unknown>;
  return policyOf(mod, path);
}

/** JSON's view of a value: `undefined` properties absent, keys sorted, so two loads compare as the policy the cycles will read. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(sort);
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
  };
  return JSON.stringify(sort(JSON.parse(JSON.stringify(value) ?? "null")));
}

/** Validate a policy value. JSON's view first, so fold and run agree by construction on `undefined` properties. */
function validate(raw: unknown): GovernanceConfig {
  return loadGovernanceConfig(raw === undefined ? undefined : JSON.parse(JSON.stringify(raw)));
}

/** A loaded policy, and where each field came from when the policy was folded. */
export interface LoadedPolicy {
  config: GovernanceConfig;
  /** Present only for a `.ts` policy loaded in `fold` or `check` mode. */
  provenance?: PolicyProvenance;
}

/**
 * Load the policy at `path`. A `.ts` file is folded, run or both by `mode`;
 * `.json` is parsed as JSON; anything else goes through the built-in YAML
 * reader. Throws `GovernanceConfigError` when the policy is invalid, is not
 * data, or folding and running disagree; a file that cannot be read or parsed
 * throws the underlying error.
 */
export async function loadGovernancePolicy(path: string, mode: ConfigMode = "fold"): Promise<LoadedPolicy> {
  if (path.toLowerCase().endsWith(".ts")) {
    if (mode === "run") return { config: validate(await runPolicy(path)) };
    const folded = await foldPolicy(path);
    if (mode === "check") {
      const ran = await runPolicy(path);
      if (canonical(folded.value) !== canonical(ran)) {
        throw new GovernanceConfigError(
          path,
          `folding and running the policy disagree, so the file is not data; the run result is ${canonical(ran)} and the fold is ${canonical(folded.value)}`,
        );
      }
    }
    return { config: validate(folded.value), provenance: folded.provenance };
  }
  return { config: loadGovernanceConfig(parseConfigFile(path, readFileSync(path, "utf-8"))) };
}
