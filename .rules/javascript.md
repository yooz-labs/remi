# JavaScript/TypeScript Development Standards

## Runtime & Environment
- **Runtime:** Bun (not Node.js or npm)
- **Language:** TypeScript (strict mode)
- **Package Manager:** bun (not npm/yarn)

## Commands
```bash
# Install dependencies
bun install

# Run scripts
bun run dev
bun run build
bun run test

# Execute TypeScript directly
bun run src/index.ts

# Add dependencies
bun add package-name
bun add -d package-name  # dev dependency
```

## Code Style
- **Formatter:** Prettier or Biome
- **Linter:** ESLint or Biome
- **Line Length:** 100 characters
- **Semicolons:** Optional (be consistent)
- **Quotes:** Single quotes preferred

## TypeScript Config
```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "noEmit": true,
    "skipLibCheck": true
  }
}
```

## Project Structure
```
project/
├── packages/           # Monorepo packages
│   ├── daemon/         # Backend (Bun)
│   ├── app/            # Frontend (React + Capacitor)
│   └── shared/         # Shared types
├── package.json        # Root workspace config
├── tsconfig.json       # TypeScript config
└── bunfig.toml         # Bun config
```

## Workspace Setup (bunfig.toml)
```toml
[workspace]
members = ["packages/*"]
```

## Type Patterns
```typescript
// Use interfaces for objects
interface User {
  id: string;
  name: string;
}

// Use type for unions/aliases
type Status = 'pending' | 'active' | 'complete';

// Use const assertions for literal types
const COLORS = ['red', 'blue', 'green'] as const;
type Color = typeof COLORS[number];
```

## Async Patterns
```typescript
// Prefer async/await over .then()
async function fetchData(): Promise<Data> {
  const response = await fetch(url);
  return response.json();
}

// Use try/catch for error handling
async function safeOperation(): Promise<Result | null> {
  try {
    return await riskyOperation();
  } catch (error) {
    console.error('Operation failed:', error);
    return null;
  }
}
```

## Bun-Specific Features
```typescript
// File I/O
const file = Bun.file('path/to/file');
const text = await file.text();

// HTTP Server
Bun.serve({
  port: 3000,
  fetch(req) {
    return new Response('Hello');
  },
});

// WebSocket Server
Bun.serve({
  websocket: {
    open(ws) { /* connection opened */ },
    message(ws, msg) { /* handle message */ },
    close(ws) { /* connection closed */ },
  },
});

// PTY (Terminal)
const proc = Bun.spawn(['command'], {
  terminal: {
    columns: 80,
    rows: 24,
    onData: (data) => console.log(data),
  },
});
```

## Testing
```typescript
// Use Bun's built-in test runner
import { test, expect, describe } from 'bun:test';

describe('module', () => {
  test('should work', () => {
    expect(1 + 1).toBe(2);
  });
});
```

## React Patterns (for app/)
```typescript
// Prefer function components
function MyComponent({ name }: { name: string }) {
  return <div>{name}</div>;
}

// Use hooks appropriately
const [state, setState] = useState<State>(initial);
const value = useMemo(() => compute(), [deps]);
const callback = useCallback(() => action(), [deps]);
```

## Error Handling
```typescript
// Custom error types
class ApiError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'ApiError';
  }
}

// Use Result pattern for expected failures
type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };
```

## Import/Export
```typescript
// Named exports preferred
export function helper() {}
export const CONSTANT = 'value';

// Avoid default exports (harder to refactor)
// Exception: React components for lazy loading
export default function Page() {}
```

---
*Use Bun for all JavaScript/TypeScript operations. TypeScript strict mode required.*
