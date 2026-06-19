# github-warden task runner.
# Run `just` (or `just --list`) to see available recipes.

set quiet

# List recipes
default:
    @just --list

# Type-check (no emit)
tsc:
    npx tsc --noEmit

# Run the test suite (optionally pass a path/pattern: `just test diff`)
test *args:
    npx vitest run {{args}}

# Run tests in watch mode
test-watch:
    npx vitest

# Build the CLI bundle (dist/cli.js)
build:
    npm run build

# Build the GitHub Action bundle (action/index.mjs)
build-action:
    npm run build:action

# Everything CI's `check` job runs: typecheck, tests, action bundle freshness
check: tsc test build-action
    git diff --exit-code action/index.mjs

# Dogfood: audit our own config with chant (CI's `dogfood-audit` job)
audit:
    npx chant audit . --fail-on merge-worthy

# Install dependencies (clean, lockfile-faithful)
install:
    npm ci
