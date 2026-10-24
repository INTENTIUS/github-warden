/**
 * The module a `graph.reader` in workspace-kinds.json names (INTENTIUS/chant#4413).
 * chant's `graph` loads it in a reader project and calls it with the member's
 * directory; it reads the governance file there and returns graph IR.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { readGovernance, type GraphIR } from "./reader.js";

export default function read(input: { dir: string; config: { file?: string } }): GraphIR {
  const file = input.config.file ?? "governance.yml";
  return readGovernance(parse(readFileSync(join(input.dir, file), "utf-8")), file);
}
