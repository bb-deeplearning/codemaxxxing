# Wave 5 — Supervision strategies (orchestrated)

<!--
Previous waves: 0-4.
Orchestration: FULL.

Also read:
- ../../OVERVIEW.md
- ../../ORCHESTRATOR_PROTOCOL.md
- ../../INTEGRATION_INVARIANTS.md (focus: INV-D-15..17)
- ../../REFERENCES.md (Erlang OTP supervisor strategies)
- packages/opencode/test/AGENTS.md
-->

## Goal

Phase 3A. Move recovery logic out of the orchestrator's per-turn reasoning and into a declared policy at spawn time. Erlang OTP semantics adapted for LLM constraints: declare `on_failure` + `pool_strategy` at spawn; the runtime enforces.

Deliverables:

1. **D12 on_failure param on spawn_agent** — `tool/agent-spawn/agent-spawn.ts` accepts optional `on_failure: "respawn" | "escalate" | "ignore" | "kill_pool"` (default `"escalate"`, current implicit behavior).
2. **D12 pool_strategy param on spawn_agent** — optional `pool_strategy: "one_for_one" | "one_for_all" | "rest_for_one"` (default `"one_for_one"`). Applies when the spawned child is part of a pool (Wave 6 wires this; here we accept and store the param).
3. **D12 runtime enforcement** — `agent/control.ts` on terminal-status fork: if `on_failure: "respawn"` and status is non-`completed` non-`shutdown` (i.e. errored/crashed), respawn the same task_name with a new session id, max-3 respawns per task_name to prevent infinite loops; if max hit, escalate.
4. **D12 pool linkage stub** — pool_strategy stored on the per-child slot for Wave 6 to read. No active behavior here; Wave 6 wires.

Integration invariants:
- INV-D-15: `spawn-agent-with-on-failure-respawn-restarts-on-crash`
- INV-D-16: `pool-strategy-one-for-all-kills-pair-on-single-failure` (validated in stub form; full pool behavior in Wave 6)
- INV-D-17: `pool-strategy-one-for-one-isolates-failures` (validated in stub form)

## Tasks (orchestrated)

Planner outputs PLAN.json with ~3 tasks:

- T1: `agent-spawn.ts` Schema additions (on_failure, pool_strategy) + per-child slot fields in AgentControl
- T2: `agent/control.ts` respawn-on-crash logic + max-respawn cap + escalation path
- T3: INV-D-15..17 tests + tool description updates

## Gotchas

1. **Respawn must not lose ABORT context.** When the runtime respawns a crashed child, the spawner's mailbox should receive a notification noting "respawned after crash; attempt 2/3" so the spawner can adjust. This composes with Wave 4's ABORT payload — populate `abort_reason: { reason: "transient_tool_error", details: "respawned" }`.
2. **Max-respawn cap.** Three respawns total per task_name within a spawner. After cap, escalate (forward the crash without respawning; mailbox notification). The cap counter resets when the spawner closes the child OR when a new explicit `spawn_agent(task_name=X)` call from the same spawner creates a fresh slot.
3. **Default behavior MUST equal current behavior.** Existing callers (and existing tests in the hardening suite) MUST see no change. The defaults `on_failure: "escalate"` and `pool_strategy: "one_for_one"` are designed to match today's implicit semantics.
4. **Per-root scoping invariant.** Respawn happens within the same root slot. Don't cross roots.
5. **GOTCHAS to consult:**
   - `agentcontrol-providerref-must-live-in-layer-not-instancestate` — for the new slot fields.
   - `bus-subscriber-needs-instance-state-fork-and-instance-ref` — IF the respawn logic wires a new bus subscriber (probably re-uses the existing completion-watcher fiber).

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

bun test src/tool/agent-spawn/agent-spawn.test.ts   # extend
bun test src/agent/control.test.ts                  # extend
# Per-file coverage — pass TEST file paths. Source-path form runs 0 tests, exit 0
# (see GOTCHA `bun-test-coverage-source-file-arg-runs-zero-tests`).
bun test --coverage src/tool/agent-spawn/agent-spawn.test.ts
bun test --coverage src/agent/control.test.ts

bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-15'
bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-16'
bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-17'

bun test ./test/integration/multi-agent-invariants.test.ts

test -f .wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_5/PLAN.json
test -f .wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_5/CONTRACT.json
```

All must exit 0.
