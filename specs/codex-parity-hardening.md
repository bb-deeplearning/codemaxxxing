# codex-parity-hardening

> **Status (as of 2026-05-14):** shipped on the `codex-parity` branch in
> 6 waves. All baseline metrics within budget vs the prior campaign's
> wave_7 capture. The full pre-existing test suite still passes under
> the team's `bun test --timeout 30000` invocation. The two-chat-same-
> project scenario, the spawn-then-wait-immediate-return scenario, and
> the legacy `task` tool all observably work. Campaign archive:
> `.wave/campaigns/codex-parity-hardening-2026-05-14/`.

## Background

The previous campaign ([`specs/codex-parity.md`](./codex-parity.md))
shipped the multi-agents v2 subsystem in 16 waves with per-primitive
100% line coverage and a frozen perf baseline. Three structural bugs
survived that gate. Two were unfixed; one had been patched on the
branch but had no integration test asserting the fix stayed put. None
of the three were caught by the previous campaign's tests because the
tests asserted that primitives worked — string propagation, mailbox
seq increments, status transitions — not that the user-facing scenarios
those primitives composed into actually worked.

This hardening campaign fixes the two remaining bugs, audits the
already-landed third, and codifies the integration-first discipline
that would have caught all three. The first-class deliverable is
[`INTEGRATION_INVARIANTS.md`](../.wave/campaigns/codex-parity-hardening-2026-05-14/plan/INTEGRATION_INVARIANTS.md)
plus the harness at
`packages/opencode/test/integration/multi-agent-invariants.test.ts`
that holds every multi-agent surface against scenario-level invariants.
Coverage is necessary; it is not sufficient.

## Bug 1 — `AgentControl` state shared across root sessions

### What we saw

Two chat sessions opened against the same project saw each other's
subagents. Chat A's `list_agents` returned chat B's workers. A
`spawn_agent` from chat B with `task_name: "worker_a"` collided on
`path_already_exists` if chat A had spawned a `worker_a` first.
`send_message` to a session id from one chat reached into the other.
`close_agent` cascaded across the root boundary. `wait_agent` wedged
on a parent that didn't own the child it was waiting on.

### Root cause

`AgentControl`'s state lived inside `InstanceState.make` keyed per
directory. Every root session in the same project shared one registry,
one mailbox map, one statuses map, one fibers map, and one `rootRef`
(last-write-wins on `registerSessionRoot`). The previous campaign's
unit tests for each primitive always ran with exactly one root in the
test fixture; the bug surfaced the moment a real user opened a second
chat in the same project.

### Fix

Wave 1 generalised per-instance state to per-root state. Each
registered root session gets its OWN registry, mailboxes, statuses,
and fibers. A `sessionToRoot` index resolves any session id (root or
sub-agent) to its root in O(1) so every method routes the caller's
operations through the right slot. Per-root teardown subscribes to
`Session.Event.Deleted` so closing a chat tears down only that root's
slot.

| Reference | Lines |
|---|---|
| `PerRootData` + `InternalState` shape | `packages/opencode/src/agent/control.ts:297-311` |
| `ensureRootSlot` (idempotent root registration; root also gets a mailbox so `wait_agent` from root works) | `packages/opencode/src/agent/control.ts:447-465` |
| `slotFor` (the O(1) session→root resolution) | `packages/opencode/src/agent/control.ts:467-473` |
| `sendInterAgentCommunication` cross-root rejection | `packages/opencode/src/agent/control.ts:761-803` |
| `Bus.subscribe(SessionDeleted)` per-root teardown | `packages/opencode/src/agent/control.ts:392-409` |

The interface signature change: `sendInterAgentCommunication`,
`listAgents`, and `resolveAgentReference` each gained a required
`senderID: SessionID` parameter so the service can resolve the
caller's root before doing anything. This is permitted by
[`BACKWARD_COMPAT.md`](../.wave/campaigns/codex-parity-hardening-2026-05-14/plan/BACKWARD_COMPAT.md)
because `AgentControl.Service` is an internal-to-package interface;
the user-observable surface (tool input shapes, output JSON, error
tags, permission keys, Bus event payloads) is unchanged.

### Codex precedent

