# Style — codemaxxxing standards, applied with no slack

The repo has a style guide (`AGENTS.md` at repo root, `packages/opencode/AGENTS.md` for package). This campaign holds to those AND raises the bar in places that matter for code that ships permanently.

## Effect rules (from packages/opencode/AGENTS.md)

- `Effect.gen(function* () { ... })` for composition.
- `Effect.fn("Domain.method")` for traced/named effects. `Effect.fnUntraced` for internal helpers.
- `Effect.callback` for callback-based APIs.
- `Effect.void` instead of `Effect.succeed(undefined)`.
- `DateTime.nowAsDate` over `new Date(yield* Clock.currentTimeMillis)`.
- Use `Schema.Class` for multi-field data. Use branded schemas (`Schema.brand`) for single-value types. Use `Schema.TaggedErrorClass` for typed errors.
- In `Effect.gen` / `Effect.fn`, prefer `yield* new MyError(...)` over `yield* Effect.fail(new MyError(...))`.
- Use `makeRuntime` (`src/effect/run-service.ts`) for service runtimes.
- Use `InstanceState` (`src/effect/instance-state.ts`) for per-directory state with per-instance cleanup.
- `Effect.fork` and `Effect.forkDaemon` do not exist in v4. Use `Effect.forkIn(scope)` to fork into a specific scope. **For concurrent siblings, you must use `Effect.forkIn(parentScope)` so siblings die when the parent's scope dies.**
- Prefer `FileSystem.FileSystem`, `ChildProcessSpawner.ChildProcessSpawner`, `HttpClient.HttpClient` over raw platform APIs.
- For background loops use `Effect.repeat` / `Effect.schedule` with `Effect.forkScoped` in the layer definition.
- Use `Effect.cached` for in-flight deduplication of concurrent callers.
- Use `Instance.bind(fn)` for native addon callbacks (node-pty, native fs.watch, etc.) — see `pty/index.ts` for the pattern.

## TypeScript style (from repo-root AGENTS.md)

- No `any`. Use `Schema.Defect` for defect-like causes.
- No non-null assertions (`!`) except where genuinely safe and commented.
- Avoid `try`/`catch` — let errors bubble through Effect.
- Use Bun APIs (`Bun.file()`, `Bun.spawn()` only when not using ChildProcessSpawner) when convenient.
- Type inference over explicit annotations; explicit types only for exported API surfaces.
- `flatMap` / `filter` / `map` over `for` loops; type guards on filter to keep inference.
- Inline values used once. Don't create variables for one-time use.

```ts
// Good
const result = await Bun.file(path.join(dir, "data.json")).json()

// Bad
const filePath = path.join(dir, "data.json")
const result = await Bun.file(filePath).json()
```

- `const` over `let`. Ternaries / early returns over reassignment.
- Avoid `else`. Prefer early returns.
- Don't destructure for the sake of it. Dot notation preserves context.
- Drizzle: snake_case field names so column names don't need redefinition.

## Module shape (mandatory)

Every module follows the self-reexport pattern:

```ts
// src/agent/control.ts
export interface Interface { ... }
export class Service extends Context.Service<Service, Interface>()("@opencode/AgentControl") {}
export const layer = Layer.effect(Service, ...)
export const defaultLayer = layer.pipe(...)

export * as AgentControl from "./control"
```

Consumers import `import { AgentControl } from "@/agent/control"` and use `AgentControl.Service`, `AgentControl.layer`, etc.

For multi-sibling directories (like `packages/opencode/src/agent/`), keep each module its own file with its own self-reexport. Do NOT add a barrel `index.ts`. Consumers import the specific sibling.

## Naming

- Files: kebab-case (`head-tail-buffer.ts`, `agent-control.ts`)
- Classes/Interfaces/Schemas: PascalCase (`AgentControl`, `Mailbox`, `InterAgentCommunication`)
- Functions/methods: camelCase (`pushChunk`, `spawnAgent`, `sendInterAgentCommunication`)
- Constants: SCREAMING_SNAKE_CASE for true constants (`MAX_UNIFIED_EXEC_PROCESSES`)
- Brand types: PascalCase with `ID` suffix where applicable (`AgentPath`, `ProcessID`, `ThreadID`)
- Permission keys: snake_case strings matching tool names (`exec_command`, `spawn_agent`, `send_message`, `wait_agent`, etc.)

## Testing tone

Test names read as sentences:

```ts
it("pushChunk fills head before tail when below max_bytes", () => { ... })
it("returns timed_out: true when no mailbox update arrives before deadline", () => { ... })
it("spawnAgent rejects when depth exceeds agent_max_depth", () => { ... })
```

Bad:
```ts
it("test 1", () => { ... })
it("works", () => { ... })
it("pushChunk", () => { ... })
```

## Comments

Code comments explain **why**, not **what**. The what is in the code. The why is the context the next reader needs.

```ts
// BAD
// Increment the counter
counter += 1

// GOOD
// Codex's empty-poll uses a 5s minimum to prevent the model from spam-polling
// short-running processes — see process_manager.rs:643-652. We replicate this
// because the same model behavior produces the same pattern here.
yieldTime = clamp(yieldTime, MIN_EMPTY_YIELD_TIME_MS, maxWriteStdinYieldTimeMs)
```

When porting from codex, leave a comment with the exact codex file:line you ported so future readers can verify.

## File length

Keep files under 600 lines where possible. The exceptions in this codebase (prompt.ts at 1931, session/index.tsx at 2915) exist for historical reasons and are actively a problem. Don't add to them. New modules go in their own files.

## Imports

- Absolute imports via `@/` for opencode src
- `@opencode-ai/core/...` for the core package
- `effect` for Effect modules
- Group: external, internal `@/`, internal relative — separated by blank lines

## Error handling

- Use `Schema.TaggedErrorClass` for new error types
- Errors carry the data the caller needs to recover or report — not just a string
- Tools return `FunctionCallError.RespondToModel` for model-recoverable errors (mirrors codex pattern)
- Effect failures propagate via `yield* new SomeError({ ... })`

## What "junior-tier code" looks like (don't ship this)

- Mutable state outside of clearly-bounded scopes
- `console.log` for debugging left in
- Commented-out code
- Catch-all `try/catch` that swallows errors
- Functions with > 5 parameters that should be a single options object
- Magic numbers without a named constant or comment
- Copy-pasted blocks instead of extracting helpers
- Tests that test mocks instead of behavior
- Tests that don't actually run the code under test
- New global state
- Implicit `any` types
- A 200-line function that should be three 60-line functions

If you find yourself writing any of those, stop. Restructure.

## What good code looks like

- Each function does one thing, named for what it does
- State is held by services (`InstanceState` for per-directory, `Context.Service` for layers)
- Concurrency primitives are explicit (`Effect.forkIn`, `Queue`, `SubscriptionRef`)
- Errors are typed and the caller knows which ones can happen
- Hot loops are profiled, not guessed
- Tests exist for every behavior, not every line — but coverage is 100% as a side effect

## Verification before commit

Every wave's commit must pass:

```bash
cd packages/opencode
bun typecheck    # zero errors
bun lint         # zero errors
bun test <wave-files>  # all green, 100% coverage
bun test <wave-perf-bench>  # within budget
```

These run via `git add -A && git commit -m "..."` — do NOT use `--no-verify`. If pre-commit hooks complain, fix the cause.
