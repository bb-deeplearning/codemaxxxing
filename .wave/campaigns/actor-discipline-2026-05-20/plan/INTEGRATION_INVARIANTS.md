# Integration Invariants — Actor Discipline

This is the campaign's first-class deliverable. Every wave that touches a multi-agent surface MUST add at least one `it.instance` test in `packages/opencode/test/integration/multi-agent-invariants.test.ts` against the relevant invariant before its production code lands.

## Why this exists

The codex-parity-hardening campaign established the discipline: coverage is necessary, integration invariants are sufficient. Three bugs in the post-campaign window slipped through 100% coverage because no test asserted the model-visible output, no test composed completion-watch with subagent body delivery, no test composed mailbox send with fiber revival.

This campaign extends the catalog with INV-D-01..26 for the actor-discipline surfaces. The bugs we're preventing are reproducible — `ses_1c2e8d84affeZ7t5g5LKveGDTo` (delivery failure) and `ses_1d84f236bffeEWmrmOhp6SoLma` Demo 2 (sibling deadlock). Both become regression tests in Wave 2.

## How to use this file

For every wave:

1. Read this file end-to-end.
2. Identify which invariants the wave's changes affect.
3. For each, locate (or add) the corresponding `it.instance` test in `test/integration/multi-agent-invariants.test.ts`. The test name MUST match the slug.
4. Make the test pass before the wave commits.
5. If you discover a new sharp edge mid-wave, append it under "Discovered during execution" at the bottom and write the green test. Future waves treat new entries the same as seeded ones.

The Iteration 8 hardening catalog (in `.wave/campaigns/codex-parity-hardening-2026-05-14/plan/INTEGRATION_INVARIANTS.md`) remains authoritative for multi-root scoping, child-completion-wakes-parent, cross-root-send-rejection, session-deletion-cleanup, parent-close-cascades-to-children. This file EXTENDS that catalog; does not replace.

## Phase 1 invariants — delivery contract + sibling patterns

### `INV-D-01: extractor-returns-text-from-finish-tool-calls` (Wave 0)

Spawn a child via `spawn_agent`. Drive the child's runLoop (stub provider) to emit one assistant message containing BOTH a text part ("This is my deliverable.") AND a `close_agent(target: self)` tool call — the message's `finish` reason is `tool-calls`. After child terminates, parent's mailbox receives a notification whose body contains "This is my deliverable." (not the prior turn's text, not empty). Validates the D5 narrowed predicate.

### `INV-D-02: explicit-send-message-delivers-and-completion-notifies` (Wave 0)

Spawn a child. Child runLoop calls `send_message(target: parent_path, message: "Explicit deliverable.")`, then on a SEPARATE next step calls `close_agent(target: self)`. Parent's mailbox contains, in order: (a) the explicit message with author = child path, (b) the completion notification with status label "shutdown". Validates that explicit send and self-close compose correctly (the diagnostic session's `ses_1ce9356abffep1L0TvDbD80uUO` bug is regression-tested here).

### `INV-D-03: safety-net-warning-when-deliverable-missing` (Wave 0)

Spawn a child. Child runLoop emits NO text in any assistant turn (only thinking + tool calls), never calls `send_message` or `followup_task` to parent, then `close_agent(self)`. Parent's mailbox receives a single message whose body BEGINS with the safety-net warning prefix ("⚠️ Auto-extraction returned a short/likely-status message. Child did NOT call send_message/followup_task to deliver."). The warning includes the child's last assistant text (or "<no text emitted>" if none).

### `INV-D-04: agent-close-without-target-resolves-to-caller` (Wave 0)

Spawn a child at `/root/abc`. Within the child's runLoop, call `close_agent` with `target` omitted (or `target: undefined`). The close operation targets `/root/abc`. The returned `previous_status` reflects the child's state at close time. No `path_invalid` error.

### `INV-D-05: subagent-prompt-contains-canonical-path` (Wave 0)

Spawn a child with `task_name: "worker_a"`. Capture the system prompt the child sees on its first turn. Assert the prompt contains the substring `/root/worker_a` verbatim (D2 templating). The injection lives in the `multi-agent-subagent` capability hint fragment.

### `INV-D-06: send-message-is-unicast-not-broadcast` (Wave 1)

