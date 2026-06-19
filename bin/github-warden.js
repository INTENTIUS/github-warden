#!/usr/bin/env node
/**
 * github-warden bin launcher.
 *
 * This file is checked into git so it exists at npm pack-validation time
 * (before `prepack` / `build` runs). It loads the built dist/cli.js — which
 * is produced by `prepack` before the tarball is assembled — and calls the
 * exported `run()` function with the process argv.
 *
 * Why a launcher instead of pointing `bin` at `dist/cli.js` directly:
 *   npm validates `bin` paths BEFORE `prepack` runs. At that moment dist/cli.js
 *   does not exist, so npm strips the bin entry. A committed launcher that
 *   exists at pack time survives validation; dist/cli.js is still built and
 *   included in the tarball by prepack.
 */

import(new URL("../dist/cli.js", import.meta.url).href).then((mod) => {
  return mod.run(process.argv.slice(2));
}).catch((err) => {
  process.stderr.write(`github-warden: fatal: ${err?.message ?? err}\n`);
  process.exit(3);
});
