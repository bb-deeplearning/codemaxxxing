# Iteration 8: Multi-agent architecture and tool surface overhaul

**Date**: 2026-05-13 through 2026-05-17 (29 commits of feature work + 38 wave-bookkeeping commits across three campaigns)

This is the biggest divergence from upstream OpenCode since the initial fork. We rewrote how subagents talk to each other and how the model runs shell-flavored work. The point isn't parity with any other harness. We'd accumulated specific opinions about both surfaces and OpenCode's defaults didn't fit. We used `openai/codex-cli` as a reference because it had already shipped tools in a shape close to what we wanted, which made the implementation faster, but the goal was always our architecture.

## Discovery

Two surfaces were holding us back.

### OpenCode's sub-agent architecture is fire-and-forget

`task` is the only way a parent agent reaches a child. Parent calls `task`, blocks until the child's run-loop ends, gets back a single text string. No channel back during execution. No way to refine the child's task mid-flight. No concurrent siblings. No observable status. This works for "go grep the codebase" and it falls apart for everything else we kept wanting to do.

- **Parallel fan-out.** We routinely want 3 to 5 explorers each looking at a different area of the codebase. With `task` that's either three sequential blocks (slow) or a single agent trying to look at everything at once (poor focus). Neither is what we mean.
- **Worker then observer.** A worker reports back, the parent looks at the result and refines: "go deeper on the auth middleware." With `task` that's a new spawn that re-pays the context warmup cost. The original worker's intermediate state is gone.
- **Debate.** Spawn two agents with different framings, let them argue. Impossible with fire-and-forget. You'd need them to coordinate, and the only mechanism is the parent shuttling messages between them turn by turn.
- **Long-running siblings.** Spawn a watcher to keep an eye on test output while the main thread does other work. The parent should be able to keep going, then check in. `task` blocks the parent.

We'd been hand-coding workarounds for each of these patterns and it was getting silly.

### OpenCode's `bash` tool is one-shot

Every `bash` invocation spawns a fresh process and exits when the command does. Fine for `ls`, `git status`, `mkdir`. Useless for the modal work that drives deep coding sessions.

- **REPLs.** Boot Python, load imports, build state, run one expression, exit. Next expression starts from scratch. Re-paying the boot cost on every call.
- **Dev servers.** Spin up `next dev`, observe a log line, edit the file, observe how the server reacts. Can't be done with bash. You spawn `next dev`, it runs forever or you kill it. Either way you can't push input or read incremental output.
- **File watchers.** `tsc --watch`, `vitest --watch`, `cargo watch`. Same problem.
- **Long-running observables.** `tail -f`, `kubectl logs -f`. Run forever; bash either blocks forever or kills them.

We had a model that knew how to use REPLs and dev servers but no tool that let it.

### Plus a structural concern

Even if we'd built persistent processes as a new tool alongside `bash`, the model would face decision overload every turn: bash or exec_command? Both work, slightly different parameter shapes, slightly different error semantics. Same problem for `task` vs `spawn_agent`. That's inference budget burned on a question we'd already answered.

## Research

### Codex's `unified_exec` and `multi_agent_v2`

`openai/codex-cli` had implemented both surfaces in a shape close to what we wanted.

`unified_exec` is a model-facing persistent PTY pool. Tools `exec_command` (spawn) and `write_stdin` (re-enter to send input or poll output). 64-process LRU pool. Head/tail-buffered output, 50/50 split inside a 1 MiB cap so the model sees both the prologue and the recent activity. Yield-time clamps tuned to keep REPLs responsive and long polls cheap: 5s floor on empty polls so the model can't spam-poll a slow process, 250ms floor on input-sending writes, 30s ceiling everywhere.

`multi_agent_v2` is concurrent interactive subagents with cross-agent messaging. Six tools: `spawn_agent` (fire-and-keep-running), `send_message` (FYI queue), `followup_task` (queue AND wake), `wait_agent` (block on mailbox update), `list_agents` (snapshot), `close_agent` (release a slot). Per-parent registry, depth-limited to 4 levels, per-session mailbox with a monotonic seq for wake-up semantics.

