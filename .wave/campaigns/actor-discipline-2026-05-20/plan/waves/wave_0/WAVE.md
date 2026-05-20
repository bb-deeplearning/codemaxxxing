# Wave 0 — Bootstrap (executor-solo)

<!--
Previous waves: none — this is the first wave.
Orchestration: SOLO. Do NOT spawn planner/generator/evaluator subagents for this wave.
The orchestrator pattern needs the safety net (D5) and canonical path injection (D2)
to be in place BEFORE it can safely spawn subagents. This wave lands those.

Also read:
- ../../OVERVIEW.md
- ../../INTEGRATION_INVARIANTS.md (focus: INV-D-01..05, INV-D-07)
- ../../PROMPT_SURFACES.md (assembly order section — the capability-hint render path matters for D2)
- ../../REFERENCES.md (diagnostic session IDs; repo file:line refs)
- repo-root GOTCHAS.md (indexes first; load specific entries as needed)
- packages/opencode/test/AGENTS.md (testEffect / it.instance patterns)
- packages/opencode/AGENTS.md (Effect v4 + module shape)
-->

## Goal

Land the harness floor so Wave 1+ can orchestrate subagents safely. Six surgical code changes, no prose changes, no new tools. Lands as ONE wave because the changes are tightly coupled — they all sit in `agent/control.ts`, `session/system.ts`, or `tool/agent-close/agent-close.ts`.

Deliverables:

1. **D5 extractor narrowing** — `agent/control.ts:712-716` predicate change + body change. Drop tool parts from the matched message; walk back if filtered result is empty. Keeps the "most recent assistant message with text" semantics but no longer skips entire messages on `finish: "tool-calls"`.
2. **D5 safety-net warning** — `agent/control.ts:718-728` body change. When extracted body is empty/likely-status AND child never called send_message/followup_task to spawner, prepend the structured ⚠️ warning to the synthetic mail.
3. **D2 canonical-path injection** — `session/system.ts:101-116` `capabilityHints` change. Template `/root/<task_name>` into the `multi-agent-subagent.txt` fragment per-spawn.
4. **D6 root-hold for in-flight mail** — `session/prompt.ts` or `agent/control.ts` change. When root is about to end its turn AND a live descendant has un-drained mail in flight, drain first.
5. **D3 first-class self-close** — `tool/agent-close/agent-close.ts` Schema change. `target` becomes optional → caller is target.
6. **D9 close_agent error split** — `tool/agent-close/agent-close.ts:60-68` metadata change. Distinguish `already_terminated` (success case when target self-terminated) from `path_invalid` (model used wrong reference).

Integration invariants to land green:
- INV-D-01: `extractor-returns-text-from-finish-tool-calls`
- INV-D-02: `explicit-send-message-delivers-and-completion-notifies`
- INV-D-03: `safety-net-warning-when-deliverable-missing`
- INV-D-04: `agent-close-without-target-resolves-to-caller`
- INV-D-05: `subagent-prompt-contains-canonical-path`
- INV-D-07: `close-agent-distinguishes-already-terminated-from-path-invalid`

(INV-D-06 and INV-D-08 land in Wave 1 and Wave 2 respectively, after prose changes give the sibling-coordination doctrine a place to live.)

## Tasks

**Executor-solo.** Do these in sequence yourself; do NOT spawn subagents.

### Task 0.1 — D5: extractor narrowing + safety net

File: `packages/opencode/src/agent/control.ts`

Current predicate (lines 712-716):
```ts
(m) =>
  m.info.role === "assistant" &&
  typeof m.info.finish === "string" &&
  m.info.finish !== "tool-calls"
```

New behavior:
1. Match the most recent assistant message regardless of `finish` reason.
2. Extract body by joining ONLY text parts (filter out tool parts), per the current `718-728` join.
3. If the joined body is empty, walk back to the previous assistant message; repeat until a non-empty body is found OR no more assistant messages.
4. After extraction: check if child ever called `send_message` or `followup_task` with `recipient === input.parentPath` during its lifetime. If NOT, AND the extracted body is empty OR matches a heuristic "looks like a status line" (length < 200 chars AND no newlines AND contains words like "delivered", "complete", "done", "no further", "closing"), prepend the safety-net warning:

```
⚠️ Auto-extraction returned a short/likely-status message. Child did NOT call
send_message/followup_task to deliver. Last assistant text follows:

<extracted body or "<no text emitted>">
```

The "child called send/followup to spawner" check needs a new piece of state on the per-child slot in `AgentControl`. Add an `outgoing_to_spawner: boolean` flag flipped to `true` by `sendInterAgentCommunication` when `comm.recipient` resolves to the spawner's path. Per-root scoping applies (the flag lives in the per-child slot under the root's slot).

Tests (run RED first):

`packages/opencode/src/agent/control.test.ts` — add three test cases:
- "extractor returns text from a `finish: tool-calls` message" (INV-D-01 minimal repro at unit level)
- "extractor walks back on empty filtered body" (text-less last message)
- "safety-net warning prepended when no deliverable sent"

