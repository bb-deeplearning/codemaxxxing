# Wave 5 — Mailbox primitive

**Prior waves:** 0-4 (none of which touch agent code).
**Also read:** `OVERVIEW.md`, `STYLE.md`, `TDD.md`, `CONSTANTS.md`.
**Codex source to mirror:**
- `/Users/rohan/Documents/Personal/experiments/codemaxxxing-codex/codex-rs/core/src/agent/mailbox.rs` (161 lines) — `Mailbox` + `MailboxReceiver`

## Goal

Build the per-session mailbox primitive that powers cross-agent messaging. Exact semantic parity with codex's mailbox: monotonic seq, drain-in-delivery-order, has_pending_trigger_turn detection, watch-channel notification.

## Tasks

Sequential.

### 1. Define the message schema

File: `packages/opencode/src/agent/agent-path.ts`

```ts
import { Schema } from "effect"

const ROOT = "/root"

const _AgentPath = Schema.String.pipe(
  Schema.brand("AgentPath"),
  // Validation: must start with "/", must use only [a-z0-9_/], no trailing slash, no double slashes
)

export type AgentPath = typeof _AgentPath.Type

export const AgentPath = Object.assign(_AgentPath, {
  ROOT: _AgentPath.make(ROOT),
  root: () => _AgentPath.make(ROOT),
  isRoot: (p: AgentPath) => p === ROOT,
  parent: (p: AgentPath) => /* "/root/a/b" → "/root/a"; "/root" → null */,
  join: (p: AgentPath, leaf: string) => /* "/root/a" + "b" → "/root/a/b" */,
  // Resolve a relative-or-canonical reference against current.
  // - "task_x" → current/task_x
  // - "/root/x/y" → "/root/x/y"
  // - "../sibling" → parent(current)/sibling
  resolve: (current: AgentPath, reference: string) => Effect.Effect<AgentPath, AgentPathInvalidError>,
})

export class AgentPathInvalidError extends Schema.TaggedErrorClass<AgentPathInvalidError>()(
  "AgentPathInvalidError",
  { input: Schema.String, reason: Schema.String },
) {}

export * as AgentPath from "./agent-path"
```

Tests in `packages/opencode/src/agent/agent-path.test.ts` cover:
- root path is `/root`
- valid paths: `/root`, `/root/a`, `/root/a/b/c`, `/root/_x_`
- invalid paths: `""`, `/root/`, `/root//x`, `/root/X` (uppercase), `/root/a-b` (hyphen), `/foo` (not under root)
- `parent` returns null for root, returns the prefix for nested
- `join` validates the leaf
- `resolve` for relative names: `task_x` from `/root/a` → `/root/a/task_x`
- `resolve` for canonical paths: `/root/x/y` → `/root/x/y`
- `resolve` for `..`: from `/root/a/b`, `..` → `/root/a`
- `resolve` errors: invalid leaf, escaping root with `..`, etc.

### 2. Define the InterAgentCommunication shape

File: `packages/opencode/src/agent/inter-agent-communication.ts`

```ts
export class InterAgentCommunication extends Schema.Class<InterAgentCommunication>(
  "InterAgentCommunication",
)({
  author: AgentPath,
  recipient: AgentPath,
  content: Schema.String,
  trigger_turn: Schema.Boolean,
  sent_at: NonNegativeInt,
  // Optional structured items for richer messaging (matches codex Op::InterAgentCommunication).
  // For v0 we ship plain text only; this is here for forward compat.
  items: Schema.optional(Schema.Array(Schema.Unknown)),
}) {}

export * as InterAgentCommunication from "./inter-agent-communication"
```

Tests at `inter-agent-communication.test.ts` cover construction, schema validation, JSON roundtrip.

### 3. Tests first for Mailbox

File: `packages/opencode/src/agent/mailbox.test.ts`

