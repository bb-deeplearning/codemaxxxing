# Wave 0 — Notes

## Attempt 1 — user_question

**Session:** ses_1dab5d497ffeqTcXWqL9ALEVZV
**Commit:** 45d2fbaf9
**Date:** 2026-05-14
**Decision on entry:** first attempt

### What happened

Wrote `packages/opencode/test/integration/multi-agent-invariants.test.ts` verbatim per
`plan/waves/wave_0/WAVE.md` (300 lines of spec). All 10 invariant `it.instance.skip` stubs
plus 3 NON-SKIPPED bug-3 audit tests. Used `ProviderID.make("test")` / `ModelID.make("test-model")`
and `MessageID.make("")` from the existing `multi-agent-tools.test.ts` pattern (cleaner than the
spec's `as never` casts; gotcha 5 in WAVE.md explicitly endorses copying that pattern).

### What failed

Two distinct issues block wave 0 verification.

#### Issue 1 — bug-3 audit test 1 cannot pass as written

Spec (`plan/waves/wave_0/WAVE.md` lines 179-183):

```ts
expect(spawn.description).toMatch(/\bexplore\b/)
expect(spawn.description).toMatch(/\bgeneral\b/)
expect(spawn.description).not.toMatch(/\bexplorer\b/)
expect(spawn.description).not.toMatch(/\bworker\b/)
expect(spawn.description).not.toMatch(/\bdefault\b/)
```

Spec gotcha 4a (lines 264-266 in WAVE.md) claims `\bword\b` is safe against the prose because
it uses word boundaries. Empirically false. `bun test ./test/integration/multi-agent-invariants.test.ts`
output:

```
1 fail  (bug 3 audit > spawn_agent description lists explore + general (not explorer / worker))
2 pass  (other 2 bug-3 audit tests)
10 skip (invariants)
```

Failing assertion: `expect(spawn.description).not.toMatch(/\bexplorer\b/)`.

Empirical regex matches against `packages/opencode/src/tool/agent-spawn/agent-spawn.txt`:

| regex            | line | substring matched         |
|------------------|------|---------------------------|
| `\bworker\b`     | 44   | `Observer/worker —`       |
| `\bexplorer\b`   | 92   | `an explorer.`            |
| `\bdefault\b`    | 29   | `by default.`             |
| `\bdefault\b`    | 107  | `(default):`              |

In every case word boundaries are present on both sides (non-word chars: space, `/`, `(`, `)`, `:`, `.`).
Word-boundary regex matches all four phrases. Gotcha 4a is mistaken about word-boundary semantics
for these specific prose phrases (it correctly identifies that `worker_a`, `worker_1`, `workers`,
`/root/explorers` are safe — those have word-character neighbors — but it's wrong about
"an explorer" and "(default)" which have non-word neighbors).

The spec's HIGH-LEVEL intent is clear: verify `describeSpawnAgent`'s appended enumeration only
includes real subagents (`explore`, `general`), not codex role names (`explorer`, `worker`,
`default`). The literal encoding of that intent is buggy because the appended enumeration is
concatenated with the .txt prose, and the prose legitimately uses those words as illustrative
copy.

#### Issue 2 — 21 pre-existing typecheck errors block "zero errors" verification

```bash
$ bun typecheck 2>&1 | grep -c "error TS"
21
```

All 21 errors are pre-existing (verified via `git stash`). They live in:

- `packages/opencode/src/tool/agent-spawn/agent-spawn.test.ts` — 20 errors
- `packages/opencode/src/tool/agent-spawn/schema.test.ts` — 1 error

Pattern: `Property 'agent_type' is missing in type '{ message: string; task_name: string; }'`.

The bug 3 fix commit `c86c58f94` made `agent_type` a required field on `spawn_agent`'s
`Parameters` schema (which is exactly what the wave-0 audit test 3 asserts). The fix
did NOT update dependent test files to supply the new required field — they were left with
`{ message, task_name }` only. They've been failing typecheck on the codex-parity branch
since that commit.

Wave-0 verification step 1 says "Typecheck — zero errors". Pre-existing 21 errors block this
regardless of my changes (my new file contributes 0 errors).

### Diagnosis

Both issues are spec defects, not transient. The spec author wrote test bodies they did not run
(`bun test`) and a verification step (`zero errors`) they did not check (`bun typecheck`) before
shipping the WAVE.md. The verifier patch commit `c04478fc8` reviewed the substring assertions
but kept them — either the verifier missed the empirical regex behavior or has a different view
than what I'm seeing. The 21 pre-existing typecheck errors were not addressed by either author.

These are not retryable failures. A fresh session writing the same spec verbatim would land at
the same outcome.

### Tried in-session

1. Wrote test file verbatim per spec.
2. Ran `bun typecheck` — 21 pre-existing errors (none from my file).
3. Ran `bun test ./test/integration/multi-agent-invariants.test.ts` — 1 fail / 2 pass / 10 skip
   on bug-3 audit; failure on `\bexplorer\b` matching "an explorer." in prose (full output
   captured in chat).
4. Empirically verified the regex behavior against agent-spawn.txt with a one-off bun script
   (matches detailed in table above).

Did NOT modify the spec. Did NOT modify production code. Did NOT modify pre-existing test files.
Did NOT relax the failing assertion on my own initiative.

### Recommendation

Two independent decisions needed from the user.

**Issue 1 — regex/prose conflict.** Three viable options:

1. **A. Modify `agent-spawn.txt` prose** to remove standalone occurrences of forbidden words.
   Concrete edits: "by default" → "as the default" (line 29); "Observer/worker —" → 
   "Observer/aggregator —" (line 44); "an explorer." → "an explore agent." (line 92);
   `(default):` → `(this is the default):` (line 107). Changes user-visible model description
   text. ~4 line edits in agent-spawn.txt. Tightens the prose against future "did codex roles
   leak in" regressions.

2. **B. Adjust test 1 to scope assertions to the appended enumeration.** Extract the
   "Available agent types and the tools they have access to:\n..." block and assert against
   that substring only. Preserves spec intent (verify enumeration doesn't list codex roles).
   No production change. Test stops asserting on the prose entirely (because the prose isn't
   what the bug-3 fix touches anyway).

3. **C. Drop test 1.** Keep tests 2 (`agent_type: "explorer"` rejected with `agent_type_invalid`
   error tag) and 3 (schema requires `agent_type`). Both directly test the bug-3 fix; test 1 was
   defense-in-depth against an unrelated regression vector. The campaign already has the strong
   guarantees from tests 2 + 3.

Recommended: **B** (preserves intent, no behavior change). **A** is fine if the user wants the
prose tightened anyway. **C** loses one layer of defense but is the simplest.

**Issue 2 — pre-existing typecheck errors.** Three viable options:

1. **X. Fix the 21 errors** by adding `agent_type: "explore"` (or similar valid value) to each
   Parameters object in `agent-spawn.test.ts` and `schema.test.ts`. Mechanical fix; ~21 lines
   across 2 test files. Honors wave 0's "zero typecheck errors" verification.

2. **Y. Accept pre-existing baseline.** Reinterpret wave 0's verification as "zero NEW
   errors". My changes contribute 0; pre-existing 21 stay as known-debt for a future cleanup
   wave. Pragmatic but loosens the bar.

3. **Z. Roll back the bug-3 fix's required-parameter constraint.** Revert agent_type to
   optional. Defeats bug 3. Not recommended.

Recommended: **X** (clean baseline; pure test fix; small mechanical work).

If user picks **B + X** the wave can complete in one short follow-up turn — I'll narrow test 1
to the enumeration substring and add `agent_type: "explore"` to the 21 broken test sites. Both
are test-file work consistent with "no production code changes".

If user picks **A** I will edit agent-spawn.txt as specified above (or per their preferred
wording) — that IS a production change but a tiny cosmetic one.

---

## Attempt 2 — complete

**Session:** ses_1dab5d497ffeqTcXWqL9ALEVZV (resumed via user reply)
**Commit:** TBD
**Date:** 2026-05-14
**Decision on entry:** continue (resumed after USER QUESTION; user picked B + X)

### What happened

User clarified concern was about the visual closeness of `explore` (real subagent) and
`explorer` (codex role rejected by bug 3). After confirming `agent_type: "explore"` is the
correct real-subagent name, user picked B + X. Executed both:

**B — narrow test 1 of bug 3 audit to the appended enumeration only.**
The corrected test extracts the `"Available agent types and the tools they have access to:"`
substring from `spawn.description` (per `describeSpawnAgent` in `registry.ts:326-339`) and
asserts on bullet anchors `^- explore:` / `^- general:` (positive) and `^- explorer:` /
`^- worker:` / `^- default:` (negative). Multiline `/m` regex catches enumeration entries
while ignoring prose mentions like "an explorer.", "Observer/worker —", "by default.".

**X — added `agent_type: "explore"` to all broken sites.**
Scope expanded beyond the original 21 typecheck errors after empirically running the affected
files (`bun test ./src/tool/agent-spawn/{schema,agent-spawn}.test.ts`):

| File | Sites fixed | Reason |
|------|-------------|--------|
| `src/tool/agent-spawn/agent-spawn.test.ts` | 20 | Typecheck errors (missing required field) — same fix also clears 14 runtime SchemaError failures |
| `src/tool/agent-spawn/schema.test.ts` | 1 typecheck + 2 stale behavioral tests | Line 28 typecheck; lines 14-17 ("required = message + task_name") + lines 27-32 ("accepts message + task_name only") encoded pre-fix shape |
| `test/integration/multi-agent-tools.test.ts` | 1 | Runtime-only failure typechecker missed because `Tool.Def` cast erases Parameters typing |

Also added one new test in `schema.test.ts`: "rejects missing agent_type (bug 3 fix made it
required)" — explicitly defends the requiredness invariant going forward.

Renamed schema.test.ts assertions from "required = message + task_name" → "required =
agent_type + message + task_name" and "accepts message + task_name only" →
"accepts message + task_name + agent_type (the new required minimum)" so the test names
reflect post-fix reality.

Two new GOTCHAS appended to `plan/GOTCHAS.md`:
1. `word-boundary-regex-vs-prose-collisions` — `\bword\b` matches every prose mention; scope
   regex assertions to structured sections.
2. `bug-3-fix-left-test-files-with-stale-required-shape` — schema-tightening migration
   checklist (typecheck → grep → run-affected-tests → audit `required`-list assertions).

### What passed

```
bun typecheck             → 0 errors
bun lint                  → 0 errors (3010 pre-existing warnings unchanged; touched files: 0 errors / 12 warnings, all pre-existing patterns)
bun test ./test/integration/multi-agent-invariants.test.ts → 3 pass / 10 skip / 0 fail (matches WAVE.md expected outcome)
bun test (touched files combined: 4 files)                  → 47 pass / 10 skip / 0 fail
```

No perf bench for wave 0 (no production code touched).

### Diagnosis

Both spec defects from attempt 1 resolved per user choice. Test 1's intent (verify
enumeration omits codex roles) is preserved with stricter scoping. Pre-existing typecheck +
runtime test debt cleared mechanically.

### Recommendation

Wave 1 can proceed. Integration test scaffold is in place at
`packages/opencode/test/integration/multi-agent-invariants.test.ts` with all 10 invariant
slugs as `.skip` stubs ready for unskip + implementation. Bug 3 audit (3 non-skipped tests)
defends the existing fix against regression. Two new GOTCHAS captured for future waves.

---
