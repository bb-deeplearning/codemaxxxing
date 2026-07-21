# Changes: Host-scoped run lock + session-home routing + mid-lap unsend

**Date**: 2026-07-20 → 2026-07-21

Session correctness batch. Root problem ("dual lap"): the same session could run two loops concurrently — a second process or a bare HTTP verb landing on the wrong instance would start a fresh runLoop on the receiver's cwd while the real one was mid-flight. Fixed with a host-scoped file lock plus two residuals (shells not holding the lock; bare verbs routing to the receiver's cwd), and two adjacent session fixes.

## Host-scoped run lock (`ffed788315`)

- **At most one runLoop per session across instances AND processes.** `session/run-state.ts` wraps `ensureRunning` in a host-scoped `EffectFlock` file lock keyed `session-run:<id>`; a held lock fails fast with `Session.BusyError`, matching the in-memory runner.
- `packages/core/src/util/effect-flock.ts` extended (stale-break inherited from the existing flock semantics); GOTCHAS entry documents the design + the two known residuals at ship time.

## Residual (1): startShell rides the lock (`af2a115d4c`)

- `EffectFlock` grows **`tryAcquire`** — single attempt, `LockHeldError` on contention, stale-break inherited, scoped release identical to `acquire`.
- `startShell` wraps the same `session-run:` key `ensureRunning` holds, so **shells and loops exclude each other** across instances and processes; a held lock dies `Session.BusyError`.

## Residual (2): bare session verbs route to the session's home directory (`0319a00830`)

- Bare loop verbs (no `?directory=` / `x-opencode-directory`) — `message`, `prompt_async`, `shell`, `command`, `abort`, `loop`, `summarize`, `revert`, `unrevert`, `fork`, `init`, message DELETE, and permission replies — now fall back to `session.directory` (before `process.cwd`). A bare POST no longer runs the lap on the receiver's cwd, and bare ask replies stop being eaten by the default instance's empty registry.
- Explicit routing still wins; **reads deliberately stay bare** (routing a GET could spawn an instance).
- Shared `isSessionHomeRoute` in `src/server/shared/workspace-routing.ts` (NEW), wired into both backends' directory resolution (`httpapi/middleware/workspace-routing.ts` + legacy `instance/middleware.ts`). Tests: `test/server/workspace-routing.test.ts` (NEW).
- **GOTCHAS (`c2aa23c031`)**: both residuals marked closed on the run-lock entry, with test pins.

## Mid-lap unsend for queued unconsumed messages (`d44ad81889`)

- A queued message only EXISTS while the loop runs, so the old blanket `assertNotBusy` made unsend impossible by construction. DELETE message while busy now succeeds iff the target is a user message no assistant message was born after (the runLoop's own consumed test); consumed targets keep the exact `BusyError` wire shape per backend.
- `Session.canUnsendWhileBusy` (`session/session.ts`) shared by both backends; dual-harness tests fake busy through a real hung lap (`test/server/httpapi-session.test.ts` +173 lines).

## Variant-less prompts walk model memory (`834e1c9e88`)

- `session/prompt.ts`: a prompt with no explicit variant now walks **agent variant → tui per-model memory** before running bare, so a model's remembered effort/variant applies instead of being silently dropped. 94 new test lines in `test/session/prompt.test.ts`.
