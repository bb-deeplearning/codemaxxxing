# Style — codemaxxxing standards (carried forward from codex-parity-2026-05-13)

This file is a focused carry-forward of the previous campaign's `STYLE.md`, edited for this campaign's narrower scope. The full version lives at `.wave/campaigns/codex-parity-2026-05-13/plan/STYLE.md` — consult it for any rule not enumerated here.

## Effect v4 rules (most relevant to this campaign)

- `Effect.gen(function* () { ... })` for composition.
- `Effect.fn("Domain.method")` for named/traced effects. `Effect.fnUntraced` for internal helpers.
- `Effect.callback` for callback-based APIs.
- `Effect.void` instead of `Effect.succeed(undefined)`.
- `Schema.Class` for multi-field data; `Schema.brand` for single-value types; `Schema.TaggedErrorClass` for typed errors.
- In `Effect.gen` / `Effect.fn`, prefer `yield* new MyError(...)` over `yield* Effect.fail(new MyError(...))`.
- Use `makeRuntime` (`src/effect/run-service.ts`) for service runtimes.
- Use `InstanceState.make(...)` (`src/effect/instance-state.ts`) for per-directory state with per-instance cleanup. **Bug 1 of this campaign is what happens when InstanceState's per-directory keying is mismatched against per-root semantics — see Wave 1.**
- `Effect.fork` and `Effect.forkDaemon` do not exist in v4. Use `Effect.forkIn(scope)` to fork into a specific scope.
- For concurrent siblings (the multi-agent child fibers), use `Effect.forkIn(parentScope)` so siblings die when the parent's scope dies.
- For background subscribers inside `InstanceState.make`, use `Effect.forkScoped(...)` and re-inject `Effect.provideService(InstanceRef, ctx)` per the GOTCHA `bus-subscriber-needs-instance-state-fork-and-instance-ref`.
- `Result` not `Either` (Effect v4 rename) — see GOTCHA `effect-v4-either-renamed-to-result`. `Effect.result` not `Effect.either`. `Result.isSuccess` / `Result.isFailure` / `r.success` / `r.failure`.
- `SubscriptionRef.changes(ref)` — top-level, not `ref.changes` — per GOTCHA `subscriptionref-changes-is-top-level`.

## TypeScript style

- No `any`. Use `Schema.Defect` for defect-like causes.
- No non-null assertions (`!`) except where genuinely safe and commented.
- Avoid `try`/`catch` — let errors bubble through Effect. (Exception: the existing `try { EventV2.run(...) } catch {}` swallow pattern in `control.ts` for projector-side failures stays.)
- Use Bun APIs (`Bun.file()`, `Bun.spawn()`) when convenient.
- Type inference over explicit annotations; explicit types for exported API surfaces.
- `flatMap` / `filter` / `map` over `for` loops; type guards on filter to keep inference.
- Inline values used once.
- `const` over `let`. Ternaries / early returns over reassignment.
- Avoid `else`. Prefer early returns.
- Don't destructure for the sake of it. Dot notation preserves context.

## Module shape (mandatory)

Every module follows the self-reexport pattern. NO `export namespace`. Per `packages/opencode/AGENTS.md`:

```ts
// src/agent/control.ts
export interface Interface { ... }
export class Service extends Context.Service<Service, Interface>()("@opencode/AgentControl") {}
export const layer = Layer.effect(Service, ...)
export const defaultLayer = layer.pipe(...)

export * as AgentControl from "./control"
```

Consumers `import { AgentControl } from "@/agent/control"` and use `AgentControl.Service`, `AgentControl.layer`, etc.

For the per-root refactor in Wave 1: keep all per-root state inside the existing `InstanceState.make` closure as a `Map<RootSessionID, PerRootData>`. Do NOT extract a new module — the cohesion is in the AgentControl service.

## Naming

- Files: kebab-case.
- Classes/Interfaces/Schemas: PascalCase.
- Functions/methods: camelCase.
- Constants: SCREAMING_SNAKE_CASE.
- Brand types: PascalCase with `ID` / `Path` suffix.
- Permission keys: snake_case strings matching tool names.

## Testing tone

Test names read as sentences:

```ts
it.instance("two roots in the same project each see only their own children", () => ...)
it.instance("wait_agent returns within 100ms of child completion", () => ...)
it.instance("send to a session id from a different root rejects with AgentNotFoundError", () => ...)
```

Bad:

```ts
it.instance("multi root works", () => ...)
it.instance("test wait", () => ...)
```

## Comments

Code comments explain **why**, not **what**. When porting from codex, leave the codex file:line you ported.

```ts
// Mirrors codex maybe_start_completion_watcher (control.rs:943-1015): when a
// child reaches a final status, send a notification to the parent's mailbox so
// wait_agent's seq watch wakes. trigger_turn=false because this is informational.
```

## File length

Keep files under 600 lines where possible. `agent/control.ts` is currently ~1095 lines and the per-root refactor will likely add another ~200. If it crosses 1300 lines AFTER Wave 1, factor a `per-root.ts` helper file out (with its own self-reexport), but do not pre-emptively split — coherence first, length second.

## Imports

- Absolute imports via `@/` for opencode src.
- `@opencode-ai/core/...` for the core package.
- `effect` for Effect modules.
- Group: external, internal `@/`, internal relative — separated by blank lines.

## Error handling

- Use `Schema.TaggedErrorClass` for new error types.
- Errors carry the data the caller needs to recover or report — not just a string.
- Tools return model-recoverable errors via the `metadata.error` + `output: <prose>` shape (mirrors codex `FunctionCallError::RespondToModel`).

## What "junior-tier code" looks like (don't ship this)

- Mutable state outside of clearly-bounded scopes.
- `console.log` for debugging left in.
- Commented-out code.
- Catch-all `try/catch` that swallows errors (the `EventV2.run` swallow is the documented exception).
- Functions with > 5 parameters.
- Magic numbers without a named constant or comment.
- Copy-pasted blocks instead of helpers.
- Tests that test mocks instead of behavior.
- Tests that don't actually run the code under test.
- New global state.
- Implicit `any` types.

## Verification before commit

Every wave's commit must pass:

```bash
cd packages/opencode
bun typecheck    # zero errors
bun lint         # zero errors
bun test --coverage <single-file>.test.ts   # 100% line coverage on touched files
bun test ./test/integration/multi-agent-invariants.test.ts   # all enabled invariants pass
bun test ./test/perf/<wave-bench>.bench.ts  # within budget vs baseline (when applicable)
```

Run via `git add -A && git commit -m "..."` — do NOT use `--no-verify`. If pre-commit hooks complain, fix the cause.