Spawn two siblings `/root/alice` and `/root/bob` from root. From root: `send_message(target: "/root/alice", message: "for alice only")`. Bob's mailbox is empty (no broadcast). Alice's mailbox contains the message. Validates the unicast doctrine the post-D7 prose declares.

### `INV-D-07: close-agent-distinguishes-already-terminated-from-path-invalid` (Wave 0)

Spawn `/root/childA`. Wait for it to self-terminate via its own `close_agent(self)`. Call `close_agent(target: "/root/childA")` from parent — returns metadata `{ error: "already_terminated" }`, NOT `{ error: "path_invalid" }`. Separately: call `close_agent(target: "/root/nonexistent")` — returns `{ error: "path_invalid" }`. D9 split.

### `INV-D-08: coordinator-fan-out-delivers-single-consolidated-message` (Wave 2)

Spawn a coordinator subagent. Coordinator spawns 2 grandchildren in a single message with two `spawn_agent` calls. Grandchildren each `send_message(coordinator, <partial finding>)` then self-close. Coordinator drains, integrates, sends ONE consolidated `send_message(root, <integrated report>)`. Coordinator self-closes. Root's mailbox: ONE message from coordinator (not N). The integrated report contains both grandchildren's content. (Locks in Demo 1's success pattern from `ses_1d84f236bffeEWmrmOhp6SoLma` as a regression-resistant shape.)

## Phase 2 invariants — ask pattern + ABORT protocol

### `INV-D-09: correlation-id-pairs-reply-to-request` (Wave 3)

Parent calls `send_message(target: child, message: <body>, correlation_id: "req-1")`. Child replies via `send_message(target: parent, message: <body>, correlation_id: "req-1")`. Parent calls `wait_for_reply(correlation_id: "req-1", timeout: 5000)`. Returns within 100ms of child's send. Returns the child's message body. A second `wait_for_reply` for the same correlation_id returns immediately with the queued message (idempotent within mailbox lifetime).

### `INV-D-10: wait-for-reply-times-out-without-matching-correlation` (Wave 3)

Parent calls `wait_for_reply(correlation_id: "req-1", timeout: 500)`. No message arrives. Returns with `timed_out: true` after ~500ms. Unrelated `send_message` (without correlation_id, or with different correlation_id) lands in the mailbox during the wait but does NOT wake the wait_for_reply call. Validates targeted wait vs broad `wait_agent`.

### `INV-D-11: missing-timeout-on-wait-emits-warning` (Wave 3)

Subagent calls `wait_agent` without a timeout (or with timeout > 600000ms cap). Tool returns a structured warning AND completes the call — does not silently allow indefinite wait. The warning recommends a meaningful timeout. (Doctrine enforcement at the runtime layer; complements prose change.)

### `INV-D-12: abort-reason-delivered-as-structured-payload` (Wave 4)

Child runLoop emits `ABORT(spec_wrong): details here.` as its last assistant line, then close_agent. Parent's mailbox receives a notification whose body parses to `{ abort_reason: "spec_wrong", details: "details here." }` (structured), in addition to the human-readable text. Validates D11 recognition: control.ts parses ABORT set-phrases and includes a structured payload in the InterAgentCommunication.

### `INV-D-13: orchestrator-pivots-on-abort-approach-failed` (Wave 4)

Orchestrator spawns generator + evaluator. Evaluator emits `ABORT(approach_failed): <details>`. Orchestrator (in this test, a stub orchestrator that follows the protocol) reverts the task's commits via `git revert --no-commit <sha>`, respawns the pair with the ABORT details prepended to generator's prompt, and proceeds. New pair completes the task on the second attempt. Test asserts: revert commit exists, second-attempt commits exist, CONTRACT.json shows criteria passed.

### `INV-D-14: set-phrase-ladder-extended-to-all-subagent-types` (Wave 4)

Spawn each of `general`, `explore`. Each is told to emit `ABORT(out_of_scope): test` as its last line. control.ts recognizes the ABORT in each case; parent's mailbox receives the structured payload. Validates D11 generalization (not just wave-system agents).

## Phase 3 invariants — supervision + pools + lifecycle + behaviors

### `INV-D-15: spawn-agent-with-on-failure-respawn-restarts-on-crash` (Wave 5)

`spawn_agent(..., on_failure: "respawn")`. Stub the child runLoop to crash on its first turn. Within 200ms of the crash, the registry shows a NEW child at the same task_name (regenerated session id). The replacement child runs to completion normally. on_failure metadata persists across the respawn (so a chain of crashes does NOT loop forever — wave-level retry_count semantics apply).

### `INV-D-16: pool-strategy-one-for-all-kills-pair-on-single-failure` (Wave 5)

`spawn_pool(..., count: 2, pool_strategy: "one_for_all")`. One child crashes. The OTHER child receives a notification + is closed within 100ms. The pool surfaces a single completion event to the spawner (not two). Validates one_for_all in concurrent-sibling scenarios (prosecutor/defense, generator/evaluator).

### `INV-D-17: pool-strategy-one-for-one-isolates-failures` (Wave 5)

`spawn_pool(..., count: 3, pool_strategy: "one_for_one")`. One child crashes; others continue. on_failure: "respawn" triggers a replacement. The pool surfaces individual events per child.

### `INV-D-18: spawn-pool-collect-all-aggregates-results` (Wave 6)

`spawn_pool(..., count: 3, collect: "all")`. All three children produce deliverables via send_message. Pool returns a list of three results, in completion order. Validates the fan-out primitive.

### `INV-D-19: spawn-pool-collect-first-cancels-remaining` (Wave 6)

`spawn_pool(..., count: 3, collect: "first")`. First child completes. The other two are closed within 100ms; pool returns the first child's result. Useful for "race three search strategies, take the fastest."

### `INV-D-20: spawn-pool-permission-collapses-to-task` (Wave 6)

User config `permission.task: { "explore": "allow" }`. Call `spawn_pool(agent_type: "explore", count: 2, ...)`. No permission prompt fires. All members spawn under the user's existing rule. Mirrors EDIT_TOOLS / SHELL_TOOLS / MULTI_AGENT_TOOLS precedent.

### `INV-D-21: link-paired-death-on-either-crash` (Wave 7)

`spawn_agent(/root/a)` then `spawn_agent(/root/b)` then `link(/root/a, /root/b)`. Crash `/root/a`. Within 100ms, `/root/b` is closed with status `linked_death`. Symmetric: crashing `/root/b` first kills `/root/a`. Unlink before crash → no cascade. Validates D14.

### `INV-D-22: bounded-mailbox-rejects-on-overflow` (Wave 7)

Set per-agent mailbox cap to 4 (test override). Sender calls `send_message(target: child, ...)` five times. The fifth call returns a structured `{ error: "mailbox_full", retry_after_ms: <hint> }`. Mailbox contains 4 items, in order. Sixth call also fails until child drains. After drain, sends succeed again. Validates D15 backpressure.

### `INV-D-23: bounded-mailbox-does-not-block-completion-notification` (Wave 7)

Same setup as INV-D-22, mailbox full. Child terminates. Completion notification is delivered DESPITE mailbox-full state (it's a system notification, not subject to user backpressure). One of the 4 queued messages is evicted FIFO to make room, OR a separate small system-notification slot is reserved. Doc says which. Test asserts: notification arrives; behavior is documented.

### `INV-D-24: agent-type-behavior-contract-validated-at-spawn` (Wave 8)

`agent_type: "general"` declares behavior `subagent_v1` with required outputs `[send_message_to_spawner]`. Spawn a child whose runLoop never calls send_message and only emits text. Runtime detects contract violation at terminal-status time and surfaces an explicit "behavior contract violated: missing send_message to spawner" message, in addition to the safety-net warning. Validates D16 declared contracts.

### `INV-D-25: behavior-contract-version-bump-coexists-with-prior-version` (Wave 8)

`general` agent supports `subagent_v1` and `subagent_v2` simultaneously. Spawn one of each. Each is validated against its declared version's contract. No cross-contamination. Mirrors the migration path for plugin tool.definition hooks (Iteration 8).

### `INV-D-26: behavior-contract-violation-fails-orchestrated-wave-not-spawn` (Wave 8)

A contract violation at spawn time does NOT prevent the spawn (the spawn must succeed for the orchestrator to observe the child's behavior). Validation runs at terminal-status time and surfaces via mailbox notification. The orchestrator chooses whether to pivot, retry, or abort the wave. Separates "violation detected" from "what to do about it."

## Discovered during execution

(Append new invariants here with `INV-D-27` onward. Each entry: slug, owning-wave, behavioral description in the same shape as above. The wave that discovered it owns the test.)