These were not perfect drop-ins. codex is a Rust codebase and we're TypeScript on Effect. codex's role vocabulary differs from ours. codex ships these as mutually-exclusive upgrades and we wanted to evolve the surface in stages. But the shape was right, and the documented operational invariants (yield-time clamps, pool caps, depth cap, mailbox seq) gave us numbers to match instead of re-deriving from scratch.

### What we kept from codex

- **`unified_exec`.** Pool cap. Head/tail buffer geometry. Yield-time clamps. The `origin: "tui" | "model"` distinction (TUI-spawned PTYs auto-remove on exit; model-spawned ones persist so the model can drain final output via follow-up poll).
- **`multi_agent_v2`.** Six-tool API surface. Mailbox plus seq-watch wake-up. Per-parent registry. Depth cap (`AGENT_MAX_DEPTH = 4`). The spawn-then-wait completion notification pattern. The conventions for `agent_type`, `task_name`, canonical `/root/...` paths.
- **Permission key collapsing.** Codex models permission decisions per-tool-family, not per-tool. The six v2 tools all consult one key. We adopted the same pattern but mapped it onto our existing `EDIT_TOOLS` precedent (`edit`, `write`, `apply_patch` all consult permission key `edit`).

### What we changed

- **Subagent names.** Codex has roles (`default`, `explorer`, `worker`). We have subagents (`explore`, `general`, user-defined custom agents). We kept our names. Bug 3 in the hardening campaign came from importing codex's role names verbatim into prose without translating. The model called `spawn_agent` with `agent_type: "explorer"` and the lookup failed silently. We fixed it with required-string parameter, per-turn description templating, and execute-body validation against the live registry.
- **Mutual exclusion.** Codex gates `bash` vs `exec_command` via a config flag; the model sees one or the other based on config. We initially shipped both as alternatives, then dropped `bash` and `task` from the model's tool list in a separate campaign. Cleaner: no config gate, just removal. The legacy files stay importable from internal code as backstops.
- **Prompt voice.** Codex's `multi_agent_v2.root_agent_usage_hint_text` and `subagent_usage_hint_text` are direct ports of codex's house style. We rewrote both fragments in codemaxxxing voice with our anti-over-engineering rules, our concrete examples, and our cost-and-discipline framing.
- **Conversational pauses.** Codex doesn't have this; we already had it from the wave system iteration. The multi-agent pause path uses the same mechanism. Agent ends turn, session stays alive, user replies in chat, agent resumes mid-thread.
- **Capability hints.** Codex injects hints unconditionally. We gate ours on the agent's effective permission set. An agent with `exec_command: deny` doesn't get the persistent-process hint, since it can't use the tool anyway. `SystemPrompt.capabilityHints(agent)` runs at session bootstrap and injects up to three fragments.

### Two structural failure modes worth recording before we hit them

**Per-root scoping.** A naïve implementation puts `AgentControl` state in `InstanceState` (per-directory). The moment a user opens two chats in the same project, they see each other's subagents. Codex documents this explicitly: "An `AgentControl` instance is intended to be created at most once per root thread/session tree." `InstanceState` is the right primitive for "one per project", not "one per chat in a project."

**Completion watcher.** The child fiber's `onExit` updates the child's status. `wait_agent` watches the parent's mailbox seq. These two ends are not connected unless something forks a watcher that bridges them. Codex's `maybe_start_completion_watcher` does exactly this: a tokio task per spawn that holds the child's status receiver, waits for `is_final`, posts a notification to the parent's mailbox.

We hit both. They're documented under Solution below.

## Solution

Three back-to-back wave campaigns on the `codex-parity` branch, then a handful of post-campaign fixes from dogfooding. Each campaign is captured in a full engineering reference under `specs/`. This section gives the iteration narrative.

### Phase 1: `codex-parity` (16 waves)

Archive: `.wave/campaigns/codex-parity-2026-05-13/`. Spec: [`specs/codex-parity.md`](../specs/codex-parity.md).

Built the new tools alongside the legacy ones. Goal: model can use them, but old workflows aren't disrupted.

What landed:

- **Two new tools for persistent processes.** `packages/opencode/src/tool/process/exec-command.ts` plus `write-stdin.ts`. Constants extracted to a shared file (`constants.ts`) so prose and code reference the same numbers.
- **Pty.Service extensions.** Race-read between output/exit/timeout. LRU pruner gated on `MAX_UNIFIED_EXEC_PROCESSES`. `origin: "tui" | "model"` field on `Pty.Info` to control the legacy auto-remove-on-exit path. `HeadTailBuffer` ported from `codex-rs/core/src/unified_exec/head_tail_buffer.rs` (symmetric 50/50 inside 1 MiB cap). `ProcessSessions` per-instance map of model-spawned PTYs.
- **Six new tools for multi-agent v2.** `packages/opencode/src/tool/agent-spawn/`, `agent-send/`, `agent-followup/`, `agent-wait/`, `agent-list/`, `agent-close/`. Each is a directory containing the tool, its description text, its schema tests, and its execute tests.
- **AgentControl service.** `packages/opencode/src/agent/control.ts` orchestrates the whole subsystem. Per-parent registry, per-session mailbox, status SubscriptionRefs, fiber registry. `registerRunLoop` hands the per-session loop closure to a layer-scope `providerRef` so spawn calls can re-enter the runLoop without a service-graph cycle.
- **Mailbox plus InterAgentCommunication.** Append-only queue per session with a monotonic seq watch for `wait_agent` wake-ups. `packages/opencode/src/agent/mailbox.ts` plus `inter-agent-communication.ts`.
- **AgentRegistry plus AgentPath.** Per-parent registry with depth-limited spawn reservations. Canonical `/root/...` path strings. `AGENT_MAX_DEPTH = 4` matches codex.
- **LiveAgent, AgentStatus, AgentMetadata.** Status snapshot exposed to `list_agents`. Status derived from `Step.Started` and `Step.Ended` events on the bus.
- **Two-channel event emission.** Sourced log (`session.next.agent.*` types) for replay. In-process bus (`agent.*` types) for the TUI and plugins to subscribe to. Documented under the GOTCHA `[eventv2-and-bus-dual-emission-with-parallel-type-prefixes]`.
- **runLoop integration.** `packages/opencode/src/session/prompt.ts:1526` drains the recipient's mailbox at the top of every iteration. Drained entries are injected as synthetic `MessageV2.UserPart`s with `metadata.from = <author AgentPath>` and `metadata.trigger_turn = <bool>`. `SubtaskPart` gains an optional `protocol?: "v2"` field that routes through `AgentControl.spawnAgent`. Absent or any other value continues through the legacy `task` dispatch path.
- **Capability hint fragments.** `packages/opencode/src/agent/prompt/persistent-processes.txt`, `multi-agent-root.txt`, `multi-agent-subagent.txt`. `SystemPrompt.capabilityHints(agent)` at `packages/opencode/src/session/system.ts:101` injects them based on the agent's effective permission set.
- **Per-built-in permission defaults.** `packages/opencode/src/agent/agent.ts:107-301`. `build` and `general` allow everything; `explore` allows messaging but not spawning or closing; `plan` denies all new tools; `compaction`, `title`, and `summary` deny everything wildcard-wise.
- **TUI rendering.** `process-tool.tsx` renders `Process` and `ProcessWriteStdin` parts. `subagent-status.ts` plus `subagent-footer.tsx` derive a per-session status string. `mailbox-message.tsx` renders synthetic UserParts with cross-agent visual treatment. `dialog-subagent.tsx` adds a `close` action to the subagent quick-action dialog.
- **Test discipline.** TDD throughout. 100% line coverage per file (verified per-wave with `bun test --coverage`). 10 e2e scenarios in `packages/opencode/test/e2e/`. Frozen perf baseline at `.wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json` with a 5/10/15% budget on p50/p95/p99.
- **`GOTCHAS.md` knowledge base.** New file at the repo root, progressive-disclosure structure (indexes first, full entries by slug). Captures the sharp edges discovered during the campaign: Effect v4 renames, Bus and InstanceState pitfalls, opentui render traps, Bun coverage quirks, PTY origin gating, perf bench methodology. Designed so future agents can `Read GOTCHAS.md limit=200` for indexes only, then jump to relevant entries with offset reads.

### Phase 2: `codex-parity-hardening` (6 waves)

