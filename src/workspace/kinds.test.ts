import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";

// The forge-governance member kind (INTENTIUS/chant#3180): a data-only kinds
// file chant reads at the package's ./workspace-kinds subpath, and a JSON
// Schema that chant checks the member's governance file against (WSP012).

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (rel: string): any => JSON.parse(readFileSync(join(root, rel), "utf-8"));

const pkg = readJson("package.json");
const kinds = readJson("workspace-kinds.json");
const kind = kinds.kinds[0];
const schema = readJson(kind.memberFile.schema);
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

// chant's own schema for a kinds file: what chant checks this file against
// before it registers the kind.
const kindsSchema = createRequire(import.meta.url)("@intentius/chant/workspace/workspace-kinds.schema.json");
const validateKinds = new Ajv2020({ allErrors: true, strict: false }).compile(kindsSchema);

const sample = parseYaml(readFileSync(join(root, "examples", "governance.yml"), "utf-8"));

describe("forge-governance kinds file", () => {
  test("declares one kind, with the fields chant reads", () => {
    expect(kinds.schema).toBe(1);
    expect(kinds.kinds).toHaveLength(1);
    expect(kind.name).toBe("forge-governance");
    expect(kind.precedence).toBeGreaterThan(0);
    expect(kind.precedence).toBeLessThan(500);
    expect(kind.outputs).toEqual(["repos", "teams"]);
    expect(kind.graph.reader).toBe("dist/graph-reader.mjs");
    expect(kind.drift).toEqual({ reader: "dist/drift-reader.mjs", config: { dir: "{dir}", file: "governance.yml" } });
    expect(pkg.scripts.build).toContain("npm run build:drift");
    expect(pkg.scripts["build:drift"]).toContain("--outfile=dist/drift-reader.mjs");
  });

  test("validates against chant's workspace-kinds.schema.json", () => {
    expect(validateKinds(kinds), JSON.stringify(validateKinds.errors, null, 2)).toBe(true);
  });

  test("chant's kinds schema refuses a kind with both a lexicon and a reader", () => {
    const bad = structuredClone(kinds);
    bad.kinds[0].graph.lexicon = "github";
    expect(validateKinds(bad)).toBe(false);
  });

  test("probes for the file it checks", () => {
    expect(kind.probe).toEqual({ anyFile: [kind.memberFile.path] });
  });

  test("is exported and shipped by the package", () => {
    expect(pkg.exports["./workspace-kinds"]).toBe("./workspace-kinds.json");
    expect(pkg.files).toContain("workspace-kinds.json");
    expect(pkg.files).toContain("schemas");
  });
});

describe("forge-governance member file schema", () => {
  test("accepts the sample policy", () => {
    expect(validate(sample), JSON.stringify(validate.errors)).toBe(true);
  });

  test("refuses a policy without its top-level map", () => {
    expect(validate({})).toBe(false);
  });

  test("refuses a misspelled field", () => {
    const bad = structuredClone(sample) as any;
    const top = bad.orgs ?? bad.nodes;
    const first = top[Object.keys(top)[0]];
    first.settngs = {};
    expect(validate(bad)).toBe(false);
    expect(JSON.stringify(validate.errors)).toContain("settngs");
  });
});
