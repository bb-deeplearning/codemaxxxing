# Wave 7 — Link/unlink + bounded mailboxes (orchestrated)

<!--
Previous waves: 0-6.
Orchestration: FULL.

Also read:
- ../../OVERVIEW.md
- ../../ORCHESTRATOR_PROTOCOL.md
- ../../INTEGRATION_INVARIANTS.md (focus: INV-D-21..23)
- ../../REFERENCES.md (Erlang link/monitor; Akka bounded mailboxes)
- packages/opencode/test/AGENTS.md
-->

## Goal

Phase 3C. Two lifecycle primitives borrowed from Erlang/Akka:

- **link** — bidirectional death. Two linked agents die together. Useful for paired-actor patterns (generator/evaluator, prosecutor/defense, worker/verifier).
- **bounded mailbox + backpressure** — per-agent mailbox cap; sender gets a structured "mailbox full" error rather than queueing indefinitely.

Deliverables:

1. **D14 link tool** — new `packages/opencode/src/tool/agent-link/agent-link.ts`. Provides `link(target_a, target_b)` and `unlink(target_a, target_b)`. Permission key `task`.
2. **D14 link enforcement in control.ts** — link table per root slot. On any linked agent's terminal status (non-shutdown), close the other linked agent within 100ms. Status label: `linked_death`.
3. **D15 bounded mailbox** — `agent/mailbox.ts` accepts a capacity (default: 32; per-agent override via spawn_agent param `mailbox_cap`). On overflow: `send_message` / `followup_task` return structured `{ error: "mailbox_full", retry_after_ms: <hint> }`. The completion-watcher's notifications are exempt (small reserved system-notification slot OR FIFO eviction of oldest user message — pick one, document).
4. **D15 prose** — `multi-agent-root.txt` "Limits" section update: mention bounded mailboxes + backpressure. `multi-agent-subagent.txt` mention: how to handle `mailbox_full` errors (retry with backoff; consider followup_task to wake recipient to drain).

Integration invariants:
- INV-D-21: `link-paired-death-on-either-crash`
- INV-D-22: `bounded-mailbox-rejects-on-overflow`
- INV-D-23: `bounded-mailbox-does-not-block-completion-notification`

## Tasks (orchestrated)

Planner outputs PLAN.json with ~5 tasks:

- T1: `tool/agent-link/agent-link.ts` (NEW; both link and unlink in one file)
- T2: `agent/control.ts` link table + linked-death cascade
- T3: `agent/mailbox.ts` bounded queue + overflow shape + completion-notification reserved slot/eviction
- T4: `tool/agent-send/agent-send.ts` + `tool/agent-followup/agent-followup.ts` handle `mailbox_full` return shape
- T5: Prose updates + INV-D-21..23 tests

## Gotchas

1. **Link symmetry.** `link(A, B)` is equivalent to `link(B, A)`. Internal representation: unordered pair. Don't duplicate in the link table.
2. **`unlink` must be cheap and idempotent.** Calling unlink on unlinked pair = no-op. Don't error.
3. **Link survives across pool_strategy.** A linked agent that's part of a pool with `one_for_one` still triggers linked_death on its peer (the link is its own mechanism). Two mechanisms can coexist; document the precedence (link fires first; pool_strategy may override behavior on the broader pool).
4. **Bounded mailbox default of 32.** Chosen as a starting number. Tune from observability (Wave 9 instrumentation).
5. **Completion-notification handling under mailbox-full.** Pick ONE of:
   - (a) Reserved system-notification slot (size 4) separate from user mailbox.
   - (b) FIFO eviction of oldest user message to make room for system notification.
   Document in the tool description and in `multi-agent-root.txt` Limits section. (a) is cleaner; (b) is simpler. Recommend (a).
6. **Cross-root link rejection.** `link(/root_a/x, /root_b/y)` MUST fail with same shape as cross-root send rejection. Per-root scoping invariant.
7. **GOTCHAS to consult:**
   - `agentcontrol-providerref-must-live-in-layer-not-instancestate` — link table state.
   - `permission-key-collapse-needs-dual-write-evaluate-vs-disabled` — agent-link tool consults `task` key.
   - `bus-subscriber-needs-instance-state-fork-and-instance-ref` — link cascade may wire a new bus subscriber.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

bun test src/tool/agent-link/agent-link.test.ts        # NEW
bun test src/agent/mailbox.test.ts                     # extend
bun test src/agent/control.test.ts                     # extend
bun test src/tool/agent-send/agent-send.test.ts        # extend (mailbox_full handling)
bun test src/tool/agent-followup/agent-followup.test.ts # extend

# Per-file coverage — pass TEST file paths. Source-path form runs 0 tests, exit 0
# (see GOTCHA `bun-test-coverage-source-file-arg-runs-zero-tests`).
bun test --coverage src/tool/agent-link/agent-link.test.ts
bun test --coverage src/agent/mailbox.test.ts

bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-21'
bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-22'
bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-23'

bun test ./test/integration/multi-agent-invariants.test.ts

test -f .wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_7/PLAN.json
test -f .wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_7/CONTRACT.json
```

All must exit 0.