Codex documents the per-root invariant in
`codex-rs/core/src/agent/control.rs:130-136`: "An `AgentControl`
instance is intended to be created at most once per root thread/session
tree. That same `AgentControl` is then shared with every sub-agent
spawned from that root, which keeps the registry scoped to that root
thread rather than the entire `ThreadManager`." The previous campaign
implicitly carried this design but violated it by reusing
`InstanceState`'s per-directory keying — `InstanceState` is the right
primitive for "one per project", not "one per chat in a project".

## Bug 2 — `wait_agent` never wakes on child completion

### What we saw

Parent session calls `spawn_agent` then `wait_agent` with timeout
30s. Child run-loop completes successfully in under 1s. `wait_agent`
times out at the full 30s every time, returning `timed_out: true`
with no useful information. Streaming felt fine; lifecycle felt
broken.

### Root cause

The child fiber's `onExit` handler updated the child's status
`SubscriptionRef` and stopped. `wait_agent`
(`packages/opencode/src/tool/agent-wait/agent-wait.ts:115-127`) raced
the parent's mailbox seq watch against a `Effect.sleep(timeoutMs)`.
Status transitions on the CHILD did not advance the PARENT's mailbox
seq — there was no path between them. The two ends of the wait were
disconnected; the timeout always won.

The previous campaign's per-primitive tests for the child fiber
asserted the status SubscriptionRef was set correctly. The
per-primitive tests for `wait_agent` exercised the timeout path. No
test composed the two primitives.

### Fix

Wave 2 added a sibling watcher fiber forked at every `spawnAgent`
call. The watcher subscribes to the child's status SubscriptionRef.
On final, non-shutdown status it routes a notification through
`sendInterAgentCommunication` to the parent's mailbox. The parent's
mailbox seq advances; `wait_agent`'s race resolves on the change
branch within ~ms of child completion.

| Reference | Lines |
|---|---|
| Sibling completion watcher fork | `packages/opencode/src/agent/control.ts:628-665` |
| Skip rule (closeAgent-triggered shutdown) | `packages/opencode/src/agent/control.ts:644` |
| Notification body construction | `packages/opencode/src/agent/control.ts:657-660` |
| Child fiber `onExit` (writes the final status the watcher reads) | `packages/opencode/src/agent/control.ts:605-625` |
| Root mailbox provisioning so `wait_agent` from root works | `packages/opencode/src/agent/control.ts:454-458` |

The watcher is forked into the per-root data scope (`Effect.forkIn(data.scope)`)
so it dies with the slot. Its send is wrapped in `Effect.catch` so a
race against parent deletion absorbs the resulting `AgentNotFoundError`
silently — there is nothing left to wake.

### Codex precedent

Codex's `maybe_start_completion_watcher`
(`codex-rs/core/src/agent/control.rs:943-1015`) does the same: spawn
a tokio task that holds the child's status receiver, waits for
`is_final`, then injects the notification into the parent. Codex's
notification carries a richer payload including the child's
`last_agent_message`; opencode's `InterAgentCommunication.content` is
plain text so we synthesize a one-line summary. Structured status
information is still available via `subscribeStatus(child_id)` for
any consumer that wants it.

### Notification body shape

Constrained per
[`MESSAGE_SHAPES.md` § "completion notification body shape (Wave 2)"](../.wave/campaigns/codex-parity-hardening-2026-05-14/plan/MESSAGE_SHAPES.md):

```ts
new InterAgentCommunication({
  author: <child_path>,
  recipient: <parent_path>,             // /root if parent is root
  content: `Agent ${child_path} reached status: ${status_label}`,
  trigger_turn: false,                  // informational, not a turn-trigger
  sent_at: Date.now(),                  // wall-clock at observation
})
```

