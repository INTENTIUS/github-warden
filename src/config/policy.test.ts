import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadGovernancePolicy } from "./policy.js";
import { GovernanceConfigError } from "./load.js";

const ex = (name: string) => resolve(import.meta.dirname, "..", "..", "examples", name);
const load = async (path: string, mode?: "fold" | "run" | "check") => (await loadGovernancePolicy(path, mode)).config;

/** A fresh directory holding one policy file. Left in the OS temp dir. */
function policyFile(name: string, text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gw-policy-"));
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
}

describe("loadGovernancePolicy", () => {
  it("a .ts policy folded, a .ts policy run, and the .yml load to the same object", async () => {
    const yml = await load(ex("governance.yml"));
    const folded = await load(ex("governance.ts"), "fold");
    const ran = await load(ex("governance.ts"), "run");
    expect(folded).toEqual(yml);
    expect(ran).toEqual(yml);
    expect(folded.orgs["my-org"].repos?.["my-repo"].branchProtection?.[0].pattern).toBe("main");
  });

  it("fold is the default mode", async () => {
    expect((await loadGovernancePolicy(ex("governance.ts"))).provenance).toBeDefined();
  });

  it("check mode passes when folding and running agree", async () => {
    await expect(load(ex("governance.ts"), "check")).resolves.toBeTruthy();
  });

  it("a policy that reads the environment is refused by fold, with the line, and accepted by run", async () => {
    await expect(load(ex("not-data.ts"))).rejects.toThrow(GovernanceConfigError);
    await expect(load(ex("not-data.ts"))).rejects.toThrow(/not data/);
    await expect(load(ex("not-data.ts"))).rejects.toThrow(/\d+:\d+/);
    await expect(load(ex("not-data.ts"), "check")).rejects.toThrow(/not data/);
    const ran = await load(ex("not-data.ts"), "run");
    expect(ran.orgs["my-org"].repos?.["my-repo"].hasWiki).toBe(false);
  });

  it("an undefined property is absent, the way JSON leaves it, so selective-by-omission holds", async () => {
    const p = policyFile("governance.ts", "const on = false;\nexport default { orgs: { o: { repos: { r: { hasWiki: on ? true : undefined } } } } };\n");
    for (const mode of ["fold", "run"] as const) {
      const config = await load(p, mode);
      expect("hasWiki" in (config.orgs.o.repos?.r ?? {})).toBe(false);
    }
  });

  it("accepts `export const policy`", async () => {
    const p = policyFile("governance.ts", "export const policy = { orgs: { o: { repos: { r: { hasWiki: true } } } } };\n");
    expect((await load(p)).orgs.o.repos?.r.hasWiki).toBe(true);
  });

  it("refuses a .ts file with no policy export", async () => {
    const p = policyFile("governance.ts", "export const other = { orgs: {} };\n");
    await expect(load(p)).rejects.toThrow(/export default/);
  });

  it("a .ts policy gets the same validation errors as YAML", async () => {
    const p = policyFile("governance.ts", 'export default { orgs: { o: { repos: { r: { hasWiki: "yes" } } } } };\n');
    await expect(load(p)).rejects.toThrow(GovernanceConfigError);
    await expect(load(p)).rejects.toThrow(/hasWiki/);
  });

  it("refuses a config with no orgs map", async () => {
    const p = policyFile("governance.json", "{}");
    await expect(load(p)).rejects.toThrow(/orgs/);
  });

  it("YAML and JSON carry no provenance", async () => {
    expect((await loadGovernancePolicy(ex("governance.yml"))).provenance).toBeUndefined();
  });
});