Then `packages/opencode/test/integration/multi-agent-invariants.test.ts` — add the three integration invariants INV-D-01, INV-D-02, INV-D-03 as `it.instance` blocks. Follow the pattern in the existing `child-completion-wakes-parent` test (lines around 80+). Use the stub-provider pattern from `installNeverLoop` plus a scripted runLoop that emits the specific message shapes.

### Task 0.2 — D2: canonical-path injection

File: `packages/opencode/src/session/system.ts`

Current `capabilityHints` reads the static `multi-agent-subagent.txt` and appends. New behavior: when injecting the subagent fragment, also append a per-spawn block:

```
You are operating as `<canonical_path>`. To close yourself:
  close_agent(target: "<canonical_path>")
  # or just omit the target; defaults to self.
```

The canonical path needs to reach `capabilityHints`. Two options — both require changing the `capabilityHints` signature (the current `(agent: Agent.Info) => Effect<string[]>` carries only the agent type name, not the per-spawn session identity):
- (a) Plumb `agentPath: AgentPath` through the call chain from `prompt.ts:1766-1779` → `system.ts:capabilityHints`. Signature becomes `(agent: Agent.Info, agentPath: AgentPath) => ...`. Caller in prompt.ts already has the value (via `currentAgentPath(control, sessionID)` from `tool/agents/current-path.ts`).
- (b) Plumb `sessionID: SessionID` instead and resolve at render time inside `capabilityHints` via the existing `currentAgentPath(control, sessionID)` helper. AgentControl moves into `capabilityHints`' dependency layer.

Pick (b). Reason: AgentControl is already required by `ToolRegistry` (see the GOTCHA `agentcontrol-required-by-toolregistry-existing-test-layers`), so plumbing it into `SystemPrompt` is consistent. The `currentAgentPath` helper at `packages/opencode/src/tool/agents/current-path.ts` is the right entry point — it lazy-registers root and returns the canonical path. Adding to `SystemPrompt`'s layer dependencies means updating tests that construct minimal layers — search for `SystemPrompt.defaultLayer` in tests and ensure AgentControl is in the merged layer.

For root sessions (no canonical path / path = `/root`), skip the injection. The hint only renders for subagents (per the existing `agent.mode === "subagent"` gate at `system.ts:101-116`).

Test (INV-D-05): spawn a child with `task_name: "worker_a"`. Capture the system prompt the child sees on its first turn (use the same `installNeverLoop` + capture pattern as existing tests). Assert substring `/root/worker_a` appears in the system prompt.

### Task 0.3 — D6: root-hold for in-flight mail

File: `packages/opencode/src/session/prompt.ts` (around the mailbox-drain logic at 1451-1502) OR `packages/opencode/src/agent/control.ts` (whichever owns the "turn ending" lifecycle for root sessions).

Investigation step (you do this in your own context):
1. Search for where a root session's turn settles (where `Step.Ended` is emitted for the root).
2. Identify whether there's a hook between "model emits stop" and "session.status flips to completed."
3. The new logic: before the root session's status flips to `{ completed: ... }`, check `AgentControl.hasPendingInflightMail(sessionID)`. If true, run one more mailbox drain (synthetic turn) to pick up the in-flight mail. If still pending after that drain, log a warning and proceed (don't loop forever).

`hasPendingInflightMail(rootSessionID)`:
- For every live descendant subagent under this root...
- Check if the subagent has any non-`shutdown` final-status message whose corresponding mailbox notification hasn't been drained yet by root.
- Returns `true` if any descendant has pending notifications.

This needs careful design — the wrong shape risks infinite loops or session-completion stalls. If your investigation shows the right hook doesn't exist cheaply, emit USER QUESTION with the options:
- (a) Add the hook; medium complexity.
- (b) Defer D6 to a follow-up wave; ship D5+D2+D3+D9 in Wave 0.
- (c) Implement a simpler "wait 500ms before completing root if any descendant is alive" heuristic; cheap but not correct.

If you proceed: add `INV-D-02` integration test variant that asserts the parent receives a child's `send_message` even if the child sends moments before the parent settles its final turn.

### Task 0.4 — D3 + D9: agent-close target optional + error split

File: `packages/opencode/src/tool/agent-close/agent-close.ts`

D3:
- Make `target` field on `Parameters` optional: `target: Schema.optional(Schema.String)`.
- In `execute`, if `target` is `undefined`, set it to the caller's canonical path: `params.target = String(currentPath)` (you can get currentPath at `agent-close.ts:51-54` already).
- Update tool description to document the self-close form.

D9:
- The error metadata at `agent-close.ts:60-68` currently returns `error: "invalid_target"`. Split:
  - If `resolveAgentReference` fails AND the target string matches a previously-known subagent path under this root (search `AgentControl.knownPaths(rootID)`): return `error: "already_terminated"`. NOT a hard error from the model's perspective; the tool output includes `previous_status: "shutdown"` semantically.
  - Otherwise: `error: "path_invalid"` (the path was never registered under this root).