Where `status_label` is one of `completed` or `errored`. The watcher
fires only when `AgentStatus.isFinal(status) === true` AND the status
is not `"shutdown"` — so `interrupted` (non-final, per
`packages/opencode/src/agent/status.ts:49-52`) and `shutdown` (the
parent's own action via `closeAgent`) never produce notifications.
The body shape is part of the cross-agent message contract and stays
stable across this campaign and any future wave.

## Bug 3 — `agent_type` role-vocabulary mismatch (already patched)

### What we saw

The model called `spawn_agent` with `agent_type: "explorer"` (the
codex role name). Opencode has no `explorer` agent. The lookup
failed; the error response leaked all primary + hidden agents. The
model picked `default` next, with the same outcome.

### Root cause

Codex has roles (`default`, `explorer`, `worker`); opencode has
subagents (`explore`, `general`, user-defined). The previous campaign
imported codex's role names verbatim into prose, schema, and tests
without mapping them to opencode's existing primitives. 100% line
coverage didn't catch it because the tests verified that the
`agent_type` string propagated through the spawn pipeline — they
never asserted the propagated string resolved to a real agent.

### Fix (already landed at commit `c86c58f94`)

Production change: `agent_type` made a required `Schema.String`;
`describeSpawnAgent` (mirror of the existing `describeTask` pattern
for the legacy `task` tool) templates the live eligible subagent set
into the tool's description per turn; the `execute` body validates
against the eligible set and returns a model-recoverable
`agent_type_invalid` error when the lookup fails.

| Reference | Lines |
|---|---|
| Required `agent_type: Schema.String` parameter | `packages/opencode/src/tool/agent-spawn/agent-spawn.ts:31-33` |
| Eligible-set validation in `execute` | `packages/opencode/src/tool/agent-spawn/agent-spawn.ts:133-150` |
| `describeSpawnAgent` enumeration | `packages/opencode/src/tool/registry.ts:326-339` |

### Verification

Wave 0 added three audit tests in
`packages/opencode/test/integration/multi-agent-invariants.test.ts:733-839`
that fail loudly if the bug-3 fix regresses: the description
enumeration must list `explore` + `general` (not `explorer` /
`worker` / `default`) as bullet entries, the spawn execute body must
reject `agent_type: "explorer"` with the `agent_type_invalid` tag,
and the `Parameters` schema must keep `agent_type` as a required
string field. The tests are not skipped; they run on every CI
invocation.

## The shared root cause

The three bugs share a single defect mode: tests asserted that
primitives worked, never that scenarios worked.

Bug 1 had per-primitive tests for every `AgentControl` method, all
green, all running with exactly one root in the fixture. The
two-chat-same-project scenario was never composed.

Bug 2 had per-primitive tests for the child fiber's `onExit` (status
SubscriptionRef updated) and for `wait_agent` (timeout path). The
spawn-then-wait-immediate-return scenario was never composed.

Bug 3 had per-primitive tests for `spawn_agent`'s parameter
propagation (agent_type string was passed through the call chain).
The model-asks-for-an-agent-that-doesn't-exist scenario was never
composed — and the chosen example values in those propagation tests
were the codex role names that a real model would never resolve.

[`INTEGRATION_INVARIANTS.md`](../.wave/campaigns/codex-parity-hardening-2026-05-14/plan/INTEGRATION_INVARIANTS.md)
is the durable answer. Every multi-agent surface — present and future
— must hold the listed scenarios. The harness in
`packages/opencode/test/integration/multi-agent-invariants.test.ts`
tests behavior, not implementation: each `it.instance` block walks the
scenario the invariant describes and asserts what the user would
observe.

## INTEGRATION_INVARIANTS.md

The catalog at the top of the doc names ten invariants; the harness
contains one `it.instance` per slug plus the three bug-3 audit tests.
The wave that introduces a new multi-agent surface MUST add the
relevant invariant test before the production code lands. Adding a
new invariant is allowed and expected — append it to the doc's
"Discovered during execution" section, then the implementation.

| Slug | Status | Wave |
|---|---|---|
| `multi-root-isolation` | green | Wave 1 |
| `child-completion-wakes-parent` | green | Wave 2 |
| `child-completion-notification-body-shape` | green | Wave 2 |
| `cross-root-send-rejection` | green | Wave 1 |
| `session-deletion-cleanup` | green | Wave 1 |
| `parent-close-cascades-to-children` | green | Wave 3 |
| `child-fiber-interrupt-during-wait` | green | Wave 2 |
| `mailbox-drain-at-runloop-boundary-with-concurrent-sends` | green | Wave 3 |
| `pty-cleanup-on-parent-abort` | green | Wave 3 |
| `legacy-task-tool-coexists-with-v2` | green | Wave 4 |
| bug-3 audit: enumeration lists `explore`/`general`, not codex roles | green | Wave 0 |
| bug-3 audit: spawn rejects `explorer` with `agent_type_invalid` | green | Wave 0 |
| bug-3 audit: `Parameters.agent_type` required `Schema.String` | green | Wave 0 |

