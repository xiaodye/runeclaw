# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Instructions

### Documentation Lookup

Use the `find-docs` skill whenever the user asks about a library, framework, SDK, API, CLI tool, or cloud service, even well-known ones like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. This includes API syntax, configuration, version migration, library-specific debugging, setup instructions, and CLI tool usage. Use even when the answer seems familiar, because local knowledge may be stale. Prefer it over web search for library docs.

Do not use it for refactoring, writing scripts from scratch, debugging business logic, code review, or general programming concepts.

The skill drives the Context7 CLI (`npx ctx7@latest`). Two steps:

1. Resolve the library name to an ID: `npx ctx7@latest library <name> "<query>"` — skip only if the user provides an exact library ID in `/org/project[/version]` format.
2. Query docs with that ID: `npx ctx7@latest docs <libraryId> "<query>"`.

Pick the best match by exact name match, description relevance, code snippet count, source reputation, and benchmark score; if results look wrong, try alternate names or rephrased queries. Keep queries descriptive and one-topic, never include secrets, and cap at 3 attempts per question before falling back to the best result you have.

### TypeScript TSDoc

When adding or changing TypeScript/TSX code, follow `.agent/skills/add-tsdoc-comments/SKILL.md` and add concise **Chinese** TSDoc for newly introduced or materially changed functions, methods, class members, interface fields, and object-like type members.

## Commands

- `pnpm dev` — run from source via `tsx src/index.ts` (no compile step; preferred for development)
- `pnpm build` — bundle `src/index.ts` → `dist/index.js` via esbuild (deps stay external; injects shebang + sets exec bit). `bin` points at `dist/index.js`
- `pnpm start` — run the built `dist/index.js`
- `pnpm init` — run the interactive config wizard (generates `runeclaw.config.json` + `.env`)
- `pnpm start:rag` / `runeclaw --rag` — start with auto-import of `docs/*.md` into the RAG store
- `pnpm release [-- minor | major]` — bump version + publish `@xiaodye/runeclaw` to the npm registry (`scripts/release.mjs`)

There is **no test runner configured** — no test script or framework dependency. (`src/context/defense.spec.ts` is a stray spec with no harness.) Node 22+ / pnpm 10.x is required.

## Architecture

RuneClaw is a local AI-agent CLI. The runtime is composed from a single entry point, then wired together in one composition root.

### Entry → composition root → loop

- `src/index.ts` — CLI entry; parses the subcommand (`init` / `start` / `continue` / `help` / `version` / `--rag`) and lazy-imports the target module.
- `src/main.ts` — the **composition root**. Constructs every service and wires them together: loads config, builds the OpenAI-compatible provider (`@ai-sdk/openai` → DeepSeek), registers tools, and starts memory, RAG, skills, plugins, the Feishu channel, cron, sub-agents, hooks, and the command dispatcher. `startAgent()` then runs the readline REPL. This file is the map for how anything fits together.
- `src/agent/loop.ts` — the core loop. Uses `streamText` from the `ai` SDK (`@ai-sdk/*`), streams text + tool calls, and drives retries (`retry.ts`), loop detection (`loop-detection.ts`), and context compression (`../context/defense.js`). Hard limits: `MAX_STEPS = 15`, `MAX_RETRIES = 3`, `TOKEN_BUDGET = 150_000`.

### Central abstractions

- `src/tools/registry.ts` — `ToolRegistry` is the heart of tool execution. Tools are `ToolDefinition`s with `name` / `description` / `parameters` (JSON Schema) / `execute`. `register()` adds them; `toAISDKFormat()` converts them to AI-SDK tools while adding: bash risk classification (`security/bash-classifier.ts`), pre/post hook execution, a concurrency lock (exclusive vs. concurrency-safe tools), and result truncation (`truncateResult`). Tools with `shouldDefer: true` are hidden until discovered via the `tool_search` tool; MCP tools are registered prefixed as `mcp__<server>__<name>`.
- `src/context/prompt-builder.ts` — `PromptBuilder` composes the system prompt as an ordered `.pipe(name, fn)` chain; `build(ctx)` joins the non-null sections. Wired in `main.ts` with `coreRules` → `toolGuide` → `deferredTools` → `memoryContext` → `ragContext` → `skillContext` → `sessionContext`. Add prompt sections by adding a pipe here.
- `src/config/` — `schema.ts` defines `SuperAgentConfigSchema` (zod); `loader.ts` reads `runeclaw.config.json` and substitutes `${VAR}` placeholders from environment variables (loaded via `dotenv/config`).

### Subsystems (one directory each)

- `src/tools/` — built-in tools (file, shell, search, web-search, memory, rag, cron, spawn) + MCP client/adapters.
- `src/rag/` — SQLite vector store (`sqlite-store.ts`, using `sqlite-vec` on `knowledge.db`), DashScope embedder (`embedder.ts`), chunker, and search.
- `src/memory/`, `src/session/`, `src/cron/` — persistence layers (memory store, session JSONL, cron jobs/logs).
- `src/security/` — RBAC roles (`roles.ts`), pre/post `hooks.ts`, and `bash-classifier.ts` for dangerous-command detection.
- `src/channels/` — the Feishu/Lark channel (Hono server on port 3000), registered through `ChannelGateway`.
- `src/commands/` — slash commands, combined via `createDispatcher([...])` into the REPL.
- `src/agents/`, `src/skills/`, `src/plugins/`, `src/mcp/`, `src/ui/`, `src/usage/` — sub-agent spawning, skill loading, plugin management, MCP, terminal UI (Ink/markdown), and usage/cost tracking.

## Conventions

- **Secrets go in `.env`, never in `runeclaw.config.json`.** The config file holds only `${LLM_API_KEY}`-style placeholders that `loadConfig` substitutes at startup.
- **Import specifiers are inconsistent** — some files use extensionless imports (`./tools/registry`) and others use `.js` (`./mcp-client.js`). esbuild resolves both at build time and tsx at dev time; match the style of the surrounding file.
- `docs/` is **RAG test data**, not real project docs (its `api-design.md` / `deployment-guide.md` describe a fictional Postgres/PM2 setup). Runtime data (`.cron/`, `.sessions/`, `.memory/`, `.usage/`, `knowledge.db`) is gitignored/local.
- Commit messages and code comments are written in Chinese.
- 用最简单的方式实现，不要考虑本次需求之外的扩展性，能用现有依赖就不要造轮子。
- WEB UI 相关的改动，完成后必须打开页面截图自查，覆盖暗色模式和窄屏，确认视觉无误再报告完成。