- Update tool description: "When you `close_agent` a subagent that has self-terminated, the call returns `already_terminated` — this is the success case, not an error."

Tests:
- `packages/opencode/src/tool/agent-close/agent-close.test.ts` — add two test cases:
  - "close_agent with omitted target closes the caller" (INV-D-04 unit-level)
  - "close_agent on self-terminated child returns already_terminated, not path_invalid" (INV-D-07 unit-level)
- `packages/opencode/test/integration/multi-agent-invariants.test.ts` — add INV-D-04 and INV-D-07 as `it.instance` blocks.

## Gotchas

1. **Per-root scoping invariant.** The new `outgoing_to_spawner` flag and the new `hasPendingInflightMail`/`knownPaths` methods MUST resolve via the caller's root. Mirror the existing `slotFor(senderID)` pattern in `AgentControl`. Do NOT walk all roots. Reference: `multi-root-isolation` invariant in the hardening campaign's INTEGRATION_INVARIANTS.md.
2. **Capability hint cache.** `SystemPrompt.capabilityHints` rendering must remain pure with respect to the input session's metadata. The per-spawn path is per-session — same session always gets the same path. No cache invalidation concerns.
3. **The "looks like a status line" heuristic in D5.** Don't over-tune. False positives waste a warning; false negatives suppress the safety net. Start with the heuristic in Task 0.1 (length < 200, no newlines, contains specific words). If the diagnostic-session-3 test (`ses_1c2e8d84affe...` plato's message) doesn't trigger the warning, tighten. Test with both the diagnostic session's actual "Report delivered to parent" message AND a legitimate short deliverable like "Found: /abs/path/file.ts:42 — `validate()` checks expiry."
4. **The flag in D5 needs to persist beyond the send call.** `outgoing_to_spawner: true` is set once on the first send to spawner and stays true even after the child terminates. The completion-watcher reads it at terminal time. Don't put it in a transient request scope.
5. **`Schema.optional` semantics.** Effect's `Schema.optional` makes the field omittable in input but materializes as `undefined` in output. Check `agent-spawn.ts:Parameters` for an existing example of `Schema.optional` in this codebase.
6. **D6 is the risk.** If your investigation shows D6 needs more than a one-evening implementation, take the USER QUESTION exit. Wave 0 can ship without D6; later waves' subagent-delivery scenarios may surface the race but the safety net (D5) catches them with a warning. D6 is a refinement, not a blocker.
7. **Don't touch `active_session_id` or `active_session_kind`.** Loop-managed fields. (Reminder from AGENT_INSTRUCTIONS.md State update protocol.)
8. **GOTCHAS to consult before writing:**
   - `agentcontrol-providerref-must-live-in-layer-not-instancestate` — for the new state field.
   - `bun-coverage-aggregation-flake` — for per-file coverage.
   - `agentcontrol-required-by-toolregistry-existing-test-layers` — for the new D2 layer dependency.
   - `bus-subscriber-needs-instance-state-fork-and-instance-ref` — if D6 wires a new subscriber.
   - `effect-v4-either-renamed-to-result`, `effect-v4-catchall-renamed-to-catch` — for any new Effect code.

## Verification

```bash
cd packages/opencode

# Typecheck + lint (full repo)
bun typecheck
bun lint

# Unit tests for the four touched files
bun test src/agent/control.test.ts
bun test src/tool/agent-close/agent-close.test.ts

# Per-file 100% coverage. CRITICAL: pass the TEST file path, not the source path.
# `bun test --coverage src/agent/control.ts` runs 0 tests and exits 0 (silent
# false-pass) per GOTCHA `bun-test-coverage-source-file-arg-runs-zero-tests`.
# Tests selected by path; coverage reports every source file the test exercises
# (which includes control.ts / agent-close.ts / system.ts when those tests
# import them).
bun test --coverage src/agent/control.test.ts
bun test --coverage src/tool/agent-close/agent-close.test.ts
bun test --coverage test/session/system.test.ts
# (D6 changes may also touch src/session/prompt.ts — coverage that file via the
# test that exercises it; do NOT pass src/session/prompt.ts as the argument)

# Integration invariants — all six must be green
bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-01'
bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-02'
bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-03'
bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-04'
bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-05'
bun test ./test/integration/multi-agent-invariants.test.ts -t 'INV-D-07'

# Full multi-agent invariant suite (regression check — none of the hardening
# campaign's existing invariants must fail)
bun test ./test/integration/multi-agent-invariants.test.ts
```

All must exit 0. If `bun lint` complains about formatting on edited files, fix and re-run; don't skip.

If D6 was deferred per USER QUESTION (b), skip INV-D-02's "in-flight mail moments before settle" sub-case and note in NOTES.md.
