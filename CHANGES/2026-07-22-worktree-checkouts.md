# Changes: Worktree checkouts — the full system

**Date**: 2026-07-22

One batch (`31288e6584`): the worktree plumbing probed on 2026-07-21 becomes a system — agents get isolated checkouts at spawn, readiness means a live instance, and the review verbs (diff / merge / discard) land in both backends so a phone tap can land or destroy the work. Built as the cmx half of boxbox-web's `docs/idea-worktrees.md`; the boxbox half (review lanes, checkout folding, the review card) rides the same wire.

## The service rewrite (`src/worktree/index.ts`)

- **Branch-optional `Info`** with detached-HEAD support; `list()` / `listAt()` return grouped, canonical shapes instead of bare db strings (paths canonicalized at `makeWorktreeInfo` — macOS `/var` vs `/private/var` join hazard).
- **Readiness means ALIVE**: populate → `.worktreeinclude` CoW copy (ignored-but-needed files: `.env` yes, `cache.log` no) → instance boot → start scripts → `worktree.ready`. Failures emit `worktree.failed {message, log}` carrying the stderr tail. Start timeout `OPENCODE_WORKTREE_START_TIMEOUT_MS`, default 600000. `StartCommandFailedError` deleted — failure is an event, not a throw.
- **Disk ceiling**: create refuses (`CreateRefusedError`) under max(5GB, 10%) free disk or 15 checkouts per project.
- **Remove disposes the checkout's loaded instance** — `disposeDirectory` port into `src/project/instance-store.ts`. Before this, watcher events kept arriving for a deleted directory 40s after removal.
- **Discard snapshots dirty work to a dangling commit** and returns the rescue sha — a phone-tap destructive control stays recoverable, no named-ref litter.
- **Merge is a LOCAL squash-merge on the owner machine** — push stays with whoever holds the creds. Conflicts return structured, the client sends the thread back to the agent.

## Review verbs in both backends

`GET/POST /experimental/worktree/{diff,merge,discard}` in hono (`routes/instance/experimental.ts`) AND effect-httpapi (`httpapi/groups/experimental.ts` + `handlers/experimental.ts`, `ExperimentalPaths.worktreeDiff/Merge/Discard`), with parity pinned in `test/server/httpapi-json-parity.test.ts` (seeded worktree block) and `httpapi-experimental.test.ts`. Diff ships `{branch?, base, baseRef, commits, dirty, mergeable?, additions, deletions, files[], diff, truncated}`.

Unified project index: `GET /project?worktrees=true` enriches rows per-project via `Effect.catchCause` — thrown `NamedError`s are **defects**, and one stale project row must not 500 the whole index (live-caught: it did).

## Spawn isolation

- `isolation: "none" | "worktree"` on `spawn_agent` / `spawn_pool` params + per-agent config knob (`config/agent.ts` AgentSchema + KNOWN_KEYS, hot-reloadable). **Built-in agent types stay OFF** — flipping live fleet spawn semantics silently is unsafe; opt in via `"agent": {"general": {"isolation": "worktree"}}`.
- Isolated children run in their own checkout via `InstanceRef` rebinding (session create + `startAgentFiber`); respawns continue in the SAME checkout (the respawn branch never settles it).
- Completion notifications append the checkout verdict AFTER the body (`STATUS_HEADER_RE` untouched): `[checkout kept: branch X · N commits ahead of base · dirty tree · +A -D — merge, send back, or discard: <dir>]` or `[checkout: clean — removed]`.
- Wiring keeps `AgentControl` at zero layer deps: the settler is injected via `registerCheckoutSettler` (the `registerRunLoop` precedent), `WorktreeIsolation.init()` runs on the serve spine in `server.ts` `listen` (the configreload-lazy-service gotcha). Worktree creation happens in the spawn TOOLS via dynamic `import("@/effect/app-runtime")` + `attach` — avoids the ToolRegistry/AgentControl layer-dep traps and an import cycle.
- Worktree-scoped session verbs anchor git at the PRIMARY project cwd (live-caught: worktree-scoped remove ran git from the deleted checkout's directory).

## Tests

- `test/project/worktree.test.ts`: 24 pins (readiness contract, include-copy, ceiling, discard snapshot, scoped-merge regression).
- `src/agent/control.test.ts`: 142 pass (isolation mechanism pins: InstanceRef binding, respawn continuity, settler injection).
- httpapi experimental + json-parity green; `bun typecheck` clean; SDK regenerated (`packages/sdk/js`).
- Three full live loops against a from-source serve: merge landed a real commit with branch+checkout auto-removed, discard rescue sha recovered content, `.env` copied / `cache.log` excluded, `worktree.failed` carried a real stderr tail.

## Turn-zero hotfix (`0037390865`, 2026-07-23)

Shipped the same day the batch deployed: five isolated children died at turn zero on the boxbox vm — `No user message found in stream`, deterministic, zero model calls. The child's loop fiber runs under the WORKTREE's InstanceRef (by design), but its slot and mailbox lived in the spawning instance's `InternalState`; the loop's mailbox drain resolved a fresh empty state and the initial task never became a user message. Fix: layer-scoped `sessionHome` index (session → owning InternalState, lifetime mirroring `sessionToRoot`), and every session-anchored AgentControl method resolves through it with ambient fallback. Also fixes `fork_turns: "all"` isolated children being deaf to followups and nested spawns from inside isolated fibers. Pin drives the real loop shape — red on the old code. See GOTCHAS `agentcontrol-tree-state-resolves-by-session-home-not-ambient-instance`.
