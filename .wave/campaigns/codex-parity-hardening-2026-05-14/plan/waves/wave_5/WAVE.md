# Wave 5 — Spec doc

<!--
Previous waves:
- wave_0 — integration test scaffolding + bug 3 audit
- wave_1 — per-root scoping
- wave_2 — completion watcher
- wave_3 — audit pass
- wave_4 — backward compat + perf

Also read:
- ../../INTEGRATION_INVARIANTS.md (the canonical invariant catalog — link from spec)
- ../../GOTCHAS.md (the curated gotcha index — note new entries discovered this campaign)
- ../../STYLE.md (file length + comment-style conventions for the spec doc)
- The previous campaign's spec doc as a tone reference: <repo>/specs/codex-parity.md (375 lines)
- specs/tui-render-freeze.md as a deeper-dive tone reference (487 lines, structured around "what we saw" + "what we did" + "what stays true going forward")
-->

## Goal

Ship `<repo>/specs/codex-parity-hardening.md` as the permanent record of this campaign: the three bugs, the per-root scoping fix, the completion watcher, the integration-first discipline that codifies what would have prevented them.

The doc is for the next reader (an engineer auditing the multi-agent subsystem six months from now) and the next AI session (an executor that needs to understand WHY the surfaces look the way they do). Both audiences read for the "why" — the "what" is in the code.

## Tasks

Single agent, sequential. One file: `<repo>/specs/codex-parity-hardening.md`.

Structure:

```markdown
# codex-parity-hardening

Hardens the multi-agent v2 subsystem shipped by codex-parity (2026-05-13)
against three structural bugs that survived the previous campaign's
per-primitive 100% coverage. Documents the integration-first discipline that
codifies what would have prevented them.

## Background

(Two paragraphs. The previous campaign's scope. Why a hardening campaign
even exists. The shared root cause across the three bugs: tests asserted
that primitives worked, not that scenarios worked.)

## Bug 1 — AgentControl state shared across root sessions

### Symptom

(One paragraph: the user-visible failure. Two chats in same project; one
sees the other's workers; etc.)

### Root cause

(One paragraph: InstanceState keyed per directory, not per root. rootRef
last-write-wins. Every Map shared.)

### Fix

(One paragraph + structural reference: per-root data slots inside
InstanceState, sessionToRoot index, every method resolves caller's root.
Reference: `packages/opencode/src/agent/control.ts:<relevant lines after
the wave 1 commit>`.)

### Codex precedent

(One paragraph: codex's `AgentControl` is created at most once per root
thread/session tree, per `codex-rs/core/src/agent/control.rs:130-136`.
We had this design implicit; the previous campaign violated it by reusing
InstanceState's per-directory keying.)

## Bug 2 — wait_agent never wakes on child completion

### Symptom

(One paragraph: parent waits, child completes in 2s, wait times out at 30s.)

### Root cause

(One paragraph: child fiber's onExit only updates child's status
SubscriptionRef. wait_agent subscribes to parent's mailbox seq watch.
Status change doesn't advance parent's seq.)

### Fix

(One paragraph + structural reference: sibling completion watcher fiber
forked at every spawnAgent. Subscribes to child's status. On final status
(non-shutdown) sends an InterAgentCommunication to parent's mailbox.
Reference: `packages/opencode/src/agent/control.ts:<relevant lines after
the wave 2 commit>`.)

### Codex precedent

(One paragraph: codex `maybe_start_completion_watcher` at
`codex-rs/core/src/agent/control.rs:943-1015`.)

### Body shape

(Reference: this campaign's `MESSAGE_SHAPES.md § "NEW: completion
notification body shape"`. Inline the body shape spec verbatim.)

## Bug 3 — agent_type role-vocabulary mismatch (already patched)

### Symptom

(One paragraph: model called `spawn_agent` with `agent_type: "explorer"`,
the codex role name. Opencode has no `explorer` agent. Lookup failed; error
leaked all primary + hidden agents.)

### Root cause

(One paragraph: codex has roles; opencode has agents. Previous campaign
imported codex role names verbatim into prose + tests without mapping.
100% coverage didn't catch it because tests only verified string
propagation, not behavioral lookup.)

### Fix (already landed at commit c86c58f94)

(One paragraph + structural reference: agent_type required Schema.String;
describeSpawnAgent templates valid types into description per-agent at
runtime; spawn_agent execute body validates against eligible set. Mirrors
the existing describeTask pattern for the legacy task tool.)

### Verification

