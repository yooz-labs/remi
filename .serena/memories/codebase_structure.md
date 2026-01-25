# Remi Codebase Structure

## Root (`remi/`)
- `package.json` - Bun workspace root
- `tsconfig.json` - Root TS config (strict, ESNext, bundler resolution)
- `biome.json` - Linter/formatter config (spaces, single quotes, semicolons)
- `.rules/` - Development standards (testing, git, CI/CD, etc.)
- `.context/` - Planning docs (plan.md, research.md, ideas.md)

## Daemon (`packages/daemon/`)
Core backend that manages Claude Code sessions via PTY.

### Source (`src/`)
- `cli.ts` - Entry point
- `index.ts` - Package exports
- `pty/` - PTY session management
  - `pty-session.ts`, `pty-manager.ts`
- `transcript/` - Claude Code transcript monitoring
  - `transcript-watcher.ts`, `transcript-discovery.ts`, `transcript-message-bridge.ts`, `types.ts`
- `parser/` - Output parsing
  - `question-parser.ts` - Detects Y/N, numbered, free-text questions
  - `status-parser.ts` - Parses Claude Code status lines
  - `bullet-engine.ts` - Parses bullet-point output
  - `ansi.ts` - ANSI escape code handling
  - `output-processor.ts` - Main output processing pipeline
- `server/` - WebSocket server
  - `websocket-server.ts`, `connection.ts`
- `adapters/` - Client adapters
  - `telegram-adapter.ts`, `telegram-ui.ts` - Telegram bot
  - `websocket-adapter.ts` - WebSocket clients
  - `connection-adapter.ts` - Base adapter interface
  - `adapter-registry.ts` - Adapter management
- `api/` - Message API
  - `message-api.ts`, `bullet-content-registry.ts`
- `session/` - Session management
  - `session-registry.ts`

### Tests (`tests/`)
- `question-parser.test.ts`
- `status-parser.test.ts`
- `bullet-engine.test.ts`
- `ansi.test.ts`
- `websocket-server.test.ts`
- `session-registry.test.ts`
- `transcript-discovery.test.ts`
- `transcript-watcher.test.ts`
- `message-api.test.ts`
- `bullet-content-registry.test.ts`

## Shared (`packages/shared/`)
Shared types and protocol definitions.

### Source (`src/`)
- `types.ts` - Core type definitions
- `protocol.ts` - WebSocket protocol messages
- `index.ts` - Package exports

### Tests (`tests/`)
- `types.test.ts`
- `protocol.test.ts`
- `index.test.ts`

## Web (`packages/web/`)
React frontend with Capacitor for mobile.

### Source (`src/`)
- `App.tsx`, `main.tsx` - App entry
- `components/chat/` - ChatView, MessageList, MessageBubble, InputArea, ChatHeader
- `components/layout/` - AppLayout
- `components/session/` - SessionList, SessionCard, ConnectModal
- `hooks/` - useWebSocket
- `lib/` - websocket-client
- `types/` - Frontend type definitions

## Signaling (`packages/signaling/`)
Cloudflare Worker for WebRTC signaling.

### Source (`src/`)
- `index.ts` - Worker entry (Durable Objects)
- `connection-room.ts` - WebSocket room management
- `code-generator.ts` - Connection code generation
- `types.ts` - Signaling types

### Tests (`tests/`)
- `code-generator.test.ts`
- `types.test.ts`
