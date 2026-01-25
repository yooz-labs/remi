# Task Completion Checklist - Remi

After completing any code changes, run the following:

## 1. Lint & Format
```bash
biome check --write .
```

## 2. Type Check
```bash
tsc --noEmit
```

## 3. Tests
```bash
bun test --coverage
```

## 4. Verify No Regressions
- All existing tests pass
- No new type errors introduced
- No lint violations

## 5. Git
- Atomic commits with descriptive messages
- Feature branches for non-trivial changes
- Push and create PR with `gh pr create`

## Notes
- NO mocks in tests
- Coverage target: 60-80%
- Run from workspace root (`remi/`)
- Biome config is at root level, applies to all packages
- TypeScript exclude: `packages/signaling/**/*` (uses Cloudflare Workers types)
