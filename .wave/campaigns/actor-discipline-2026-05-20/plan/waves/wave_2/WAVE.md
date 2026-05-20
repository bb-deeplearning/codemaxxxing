# Wave 2 — Validation: drive Phase 1 invariants green (orchestrated)

<!--
Previous waves: Wave 0 (harness floor) + Wave 1 (prose).
Orchestration: FULL. See Wave 1's WAVE.md for spawn message templates.

Also read:
- ../../OVERVIEW.md
- ../../ORCHESTRATOR_PROTOCOL.md
- ../../INTEGRATION_INVARIANTS.md (focus: full INV-D-01..08 catalog)
- ../../REFERENCES.md (diagnostic session IDs)
- packages/opencode/test/AGENTS.md
-->

## Goal

Verify Waves 0 + 1 actually fixed the bugs by reproducing both diagnostic sessions end-to-end as integration tests, and assert all Phase 1 invariants (INV-D-01..08) are green. Wave is mostly test work; minimal new production code (only if a fix is incomplete).

The output of this wave is **proof of fix**, not new features. If reproductions fail, escalate to PLAN UNDOABLE; the verifier will amend Wave 0 or 1's spec.

Deliverables:

1. **Diagnostic session 1 reproduction** — `multi-agent-invariants.test.ts`: scenario test that mimics `ses_1c2e8d84affeZ7t5g5LKveGDTo` shape. Stub-provider scripts a child runLoop that emits "report text + close_agent" in the SAME assistant turn. Asserts parent receives the report (not a cleanup message). Marks as `INV-D-01-regression-ses_1c2e8d84affe`.
2. **Diagnostic session 2 (Demo 2) reproduction** — `multi-agent-invariants.test.ts`: scenario test that spawns two siblings, each instructed to "send opening to /root and wait for opposing opening." Asserts the deadlock IS reproducible WITHOUT the unicast doctrine in prompts, then asserts that AFTER Wave 1's prose changes load into the test layer's subagent prompt, the model would not be instructed to do this (prose grep test). Marks as `INV-D-06-regression-ses_1d84f236bffe`.
3. **Full Phase 1 invariant matrix green** — all of INV-D-01..08 pass when run together.
4. **NOTES.md cross-reference** — wave audit subsection: which invariants needed which wave's fix; any drift observed; recommendations for Phase 2.

## Tasks (orchestrated)

Spawn planner. Planner outputs PLAN.json with ~3 tasks:

- T1: `INV-D-01-regression-ses_1c2e8d84affe` reproduction test
- T2: `INV-D-06-regression-ses_1d84f236bffe` reproduction test (with the meta-test that asserts current prompts contain the unicast doctrine)
- T3: Audit + regression sweep (run full invariant suite, confirm green, write NOTES.md audit subsection)

Generator+evaluator pairs per task. Per ORCHESTRATOR_PROTOCOL.md.

### Specifics for T1

The test reconstructs the failure shape without needing the real Cidoo ABM066 prompt:

```ts
it.instance("INV-D-01-regression-ses_1c2e8d84affe", () =>
  Effect.gen(function* () {
    // Spawn a child with a scripted runLoop that emits one assistant message
    // containing { text: "FULL REPORT BODY ~5KB", tool: close_agent(self) }
    // → finish: "tool-calls"
    // Then a second assistant message with just text: "Done."
    // → finish: "stop"
    //
    // Parent waits for completion. Drains mailbox. Asserts:
    //   - exactly ONE message from child path
    //   - body contains "FULL REPORT BODY" (the deliverable, NOT "Done.")
  }),
)
```

### Specifics for T2

Two-part test:

(a) Runtime behavior: even WITHOUT prose changes, the runtime is unicast (it always was). Spawn two siblings, send to /root from each, assert peer mailboxes are empty.

(b) Prose presence: assert `multi-agent-root.txt` contains the unicast doctrine string ("Messages are unicast" or equivalent from D7's prose). Asserts `multi-agent-subagent.txt` contains the mirror sentence. Both via grep on file contents. This locks in that the doctrine is documented even if a future careless edit removes it.

### Specifics for T3

The audit subsection in NOTES.md captures:

- Which invariants needed which fix (table: invariant_slug → wave → fix description).
- Any drift observed during the wave (e.g. a previously-green invariant flickering RED on a retry).
- Recommendations for Phase 2 (Waves 3-4): is the safety net adequate, or should D5's heuristic be tightened? Did D6 (root-hold) actually land in Wave 0, or was it deferred?

## Gotchas

1. **Test isolation.** Each reproduction test uses `it.instance` with its own tmp directory. Don't let test runLoops leak state across tests. afterEach `disposeAllInstances()` is the existing pattern.
2. **Stub provider scripting.** The runLoop accepts a scripted sequence of `{ role: "assistant", content: [...], finish: "..." }` shapes. See `multi-agent-invariants.test.ts:installNeverLoop` for the stub pattern; for scripted multi-turn responses, look at the bug-3 audit tests in the same file (they use scripted runs).
3. **Prose grep tests are not full integration tests.** They run fast. Keep them in `test/prose/subagent-prompts.test.ts` (created in Wave 1) rather than the integration suite, unless they need the integration layer (e.g. for INV-D-06's runtime sub-test).
4. **If a Phase 1 invariant fails here**, that's diagnostic — fix the gap, OR (if the gap is structural) emit PLAN UNDOABLE pointing at the wave that left the hole.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

# All Phase 1 invariants + the two regressions
bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-0'

# Prose grep tests (regression on Wave 1 prose)
bun test test/prose/subagent-prompts.test.ts

# Full multi-agent invariant suite
bun test ./test/integration/multi-agent-invariants.test.ts

# Orchestrator artefacts
test -f .wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_2/PLAN.json
test -f .wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_2/CONTRACT.json
test -f .wave/campaigns/actor-discipline-2026-05-20/plan/waves/wave_2/NOTES.md  # audit subsection required for this wave even on success
```

All must exit 0.