The thirteen tests live at
`packages/opencode/test/integration/multi-agent-invariants.test.ts:157-840`.
None are skipped. The full file runs in well under a minute under
`bun test`.

## Performance

Per-wave deltas vs the prior campaign's frozen wave_7 baseline are in
[`artifacts/perf-final-report.md`](../.wave/campaigns/codex-parity-hardening-2026-05-14/artifacts/perf-final-report.md).
Budget per
[`PERF.md`](../.wave/campaigns/codex-parity-hardening-2026-05-14/plan/PERF.md):
5/10/15 % on p50/p95/p99 vs baseline. All 9 metrics are within budget
across both waves that touched production code (Wave 1 — per-root
scoping; Wave 2 — completion watcher); Waves 3 + 4 made no production
change. The watcher fork's structural cost lands on
`spawnAgent.p99` near the +15% budget edge under the bench's 200
sequential spawns; the production cap of `AGENT_MAX_THREADS=16` keeps
real-world fan-out far below this. A `Fiber.await`-based alternative
tested during Wave 2 was 30× worse on this percentile and was
rejected.

The pre-existing concurrent-session perf invariants in
`packages/opencode/test/e2e/concurrent-perf-invariants.test.ts`
continue to pass on a clean host. The mailbox seq-watch wakeup p99
test is a known suite-pollution flake on hosts under load — verified
identical with and without this campaign's changes per the inherited
`e2e-perf-sibling-fanout-needs-median-of-n` GOTCHA.

## Backward compatibility

Verified end-to-end in Wave 4. Every constraint enumerated in
[`BACKWARD_COMPAT.md`](../.wave/campaigns/codex-parity-hardening-2026-05-14/plan/BACKWARD_COMPAT.md)
holds:

- Legacy `task` tool stays in the registry, takes the same input,
  produces the same `<task_result>` envelope. Asserted by the
  `legacy-task-tool-coexists-with-v2` invariant test. The legacy
  path still creates child sessions via
  `Session.create({ parentID })` directly, with no `AgentControl`
  involvement — Wave 1's per-root refactor does not couple the two.
- The six v2 multi-agent tools' input parameters, output JSON,
  permission keys, error tag set, and emitted Bus events stay
  unchanged. Wave 1 changed the internal `AgentControl.Service`
  signature (added `senderID` to three methods); the user-facing
  surface is unchanged.
- No Drizzle migrations. All new state — the per-root slot map, the
  session-to-root index, the completion-watcher fiber — is
  in-memory.
- `Pty.Service`, `Session.Service`, `MessageV2.Part`, `Tool.Context`,
  `Permission.ask` — all unchanged. The TUI subagent navigation
  keybinds and renderers continue to work.

The full pre-existing test suite passes under the team's
`bun test --timeout 30000` invocation (the script `package.json`
exposes as `bun test`). Two `plugin-hooks` tests time out under bare
`bun test` at the default 5s — these are pre-existing 5s/30s timeout
boundary issues, not regressions introduced by this campaign.

## Discoveries appended to GOTCHAS.md

Three new entries landed in
[`GOTCHAS.md`](../.wave/campaigns/codex-parity-hardening-2026-05-14/plan/GOTCHAS.md):

- **`word-boundary-regex-vs-prose-collisions`** — `\bword\b` matches
  every English usage of `word` in a sentence, because spaces and
  punctuation are non-word characters. Wave 0's first attempt at
  asserting "the codex role name `worker` does not appear in the
  spawn description" matched against the prose in `agent-spawn.txt`
  ("Observer/worker —"). The fix: scope the regex to the bullet
  enumeration (`^- name:`) instead of the whole description string.
