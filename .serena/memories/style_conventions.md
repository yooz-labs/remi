# Code Style & Conventions - Remi

## TypeScript
- **Strict mode** enabled with extra checks:
  - `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
  - `noImplicitOverride`, `noPropertyAccessFromIndexSignature`
  - `verbatimModuleSyntax` (explicit type imports)
- **Target:** ESNext, module ESNext, bundler resolution
- **Types:** `@types/bun`

## Biome Rules
- **Indent:** 2 spaces
- **Line width:** 100 chars
- **Semicolons:** always
- **Quotes:** single quotes
- **Imports:** organized (sorted)
- **Strict rules:**
  - `noUnusedVariables: error`
  - `noUnusedImports: error`
  - `noGlobalEval: error`
  - `noExplicitAny: error`
  - `useConst: error`
  - `useTemplate: error`
- **Warnings:**
  - `noForEach: warn`
  - `noNonNullAssertion: warn`

## File Organization
- One module per file
- Export from `index.ts` barrel files
- Tests in `tests/` directory at package level (not `__tests__`)
- Test files named `<module>.test.ts`

## Naming
- camelCase for variables, functions
- PascalCase for types, interfaces, classes
- kebab-case for file names
- UPPER_CASE for constants

## Testing Patterns (Bun Test)
- Import from `bun:test`
- Use `describe` / `test` (not `it`)
- NO mocks, stubs, or fake data
- Test with real implementations
- Pattern: `import { describe, expect, test } from 'bun:test';`

## Imports
- Use `.ts` extension in imports (allowImportingTsExtensions)
- Use workspace references: `@remi/shared`, `@remi/daemon`
- Type-only imports with `import type { ... }`

## Git Commits
- Format: `<type>: <subject>` (max 50 chars)
- Types: feat, fix, docs, refactor, test, chore
- NO emojis, NO AI attribution
