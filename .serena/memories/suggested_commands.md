# Suggested Commands for Remi

## Development
```bash
# Start daemon
bun run daemon          # or: bun run packages/daemon/src/cli.ts
bun run daemon:dev      # with --watch

# Web frontend
cd packages/web && bun run dev   # Vite dev server

# Signaling worker
cd packages/signaling && bun run dev  # Wrangler dev
```

## Testing
```bash
# Run all tests
bun test

# With coverage
bun test --coverage
bun test --coverage --coverage-reporter=text --coverage-reporter=lcov

# Watch mode
bun test --watch

# Specific package
bun test packages/daemon/tests/
bun test packages/shared/tests/
bun test packages/signaling/tests/
```

## Linting & Formatting
```bash
# Check (all packages)
biome check .

# Fix
biome check --write .

# Format only
biome format --write .
```

## Type Checking
```bash
# Root (covers daemon + shared)
tsc --noEmit

# Web package
cd packages/web && tsc -b

# Signaling
cd packages/signaling && tsc --noEmit
```

## Build
```bash
# Web build
cd packages/web && bun run build

# Mobile
cd packages/web && bun run build && npx cap sync ios && npx cap open ios
```

## Git
```bash
git checkout -b feature/name
git add -p
git commit -m "feat: description"
git push -u origin feature/name
gh pr create
```

## Package Management
```bash
bun install              # Install all workspace deps
bun add <pkg>            # Add to root
bun add <pkg> --filter @remi/daemon  # Add to specific package
```