(One paragraph: Wave 0's bug-3 audit test in
`test/integration/multi-agent-invariants.test.ts`. Asserts the fix is
intact; runs on every CI invocation.)

## The shared root cause

(Three paragraphs. The previous campaign tested every primitive at 100%
coverage. Two structural bugs survived. The campaign asserted that strings
propagated, that mailbox seqs incremented, that status transitions fired.
None of these tests composed primitives into the actual end-to-end
scenarios users hit. INTEGRATION_INVARIANTS.md is the durable answer.)

## INTEGRATION_INVARIANTS.md

(Two paragraphs + table. List every invariant from the doc with a one-line
description. Each invariant has a corresponding test in
`packages/opencode/test/integration/multi-agent-invariants.test.ts`. New
multi-agent code MUST add a test for the relevant invariant before the
implementation lands.)

| Slug | Description | Test status |
|---|---|---|
| multi-root-isolation | ... | green (Wave 1) |
| child-completion-wakes-parent | ... | green (Wave 2) |
| ... | ... | ... |

## Performance

(Reference: this campaign's `PERF.md` and `artifacts/perf-final-report.md`.
One paragraph summary: every metric within budget vs the prior campaign's
frozen baseline.)

## Backward compat

(Reference: this campaign's `BACKWARD_COMPAT.md`. One paragraph: legacy
task tool, old sessions, Pty consumers, existing TUI all keep working.
Wave 4 verified.)

## Discoveries appended to GOTCHAS.md

(One paragraph + bullet list. Any new gotchas discovered this campaign
that future waves should know about. Reference each by slug + one-line
summary.)

## What this campaign explicitly does NOT do

(Two paragraphs. List of things the campaign did NOT touch even though
they're nearby:
- The TUI subagent rendering — Wave 11 of the previous campaign owned
  that surface and it isn't broken.
- The legacy task tool — coexists with v2; not replaced.
- The Pty subsystem internals — only the cleanup-on-cascade invariant
  was asserted.
- The model provider stub — used unchanged from prior campaign.

The point: a hardening campaign is narrower than a feature campaign.
Adding scope dilutes the discipline.)

## Forward-looking

(One paragraph. The next multi-agent feature MUST add tests against
INTEGRATION_INVARIANTS.md. Adding a new invariant is allowed and expected
— write it as a green test, then write the doc entry.)
```

Total length target: 300-450 lines. The previous campaign's spec is 375 lines — close to that is the right size.

Tone: file:line references throughout. Codex precedent inline where it matters. No marketing language. Treat the next reader as a peer who needs context, not a stakeholder who needs convincing.

## Gotchas

1. **File:line references must be ACCURATE.** After Wave 1 + 2 land, the line numbers in `agent/control.ts` will have shifted. Regenerate every `:line` reference by reading the post-wave-2 file. If a reference points to the wrong line, the doc starts lying immediately.

2. **The spec is documentation, not advocacy.** Don't editorialize ("this elegant solution..."). State what was wrong, what was changed, why. Future readers are skeptical of past decisions; a doc that recognizes that earns trust.

3. **Link, don't duplicate.** The spec links to `INTEGRATION_INVARIANTS.md`, `MESSAGE_SHAPES.md`, `PERF.md`, `BACKWARD_COMPAT.md`, `GOTCHAS.md`, and `artifacts/perf-final-report.md`. Inline a one-paragraph summary; the link carries the depth.

4. **Codex references are READ-ONLY.** The spec quotes codex file:line; don't suggest modifying codex.

5. **Tone reference is `specs/tui-render-freeze.md`.** Read it before writing. Adopt its structure: what we saw, what we did, what stays true going forward.

## Verification

```bash
cd packages/opencode

# 1. Typecheck — no production code touched, but bun typecheck should still
#    pass against any prior wave's leftovers.
bun typecheck

# 2. Lint — same.
bun lint

# 3. Spec doc exists and has reasonable length.
test -s ../../specs/codex-parity-hardening.md
wc -l ../../specs/codex-parity-hardening.md   # expect 300-450

# 4. Spec doc references real files at real lines (smoke test).
grep -E "control\.ts:[0-9]+" ../../specs/codex-parity-hardening.md   # expect non-empty

# 5. Every link target exists. Manually verify each link in the doc.

# 6. The full multi-agent test surface still passes (the spec wave didn't
#    touch code, but verify nothing drifted between Wave 4 and now).
bun test ./src/agent/
bun test ./test/integration/multi-agent-invariants.test.ts
```

The wave is complete when the spec is written, links are real, and `bun test` still passes.
