# Wave 3 — Audit pass: apply remaining INTEGRATION_INVARIANTS to existing surfaces

<!--
Previous waves:
- wave_0 — integration test scaffolding + bug 3 audit
- wave_1 — per-root scoping in AgentControl
- wave_2 — completion watcher

Also read:
- ../../INTEGRATION_INVARIANTS.md (focus on parent-close-cascades-to-children, mailbox-drain-at-runloop-boundary-with-concurrent-sends, pty-cleanup-on-parent-abort)
- ../../GOTCHAS.md (CRITICAL: bench-effect-runpromise-loses-instance-in-async-callback for any test that polls; e2e-perf-sibling-fanout-needs-median-of-n if perf invariants are touched)
- ../../STYLE.md, TDD.md, BACKWARD_COMPAT.md
- Codex reference (READ-ONLY): /Users/rohan/Documents/Personal/experiments/codemaxxxing-codex/codex-rs/core/src/agent/control.rs lines 751-761 — shutdown_agent_tree
-->

## Goal

Apply the remaining INTEGRATION_INVARIANTS scenarios to existing multi-agent surfaces. Most should pass without any production code change — the existing implementation is correct for these scenarios; the previous campaign just never asserted them at the integration level. Where a test reveals a gap, patch the gap in this wave.

The point of this wave is to lock in the discipline: every invariant has a green integration test. A future wave that touches AgentControl runs this file as part of its verification and learns immediately if it's broken any of them.

## Tasks

### Sub-agent A — `parent-close-cascades-to-children`

Single agent, sequential. Unskip and implement the test in `multi-agent-invariants.test.ts`. The test:

- Use `installNeverLoop` so spawned agents stay alive.
- Spawn a tree: root → workerA → workerB. (Spawn workerA from root, then spawn workerB from workerA's session id.)
- Call `closeAgent(workerA.id)` from root.
- Assert: workerB's status is `shutdown`. workerA's status is `shutdown`. The cascade went leaves-first (workerB shut before workerA, per `closeAgent`'s descendants walk at `control.ts:790-803`).
- Assert: a second `closeAgent(workerA.id)` returns `previous_status: "shutdown"` without error (idempotency).
- Assert: `listAgents` from root no longer shows workerA OR workerB.

If the test passes against the post-Wave-1+2 code without any production change, GREAT — that's the invariant verifying the existing implementation is correct.

If the test FAILS, the cascade is broken (likely because Wave 1's per-root refactor missed a path). Fix the production code; do NOT loosen the test.

### Sub-agent B — `mailbox-drain-at-runloop-boundary-with-concurrent-sends`

Single agent, sequential. Unskip and implement. The test asserts that under concurrent send pressure, no message is lost between a drain and the next send.

- Setup: spawn one child (`installNeverLoop`).
- In a single Effect.gen body:
  - Fork 10 fibers each calling `control.sendInterAgentCommunication(child.id, comm_i)` with a unique payload.
  - Concurrently call `control.drainMailbox(child.id)` once.
  - Wait for all 10 send fibers to complete.
  - Call `control.drainMailbox(child.id)` a second time.
- Assert: union of (first drain, second drain) has exactly 10 messages, all with the unique payloads, no duplicates.

This asserts the Mailbox primitive's atomic seq + appends (`Ref.modify` in `mailbox.ts`) holds under concurrent fan-in. Should pass against current code.

If this test passes today (and likely does — the Mailbox primitive's wave-5 tests cover it at the unit level), the integration test still adds value: it asserts the routing through `sendInterAgentCommunication` (which now does root resolution per Wave 1) doesn't lose messages.

If the test FAILS, the failure mode is interesting — likely a race in the per-root resolution lookup. Investigate; fix the gap; do NOT loosen the test.

### Sub-agent C — `pty-cleanup-on-parent-abort`

Single agent, sequential. Unskip and implement. The test asserts that PTY cleanup composes with multi-agent cancellation.

- Setup: register a stub run-loop that, in its body, spawns a Pty via `Pty.create({ origin: "model", ... })` and reads from it. The script keeps the PTY alive for the duration of the test (e.g. `bun -e 'setInterval(()=>{},5000)'`).
- Spawn a child via `control.spawnAgent({ ... })`. The child's stub run-loop creates a PTY.
- Sleep 100ms — let the PTY spawn and register.
- Assert: `Pty.list()` returns at least 1 entry tied to the child's session.
- Call `control.cancelChildrenOf(parentID)` (or close the parent session via `Session.cancel`).
- Sleep 100ms — let the cascade settle.
- Assert: `Pty.list()` returns 0 entries.

If this test FAILS, the PTY is leaking on cascade. Investigate the `acquireUseRelease` pattern in `exec-command.ts` and the `forkIn(parentScope)` chain in AgentControl. Fix; do NOT loosen.

### Optional — discovered invariants

If during this wave you discover an additional integration invariant worth asserting, append it to `INTEGRATION_INVARIANTS.md` under "Discovered during execution" and add the corresponding `it.instance` test. Document in NOTES.md (success-with-additions section) what you added.

## Gotchas

1. **`bench-effect-runpromise-loses-instance-in-async-callback`** — the integration tests poll for state (e.g. "wait for the cascade to settle"). Per the gotcha, polling MUST happen inside `Effect.gen` (not `Effect.promise(async () => { await Effect.runPromise(...) })`). Use `yield* Effect.sleep("100 millis")` between assertions.

2. **`disposeAllInstances` per test.** Already in the test file from Wave 0. If you add additional test files in this wave, copy the `afterEach(disposeAllInstances)` pattern.

3. **PTY test needs `installScriptedRunLoop` not `installNeverLoop`.** The pty-cleanup test needs the run-loop to actually spawn a PTY. Build a minimal scripted loop:
   ```ts
   const installPtySpawningLoop = Effect.gen(function* () {
     const control = yield* AgentControl.Service
     const pty = yield* Pty.Service
     yield* control.registerRunLoop((sessionID) =>
       Effect.gen(function* () {
         yield* pty.create({
           command: "bun",
           args: ["-e", "setInterval(()=>{},5000)"],
           origin: "model",
           // ... other required Pty.create args
         })
         yield* Effect.never
       }),
     )
   })
   ```
   Read `Pty.create`'s required args from `pty/index.ts`. The `origin: "model"` is required to avoid the auto-remove-on-exit gating per GOTCHAS `pty-onexit-auto-remove-tui-only`.

4. **Cascade ordering.** `closeAgent`'s descendants walk is leaves-first (`control.ts:790-800`). Test the ordering: when both workerA and workerB are alive, after `closeAgent(workerA.id)`, workerB shuts down BEFORE workerA's status flips to shutdown. The check is hard to nail without a status-change recorder; an acceptable simpler assertion is "both end up shutdown after the cascade settles". If you really want to assert order, subscribe to each child's status SubscriptionRef and record the timeline before triggering the cascade.

5. **Concurrent-send test timing.** 10 forks finishing concurrently produce a fast burst. Call the second `drainMailbox` AFTER awaiting all fork results (`Effect.forEach(forks, Fiber.join)`). The first drain is racing against an in-flight subset; that's intentional — the union assertion proves no message is lost.

6. **PTY test cleanup.** The test body creates a real PTY. If the cascade fails to clean it, the test process keeps a child alive past the test. Bun's test runner usually reaps these but not always reliably. Add a defensive `afterEach` that runs `Pty.list()` and force-removes any stragglers — or better, use `await using` with a `[Symbol.asyncDispose]` that kills any leaked PTYs. The existing `disposeAllInstances` already disposes the InstanceState scope, which should kill the PTYs via the existing finalizer chain. If PTYs persist, that's its own bug — surface as USER QUESTION.

7. **No production code change unless a test fails.** This wave is primarily a verification wave. If all three sub-agent tests pass green against the post-Wave-1+2 code, you've LOCKED IN the invariants — that's success. If any fails, the failure surfaces a gap that this wave fixes. Either outcome is a successful wave; the win is the green integration test.

## Verification

```bash
cd packages/opencode

# 1. Typecheck — zero errors.
bun typecheck

# 2. Lint — zero errors.
bun lint

# 3. The new + existing integration tests all pass.
bun test ./test/integration/multi-agent-invariants.test.ts
bun test ./test/integration/multi-agent-tools.test.ts

# 4. If this wave touched any production code (because a test revealed a gap),
#    coverage on touched files at 100% line.
bun test --coverage src/agent/<touched-file>.test.ts 2>&1 | grep -E "<file>"

# 5. Full agent test surface still passes.
bun test ./src/agent/

# 6. PTY tests still pass (the cleanup invariant didn't break anything).
bun test ./src/pty/

# 7. If this wave touched production code on a hot path, re-run the relevant
#    bench and assert no regression.
```

Integration test names that MUST be green after this wave:

- `parent-close-cascades-to-children`
- `mailbox-drain-at-runloop-boundary-with-concurrent-sends`
- `pty-cleanup-on-parent-abort`

The wave is complete when those three plus all unskipped invariants from Waves 0/1/2 are green AND any new invariants discovered this wave are added to the doc + the test file.
