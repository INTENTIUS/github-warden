import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { composeWorkspaceGraph, readMemberIr } from "@intentius/chant/workspace/compose-graph";
import { GRAPH_CONTRACT_VERSION, GRAPH_OUTPUT_SCHEMA_ID } from "@intentius/chant/workspace/graph-cli";
import read from "./entry.js";

// The graph reader's output for the example policy, composed the way
// `chant workspace graph` composes a member, must satisfy chant's workspace
// graph schema (the read contract a forge-governance member's graph is part of).

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const graphSchema = require("@intentius/chant/workspace/graph.schema.json");

describe("graph reader output against chant's graph.schema.json", () => {
  const ir = read({ dir: join(root, "examples"), config: { file: "governance.yml" } });

  test("the reader's IR is what chant reads from a member", () => {
    const parsed = readMemberIr(JSON.stringify(ir));
    expect("ir" in parsed, JSON.stringify(parsed)).toBe(true);
  });

  test("the composed workspace document validates", () => {
    const parsed = readMemberIr(JSON.stringify(ir));
    if (!("ir" in parsed)) throw new Error(JSON.stringify(parsed.reason));
    const graph = composeWorkspaceGraph({ name: "ws", root: "." }, [
      {
        member: {
          name: "governance",
          dir: "governance",
          kind: "forge-governance",
          status: "composed",
          reason: null,
          chant: null,
          irVersion: parsed.irVersion,
          live: false,
        },
        ir: parsed.ir,
      },
    ]);
    const doc = { $schema: GRAPH_OUTPUT_SCHEMA_ID, contract: GRAPH_CONTRACT_VERSION, chant: "0.124.95", at: null, ...graph };

    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(graphSchema);
    expect(validate(doc), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(doc.nodes.length).toBeGreaterThan(0);
    expect(doc.nodes.every((n) => n.member === "governance" && n.id.startsWith("governance/"))).toBe(true);

    // The check bites: a node without its lexicon is refused.
    const broken = structuredClone(doc) as any;
    delete broken.nodes[0].lexicon;
    expect(validate(broken)).toBe(false);
  });
});