Archive: `.wave/campaigns/codex-parity-hardening-2026-05-14/`. Spec: [`specs/codex-parity-hardening.md`](../specs/codex-parity-hardening.md).

100% line coverage shipped phase 1. Three structural bugs survived it.

**Bug 1: AgentControl state shared across root sessions.** Two chat sessions opened against the same project saw each other's subagents. Chat A's `list_agents` returned chat B's workers. `spawn_agent` from chat B with `task_name: "worker_a"` collided on `path_already_exists` if chat A had spawned a `worker_a` first. Root cause: state lived in `InstanceState` (per-directory), so every root session in the same project shared one registry, one mailbox map, one `rootRef`. The per-primitive tests always ran with exactly one root in the fixture. The bug surfaced the first time we opened a second chat.

Fix: generalized to per-root state. Each registered root session gets its own slot (registry, mailboxes, statuses, fibers). A `sessionToRoot` index resolves any session id to its root in O(1). Per-root teardown subscribes to `Session.Event.Deleted`. `sendInterAgentCommunication`, `listAgents`, and `resolveAgentReference` each gained a required `senderID: SessionID` parameter so the service can resolve the caller's root before doing anything. The user-observable surface (tool inputs, outputs, error tags, permission keys, bus event payloads) is unchanged.

**Bug 2: `wait_agent` never wakes on child completion.** Parent calls `spawn_agent` then `wait_agent(timeout: 30s)`. Child completes in under 1s. `wait_agent` times out at the full 30s every time. The child fiber's `onExit` updated the child's status SubscriptionRef; `wait_agent` raced the parent's mailbox seq watch against `Effect.sleep(timeoutMs)`. Status transitions on the CHILD did not advance the PARENT's mailbox seq. There was no path between them. The timeout always won.

Fix: sibling watcher fiber forked at every `spawnAgent`. Subscribes to the child's status SubscriptionRef. On final, non-shutdown status, routes a notification through `sendInterAgentCommunication` to the parent's mailbox. Parent's seq advances, `wait_agent`'s race resolves on the change branch within milliseconds.

**Bug 3: `agent_type` validation.** Model called `spawn_agent` with `agent_type: "explorer"` (codex role name). Opencode has no `explorer` agent. The lookup failed and the error leaked every primary plus hidden agent. Model picked `default` next, same outcome. The per-primitive tests verified the string propagated through the spawn pipeline. They never asserted the propagated string resolved to a real agent. And the chosen example values in those propagation tests were `"explorer"` and `"worker"`, codex role names a real model would never resolve in opencode.

Fix (already landed at commit `c86c58f94` before the hardening campaign): `agent_type` made a required `Schema.String`. `describeSpawnAgent` mirrors the existing `describeTask` pattern by templating the live eligible subagent set into the tool's description per turn. The `execute` body validates against the eligible set and returns a model-recoverable `agent_type_invalid` error when the lookup fails.

**The discipline change.** All three bugs shared a single defect mode: tests asserted primitives worked, never that scenarios worked. Bug 1 had per-primitive tests for every `AgentControl` method, all green, all running with exactly one root. Bug 2 had per-primitive tests for the child fiber's `onExit` and for `wait_agent`'s timeout path. Never composed. Bug 3 had per-primitive tests for parameter propagation, using example values that wouldn't resolve.

The hardening campaign's first-class deliverable is `INTEGRATION_INVARIANTS.md` plus the harness at `packages/opencode/test/integration/multi-agent-invariants.test.ts`. Ten invariants in the catalog. Each `it.instance` walks the scenario the invariant describes and asserts what the user would observe. The discipline: every wave touching multi-agent code must add at least one `it.instance` against the relevant scenario before its production code lands.

Coverage is necessary; the harness is sufficient. The two structural bugs that survived phase 1's 100% line coverage are the empirical proof.

### Phase 3: `replace-bash-task` (7 waves)

Archive: `.wave/campaigns/replace-bash-task-2026-05-15/`. Spec: [`specs/replace-bash-task.md`](../specs/replace-bash-task.md).

The new tools were shipping correctly. Time to drop the legacy ones from the model's surface.

Three constraints made this non-trivial:

