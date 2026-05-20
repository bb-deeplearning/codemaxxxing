# Wave 6 — spawn_pool primitive (orchestrated)

<!--
Previous waves: 0-5.
Orchestration: FULL.

Also read:
- ../../OVERVIEW.md
- ../../ORCHESTRATOR_PROTOCOL.md
- ../../INTEGRATION_INVARIANTS.md (focus: INV-D-18..20)
- ../../REFERENCES.md (Akka routers; codex-parity permission-key collapse)
- ../../../codex-parity-hardening-2026-05-14/plan/INTEGRATION_INVARIANTS.md (per-root scoping invariants — full apply to spawn_pool)
- packages/opencode/test/AGENTS.md
-->

## Goal

Phase 3B. First-class fan-out primitive. Replaces the "spawn N agents in one message, manage manually" pattern with declarative spawning + collect semantics. Critical: spawn_pool members are linked via pool_strategy (from Wave 5).

Deliverables:

1. **D13 spawn_pool tool** — new `packages/opencode/src/tool/agent-pool/agent-pool.ts` (NEW directory). Single tool: `spawn_pool({ agent_type, count, per_worker_messages, pool_strategy, collect, ... })`. Returns a `pool_handle: string` immediately. Each worker spawns as if via `spawn_agent` with shared `pool_id`.
2. **D13 collect strategies** — `"all" | "first" | "any_n"`. `all`: wait for every worker to send deliverable. `first`: return the first worker's deliverable, close the rest. `any_n: K`: return after K workers complete.
3. **D13 permission key** — consults `task` (mirror MULTI_AGENT_TOOLS / EDIT_TOOLS / SHELL_TOOLS precedent). Two wiring sites:
   - `packages/opencode/src/permission/index.ts` — add `spawn_pool` to the `MULTI_AGENT_TOOLS` const at lines 336-344. This is the single source of truth for the group disable filter. `session/llm.ts:resolveTools` (lines ~470-471) consults this set; the existing `taskGroupDisabled && MULTI_AGENT_TOOLS.includes(k)` check picks up the new entry automatically.
   - `packages/opencode/src/tool/registry.ts` — add the `AgentPoolTool` import (mirror lines 18-23) and resolution (mirror lines 132-137), AND add `tool.id === AgentPoolTool.id` to the per-call permission-key OR chain at lines 410-415 so the call routes its ask through `task`. `MULTI_AGENT_TOOLS` itself is NOT redeclared here — only the per-tool id checks.
4. **D13 wire pool_strategy from Wave 5** — pool members' pool_strategy controls cross-member behavior (one_for_one isolates, one_for_all cascades).
5. **D13 prose** — `multi-agent-root.txt` adds a "Routers and pools" subsection within the "When to delegate" area. References spawn_pool with example.

Integration invariants:
- INV-D-18: `spawn-pool-collect-all-aggregates-results`
- INV-D-19: `spawn-pool-collect-first-cancels-remaining`
- INV-D-20: `spawn-pool-permission-collapses-to-task`

## Tasks (orchestrated)

Planner outputs PLAN.json with ~5 tasks:

- T1: `tool/agent-pool/agent-pool.ts` + `agent-pool.txt` (description) + Schema + execute body
- T2: `agent/control.ts` pool management (create pool, track members, dispatch by pool_strategy)
- T3: `permission/index.ts` MULTI_AGENT_TOOLS extension (the single source of truth) + `tool/registry.ts` imports + per-call permission-key OR chain extension at lines 410-415 (`session/llm.ts:resolveTools` picks up the change automatically since it consults the const)
- T4: Prose addition to `multi-agent-root.txt`
- T5: INV-D-18..20 tests

## Gotchas

1. **Pool member spawning is non-atomic.** Spawn N workers via N internal spawn_agent calls. If the 3rd of 5 spawns fails (e.g. depth cap hit), the pool's create call returns the pool_handle with 2 successful + 3 failed members. The collect strategy must handle partial pools gracefully. Document this in the tool description.
2. **`collect: "first"` cancellation.** When the first deliverable arrives, close remaining via `close_agent`. Their work is wasted; document the cost. Useful for race patterns; explicitly NOT for "spread work across N agents."
3. **`pool_id` is a string distinct from any worker's task_name.** Workers under a pool have task_name `<pool_id>_worker_<idx>`. The orchestrator can address individual workers by canonical path but the pool itself is addressed by `pool_handle` (returned from spawn_pool).
4. **Permission key collapse precedent.** Follow the replace-bash-task wave 3 pattern: add `spawn_pool` to `MULTI_AGENT_TOOLS` array (or equivalent shared const). The `permission.task: { "explore": "allow" }` rule then auto-allows `spawn_pool(agent_type: "explore", ...)`. Critical for BC.
5. **Pool slot accounting.** Members count against the 64-process pool cap. A `spawn_pool(count: 50)` will likely fail; document the cap warning in the tool description.
6. **GOTCHAS to consult:**
   - `permission-key-collapse-needs-dual-write-evaluate-vs-disabled` — MULTI_AGENT_TOOLS extension.
   - `agentcontrol-providerref-must-live-in-layer-not-instancestate` — pool state.
   - `tool-define-execute-r-must-be-never-capture-services-in-closure` — new tool define.
   - `permission-disabled-removes-tool-from-active-set` — `tools: { task: false }` should hide spawn_pool too.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

bun test src/tool/agent-pool/agent-pool.test.ts        # NEW
bun test src/tool/registry.test.ts                     # extend for spawn_pool
bun test src/permission/disabled.test.ts               # extend for MULTI_AGENT_TOOLS includes spawn_pool

# Per-file coverage — pass TEST file paths. Source-path form runs 0 tests, exit 0
# (see GOTCHA `bun-test-coverage-source-file-arg-runs-zero-tests`).
bun test --coverage src/tool/agent-pool/agent-pool.test.ts
bun test --coverage src/tool/registry.test.ts          # if you modified
bun test --coverage src/permission/disabled.test.ts    # if you modified permission/index.ts

bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-18'
bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-19'
bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-20'

bun test ./test/integration/multi-agent-invariants.test.ts

test -f .wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_6/PLAN.json
test -f .wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_6/CONTRACT.json
```

All must exit 0.
