# Wave 3 — Notes

## Attempt 1 — complete

**Session:** ses_1da44cc62ffehyxp7HT6BKXob6
**Commit:** fedb0fb62
**Date:** 2026-05-14
**Decision on entry:** first attempt

### What happened

Wave 3 audit pass — applied the remaining INTEGRATION_INVARIANTS to the
existing post-Wave-1+2 surfaces. All three target invariants pass GREEN
against the current production code; **no production change was required**.
The wave is purely test additions plus a layer-import bump (`Pty.defaultLayer`).

Three invariants unskipped + implemented in
`packages/opencode/test/integration/multi-agent-invariants.test.ts`:

| Test slug | Wave | What it asserts | Pre-existing impl correct? |
|---|---|---|---|
| `parent-close-cascades-to-children` | 3 | closeAgent on workerA cascades to workerB (path-prefix descendants walk at control.ts:842-855), both reach `shutdown`, idempotent re-close returns `previous_status: shutdown`, listAgents from root no longer reports either | ✓ |
| `mailbox-drain-at-runloop-boundary-with-concurrent-sends` | 3 | 10 concurrent `sendInterAgentCommunication` fibers + 1 racing `drainMailbox` + final drain → union has exactly N=10 unique payloads, no dupes, no losses | ✓ |
| `pty-cleanup-on-parent-abort` | 3 | Stub run-loop spawning a model-origin PTY in `acquireUseRelease` → `cancelChildrenOf` → fiber interrupt → release fires → `Pty.list()` empty | ✓ |

### Why no production change

The whole point of this wave is the campaign's bar:

> Two bugs slipped past 100% line coverage and 16 waves of perf measurement
> because tests asserted that primitives worked, not that scenarios worked.

The implementation surfaces these tests cover (`closeAgent`'s descendants
walk + idempotency, `Mailbox.send`'s atomic `Ref.modify`, the
`forkIn(parentScope)` ancestry composing with `Pty.acquireUseRelease`)
were all already correct. Wave 3 LOCKS THEM IN as integration tests so a
future wave that breaks any of them learns immediately, not at the next
campaign retrospective.

### Test design notes

**Test A (parent-close-cascades-to-children).** Tree shape per WAVE.md:
root → workerA → workerB. workerB is spawned from workerA's session id —
this exercises the `sessionToRoot` indexing landed in Wave 1 (the child's
session id resolves to its root via the index, not via the immediate
parent). Per gotcha 4 in WAVE.md, used the simpler "both end up shutdown
after the cascade settles" assertion rather than ordering — `closeAgent`
awaits `Fiber.interrupt`'s exit before returning, so the cascade is fully
settled by the time the test reads status.

**Test B (mailbox-drain-concurrent-sends).** Pre-drained the spawn-seed
message so the union math is exact (N=10 with no off-by-one for the seed).
Used `Effect.forkScoped` per the AGENTS.md Effect v4 rule (no `Effect.fork`
in v4). `Fiber.join` after the racing drain ensures every send has fully
landed before the second drain — the union assertion proves the routed
path through `sendInterAgentCommunication` (root resolution + Mailbox.send)
preserves the Mailbox's atomic seq guarantee under fan-in.

**Test C (pty-cleanup-on-parent-abort).** Used `Effect.acquireUseRelease`
in the stub run-loop instead of the spec's bare `Effect.gen` sketch. The
spec's sketch (`pty.create` + `Effect.never`) would fail not because of a
multi-agent bug but because the stub itself wouldn't clean up — `pty.create`
has no implicit finalizer. `acquireUseRelease`'s release hook is the
production pattern (mirrors `exec-command.ts`'s `acquireUseRelease`) and
fires on fiber interruption. The test asserts that the cancellation cascade
(`cancelChildrenOf` → `closeAgent` → `Fiber.interrupt`) propagates to the
release hook, killing the bun child and emptying `Pty.list`. Used
`origin: "model"` per gotcha 3 to disable the auto-remove-on-exit gating.

### Layer addition

`Pty.defaultLayer` added to the test file's `Layer.mergeAll` so Test C can
`yield* Pty.Service`. Pty's default layer brings Bus/Plugin/Config along —
the latter two are deduped via testEffect's memoMap so no cost. Tests A
and B don't use Pty but the layer init is cheap (the InstanceState.make
closure just allocates an empty `sessions` Map).

### What passed

```
bun typecheck                                                    → 0 errors
bun lint  (oxlint from repo root)                                → 0 errors (3013 warnings unchanged)
bun test ./test/integration/multi-agent-invariants.test.ts       → 12 pass / 1 skip / 0 fail
bun test ./test/integration/multi-agent-tools.test.ts            → 4 pass / 0 fail
bun test ./src/agent/                                            → 243 pass / 0 fail
bun test ./src/pty/                                              → 60 pass / 0 fail
bun test ./test/e2e/cancellation-cascade.test.ts                 → 1 pass / 0 fail
bun test --coverage src/agent/control.test.ts                    → src/agent/control.ts: 95.74 fn / 100.00 line (unchanged)
```

The 1 skip in invariants is `legacy-task-tool-coexists-with-v2` (deferred
to Wave 4 — backward compat).

`control.ts` line coverage at 100% confirms Wave 1+2 production code is
unchanged and untouched. Function% at 95.74 is the inherited
`schema-class-function-coverage` ceiling.

### Files modified

**Production (0):** none. Wave is verification-only.

**Tests (1):**
- `packages/opencode/test/integration/multi-agent-invariants.test.ts` —
  added `Pty.defaultLayer` to the layer; added `Fiber, SubscriptionRef` to
  the effect import; added `Pty` import; unskipped + implemented 3
  invariant tests (`parent-close-cascades-to-children`,
  `mailbox-drain-at-runloop-boundary-with-concurrent-sends`,
  `pty-cleanup-on-parent-abort`).

**Plan (0):** No new GOTCHAS. The only mild surprise was that the WAVE.md
sketch for Test C used a bare `pty.create + Effect.never` pattern that
would not actually clean up the PTY on interrupt — fixed by using
`acquireUseRelease`. Documented inline in the test comment, not promoted
to GOTCHAS because it's a spec-sketch nuance not a runtime trap.

### Recommendation

Wave 4 (backward compat verification + perf audit + final report) can
proceed. The integration suite is now the primary regression net for this
campaign — every multi-agent invariant has a green `it.instance` test.
The 1 remaining skip (`legacy-task-tool-coexists-with-v2`) is Wave 4's
unskip target and rounds out the integration coverage.

Wave 4 should also fold in the median-of-N fix for the
`mailbox seq-watch wakeup latency` flake noted in Wave 2's NOTES.md.

---