1. Saved permissions must keep working. Users have built up `permission.bash: { "git *": "allow" }` rules over months. The new tools needed to transparently honor them.
2. Plugin hooks must keep firing. Plugins keyed on `bash` or `task` for `tool.definition` mutations need a migration path.
3. The legacy files must remain importable from internal code. They're still useful as backstops; we just don't want to advertise them to the model.

What landed:

- **Permission key collapsing.** `SHELL_TOOLS = ["bash", "exec_command", "write_stdin"]` all consult permission key `bash`. `MULTI_AGENT_TOOLS = ["task", "spawn_agent", "send_message", "followup_task", "wait_agent", "list_agents", "close_agent"]` all consult permission key `task`. Mirror of `EDIT_TOOLS` exactly. A user with `permission.task: { "explore": "allow" }` now sees `spawn_agent(agent_type: "explore", ...)` auto-allow, the same way they used to see `task(subagent_type: "explore", ...)` auto-allow.
- **Group rules in `disabled()` and `resolveTools`.** Wildcard `permission.bash: { "*": "deny" }` (or `tools: { bash: false }`) now hides every member of `SHELL_TOOLS`. Same for `permission.task` hiding every `MULTI_AGENT_TOOLS` member. Pre-campaign only the literally-named tool was hidden.
- **`describeSpawnAgent` filter key.** The per-subagent-type filter at `tool/registry.ts:348` now consults permission key `task` (was: `spawn_agent`). A saved `permission.task: { "explore": "deny" }` filters `explore` out of `spawn_agent`'s rendered description in addition to `task`'s. Symmetric and consistent.
- **Drop `tool.shell` and `tool.task` from the registry's builtin array.** Model no longer sees `bash` or `task` in its tool list. Both `.ts` files remain importable and callable from internal code (asserted by `legacy-internal-runnable.test.ts`).
- **Plugin bridge.** `tool/registry.ts:407-421` fires the legacy ID's `tool.definition` hook first, then the new ID's, on the same `output` reference. Mutations made by the legacy hook are visible to the new-id hook. This preserves the migration path for plugins keyed on `bash` or `task`. Crucially this is NOT done for `tool.execute`. Execution semantics differ (one-shot for `bash`, persistent PTY for `exec_command`; single-shot for `task`, concurrent-interactive for `spawn_agent`) and bridging would break plugin expectations.
- **AST scanner extraction.** `packages/opencode/src/tool/shell/scan.ts` extracted from `shell.ts`. Pure refactor. 50-command differential green at `test/differential/scanner-extract.diff.test.ts`. The scanner is reentrant under 64-fiber concurrent load (stress test) and survives 1000 fuzz inputs without crashing (property test).
- **Prose migration.** Git safety protocol, PR creation flow, and file-op restriction prose migrated from `shell.txt` into `exec_command.txt`. Differential test asserts key fragments survive byte-identical modulo a documented substitution map ("the bash tool" becomes "the exec_command tool").
- **33/33 BC matrix.** Every config-shape × invocation cell from `FIXTURES.md` produces the documented (allow/deny/ask) decision against the matching invocation. Verified end-to-end at `artifacts/bc-verification.md`.

### Post-campaign fixes from dogfooding (3 commits, 2026-05-17)

