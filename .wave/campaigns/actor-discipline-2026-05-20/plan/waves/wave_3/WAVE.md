# Wave 3 — Ask pattern + correlation IDs (orchestrated)

<!--
Previous waves: 0 (floor), 1 (prose), 2 (validation).
Orchestration: FULL. See Wave 1 for spawn templates.

Also read:
- ../../OVERVIEW.md
- ../../ORCHESTRATOR_PROTOCOL.md
- ../../INTEGRATION_INVARIANTS.md (focus: INV-D-09..11)
- ../../REFERENCES.md (Akka ask pattern; Erlang gen_server:call semantics)
- packages/opencode/test/AGENTS.md
-->

## Goal

Phase 2A. Convert the broad `wait_agent` into a targeted ask pattern: messages carry `correlation_id`, waits target a specific correlation, mandatory timeouts surface deadlocks as structured timeouts rather than silent stalls.

Deliverables:

1. **D10 correlation_id on InterAgentCommunication** — `agent/inter-agent-communication.ts`: optional `correlation_id?: string` field. Round-trips through `sendInterAgentCommunication`, mailbox, drain.
2. **D10 correlation_id on send_message + followup_task** — both tools accept optional `correlation_id` parameter; pass through to InterAgentCommunication.
3. **D10 wait_for_reply variant** — `tool/agent-wait/agent-wait.ts`: new variant of the tool (same file, separate Schema/execute branch) `wait_for_reply(correlation_id, timeout)` that wakes ONLY on a message carrying the matching correlation. Standard `wait_agent` continues to work.
4. **D10 mandatory-timeout doctrine** — `multi-agent-root.txt` and `multi-agent-subagent.txt` get a "Wait timeouts" section: every wait MUST have a timeout meaningful to the protocol. wait_agent without timeout (or with cap-violating timeout) returns a runtime warning + completes normally — not a hard error, but visible.

Integration invariants:
- INV-D-09: `correlation-id-pairs-reply-to-request`
- INV-D-10: `wait-for-reply-times-out-without-matching-correlation`
- INV-D-11: `missing-timeout-on-wait-emits-warning`

## Tasks (orchestrated)

Planner outputs PLAN.json with ~4 tasks:

- T1: `agent/inter-agent-communication.ts` schema extension + mailbox round-trip update
- T2: `send_message` and `followup_task` parameter additions
- T3: `wait_for_reply` variant of `wait_agent` + runtime timeout warning
- T4: Prose additions in `multi-agent-root.txt` and `multi-agent-subagent.txt` (mandatory-timeout doctrine) + INV-D-09..11 tests

Generator+evaluator pairs per task. T1 → T2 → T3 in dependency order; T4 can run alongside T3.

## Gotchas

1. **Schema changes are additive.** Existing rows / messages without `correlation_id` MUST continue to work. Existing tests that call `send_message` without the param MUST continue to pass. Don't break the `INV-D-02` regression on parent-receives-explicit-send shape.
2. **Mailbox seq still advances on any message arrival.** wait_for_reply doesn't change the seq mechanism — it just filters at wake-time. The seq watch wakes any wait; the filter happens in the wait_for_reply execute body.
3. **Timeout warning surfaces via the existing tool-error path.** Don't crash the call; the warning is a non-fatal indicator. Wave 4's ABORT mechanism is for fatal errors; this is informational.
4. **`wait_for_reply` SHOULD NOT block `wait_agent` semantics.** The two coexist. A waiter on correlation_id="x" + another waiter without correlation_id both wake when a matching message arrives (correlation_id waiter wakes from the filtered match; the broad waiter wakes from the seq advance).
5. **Per-root scoping invariant.** wait_for_reply resolves the caller's root via senderID. Filter operates on the caller's mailbox.
6. **GOTCHAS to consult:**
   - `permission-key-collapse-needs-dual-write-evaluate-vs-disabled` — if you add a new variant that needs separate gating. (Probably not — wait_for_reply uses the same `task` key as wait_agent.)
   - `effect-v4-either-renamed-to-result`, `effect-v4-catchall-renamed-to-catch`.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

# Touched files
bun test src/agent/inter-agent-communication.test.ts   # extend
bun test src/tool/agent-send/agent-send.test.ts        # extend
bun test src/tool/agent-followup/agent-followup.test.ts # extend
bun test src/tool/agent-wait/agent-wait.test.ts        # extend

# Per-file coverage — pass TEST file paths. Source-path form runs 0 tests, exit 0
# (see GOTCHA `bun-test-coverage-source-file-arg-runs-zero-tests`).
bun test --coverage src/agent/inter-agent-communication.test.ts
bun test --coverage src/tool/agent-send/agent-send.test.ts
bun test --coverage src/tool/agent-followup/agent-followup.test.ts
bun test --coverage src/tool/agent-wait/agent-wait.test.ts

# Integration invariants Phase 2A
bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-09'
bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-10'
bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-11'

# Full suite regression
bun test ./test/integration/multi-agent-invariants.test.ts

# Orchestrator artefacts
test -f .wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_3/PLAN.json
test -f .wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_3/CONTRACT.json
```

All must exit 0.
