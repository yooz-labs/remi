# Claude Code Architecture Reference for Remi

**Date:** 2026-04-05
**Source:** `/Users/yahya/Documents/git/yooz/cc-ref` (Rust reference codebase, "claw-code")
**Purpose:** Comprehensive reference for building Remi, covering every core architectural element that a remote monitor/chat app needs to understand.

---

## Table of Contents

1. [Session and Conversation Model](#1-session-and-conversation-model)
2. [API Types and Streaming](#2-api-types-and-streaming)
3. [Tool System](#3-tool-system)
4. [Hook System](#4-hook-system)
5. [CLI Input/Output and REPL](#5-cli-inputoutput-and-repl)
6. [Command System (Slash Commands)](#6-command-system-slash-commands)
7. [Configuration and Settings](#7-configuration-and-settings)
8. [File Discovery and Project Context](#8-file-discovery-and-project-context)
9. [Permission Model](#9-permission-model)
10. [Architecture Patterns and Core Abstractions](#10-architecture-patterns-and-core-abstractions)
11. [Roadmap and Philosophy](#11-roadmap-and-philosophy)
12. [What Remi Should Track](#12-what-remi-should-track)

---

## 1. Session and Conversation Model

**Source:** `rust/crates/runtime/src/session.rs` (full file, ~860 lines)

### Core Data Structures

#### Session (the top-level container)

```rust
pub struct Session {
    pub version: u32,              // SESSION_VERSION = 1
    pub session_id: String,        // UUID-like, auto-generated
    pub created_at_ms: u64,        // Unix millis
    pub updated_at_ms: u64,        // Auto-updated on every push/touch
    pub messages: Vec<ConversationMessage>,
    pub compaction: Option<SessionCompaction>,
    pub fork: Option<SessionFork>,
    persistence: Option<SessionPersistence>,  // private; file path
}
```

**CORE (won't change):** The session is a flat ordered list of messages with metadata. session_id, timestamps, messages, compaction, and fork are fundamental.

**SURFACE (might change):** The version number, specific persistence format details.

#### MessageRole (4 roles)

```rust
pub enum MessageRole {
    System,      // Compaction summaries, system instructions
    User,        // Human input
    Assistant,   // Claude's responses
    Tool,        // Tool execution results
}
```

**CORE:** These four roles are fundamental to the Anthropic API and will not change.

#### ContentBlock (3 variants)

```rust
pub enum ContentBlock {
    Text { text: String },
    ToolUse { id: String, name: String, input: String },
    ToolResult { tool_use_id: String, tool_name: String, output: String, is_error: bool },
}
```

**CORE:** This is the fundamental content model. Every message contains one or more blocks.

- `Text`: Plain text content (assistant prose, user messages, system summaries)
- `ToolUse`: A tool invocation request from the assistant (has id, tool name, and JSON input as string)
- `ToolResult`: The result of executing a tool (links back to tool_use_id)

**Key for Remi:** The `input` field in ToolUse is a JSON string, not a parsed object. The `tool_name` in ToolResult tells you what tool produced the result without needing to look up the ToolUse.

#### ConversationMessage

```rust
pub struct ConversationMessage {
    pub role: MessageRole,
    pub blocks: Vec<ContentBlock>,
    pub usage: Option<TokenUsage>,
}
```

Each message has a role and one or more content blocks. Usage is optional and only present on Assistant messages that include API token data.

**Factory methods:**
- `ConversationMessage::user_text(text)` - creates User with single Text block
- `ConversationMessage::assistant(blocks)` - creates Assistant
- `ConversationMessage::assistant_with_usage(blocks, usage)` - with token counts
- `ConversationMessage::tool_result(tool_use_id, tool_name, output, is_error)` - creates Tool with single ToolResult block

### Session Persistence: JSONL Format

Sessions are persisted as JSONL (one JSON object per line). This is the format Remi reads from transcript files.

**JSONL record types:**

1. **`session_meta`** (always first line):
```json
{"type":"session_meta","version":1,"session_id":"abc123","created_at_ms":1712000000000,"updated_at_ms":1712000001000}
```
Optional `fork` field if session was forked.

2. **`compaction`** (optional, after meta):
```json
{"type":"compaction","count":2,"removed_message_count":15,"summary":"<summary>...</summary>"}
```

3. **`message`** (one per conversation message):
```json
{"type":"message","message":{"role":"assistant","blocks":[{"type":"text","text":"Hello"}],"usage":{"input_tokens":100,"output_tokens":20,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}
```

**Block JSON shapes:**
```json
// Text
{"type":"text","text":"content here"}

// ToolUse
{"type":"tool_use","id":"toolu_abc","name":"bash","input":"{\"command\":\"ls\"}"}

// ToolResult
{"type":"tool_result","tool_use_id":"toolu_abc","tool_name":"bash","output":"file1.txt\nfile2.txt","is_error":false}
```

**Key for Remi:** The `input` field in tool_use blocks is a stringified JSON, not a nested object. You must JSON.parse it to access tool parameters.

### Persistence Details

- **Path:** `.claw/sessions/` directory in the workspace (session_id + `.jsonl`)
- **Append-only:** New messages are appended as JSONL lines via `append_persisted_message()`
- **Rotation:** Files rotate after `ROTATE_AFTER_BYTES = 256 * 1024` (256KB). Max `MAX_ROTATED_FILES = 3` backup files.
- **Atomic writes:** `write_atomic()` writes to temp file then renames
- **Load:** `Session::load_from_path()` handles both full JSON and JSONL formats

### Session Fork

```rust
pub struct SessionFork {
    pub parent_session_id: String,
    pub branch_name: Option<String>,
}
```

Forking copies all messages and compaction state into a new session with a new session_id and a reference to the parent. The branch_name is human-readable metadata.

### Session Compaction

```rust
pub struct SessionCompaction {
    pub count: u32,                  // How many times compacted
    pub removed_message_count: usize,
    pub summary: String,             // The compacted summary text
}
```

### Token Usage (per-message metadata)

```rust
pub struct TokenUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cache_creation_input_tokens: u32,
    pub cache_read_input_tokens: u32,
}
```

---

## 2. API Types and Streaming

**Source:** `rust/crates/api/src/types.rs` (291 lines)

### Stream Events (the SSE protocol)

```rust
pub enum StreamEvent {
    MessageStart(MessageStartEvent),       // First event; contains initial MessageResponse
    MessageDelta(MessageDeltaEvent),        // Final event; stop_reason + final usage
    ContentBlockStart(ContentBlockStartEvent), // New block starts (index + initial block)
    ContentBlockDelta(ContentBlockDeltaEvent), // Incremental content for a block
    ContentBlockStop(ContentBlockStopEvent),   // Block finished
    MessageStop(MessageStopEvent),             // Stream finished
}
```

**CORE:** This is the Anthropic streaming protocol. It is stable and public API.

### Content Block Deltas (incremental updates)

```rust
pub enum ContentBlockDelta {
    TextDelta { text: String },
    InputJsonDelta { partial_json: String },
    ThinkingDelta { thinking: String },
    SignatureDelta { signature: String },
}
```

- `TextDelta`: Incremental text for a Text block
- `InputJsonDelta`: Incremental JSON for a ToolUse block's input
- `ThinkingDelta`: Extended thinking content (visible only with extended thinking enabled)
- `SignatureDelta`: Cryptographic signature for thinking blocks

### Output Content Blocks (from API response)

```rust
pub enum OutputContentBlock {
    Text { text: String },
    ToolUse { id: String, name: String, input: Value },
    Thinking { thinking: String, signature: Option<String> },
    RedactedThinking { data: Value },
}
```

Note: The API `OutputContentBlock` has `Thinking` and `RedactedThinking` variants that are NOT preserved in the session's `ContentBlock` enum. The runtime strips thinking blocks before persisting.

**Key for Remi:** The transcript/session file will NOT contain thinking blocks. You only see Text, ToolUse, and ToolResult in session data.

### Usage Tracking

```rust
pub struct Usage {
    pub input_tokens: u32,
    pub cache_creation_input_tokens: u32,
    pub cache_read_input_tokens: u32,
    pub output_tokens: u32,
}
```

Total tokens = input + output + cache_creation + cache_read.

### Pricing (per-million tokens)

| Model | Input | Output | Cache Write | Cache Read |
|-------|-------|--------|-------------|------------|
| Opus | $15.00 | $75.00 | $18.75 | $1.50 |
| Sonnet | $15.00 | $75.00 | $18.75 | $1.50 |
| Haiku | $1.00 | $5.00 | $1.25 | $0.10 |

### SSE Parsing

**Source:** `rust/crates/api/src/sse.rs`

The SSE parser reads `event:` and `data:` lines from the stream, separated by double newlines (`\n\n`). Each frame is parsed into a `StreamEvent`. The `[DONE]` sentinel and `ping` events are ignored.

---

## 3. Tool System

**Source:** `rust/crates/tools/src/lib.rs` (very large, ~3800+ lines)

### Tool Architecture Overview

The tool system has three layers:

1. **Tool Specs** (`mvp_tool_specs()`) - 40 built-in tools with name, description, JSON schema, and required permission
2. **Tool Registry** (`GlobalToolRegistry`) - Combines built-in + plugin + runtime (MCP) tools
3. **Tool Executor** (`execute_tool()`) - Dispatches tool calls to implementation functions

### Complete List of 40+ Built-in Tools

**Core file operations:**
| Tool | Permission | Description |
|------|-----------|-------------|
| `bash` | DangerFullAccess | Execute shell command |
| `read_file` | ReadOnly | Read text file (supports offset/limit) |
| `write_file` | WorkspaceWrite | Write text file |
| `edit_file` | WorkspaceWrite | Replace text in file (old_string/new_string) |
| `glob_search` | ReadOnly | Find files by glob pattern |
| `grep_search` | ReadOnly | Search file contents with regex |

**Web and information:**
| Tool | Permission | Description |
|------|-----------|-------------|
| `WebFetch` | ReadOnly | Fetch URL and convert to text |
| `WebSearch` | ReadOnly | Web search with cited results |

**Session and planning:**
| Tool | Permission | Description |
|------|-----------|-------------|
| `TodoWrite` | WorkspaceWrite | Update structured task list |
| `Skill` | ReadOnly | Load a skill definition |
| `Agent` | DangerFullAccess | Launch specialized agent task |
| `ToolSearch` | ReadOnly | Search for deferred tools |
| `NotebookEdit` | WorkspaceWrite | Edit Jupyter notebook cells |
| `Sleep` | ReadOnly | Wait without holding shell |
| `SendUserMessage` / `Brief` | ReadOnly | Send message to user |
| `Config` | WorkspaceWrite | Get/set settings |
| `EnterPlanMode` | WorkspaceWrite | Enable planning mode |
| `ExitPlanMode` | WorkspaceWrite | Exit planning mode |
| `StructuredOutput` | ReadOnly | Return structured JSON |
| `REPL` | DangerFullAccess | Interactive REPL |
| `PowerShell` | DangerFullAccess | PowerShell command |
| `AskUserQuestion` | ReadOnly | Ask user a question with optional choices |

**Task management:**
| Tool | Description |
|------|-------------|
| `TaskCreate` | Create new task |
| `TaskGet` | Get task by ID |
| `TaskList` | List all tasks |
| `TaskStop` | Stop a task |
| `TaskUpdate` | Update task with message |
| `TaskOutput` | Get task output |
| `RunTaskPacket` | Execute structured task packet |

**Worker management:**
| Tool | Description |
|------|-------------|
| `WorkerCreate` | Create new worker |
| `WorkerGet` | Get worker status |
| `WorkerObserve` | Observe worker event |
| `WorkerResolveTrust` | Resolve trust gate |
| `WorkerAwaitReady` | Wait for worker ready |
| `WorkerSendPrompt` | Send prompt to worker |
| `WorkerRestart` | Restart worker |
| `WorkerTerminate` | Terminate worker |

**Team and scheduling:**
| Tool | Description |
|------|-------------|
| `TeamCreate` | Create worker team |
| `TeamDelete` | Delete team |
| `CronCreate` | Create scheduled task |
| `CronDelete` | Delete scheduled task |
| `CronList` | List scheduled tasks |

**Integration:**
| Tool | Description |
|------|-------------|
| `LSP` | Language Server Protocol operations |
| `ListMcpResources` | List MCP resources |
| `ReadMcpResource` | Read MCP resource |
| `McpAuth` | MCP authentication |
| `MCP` | Call an MCP tool |
| `RemoteTrigger` | Remote trigger (stub) |

### Tool Execution Lifecycle

```
1. Model returns ToolUse block (id, name, input_json)
2. ConversationRuntime extracts pending tool uses
3. For each tool use:
   a. Run PreToolUse hook -> may override permission, update input, or cancel
   b. Check permission (PermissionPolicy.authorize_with_context)
   c. If allowed: execute tool via ToolExecutor.execute(name, input)
   d. Run PostToolUse hook (or PostToolUseFailure if error)
   e. Create ToolResult message (tool_use_id, tool_name, output, is_error)
   f. Push result to session
4. If any tool uses existed, loop back to step 1 (send updated history to model)
5. If no tool uses, turn is complete
```

**Key for Remi:** Each tool use creates a ToolUse block in an assistant message, followed by a ToolResult in a tool-role message. A single assistant turn can contain multiple ToolUse blocks, each of which gets its own ToolResult.

### Tool Input/Output Format

Tools receive JSON input and return string output. For Remi, the output strings appear in ToolResult blocks. Common patterns:

- **bash:** output is stdout/stderr text
- **read_file:** output is file content with line numbers
- **write_file/edit_file:** output describes what changed ("Added 3 lines to path/file.ts")
- **glob_search:** output is list of matching file paths
- **grep_search:** output is matching lines with context

---

## 4. Hook System

**Source:** `rust/crates/runtime/src/hooks.rs` (~988 lines), `rust/crates/plugins/src/hooks.rs` (~500 lines)

### Hook Events

```rust
pub enum HookEvent {
    PreToolUse,
    PostToolUse,
    PostToolUseFailure,
}
```

**CORE:** These three hook events are the stable interface.

### Hook Execution Model

Hooks are shell commands executed with JSON payload on stdin and environment variables:

**Environment variables:**
- `HOOK_EVENT`: "PreToolUse", "PostToolUse", or "PostToolUseFailure"
- `HOOK_TOOL_NAME`: Name of the tool
- `HOOK_TOOL_INPUT`: JSON string of tool input
- `HOOK_TOOL_IS_ERROR`: "0" or "1"
- `HOOK_TOOL_OUTPUT`: (PostToolUse/PostToolUseFailure only) tool output

**Stdin payload (JSON):**
```json
{
    "hook_event_name": "PreToolUse",
    "tool_name": "bash",
    "tool_input": {"command": "ls"},
    "tool_input_json": "{\"command\":\"ls\"}",
    "tool_output": null,
    "tool_result_is_error": false
}
```

### Hook Command Exit Codes

| Exit Code | Meaning |
|-----------|---------|
| 0 | Allow (continue execution) |
| 2 | Deny (block tool execution) |
| Other | Failed (hook itself errored) |

### Hook Output Protocol (JSON stdout)

Hooks can return structured JSON on stdout to influence execution:

```json
{
    "systemMessage": "Hook advisory message",
    "reason": "Additional reason text",
    "continue": false,           // false = deny
    "decision": "block",         // "block" = deny
    "hookSpecificOutput": {
        "additionalContext": "Extra info for model",
        "permissionDecision": "allow|deny|ask",
        "permissionDecisionReason": "Why",
        "updatedInput": {"command": "git status"}  // Override tool input
    }
}
```

### HookRunResult

```rust
pub struct HookRunResult {
    denied: bool,
    failed: bool,
    cancelled: bool,
    messages: Vec<String>,
    permission_override: Option<PermissionOverride>,  // Allow, Deny, Ask
    permission_reason: Option<String>,
    updated_input: Option<String>,
}
```

### Hook Configuration

Hooks are configured in runtime config (settings.json) or plugin manifests:

```json
{
    "hooks": {
        "PreToolUse": ["./hooks/pre.sh"],
        "PostToolUse": ["./hooks/post.sh"],
        "PostToolUseFailure": ["./hooks/failure.sh"]
    }
}
```

### HookAbortSignal

Hooks can be cancelled mid-execution via `HookAbortSignal`, an atomic boolean. If set, running hook processes are killed and the result is `cancelled: true`.

### HookProgressReporter

A trait for observing hook execution:
```rust
pub trait HookProgressReporter {
    fn on_event(&mut self, event: &HookProgressEvent);
}

pub enum HookProgressEvent {
    Started { event, tool_name, command },
    Completed { event, tool_name, command },
    Cancelled { event, tool_name, command },
}
```

**Key for Remi:** Remi uses hooks to receive notifications from Claude Code sessions. The hook system is the primary integration point. Remi registers hooks that call back to the daemon (e.g., via curl) when events fire. The three hook events (PreToolUse, PostToolUse, PostToolUseFailure) are stable. The notification hook events mentioned in Remi's existing research (Notification, Stop, SessionStart, etc.) are from the real Claude Code product and are a superset of the three events in this reference codebase.

---

## 5. CLI Input/Output and REPL

**Source:** `rust/crates/rusty-claude-cli/src/main.rs` (7749 lines), `input.rs`, `render.rs`

### REPL Loop

The REPL is straightforward:

```rust
fn run_repl(model, allowed_tools, permission_mode) {
    let mut cli = LiveCli::new(model, true, allowed_tools, permission_mode)?;
    let mut editor = LineEditor::new("> ", completions);
    println!("{}", cli.startup_banner());

    loop {
        editor.set_completions(cli.repl_completion_candidates());
        match editor.read_line()? {
            ReadOutcome::Submit(input) => {
                if input.trim().is_empty() { continue; }
                if matches!(input.as_str(), "/exit" | "/quit") { break; }
                match SlashCommand::parse(&input) {
                    Ok(Some(command)) => { cli.handle_repl_command(command)?; continue; }
                    Ok(None) => {}  // Not a slash command; process as user input
                    Err(error) => { eprintln!("{error}"); continue; }
                }
                editor.push_history(input);
                cli.run_turn(&input)?;
            }
            ReadOutcome::Cancel => {}    // Ctrl+C with text; clear input
            ReadOutcome::Exit => break,  // Ctrl+C empty or Ctrl+D
        }
    }
}
```

### Turn Execution (run_turn)

```rust
fn run_turn(&mut self, input: &str) {
    let (mut runtime, hook_abort_monitor) = self.prepare_turn_runtime(true)?;
    let mut spinner = Spinner::new();
    spinner.tick("Thinking...", theme, stdout);
    let mut permission_prompter = CliPermissionPrompter::new(self.permission_mode);
    let result = runtime.run_turn(input, Some(&mut permission_prompter));
    hook_abort_monitor.stop();
    match result {
        Ok(summary) => {
            self.replace_runtime(runtime);
            spinner.finish("Done", theme, stdout);
            if let Some(event) = summary.auto_compaction {
                println!(format_auto_compaction_notice(event.removed_message_count));
            }
            self.persist_session()?;
        }
        Err(error) => {
            runtime.shutdown_plugins()?;
            spinner.fail("Request failed", theme, stdout);
        }
    }
}
```

### Input System

Uses `rustyline` for readline with:
- Slash command tab completion (all commands starting with `/`)
- History tracking
- Ctrl+J or Shift+Enter for newlines
- `ReadOutcome::Submit` / `Cancel` / `Exit`

### Rendering (Markdown to Terminal)

The `TerminalRenderer` converts markdown to ANSI-colored terminal output using `pulldown-cmark` parser and `syntect` for code highlighting. Features:

- Heading colors (Cyan for h1, White for h2, Blue for h3)
- Bold, italic, emphasis
- Inline code (green), code blocks with syntax highlighting
- Tables with border rendering
- Links (underlined blue)
- Spinner animation for progress (braille spinner frames)

### JSON Output Mode

For scripted/non-interactive use:
```json
{
    "message": "final assistant text",
    "model": "claude-opus-4-6",
    "iterations": 3,
    "auto_compaction": null,
    "tool_uses": [...],
    "tool_results": [...],
    "prompt_cache_events": [...],
    "usage": {
        "input_tokens": 1000,
        "output_tokens": 200,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0
    },
    "estimated_cost": "$0.0180"
}
```

### LiveCli Structure

```rust
struct LiveCli {
    model: String,
    allowed_tools: Option<AllowedToolSet>,
    permission_mode: PermissionMode,
    system_prompt: Vec<String>,
    runtime: BuiltRuntime,
    session: SessionHandle,
}

struct BuiltRuntime {
    runtime: Option<ConversationRuntime<AnthropicRuntimeClient, CliToolExecutor>>,
    plugin_registry: PluginRegistry,
    plugins_active: bool,
    mcp_state: Option<Arc<Mutex<RuntimeMcpState>>>,
    mcp_active: bool,
}
```

---

## 6. Command System (Slash Commands)

**Source:** `rust/crates/commands/src/lib.rs` (very large, 40000+ tokens)

### All Slash Commands

| Command | Summary | Resume-safe |
|---------|---------|:-----------:|
| `/help` | Show available slash commands | Yes |
| `/status` | Show current session status | Yes |
| `/sandbox` | Show sandbox isolation status | Yes |
| `/compact` | Compact local session history | Yes |
| `/model [model]` | Show or switch the active model | No |
| `/permissions [mode]` | Show or switch permission mode | No |
| `/clear [--confirm]` | Start a fresh local session | Yes |
| `/cost` | Show cumulative token usage | Yes |
| `/resume <session-path>` | Load a saved session | No |
| `/config [section]` | Inspect config files | Yes |
| `/mcp [list\|show\|help]` | Inspect MCP servers | Yes |
| `/memory` | Inspect loaded CLAUDE.md files | Yes |
| `/init` | Create starter CLAUDE.md | Yes |
| `/diff` | Show git diff | Yes |
| `/version` | Show CLI version | Yes |
| `/bughunter [scope]` | Inspect codebase for bugs | No |
| `/commit` | Generate commit message | No |
| `/pr [context]` | Draft pull request | No |
| `/issue [context]` | Draft GitHub issue | No |
| `/ultraplan [task]` | Deep planning prompt | No |
| `/teleport <target>` | Jump to file/symbol | No |
| `/debug-tool-call` | Replay last tool call | No |
| `/export [file]` | Export conversation | Yes |
| `/session [list\|switch\|fork]` | Manage sessions | No |
| `/plugin [list\|install\|enable\|disable\|uninstall]` | Manage plugins | No |
| `/agents [list\|help]` | List agents | Yes |
| `/skills [list\|install\|help]` | List/install skills | Yes |
| `/doctor` | Diagnose setup issues | Yes |
| `/login` | Log in | No |
| `/logout` | Log out | No |
| `/plan [on\|off]` | Toggle planning mode | Yes |
| `/review [scope]` | Code review | No |
| `/tasks [list\|get\|stop]` | Manage background tasks | Yes |
| `/theme [name]` | Switch color theme | Yes |
| `/vim` | Toggle vim keybindings | Yes |
| `/voice [on\|off]` | Toggle voice input | No |
| `/upgrade` | Check for updates | No |
| `/usage` | Detailed API usage stats | Yes |
| `/stats` | Workspace/session statistics | Yes |
| `/rename <name>` | Rename session | No |
| `/copy [last\|all]` | Copy to clipboard | Yes |
| `/share` | Share conversation | No |
| `/feedback` | Submit feedback | No |
| `/hooks [list\|run]` | List/manage hooks | Yes |
| `/files` | List files in context | Yes |
| `/context [show\|clear]` | Manage context | Yes |
| `/color [scheme]` | Configure colors | Yes |
| `/effort [low\|medium\|high]` | Set effort level | Yes |
| `/fast` | Toggle fast mode | Yes |
| `/exit` / `/quit` | Exit the REPL | N/A |

**"Resume-supported"** means the command can be replayed when loading a saved session with `--resume`.

---

## 7. Configuration and Settings

**Source:** `rust/crates/runtime/src/config.rs` (~600+ lines)

### Config File Resolution Order

Config files are loaded and merged in this order (later overrides earlier):

1. `~/.claw.json` (user)
2. `~/.config/claw/settings.json` (user)
3. `<repo>/.claw.json` (project)
4. `<repo>/.claw/settings.json` (project)
5. `<repo>/.claw/settings.local.json` (local)

### ConfigSource Hierarchy

```rust
pub enum ConfigSource {
    User,     // Global user-level settings
    Project,  // Repository-level settings
    Local,    // Machine-local overrides
}
```

### RuntimeFeatureConfig

The merged config produces a `RuntimeFeatureConfig` that drives all subsystems:

```rust
pub struct RuntimeFeatureConfig {
    hooks: RuntimeHookConfig,
    plugins: RuntimePluginConfig,
    mcp: McpConfigCollection,
    oauth: Option<OAuthConfig>,
    model: Option<String>,
    permission_mode: Option<ResolvedPermissionMode>,
    permission_rules: RuntimePermissionRuleConfig,
    sandbox: SandboxConfig,
}
```

### Hook Configuration

```rust
pub struct RuntimeHookConfig {
    pre_tool_use: Vec<String>,        // Shell commands for PreToolUse
    post_tool_use: Vec<String>,       // Shell commands for PostToolUse
    post_tool_use_failure: Vec<String>, // Shell commands for PostToolUseFailure
}
```

### MCP Server Configuration

Supports multiple transport types:

```rust
pub enum McpServerConfig {
    Stdio(McpStdioServerConfig),       // Local process via stdin/stdout
    Sse(McpRemoteServerConfig),        // HTTP/SSE endpoint
    Http(McpRemoteServerConfig),       // HTTP endpoint
    Ws(McpWebSocketServerConfig),      // WebSocket endpoint
    Sdk(McpSdkServerConfig),           // SDK name reference
    ManagedProxy(McpManagedProxyServerConfig), // Managed proxy
}
```

---

## 8. File Discovery and Project Context

**Source:** `rust/crates/runtime/src/prompt.rs`

### CLAUDE.md Discovery

The system walks from the current directory up to the filesystem root, checking each directory for instruction files:

```rust
fn discover_instruction_files(cwd: &Path) -> Vec<ContextFile> {
    // Walk from root to cwd, collecting instruction files
    for dir in directories {
        // Check these candidates in order:
        dir.join("CLAUDE.md"),
        dir.join("CLAUDE.local.md"),
        dir.join(".claw").join("CLAUDE.md"),
        dir.join(".claw").join("instructions.md"),
    }
}
```

**Limits:**
- `MAX_INSTRUCTION_FILE_CHARS = 4_000` per file
- `MAX_TOTAL_INSTRUCTION_CHARS = 12_000` total

### ProjectContext

```rust
pub struct ProjectContext {
    pub cwd: PathBuf,
    pub current_date: String,
    pub git_status: Option<String>,
    pub git_diff: Option<String>,
    pub instruction_files: Vec<ContextFile>,
}
```

Git status is obtained via `git --no-optional-locks status --short --branch`.

### System Prompt Structure

The system prompt is built from sections:
1. Simple intro section
2. Output style (if configured)
3. System section
4. Doing-tasks section
5. Actions section
6. `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` (marker separating static from dynamic)
7. Environment context (model, cwd, date, platform)
8. Project context (git status, instruction files)
9. Config section
10. Appended sections

---

## 9. Permission Model

**Source:** `rust/crates/runtime/src/permissions.rs`

### Permission Modes

```rust
pub enum PermissionMode {
    ReadOnly,          // Can only read files
    WorkspaceWrite,    // Can read and write within workspace
    DangerFullAccess,  // Can execute any command
    Prompt,            // Ask user before executing
    Allow,             // Always allow
}
```

### Permission Flow

```
1. Pre-hook may override permission (allow/deny/ask)
2. If no hook override:
   a. Check deny rules (pattern matching on tool+input)
   b. Check allow rules
   c. Check ask rules
   d. Compare tool's required_mode against active_mode
   e. If tool requires higher permission than active mode:
      - Prompt user via PermissionPrompter
3. Result: PermissionOutcome::Allow or PermissionOutcome::Deny{reason}
```

### PermissionPrompter (interactive)

```rust
pub trait PermissionPrompter {
    fn decide(&mut self, request: &PermissionRequest) -> PermissionPromptDecision;
}

pub struct PermissionRequest {
    pub tool_name: String,
    pub input: String,
    pub current_mode: PermissionMode,
    pub required_mode: PermissionMode,
    pub reason: Option<String>,
}

pub enum PermissionPromptDecision {
    Allow,
    Deny { reason: String },
}
```

**Key for Remi:** When a tool requires higher permission than the current mode, Claude Code prompts the user. This is the `[Y/n]` prompt that Remi needs to detect and relay to mobile users. The `PermissionRequest` contains exactly the information Remi needs to display: what tool, what input, why it needs approval.

---

## 10. Architecture Patterns and Core Abstractions

### ConversationRuntime (the central coordinator)

```rust
pub struct ConversationRuntime<C: ApiClient, T: ToolExecutor> {
    session: Session,
    api_client: C,
    tool_executor: T,
    permission_policy: PermissionPolicy,
    system_prompt: Vec<String>,
    max_iterations: usize,          // Default: usize::MAX
    usage_tracker: UsageTracker,
    hook_runner: HookRunner,
    auto_compaction_input_tokens_threshold: u32,  // Default: 100,000
    hook_abort_signal: HookAbortSignal,
    hook_progress_reporter: Option<Box<dyn HookProgressReporter>>,
    session_tracer: Option<SessionTracer>,
}
```

### Key Traits

**ApiClient:**
```rust
pub trait ApiClient {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError>;
}
```

**ToolExecutor:**
```rust
pub trait ToolExecutor {
    fn execute(&mut self, tool_name: &str, input: &str) -> Result<String, ToolError>;
}
```

### AssistantEvent (internal streaming events)

```rust
pub enum AssistantEvent {
    TextDelta(String),           // Incremental text
    ToolUse { id, name, input }, // Completed tool use block
    Usage(TokenUsage),           // Token usage for the turn
    PromptCache(PromptCacheEvent), // Cache telemetry
    MessageStop,                 // Stream finished
}
```

### TurnSummary (what a turn produces)

```rust
pub struct TurnSummary {
    pub assistant_messages: Vec<ConversationMessage>,
    pub tool_results: Vec<ConversationMessage>,
    pub prompt_cache_events: Vec<PromptCacheEvent>,
    pub iterations: usize,           // Number of API calls in this turn
    pub usage: TokenUsage,           // Cumulative usage
    pub auto_compaction: Option<AutoCompactionEvent>,
}
```

### The Turn Loop

```
User input -> push_user_text to session
loop {
    iterations++
    Send session messages to API
    Build assistant message from stream events
    Push assistant message to session
    Extract pending tool uses
    if no tool uses: break  // Turn complete
    for each tool use:
        Run PreToolUse hook
        Check permission
        Execute tool
        Run PostToolUse hook
        Push tool result to session
}
Maybe auto-compact if input tokens > threshold
Return TurnSummary
```

**Key for Remi:** A single user turn can result in MANY API calls (iterations). Each iteration may produce text and/or tool uses. The session file will show the full history: user message, then assistant message(s) with tool uses interleaved with tool result messages.

### Auto-Compaction

When `input_tokens > auto_compaction_input_tokens_threshold` (default 100K), the runtime automatically compacts the session:

1. Keep the last 4 messages (configurable `preserve_recent_messages`)
2. Summarize all earlier messages into a System message
3. Replace session messages with [summary_system_msg, ...preserved_recent]
4. Record compaction metadata

The summary includes:
- Message counts by role
- Tools mentioned
- Recent user requests (last 3)
- Pending work (messages containing "todo", "next", "pending")
- Key files referenced
- Current work inference
- Timeline of all messages

### Session Telemetry

When a `SessionTracer` is attached, structured telemetry events are emitted:
- `turn_started` (with user_input)
- `assistant_iteration_completed` (iteration count, block count, pending tool uses)
- `tool_execution_started` (tool_name)
- `tool_execution_finished` (tool_name, is_error)
- `turn_completed` (iterations, counts)
- `turn_failed` (error)

---

## 11. Roadmap and Philosophy

### Philosophy (PHILOSOPHY.md)

This is a reference codebase for "claw-code", a demonstration of autonomous multi-agent software development. The key insight relevant to Remi:

**"Terminal is transport, not truth."** The real state of a coding session should be expressed as structured events, not scraped terminal output. This validates Remi's approach of reading transcript files and hooking into events rather than parsing terminal ANSI output.

### Roadmap (ROADMAP.md)

The roadmap is organized into 5 phases, most of which are complete:

**Phase 1 - Reliable Worker Boot (DONE):**
Worker lifecycle states: Spawning -> TrustRequired -> ReadyForPrompt -> PromptAccepted -> Running -> Blocked -> Finished/Failed

**Phase 2 - Event-Native Integration (DONE):**
Lane events schema with typed events: lane.started, lane.ready, lane.blocked, lane.red, lane.green, lane.finished, lane.failed, etc.

**Phase 3 - Branch/Test Awareness (DONE):**
Stale branch detection, recovery recipes, green-level contracts.

**Phase 4 - Task Execution (DONE):**
Structured task packets with typed fields (objective, scope, acceptance tests, etc.)

**Phase 5 - Plugin/MCP Lifecycle (DONE for registry):**
MCP startup healthcheck, degraded-mode reporting.

### Worker Status State Machine

```rust
pub enum WorkerStatus {
    Spawning,          // Process starting
    TrustRequired,     // Waiting for trust approval
    ReadyForPrompt,    // Ready to receive task
    Running,           // Executing
    Finished,          // Completed successfully
    Failed,            // Failed
}
```

### Worker Event Kinds

```rust
pub enum WorkerEventKind {
    Spawning,
    TrustRequired,
    TrustResolved,
    ReadyForPrompt,
    PromptMisdelivery,
    PromptReplayArmed,
    Running,
    Restarted,
    Finished,
    Failed,
}
```

### Lane Events

```rust
pub enum LaneEventName {
    Started, Ready, PromptMisdelivery, Blocked, Red, Green,
    CommitCreated, PrOpened, MergeReady, Finished, Failed,
    Reconciled, Merged, Superseded, Closed, BranchStaleAgainstMain,
}

pub enum LaneFailureClass {
    PromptDelivery, TrustGate, BranchDivergence, Compile, Test,
    PluginStartup, McpStartup, McpHandshake, GatewayRouting,
    ToolRuntime, Infra,
}
```

**Key for Remi:** The roadmap's emphasis on "events over scraped prose" and "terminal is transport, not truth" directly validates Remi's transcript-based architecture. The lane event system and worker lifecycle provide a model for how Remi should track session state.

---

## 12. What Remi Should Track

Based on this exhaustive analysis, here are the core elements Remi needs to understand:

### From Session Files (JSONL)

Remi reads `.jsonl` session files. Each line is one of:

| Record Type | What Remi Does With It |
|-------------|----------------------|
| `session_meta` | Extract session_id, timestamps, fork info |
| `compaction` | Know that history was compacted; show summary |
| `message` with role=user | Display as user message |
| `message` with role=assistant + Text blocks | Display as Claude's response |
| `message` with role=assistant + ToolUse blocks | Display as tool invocation indicator |
| `message` with role=tool + ToolResult blocks | Display as tool result (collapsible) |
| `message` with role=system | Compaction summary; typically hidden |

### From Hooks (real Claude Code events)

| Hook Event | What Remi Uses It For |
|------------|----------------------|
| PreToolUse | Know Claude is about to use a tool |
| PostToolUse | Know tool completed (success/failure) |
| PostToolUseFailure | Know tool failed |
| Notification (permission_prompt) | User needs to approve/deny a tool |
| Notification (idle_prompt) | Claude is idle/waiting |
| Stop | Claude's turn is complete; read transcript now |
| SessionStart | New session began |
| SessionEnd | Session ended |

### Key Invariants (CORE, won't change)

1. **Messages are ordered, append-only** in the session file
2. **Four roles:** System, User, Assistant, Tool
3. **Three content block types:** Text, ToolUse, ToolResult
4. **ToolUse.id links to ToolResult.tool_use_id** (one-to-one)
5. **A turn is:** user message, then N iterations of (assistant + tool results), ending with assistant-only message
6. **Compaction replaces old messages** with a System summary message
7. **Sessions persist as JSONL** with append-only writes
8. **Hook payload format** (JSON with hook_event_name, tool_name, tool_input, tool_output, tool_result_is_error)
9. **Three hook events** (PreToolUse, PostToolUse, PostToolUseFailure)
10. **Permission model** has modes (ReadOnly, WorkspaceWrite, DangerFullAccess) and prompt escalation

### What Might Change (SURFACE)

1. Specific tool names and schemas (new tools added frequently)
2. Slash command list (grows with each release)
3. Config file paths (`.claw` vs `.claude`)
4. Model names and pricing
5. Worker/lane event schemas (internal orchestration details)
6. MCP transport details
7. Plugin manifest format

### Mapping to Real Claude Code

This reference codebase ("claw-code") is a Rust rewrite/port. The real Claude Code uses TypeScript/Node.js. Key differences:

1. **Session path in real CC:** `~/.claude/projects/<mangled-project-path>/<session-id>.jsonl`
2. **Session path in claw-code:** `.claw/sessions/<session-id>.jsonl`
3. **Config path in real CC:** `~/.claude/settings.json`, `<repo>/.claude/settings.json`
4. **Config path in claw-code:** `~/.claw.json`, `<repo>/.claw.json`
5. **Hook events in real CC:** 25+ event types (PreToolUse, PostToolUse, Notification, Stop, SessionStart, SessionEnd, SubagentStart, SubagentStop, etc.)
6. **Hook events in claw-code:** 3 event types (PreToolUse, PostToolUse, PostToolUseFailure)

The core data model (Session, ConversationMessage, ContentBlock, MessageRole) is identical between the two implementations. The JSONL format is the same. The tool schemas are the same.
