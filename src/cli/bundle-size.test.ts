/**
 * Bundle-shape regression guard for issue #57.
 *
 * The `audit`/`report` paths reach chant's audit pipeline and the GitHub
 * lexicon's lint rules, which import the TypeScript compiler (~9 MB). cli.ts
 * loads `./audit/engine.js` with a dynamic import() so esbuild's code
 * splitting keeps the reconcile cold path lean: `dist/cli.js` plus its static
 * import closure must never pull the TS compiler back in.
 *
 * This test rebuilds the CLI in-memory with the same esbuild flags as the
 * `build` npm script (bundle + splitting + ESM outdir) and asserts, from the
 * metafile:
 *   1. the entry chunk's STATIC import closure contains no typescript input;
 *   2. that closure stays well under 2 MB;
 *   3. the compiler is still bundled somewhere (a lazy chunk), so the packed
 *      tarball stays self-contained and `npx github-warden audit` works
 *      offline from node_modules-free installs.
 *
 * If you add a static value import of ./audit/engine.js (or anything else
 * that reaches @intentius/chant's lint machinery) to the CLI's top level,
 * this test fails.
 */

import { describe, it, expect } from "vitest";
import { build, type Metafile } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function buildMetafile(): Promise<Metafile> {
  const result = await build({
    entryPoints: [path.join(root, "src/cli.ts")],
    bundle: true,
    splitting: true,
    platform: "node",
    format: "esm",
    outdir: path.join(root, "dist"),
    write: false,
    metafile: true,
    logLevel: "silent",
    absWorkingDir: root,
  });
  return result.metafile;
}

/** Output paths reachable from `entry` following static imports only. */
function staticClosure(meta: Metafile, entry: string): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const out = meta.outputs[queue.shift()!];
    for (const imp of out.imports) {
      if (imp.kind === "dynamic-import") continue;
      if (imp.external) continue;
      if (!seen.has(imp.path)) {
        seen.add(imp.path);
        queue.push(imp.path);
      }
    }
  }
  return seen;
}

function isTypescriptInput(inputPath: string): boolean {
  return /node_modules\/typescript\//.test(inputPath);
}

describe("CLI bundle shape (issue #57)", () => {
  it("keeps the TypeScript compiler out of the reconcile cold path but bundled for audit", async () => {
    const meta = await buildMetafile();

    const entry = Object.keys(meta.outputs).find(
      (p) => meta.outputs[p].entryPoint?.endsWith("src/cli.ts"),
    );
    expect(entry, "esbuild metafile has an entry chunk for src/cli.ts").toBeDefined();

    const cold = staticClosure(meta, entry!);

    // 1. No typescript input contributes to any statically-reachable chunk.
    const coldTsInputs = [...cold].flatMap((out) =>
      Object.keys(meta.outputs[out].inputs).filter(isTypescriptInput),
    );
    expect(coldTsInputs).toEqual([]);

    // 2. The cold path stays lean (acceptance: dist/cli.js well under 2 MB;
    //    we hold the whole static closure to half that).
    const coldBytes = [...cold].reduce((sum, out) => sum + meta.outputs[out].bytes, 0);
    expect(coldBytes).toBeLessThan(1024 * 1024);

    // 3. The compiler IS still bundled in some lazy chunk — the tarball must
    //    stay self-contained so audit/report work from a clean npx install.
    const anyTsInputs = Object.values(meta.outputs).some((out) =>
      Object.keys(out.inputs).some(isTypescriptInput),
    );
    expect(anyTsInputs).toBe(true);
  });
});
