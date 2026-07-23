# Changes: Declared review + the dual-lap fixes

**Date**: 2026-07-23

One batch, built the day the worktree system met production (`31288e6584` + `0037390865` shipped 07-22/23; this batch is everything the first live campaign taught). Two halves: the dual-lap kill chain (a lock that never beat + a wake that ran in the wrong instance) and the declared-review paradigm (rohan's correction after the derived lane confused him twice in one afternoon).

## The dual-lap fixes

Three concurrent runLoops interleaved one session's transcript until the provider rejected it (`content-filter` storms, then wedges: assistant messages ending in bare thinking blocks). Two latent bugs fused:

- **The flock heartbeat never beat once** (`packages/core/src/util/effect-flock.ts`). The old pipe was `fs.utimes(path, new Date(), new Date()).pipe(Effect.ignore, Effect.repeat(...))` — effects are descriptions, impure ARGUMENTS evaluate at construction, so both Dates froze at acquire time. Every 20s beat faithfully re-set mtime to the same acquire-time instant; every live holder looked stale after `STALE_MS`; any waiter could legally break a HELD lock. Fix: dates inside the thunk (fresh per beat), node's `fs/promises.utimes` directly, failures log once per handle instead of vanishing. Pins: the primitive, and a live-holder liveness pin that is RED on the frozen-Date code (`packages/core/test/util/effect-flock.test.ts`, 17 pass).
- **The root wake and child revival ran on the SENDER's fiber** (`src/agent/control.ts`). An isolated child's fiber carries the WORKTREE's InstanceRef; the woken root loop resolved the child instance's EMPTY runner map, couldn't join the live lap, and — with the rotted flock — started a concurrent one. `InternalState` now carries its owning `ctx`; the wake provides it explicitly and `startAgentFiber` always provides a deterministic ref (isolation context for isolated children, tree-owner ctx for everyone else). Sender ambience never leaks into fibers AgentControl starts. Red-green pin: wake + revival from a foreign-ref fiber observe the tree-owner's directory (`control.test.ts`, 144 pass).

## Declared review (the paradigm)

Every other need is agent-initiated (permissions, questions); review was the one species the system INFERRED from git state, and every inference is wrong somewhere: commits-exist shouts mid-work, session-idle shouts while a parent waits on its children. Locked in boxbox-web's `docs/idea-worktrees.md`; review is something an agent SAYS.

- **`request_review` tool** (`src/tool/request-review/`, NEW): root-only (a subagent's checkout rides its completion notification — integration is the parent's), checkout-only (the primary refuses), optional `note` becomes the review card's headline. Emits `worktree.review.requested {name, branch?, note?}` on the checkout's own directory (`Worktree.Event.ReviewRequested` + `requestReview` service method). Registered builtin + `POST_BASELINE_ADDITIONS` entry.
- **Busy guard**: `merge` and `discard` refuse while any session homed in the checkout is mid-turn — a phone tap can never delete a working directory under a running agent. Truth source is the run lock's on-disk protocol (lock dir + heartbeat fresher than `STALE_MS`; honest now that the heartbeat beats). Stats only, never acquires. Pinned both directions (fresh heartbeat refuses, stale one passes).
- **Checkout orientation at bootstrap** (`src/session/system.ts`, the capabilityHints precedent): any session homed in a checkout is TOLD — children hear "commit, never push, your parent integrates"; roots hear the hierarchy (children's branches merge into YOUR worktree; worktrees share refs) plus "fire `request_review` when ready". Exit-guarded so legacy callers without an instance stay byte-identical (back-compat suite green).
- **Nested spawns branch from the spawner's HEAD** — already true by construction (`git worktree add` runs in the receiving instance's cwd with no start-point); pinned so it stays true (`worktree.test.ts`, 27 pass).

## boxbox-web (same batch, other repo)

Review need = declared || wreckage: `reviewNeeded()` extracted pure + pinned (8 pins — busy quiet, child quiet forever, undeclared quiet, park busted by fresh declaration via `requestedAt` in the signature); `worktree.review.requested` flags the CheckoutSnapshot and survives ready re-emits; fault lanes with kept work grow the rescue verbs; the card and lane show the agent's note as the handoff's voice; machine card version now rides `/global/health` per connect (the field was never assigned — found 2026-07-22).

## The error-body hunt (`9f087103ac` → `87c01ab3d6` → `efa93f94d6`, same day)

The live e2e drive proved the busy guard fired but its message never reached the wire — and pulled a thread that ended at a framework-level scar. Three commits, two wrong theories, kept as the debugging story:

1. `9f087103ac` — worktree NamedError defects were never mapped on the httpapi backend (empty 500s; the hono twin always had `ErrorMiddleware`). Mapped them to a declared 400 schema. Bridge-harness green, live still broken.
2. `87c01ab3d6` — theory two: untagged struct mis-encoding in the live error union. Tagged ErrorClass. Still 401 live.
3. `efa93f94d6` — the stock-error control (`consoleSwitch` bad payload → 401-empty, live and harness, every build) isolated the truth: **effect's security middleware eats TYPED errors from auth-wrapped endpoints entirely**. The fix responds RAW (`HttpServerResponse.jsonUnsafe`, 400, the exact hono `{name, data}` contract) — the framework returns raw responses verbatim. Authed pin restored and green; red on any `Effect.fail`-based mapping. GOTCHAS: `httpapi-security-middleware-eats-typed-errors-respond-raw`.

Live-verified end to end on the vm: mid-turn discard answers `400 {"name":"WorktreeDiscardFailedError","data":{"message":"An agent is mid-turn in this checkout…"}}` while the lap runs, and succeeds after it settles. The full declared-review loop drove clean on production: compose-fresh → quiet while working (commits raised nothing) → `request_review` raised the card with the agent's note as headline → card yielded while busy → merge landed both commits and dissolved the checkout.
