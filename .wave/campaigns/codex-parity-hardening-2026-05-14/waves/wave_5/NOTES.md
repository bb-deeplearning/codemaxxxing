# Wave 5 — Notes

## Attempt 1 — complete

**Session:** ses_1da2622aaffeQNb8Pevzt2c60l
**Commit:** _pending — recorded in follow-up commit_
**Date:** 2026-05-14
**Decision on entry:** first attempt

### What happened

Wave 5 — ship the campaign's permanent spec doc at
`specs/codex-parity-hardening.md`. Single agent, sequential, one file. No
production code touched.

Read the WAVE.md spec + the cross-cutting plan docs (`OVERVIEW`,
`INTEGRATION_INVARIANTS`, `GOTCHAS`, `MESSAGE_SHAPES`, `PERF`,
`BACKWARD_COMPAT`, `STYLE`, `artifacts/perf-final-report`). Read the two
tone references (`specs/codex-parity.md` 375 lines, `specs/tui-render-freeze.md`
487 lines). Read the post-wave-2 source files I needed accurate file:line
refs against (`packages/opencode/src/agent/control.ts` 1134 lines,
`packages/opencode/src/agent/status.ts`, `packages/opencode/src/tool/agent-wait/agent-wait.ts`,
`packages/opencode/src/tool/agent-spawn/agent-spawn.ts`,
`packages/opencode/src/tool/registry.ts`, the integration test file). Cross-
checked the codex precedent file:line refs against the codex source at
`/Users/rohan/Documents/Personal/experiments/codemaxxxing-codex/codex-rs/core/src/agent/control.rs`
(`AgentControl` struct at 130-145; `maybe_start_completion_watcher` at 943-1015 — refs in
the spec read `:130-136` and `:943-1015` for the load-bearing portions).

Wrote `specs/codex-parity-hardening.md` at 429 lines (target 300-450).
Structure mirrors the WAVE.md template:

- header status block
- background (one paragraph + the integration-first thesis)
- bug 1 — what we saw / root cause / fix (with table of file:line refs) / codex precedent
- bug 2 — same shape + body shape inline
- bug 3 — same shape + verification (already-landed fix; Wave 0 audit tests)
- the shared root cause (three paragraphs on tests-of-primitives vs
  tests-of-scenarios)
- INTEGRATION_INVARIANTS.md — paragraphs + 13-row status table
- performance — paragraph linking to `artifacts/perf-final-report.md`
- backward compat — paragraph linking to `BACKWARD_COMPAT.md`
- discoveries appended to GOTCHAS.md (3 entries with prose summaries)
- what this campaign explicitly does NOT do (5 deliberate exclusions)
- forward-looking (one paragraph)
- campaign archive (per-wave commit table)

Tone: file:line throughout, codex precedent inline where it matters,
no marketing copy. Treats the next reader as a peer needing context.
Adopted `tui-render-freeze.md`'s "what we saw / what we did / what stays
true" structure for each bug section, kept `codex-parity.md`'s table-rich
style for cross-references.

### Verification

```
bun typecheck                                                    → 0 errors
bun lint  (oxlint from repo root)                                → 0 errors (3013 warnings unchanged)
test -s specs/codex-parity-hardening.md                          → ok
wc -l specs/codex-parity-hardening.md                            → 429 (target 300-450)
grep -E "control\.ts:[0-9]+" specs/codex-parity-hardening.md     → 10 refs
all linked targets exist (7 plan/artifact files + sibling spec)  → ok
bun test ./src/agent/                                            → 243 pass / 0 fail
bun test ./test/integration/multi-agent-invariants.test.ts       → 13 pass / 0 fail
```

The wave touched no production code; the test runs are sanity that
nothing drifted between Wave 4's commit and now.

### File:line refs verified against post-wave-2 source

The spec doc cites these. All read directly from
`packages/opencode/src/agent/control.ts` (1134 lines post-wave-2):

| Ref | What it points at |
|---|---|
| `control.ts:297-311` | `PerRootData` + `InternalState` interface |
| `control.ts:392-409` | `Bus.subscribe(SessionDeleted)` per-root teardown |
| `control.ts:447-465` | `ensureRootSlot` (root mailbox provisioning lives in this block) |
| `control.ts:454-458` | the specific lines that make the root's mailbox |
| `control.ts:467-473` | `slotFor` |
| `control.ts:605-625` | child fiber + `onExit` |
| `control.ts:628-665` | sibling completion watcher (Wave 2) |
| `control.ts:644` | shutdown skip |
| `control.ts:657-660` | notification body construction |
| `control.ts:761-803` | `sendInterAgentCommunication` cross-root rejection |

Plus single refs into `agent-wait.ts:115-127` (race), `status.ts:49-52`
(isFinal), `agent-spawn.ts:31-33` (required `agent_type`),
`agent-spawn.ts:133-150` (eligible-set validation),
`registry.ts:326-339` (describeSpawnAgent enumeration),
`multi-agent-invariants.test.ts:157-840` (the harness),
`multi-agent-invariants.test.ts:733-839` (bug-3 audit block).

Codex precedent refs:
- `codex-rs/core/src/agent/control.rs:130-136` — per-root invariant
- `codex-rs/core/src/agent/control.rs:943-1015` — `maybe_start_completion_watcher`

### Files modified

**Production (0):** none. Wave is doc-only.

**Docs (1):** `specs/codex-parity-hardening.md` — new, 429 lines.

**Plan (0):** no new GOTCHAS. The doc consumes the existing three Wave 0/1
discoveries already in the curated index.

**Artifacts (0):** no perf JSON or screenshots.

### Recommendation

Campaign is now complete. STATE.md transitions `wave_status: all_complete`.
The spec doc is the permanent record; the campaign archive at
`.wave/campaigns/codex-parity-hardening-2026-05-14/` carries the
per-wave-detail.

Future readers should treat `INTEGRATION_INVARIANTS.md` as the load-bearing
artifact. The spec doc summarises it; the doc itself is the rule.

---
