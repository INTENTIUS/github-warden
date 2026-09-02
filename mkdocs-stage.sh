#!/usr/bin/env bash
# Stage the curated docs (which live at the repo root for GitHub) into _docs/ for MkDocs,
# preserving structure so relative links resolve. NOTE: docs/ is a real source directory
# (docs/github-app-setup.md), so the staging dir is a separate, disposable _docs/.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf _docs
mkdir -p _docs/docs _docs/examples

cp README.md POLICY.md CLI.md CYCLES.md CI.md SETUP.md _docs/
cp docs/github-app-setup.md _docs/docs/
cp examples/governance.yml examples/README.md _docs/examples/   # linked from README + SETUP.md

echo ">> staged _docs/ for mkdocs"
