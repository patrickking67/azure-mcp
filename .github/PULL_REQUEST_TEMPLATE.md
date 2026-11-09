## What changed and why

## How I checked it

- [ ] `npm run check` passes (typecheck, lint, tests, plugin bundle, manifest)
- [ ] A change to `src/cli-policy.ts` or a gate has a test in `test/` that fails without it
- [ ] `npm run plugin:build` and `npm run manifest` rerun if `src/` or the tool list changed
- [ ] No tenant ids, subscription ids, real resource names or secrets in code, tests or docs
- [ ] Nothing ran against a real Azure subscription
- [ ] `CHANGELOG.md` updated under `[Unreleased]`

## Not verified