- **`b3c32594e`. Wake parent `wait_agent` on child self-close / sibling-close.** The completion watcher's skip rule assumed `closeAgent` was parent-driven. A grandchild told "respond then close yourself" therefore stranded the parent's `wait_agent` at its full timeout (demoed at session `ses_1ce9356abffep1L0TvDbD80uUO`). Fix: `closeAgent` takes an optional `callerID`. The watcher skips the notification only when the caller is a strict ancestor of the target (the parent's own cascade path). Self-close, sibling-close, and descendant-initiated close now fire the notification with a `"shutdown"` label.
- **`05894e683`. TUI cycle subagents by siblings, not root's children.** `session_child_first` was re-resolving to "root + root's children" instead of drilling into the current session's direct children, so descent only worked at depth 1. `session_child_cycle` and `_reverse` only worked when "siblings of a depth-1 subagent" happened to equal "root's direct children". Fixed both with proper sibling resolution.
- **`dd04cad1a`. STATE reset.** Housekeeping after a campaign settled.

## Observe

Watch for these behaviors when running codemaxxxing on real work.

### Multi-agent v2

- **Spawn returns immediately.** `spawn_agent` from the parent should return in milliseconds with the child's canonical path; the child is now running in parallel. If the model talks about the spawn as if it blocked, the prompt fragment isn't taking.
- **Parallel siblings make actual parallel progress.** Open `list_agents` from the parent's chat after spawning 3 siblings; all three should show `running` status simultaneously, not one running and two `pending_init`.
- **`wait_agent` wakes on completion, not timeout.** Spawn a child that takes about 1s; parent calls `wait_agent(timeout: 30000)`. Wake time should be 1s plus a few ms for mailbox propagation. NOT 30s.
- **Two chats in the same project don't see each other.** Open two chats in the same project. Each spawns a `worker_a`. No collision; `list_agents` from each chat shows only its own. Cancelling one chat doesn't tear down the other's children.
- **Cross-root sends are rejected.** A `send_message` from chat A targeting a session in chat B should fail with a clear error, not silently cross over.
- **Self-close wakes the parent.** Spawn a child with a prompt that ends `... then close yourself with close_agent`. Parent's `wait_agent` should wake near-instantly with a shutdown notification, not stall to timeout.
- **Subagent navigation works at depth > 1.** Open a session that has grandchildren. TUI subagent cycling (`Tab` / `Shift+Tab` or the configured keybinds) should descend into the grandchild's siblings, not jump back to root's direct children.
- **Mailbox drain prefixes show in chat.** When a child sends a message to the parent, the parent's next turn should drain the mailbox and show `[from <child_path>]` prefixed entries before the user's actual prompt. If you don't see the prefix, the drain isn't running.

### Persistent processes

- **REPL boot cost paid once.** Spawn `python` or `node` with `tty: true`. Send `import numpy as np` (or equivalent). Send a second command that uses `np`. Second command should not re-import. REPL state is held.
- **Dev server logs poll incrementally.** Spawn `next dev` or similar. Empty-poll with `write_stdin(session_id, chars: "")` every few seconds. Each poll should return only new log lines since the previous poll's cursor, not the full log.
- **5-second empty-poll floor.** Pass `yield_time_ms: 100` to an empty poll. The actual wait should be at least 5 seconds (the clamp). This is intentional and prevents spam-polling.
- **Output truncated head+tail past 1 MiB.** Spawn a process that emits a lot. Output past `UNIFIED_EXEC_OUTPUT_MAX_BYTES` should return a prefix AND a suffix with the middle elided, not just the tail.
- **`tty: true` required for stdin.** Spawn with `tty: false`, try `write_stdin` with non-empty `chars`. Should fail with `stdin is closed for this session; rerun exec_command with tty=true`.
- **Permission survives across `write_stdin` calls.** First `exec_command` triggers the per-call permission ask. Approve `always`. Subsequent `write_stdin` calls on the same `session_id` should NOT re-prompt. The per-PID rule `pid:<session_id>` registered under permission key `bash` matches the same key per-process.

### Tool surface

- **Model's tool list excludes `bash` and `task`.** Check the live tool list at the top of any session log. Both should be absent. Only `exec_command` plus `write_stdin` for shell-flavored work; only the v2 six-pack for agent-spawning.
- **Saved `permission.bash` rules still gate `exec_command`.** With a rule like `permission.bash: { "git *": "allow" }`, running `exec_command(cmd: "git status")` should auto-allow without prompting. This is the SHELL_TOOLS group collapse.
- **Saved `permission.task` rules still gate `spawn_agent`.** With a rule like `permission.task: { "explore": "allow" }`, `spawn_agent(agent_type: "explore", ...)` should auto-allow.
- **Plugin `tool.definition` hooks for `bash` propagate to `exec_command`.** If you have a plugin mutating `bash`'s description, the mutation should show up on `exec_command`'s description per turn.
- **`tools: { bash: false }` hides all three.** Config-disable `bash`; `exec_command` and `write_stdin` should also disappear from the model's tool list. Same for `tools: { task: false }` hiding the v2 six-pack.

### Capability hints

- **Build and general get all three hints.** Open a `build` agent session. The system prompt at session start should include persistent-processes + multi-agent-root + multi-agent-subagent fragments (or just root if depth 0).
- **Explore gets nothing for spawn/close.** `explore` has `spawn_agent: deny` and `close_agent: deny` per defaults; it should not see the spawning hints. It should see the subagent hint (sends + waits) since those keys are allow.
- **Compaction, title, summary get no hints.** These deny everything wildcard-wise. Their effective permission sets should produce zero fragments. System prompts unchanged from pre-campaign.

## Architectural choices worth recording

### Coverage is necessary; integration invariants are sufficient

100% line coverage shipped phase 1. Three structural bugs still survived. The bugs weren't where the per-primitive tests looked. They were in how the primitives composed. The `INTEGRATION_INVARIANTS.md` discipline established in phase 2 is the durable answer. Every multi-agent surface, present and future, must hold the listed scenarios. The harness tests behavior, not implementation: each `it.instance` walks the scenario the invariant describes and asserts what the user would observe. New invariants append to the doc's "Discovered during execution" section, then the implementation. The harness lives at `packages/opencode/test/integration/multi-agent-invariants.test.ts` and the tool-surface counterpart at `packages/opencode/test/integration/tool-surface-replacement.test.ts`.

### Per-root scoping, not per-directory

`InstanceState` is the right primitive for "one per project" (file watchers, layer caches, the wave loop's bus subscriber). It is NOT the right primitive for "one per chat in a project". Multi-chat-same-project is a real workflow (one chat working on the codebase, one chat reviewing a PR). Sharing AgentControl state across the two breaks isolation. Per-root slots plus a sessionToRoot index is the fix. Every multi-agent service method routes through `slotFor(senderID)` to find the caller's root before doing anything.

### Codex as reference, not parity goal

Codex's design choices matched what we already wanted in many places (yield-time clamps, pool caps, depth cap, mailbox seq-watch). When they did, we adopted the numbers verbatim. Re-deriving them would have been time poorly spent. When they didn't (role vocabulary, mutual-exclusion gating, prompt voice), we kept our own. The two `specs/codex-parity*.md` docs name codex explicitly throughout; the iteration logs and README frame the changes as our architecture with codex as a useful reference.

### Mutual exclusion via removal, not config gate

Codex ships `bash` and `exec_command` as a config-gated upgrade. The user picks one, the model sees one. We initially shipped both as alternatives, then dropped the legacy ones from the model's tool list in phase 3. Cleaner: no config flag for users to think about, no decision overload for the model. The legacy `.ts` files stay importable from internal code as backstops. If we ever need to re-expose, we add a single registry entry; nothing else changes.

### Plugin bridge for `tool.definition`, NOT `tool.execute`

`tool.definition` hooks are description mutations. Bridging them across the legacy/new id pair preserves the migration path with zero plugin code change. `tool.execute` hooks bake in execution-shape assumptions. A plugin hooking `bash`'s `tool.execute` expects one-shot completion semantics; firing it for `exec_command`'s persistent PTY would break the expectation. So `tool.execute` is not bridged. Plugins must migrate to the new IDs explicitly. Documented in the spec doc and surfaced once at the top of `CHANGES/2026-05-13-multi-agent-and-tool-overhaul.md`.

### Saved per-friend permission keys are silently inert

Saved rules under `permission.spawn_agent`, `permission.send_message`, etc. no longer match. Those keys are no longer the per-call ask key for those tools. Restate the intent under `permission.task`. This is the same precedent EDIT_TOOLS has carried since launch (saved `permission.write` rules don't match `write.ts`'s asks either; those land under `permission.edit`). Surfaced in the user-facing changelog at the top of the changes entry.

### `GOTCHAS.md` as a first-class artifact

The campaigns surfaced sharp edges fast: Effect v4 renames, Bus and InstanceState lifetime traps, opentui render antipatterns, Bun coverage quirks, PTY origin gating, perf bench methodology, permission routing. Documenting each one inline in the spec docs would have bloated them past readability. Documenting them in commit messages would have buried them. The standalone `GOTCHAS.md` at the repo root, with progressive-disclosure structure (indexes first, full entries by slug), is the discipline that makes the knowledge transfer across future engineers (and agents). Future work touching the same surfaces reads the relevant entry first, saves the same hours.