- **`bug-3-fix-left-test-files-with-stale-required-shape`** — when a
  `Schema.optional` field is tightened to required, every test
  building inputs without the new field becomes a runtime
  `SchemaError(Missing key)` — but only call sites with concretely
  typed `Tool.Def<typeof Parameters, ...>` flag at typecheck. Sites
  routing through plain `Tool.Def` casts erase the parameter type.
  The schema-tightening commit `c86c58f94` left 21 typecheck errors
  and 16 runtime test failures on the branch until Wave 0 surfaced
  them.
- **`syncevent-publish-uses-helper-bus-not-test-layer-bus`** — events
  emitted via `SyncEvent.run → Database.effect → ProjectBus.publish`
  land on the cross-runtime helper Bus, not the layer-local Bus that
  `testEffect`'s `Effect.provide(layer)` builds for each test. An
  in-effect `bus.subscribe(...)` from inside `InstanceState.make`
  reads from the layer-local Bus and never sees the SyncEvent. Use
  the top-level `Bus.subscribe(def, callback)` helper for these
  subscribers — that targets the same memoMap'd Bus the publish path
  writes to.

The full file in the campaign archive carries the long-form story
(symptom, root cause, fix pattern, code references) for each.

## What this campaign explicitly does NOT do

A hardening campaign is narrower than a feature campaign. The
following nearby surfaces were left alone deliberately:

- **TUI subagent rendering.** The previous campaign's Wave 11 owned
  that surface. It isn't broken; touching it would dilute the
  discipline.
- **The legacy `task` tool.** Coexists with v2; not replaced. The
  `legacy-task-tool-coexists-with-v2` invariant test guarantees the
  per-root refactor doesn't couple the two paths.
- **The Pty subsystem internals.** Only the
  `pty-cleanup-on-parent-abort` invariant was asserted; the `Pty`
  service's signatures, schemas, and event payloads are unchanged.
- **The model provider stub.** Used unchanged from the prior
  campaign. No new test fixtures.
- **Bug 3 production code.** Already patched at commit `c86c58f94`
  before this campaign started. Wave 0 added the audit tests; the
  production code was not touched. If the audit fails in a future
  CI run, the regression is a separate fix — restore by reverting
  whatever undid `c86c58f94`, do not re-fix.

Adding scope to a hardening campaign dilutes the discipline. The
point is to fix the structural defects and make the integration
harness exist; everything else stays.

## Forward-looking

The next multi-agent feature MUST add tests against
[`INTEGRATION_INVARIANTS.md`](../.wave/campaigns/codex-parity-hardening-2026-05-14/plan/INTEGRATION_INVARIANTS.md)
before its production code lands. Adding a new invariant is allowed
and expected: discover a sharp edge during implementation, write the
green test, append the doc entry, ship. The discipline that codifies
this — every wave touching multi-agent code adds at least one
`it.instance` against the relevant scenario — is non-negotiable.
Coverage is necessary; the harness is sufficient. The two structural
bugs that survived the previous campaign's 100% line coverage are
the empirical proof.

## Campaign archive

Full per-wave plans, NOTES, decisions, perf artifacts, and the
campaign-curated `GOTCHAS.md` index live at
`.wave/campaigns/codex-parity-hardening-2026-05-14/`. Six waves
(`wave_0` through `wave_5`), each with its own commit on the
`codex-parity` branch:

| Wave | Commit | What landed |
|---|---|---|
| 0 | `18932fbcd` | scaffold + bug-3 audit tests |
| 1 | `f3b932663` | per-root scoping (bug 1) |
| 2 | `09a3a7759` | completion watcher (bug 2) |
| 3 | `1b9379518` | audit pass — locked in cascade + mailbox + pty invariant tests against the existing impl |
| 4 | `4e8d3511e` | backward-compat verification + perf audit + final report |
| 5 | (this commit) | spec doc |

Wave specs live at
`.wave/campaigns/codex-parity-hardening-2026-05-14/plan/waves/wave_<N>/WAVE.md`.
Per-wave NOTES.md (every attempt's narrative, what failed, what was
tried) live at `.wave/campaigns/codex-parity-hardening-2026-05-14/waves/wave_<N>/NOTES.md`.

The branch base is the previous campaign's `codex-parity` HEAD; this
campaign continues on the same branch rather than spinning off
`codex-parity-hardening`. The default branch `dev` does NOT carry
either campaign's changes — merge is a separate decision.
