# Style — codebase idioms and what "shitty unidiomatic regression-causing amateur-tier code" means

The campaign's quality bar matches the codebase. New code that ignores the conventions below is rejected by reviewer instinct and by the wave's `bun lint` + `bun typecheck` gates. If unsure, mirror the surrounding file's pattern.

## Effect v4 (effect-smol)

Read the repo-root `AGENTS.md` § "opencode Effect rules" for the full reference. Highlights:

- Use `Effect.gen(function* () { ... })` for composition. Never raw `.then()` chains.
- Named/traced effects via `Effect.fn("Domain.method")`. Internal helpers via `Effect.fnUntraced`.
- `Effect.fn`/`Effect.fnUntraced` accept pipeable operators as extra args — no outer `.pipe()` wrapper needed.
- `Effect.callback` for callback-based APIs.
- `Effect.void`, not `Effect.succeed(undefined)`.
- `DateTime.nowAsDate` over `new Date(yield* Clock.currentTimeMillis)`.
- `Effect.fork` and `Effect.forkDaemon` DO NOT EXIST in v4. Use `Effect.forkIn(scope)` to fork into a specific scope.
- `Schema.Class` for multi-field data; `Schema.brand` for single-value branded types; `Schema.TaggedErrorClass` for typed errors; `Schema.Defect` instead of `unknown` for defect-like causes.
- In `Effect.gen` / `Effect.fn`, prefer `yield* new MyError(...)` over `yield* Effect.fail(new MyError(...))` for direct early-failure branches.

## Runtime vs InstanceState

Use `makeRuntime` (from `src/effect/run-service.ts`) for all services. Use `InstanceState` (from `src/effect/instance-state.ts`) for per-directory or per-project state with per-instance cleanup.

Per `InstanceState` rules:
- If two open directories should not share one copy of the service, it needs `InstanceState`.
- Do the work directly in the `InstanceState.make` closure — `ScopedCache` handles run-once semantics. Don't add fibers / `ensure()` / `started` flags on top.
- Cleanup via `Effect.addFinalizer` or `Effect.acquireRelease` inside the closure.
- Background stream consumers via `Effect.forkScoped` inside the closure.
- To make `init()` non-blocking, fork `InstanceState.get(state)` at the call site (e.g. `Effect.forkIn(scope)`), not by forking work inside the `InstanceState.make` closure (forking inside leaves state incomplete for other readers).
- `src/project/bootstrap.ts` already wraps every service `init()` in `Effect.forkDetach`. Keep `init()` synchronous internally; the caller controls concurrency.

## Module shape

Per repo `packages/opencode/AGENTS.md` § "Module shape":

- Do NOT use `export namespace Foo { ... }`. Not standard ESM, breaks tree-shaking, breaks Node's native TypeScript runner.
- Use flat top-level exports + self-reexport at the bottom:
  ```ts
  // src/foo/foo.ts
  export interface Interface { ... }
  export class Service extends Context.Service<Service, Interface>()("@opencode/Foo") {}
  export const layer = Layer.effect(Service, ...)
  export const defaultLayer = layer.pipe(...)

  export * as Foo from "./foo"
  ```
- For `foo/index.ts`, use `"."` for the self-reexport: `export * as Foo from "."`.
- Multi-sibling directories (e.g. `src/session/`): NO barrel `index.ts`. Each sibling self-exports.
- Consumers import the namespace projection: `import { Foo } from "@/foo/foo"`.

## General TypeScript idioms

Per repo-root `AGENTS.md` § "Style Guide":

- Keep things in one function unless composable or reusable.
- Avoid `try`/`catch` where possible.
- Avoid the `any` type.
- Use Bun APIs when possible (`Bun.file()` over `fs.readFile`).
- Rely on type inference. Avoid explicit annotations or interfaces unless needed for exports or clarity.
- Functional array methods (`flatMap`, `filter`, `map`) over `for` loops. Use type guards on `filter` to maintain type inference downstream.
- `const` over `let`. Ternaries or early returns instead of reassignment.
- Avoid `else`. Prefer early returns.
- Avoid unnecessary destructuring. Dot notation preserves context.
- Inline single-use variables.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

## Schema definitions (Drizzle)

Snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})
```

This campaign adds NO Drizzle migrations.

## Tool descriptions are prompts

Per the codex-parity campaign's `PROMPT_ENGINEERING.md` (still authoritative):

- Tool descriptions are operational manuals the model reads. Not labels.
- Codex-quality, codemaxxxing voice: terse, second-person where useful, no marketing prose.
- Cover: when to use, when NOT to use, failure modes, cost, examples.
- Length floor: ~400-800 words for substantive tools.
- Junior-tier prose ("This tool runs commands. Use it when needed.") fails the wave.

Wave 5 carries the prompt-rewriting work for this campaign. Read the codex-parity `PROMPT_ENGINEERING.md` before that wave.

## TUI render budget — DO NOT TRIP THE FREEZE

Per the repo-root GOTCHAS.md (slug `tui-render-freeze-flex-row-tall-text` and the spec `specs/tui-render-freeze.md`):

- Flex-row + tall-text inside the same render node trips opentui's layout-budget freeze. The four manifestations cataloged so far are documented; do NOT add a fifth.
- Use `inline-safe` sanitizer (`@tui/util/inline-safe`) at every confirmed risk site. Centralize.
- For body-content surfaces, drop flex-row entirely (absolute-marker pattern, same shape as `AssistantMessage` marginalia fix in `23e0e84f6`).

This campaign does NOT touch TUI rendering surfaces. If a wave finds itself reaching into `tui/`, stop and surface USER QUESTION.

## Tests cannot run from repo root

Per the `do-not-run-tests-from-root` GOTCHA. Run tests from package directories: `cd packages/opencode && bun test ...`.

## Type checking

Always `bun typecheck` from package dirs. Never `tsc` directly.

## What "amateur-tier" looks like and is rejected

Examples that fail review:

- A new function with `try`/`catch` swallowing errors silently.
- Manual `let` with conditional reassignment instead of a ternary.
- `any` types where inference would have worked.
- A new module with `export namespace`, or a new barrel `index.ts` in a multi-sibling directory.
- A test that asserts on internal state shape (`expect(service["data"]["map"].size).toBe(2)`).
- A test that doesn't follow the sentence-name rule.
- An Effect chain that reaches for `.then()` instead of `Effect.gen`.
- A new fiber forked with `Effect.fork` (doesn't exist in v4).
- A new `InstanceState.make` closure with a `started` flag or `ensure()` callback.
- A tool description that's a one-liner label.
- A bash command that runs `cd <dir> && <cmd>` instead of using `workdir`.
- A file edit that ignores the surrounding file's existing pattern (e.g. introduces a class in a file full of functions, or vice versa).

If your code looks unlike everything else in the file or directory, it's wrong. Match the local style.
