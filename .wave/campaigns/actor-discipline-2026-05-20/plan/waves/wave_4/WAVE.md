# Wave 4 — ABORT protocol + supervisor recognition (orchestrated)

<!--
Previous waves: 0-3.
Orchestration: FULL.

Also read:
- ../../OVERVIEW.md
- ../../ORCHESTRATOR_PROTOCOL.md (note: ABORT reasons catalog originates here)
- ../../INTEGRATION_INVARIANTS.md (focus: INV-D-12..14)
- ../../REFERENCES.md (Erlang let-it-crash + supervisor semantics)
- packages/opencode/test/AGENTS.md
-->

## Goal

Phase 2B. Generalize the wave system's set-phrase exits (`WAVE COMPLETE`, `WAVE FAILED`, `PLAN UNDOABLE`, `USER QUESTION`) to all subagents with a structured ABORT protocol. Subagents emit `ABORT(reason): details` as last line; control.ts parses the set-phrase and forwards a structured payload to the spawner's mailbox; spawner supervises (retry / refine / escalate / pivot).

Deliverables:

1. **D11 ABORT protocol prose** in `multi-agent-subagent.txt` — new "ABORT" section listing the six reasons (spec_wrong, transient_tool_error, out_of_scope, context_full, approach_failed, user_question) + instruction to emit as last assistant line.
2. **D11 control.ts recognition** — completion-watcher matches ABORT set-phrase from the child's last assistant text; parses `(reason): details`; includes structured `abort_reason: { reason, details }` in the InterAgentCommunication sent to spawner. Optional field on InterAgentCommunication.
3. **D11 ORCHESTRATOR_PROTOCOL.md cross-reference** — the existing protocol already documents ABORT reasons; this wave makes them runtime-enforced. Update the protocol doc to note "as of Wave 4, ABORT reasons are parsed by the runtime."
4. **D11 fan across all subagent types** — `general/anthropic.txt`, `general/gemini.txt`, `explore.txt` get a brief "ABORT reasons" reference in their existing failure-reporting section (point to the multi-agent-subagent.txt section).

Integration invariants:
- INV-D-12: `abort-reason-delivered-as-structured-payload`
- INV-D-13: `orchestrator-pivots-on-abort-approach-failed`
- INV-D-14: `set-phrase-ladder-extended-to-all-subagent-types`

## Tasks (orchestrated)

Planner outputs PLAN.json with ~4 tasks:

- T1: `agent/inter-agent-communication.ts` add optional `abort_reason` structured payload field (additive schema change)
- T2: `agent/control.ts` completion-watcher updates: parse ABORT set-phrase from extracted body; populate structured payload; route to spawner normally
- T3: Prose additions — `multi-agent-subagent.txt` ABORT section + brief refs in the three base prompts + ORCHESTRATOR_PROTOCOL.md update note
- T4: INV-D-12..14 tests (note INV-D-13 needs a stub orchestrator implementing the pivot pattern; budget extra time)

## Gotchas

1. **Set-phrase parsing must be unambiguous.** The parser looks for `ABORT(<reason>): <details>` at the END of the extracted body, possibly followed by whitespace or trailing punctuation. Don't match inside code blocks or quoted text. Use a strict line-anchor regex.
2. **Reason enum.** Only the six listed reasons. Unrecognized reason → log as `unknown_abort_reason` + still forward the payload (graceful degradation; future iterations can extend).
3. **ABORT does not bypass close.** A subagent that emits ABORT still needs to `close_agent` (or have the spawner close it). The runtime doesn't auto-close on ABORT — that's the spawner's call per supervision strategy.
4. **INV-D-13's stub orchestrator** is a test helper, not production code. It implements just enough of the pivot loop to validate the runtime supports it. The real orchestrator lives in ORCHESTRATOR_PROTOCOL.md (executed by caveman per WAVE.md instructions). Don't conflate.
5. **Cross-reference to wave system.** The wave loop's set-phrase recognition (`WAVE COMPLETE`, `WAVE FAILED`, `PLAN UNDOABLE`, `USER QUESTION`) is a SEPARATE mechanism for the wave executor session itself, not subagents. ABORT is for subagents. Two ladders, both valid.
6. **GOTCHAS to consult:**
   - `word-boundary-regex-vs-prose-collisions` — ABORT parser regex.
   - `eventv2-and-bus-dual-emission-with-parallel-type-prefixes` — IF you add a new domain event for "ABORT received" (probably don't; the InterAgentCommunication carries it).

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

# Touched files
bun test src/agent/control.test.ts                    # extend
bun test src/agent/inter-agent-communication.test.ts  # extend

# Per-file coverage — pass TEST file paths. Source-path form runs 0 tests, exit 0
# (see GOTCHA `bun-test-coverage-source-file-arg-runs-zero-tests`).
bun test --coverage src/agent/control.test.ts
bun test --coverage src/agent/inter-agent-communication.test.ts

# Prose tests
bun test test/prose/subagent-prompts.test.ts   # extended for ABORT-section assertions

# Integration invariants Phase 2B
bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-12'
bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-13'
bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-14'

# Full regression
bun test ./test/integration/multi-agent-invariants.test.ts

# Orchestrator artefacts
test -f .wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_4/PLAN.json
test -f .wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_4/CONTRACT.json
```

All must exit 0.