Cover (mirror codex's `mailbox.rs` test cases):

- `new mailbox has 0 pending` — `hasPending() === false`, `hasPendingTriggerTurn() === false`
- `send returns monotonically increasing seq starting at 1`
- `send with trigger_turn: false → hasPendingTriggerTurn() === false`
- `send with trigger_turn: true → hasPendingTriggerTurn() === true`
- `mixed sends: queue + trigger_turn → hasPendingTriggerTurn() === true`
- `drain returns messages in delivery order, then mailbox is empty`
- `drain on empty returns empty array`
- `subscribe receiver gets notified on send` — race a subscribe with a send, assert the watch advances within 10ms
- `subscribe survives multiple sends — each advances the seq`
- `concurrent sends from N fibers each get unique seq` — fork 10 fibers, each sends one message, assert seqs are 1..10 (some order)
- `drain after a notify-and-wait clears hasPendingTriggerTurn for already-drained trigger_turn messages`

### 4. Implement Mailbox

File: `packages/opencode/src/agent/mailbox.ts`

Public surface:
- `Mailbox.make()` returns `Effect<Interface>` — Interface has `send(msg) → Effect<seqNumber>`, `subscribe() → Effect<SubscriptionRef<number>>`, `drain() → Effect<readonly InterAgentCommunication[]>`, `hasPending() → Effect<boolean>`, `hasPendingTriggerTurn() → Effect<boolean>`

Implementation choice (per gotcha #1): use `Ref<readonly InterAgentCommunication[]>` for storage and `SubscriptionRef<number>` for monotonic seq notification. **Do not use `Queue.unbounded`** — Effect's Queue lacks non-consuming peek which `hasPendingTriggerTurn` needs. The Ref-backed deque matches codex's effective behavior (`MailboxReceiver` syncs from mpsc → `VecDeque` for the same reason).

Module shape per `STYLE.md` § "Module shape" — flat exports + `export * as Mailbox from "./mailbox"` at the bottom.

### 5. Bench

File: `packages/opencode/test/perf/mailbox.bench.ts`

- `mailbox.send` — 1000 sequential sends; measure per-op cost
- `mailbox.subscribe.wakeup_latency` — fork a subscriber that waits, send, measure resume latency (target: ≤ 5ms p99 per `PERF.md`)
- `mailbox.drain.100_messages` — populate to 100, drain, measure

Output: `.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_5.json`. No baseline (new code); just record.

## Gotchas

1. **Don't use `Queue` for storage.** Codex's `MailboxReceiver` keeps a `VecDeque` synced from the mpsc channel because Tokio's mpsc lacks non-consuming peek; Effect's `Queue` has the same limitation. Use a `Ref<readonly InterAgentCommunication[]>` for storage and `SubscriptionRef<number>` for notification — single source of truth, no dual-state races.

2. **`SubscriptionRef.set` for the seq notification.** `SubscriptionRef.update` is also fine. The point is: subscribers see the new seq via `SubscriptionRef.changes` which yields a stream of values.

3. **Wait semantics for subscribers.** `wait_agent` (Wave 8) will subscribe to the seq watch and use `Stream.takeUntil` or `SubscriptionRef.changes.pipe(Stream.runHead, Effect.timeout(...))`. The mailbox itself only exposes the SubscriptionRef; the timeout/race lives in `wait_agent`'s implementation.

4. **AgentPath validation is strict.** Match codex's parser: lowercase letters, digits, underscores in path segments; rooted at `/root`; no trailing slash. Errors are typed (`AgentPathInvalidError`).

5. **Schema brands and validation.** Use `Schema.brand` plus a `Schema.filter` (or `Schema.refine`) to enforce path syntax at decode time. Tests cover invalid inputs.

6. **`InterAgentCommunication.items` for forward compat.** Codex's `InterAgentCommunication` carries `Vec<UserInput>` (text, image, etc.). For v0 we ship plain-text only (`content: string`); the `items?: Array<Unknown>` field is reserved for future structured payloads.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

bun test src/agent/agent-path.test.ts
bun test src/agent/inter-agent-communication.test.ts
bun test src/agent/mailbox.test.ts

bun test --coverage src/agent/agent-path.ts          # 100%
bun test --coverage src/agent/inter-agent-communication.ts  # 100%
bun test --coverage src/agent/mailbox.ts             # 100%

bun test test/perf/mailbox.bench.ts
test -f ../../.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_5.json
```

All exit 0.

## Files

New:
- `packages/opencode/src/agent/agent-path.ts`
- `packages/opencode/src/agent/agent-path.test.ts`
- `packages/opencode/src/agent/inter-agent-communication.ts`
- `packages/opencode/src/agent/inter-agent-communication.test.ts`
- `packages/opencode/src/agent/mailbox.ts`
- `packages/opencode/src/agent/mailbox.test.ts`
- `packages/opencode/test/perf/mailbox.bench.ts`
- `.wave/campaigns/codex-parity-2026-05-13/artifacts/perf/wave_5.json`

Modified: none.
