## Attempt 1 — success

**Session:** ses_1d749e807ffemSJTGhrmeVZo3l
**Commit:** c45e6e014
**Date:** 2026-05-15
**Decision on entry:** first attempt

### What happened

Migrated substantive prose from `tool/shell/shell.txt` into
`tool/process/exec-command.txt` (Sub-agent A). Verified `agent-spawn.txt`
needs no migration (Sub-agent B). Wrote differential test, perf bench,
and unskipped 4 Wave 5 integration invariants. Mutation probe verified.

### Decisions

#### A1 vs A2 (exec_command migration approach)

Picked **A1 — direct concatenation**. Reasons:

- `exec-command.txt` is loaded as a static `default import from "./exec-command.txt"` in `tool/process/prompt.ts:7-10`; no template substitution layer exists. Wiring one in for a single tool is more code surface than the migration warrants.
- A2 (shared `tool/shared/shell-prose.ts` module) requires both `shell.ts`'s renderer AND a new `exec_command` renderer to consume it. Two renderers for one prose blob with no further reuse target. Premature abstraction.
- The substitutions needed (4 distinct substring patterns) are small enough to bake into the static file once and verify via the differential test's substitution map.

The substitution map (used by both the authored content AND the differential test):

```
each using the bash tool   → each using the exec_command tool
using the bash tool        → using the exec_command tool
the following bash commands → the following commands
besides git bash commands  → besides git commands
via the bash tool          → via the exec_command tool
```

Rendered against the **bash profile** of `ShellPrompt.render("bash", "darwin", ...)` per WAVE.md gotcha 9 — `exec_command` is bash-only on the host platform; the per-shell rendering machinery from `shell.ts` is not migrated.

#### Sub-agent B — no spawn_agent prose migration

`task.txt`'s substantive content is largely subsumed by the v2 `agent-spawn.txt`:
- Mental model / Naming / Inheritance — covered in agent-spawn.txt
- When to delegate / When NOT to delegate — covered in both, agent-spawn.txt is the more comprehensive version
- Scoping a delegated task — covered (agent-spawn.txt's "Every spawn should have a concrete deliverable" maps to task.txt's "Bad/Good" examples)
- Cost / Limits / fork_turns — covered

The "Explore agent delegation" rules (ask-questions, parallel-split, thoroughness-levels) ARE genuinely unique to task.txt — but the runtime-rendered `describeSpawnAgent` listing for `explore` already includes the thoroughness level guidance ("specify the desired thoroughness level: \"quick\" / \"medium\" / \"very thorough\""). The other explore rules are codex-style copy that would clash with the agent-spawn.txt voice.

Net: no static-file change for spawn_agent. Verified the per-subagent listing still renders correctly via the integration invariant `prose-migration-preserves-spawn-agent-eligible-list`.

### Tests / checks ran (all green)

```
bun typecheck                                                                  ✓
bun lint                                                                       ✓ (0 errors)
bun test ./test/differential/prompt-prose.diff.test.ts                         ✓ 7/7
bun test ./test/integration/tool-surface-replacement.test.ts                   ✓ 23/25 (2 wave_6 skips)
bun test ./test/perf/prompt-render.bench.ts                                    ✓ 2/2
bun test src/tool/process/ src/tool/agent-spawn/ src/tool/shell/               ✓ 164/164
bun test src/tool/registry.test.ts                                             ✓ 7/7
bun test ./test/integration/                                                   ✓ 49/51 (2 wave_6 skips)
bun test ./test/differential/                                                  ✓ 10/10
bun test src/agent/                                                            ✓ 250/250
```

### Mutation probe

- File: `packages/opencode/src/tool/process/exec-command.txt`
- Probed line: `- NEVER update the git config` (the canonical first rule of the Git Safety Protocol)
- Mutation: deleted the line via `sed -i '/NEVER update the git config/d'`
- Test run: `bun test ./test/integration/tool-surface-replacement.test.ts -t "prose-migration-preserves-git"`
- Result: **RED** — `expect(exec.description).toContain("NEVER update the git config")` failed at the integration invariant (line 1204).
- Restore: `cp /tmp/exec-command-backup.txt → exec-command.txt`
- Re-run: **GREEN**

The differential test (`exec_command.txt contains the git safety protocol fragment`) ALSO went RED on the same mutation because the deleted line was inside the substring it asserts contains-equality on. Two independent test paths catch the same regression.

### Token budget

Pre-migration baselines (from `artifacts/snapshots/prompt-prose/`):
- `bash-description.txt`         = 9938 bytes
- `exec-command-description.txt` = 6093 bytes
- `task-description.txt`         = 7328 bytes
- `spawn-agent-description.txt`  = 5883 bytes

Post-migration (from `artifacts/perf/wave_5.json`):
- `prompt.render.exec_command.bytes` = 12393 bytes
- `prompt.render.spawn_agent.bytes`  = 5811 bytes

Budgets:
- exec_command upper bound = (9938 + 6093) * 0.9 = 14428 bytes — current 12393 is 2035 bytes under (~14% headroom). ✓
- exec_command lower bound = 6093 * 0.95 = 5788 bytes — current 12393 is well above (migration ADDED content, expected). ✓
- spawn_agent within ±5% of 5883 baseline → [5588, 6178] — current 5811 in range. ✓

The 38-byte gap between file size on disk (12431) and bench-rendered size (12393) is the trailing newline + plugin-bridge `tool.definition` invocations — the rendered description goes through the plugin trigger path which can append (it doesn't here, no plugin is registered in the test environment).

The 72-byte gap between `spawn-agent-description.txt` snapshot (5883) and bench output (5811) is from the `docs` agent — present in the original snapshot capture environment but not in the clean Bun test environment. Same baseline shape, 1-line difference in the appended subagent list. The integration test uses the snapshot file (5883) as authoritative which gives a wider ±5% window; the actual bench-vs-baseline cross-environment delta is ~1.2%, well within budget.

### File-op restriction

WAVE.md task 4 (the IMPORTANT block at line 9 of shell.txt) wasn't a verbatim migration — the original block said "DO NOT use it for file operations ... use the specialized tools for this instead." with no enumeration of WHICH specialized tools. The migration takes that opportunity to enumerate Glob / Grep / Read / Edit / Write / direct text — same enumeration the bash tool's `bashCommandSection` section has at lines 109-115 of `prompt.ts`. The integration test asserts presence of "DO NOT use it for file operations" + "git, npm, docker"; the differential test asserts the bash → exec_command guidance line is gone (`Use \`bash\` instead`).

### Why NOT touch shell.txt

`shell.txt` and `task.txt` stay unchanged per BACKWARD_COMPAT.md "out of scope" boundary. Shell tool remains internally callable; the test in `tool-surface-replacement.test.ts § legacy-shell-tool-still-runnable-from-internal-code` covers the internal-callability invariant.

### What new GOTCHAS would catch?

Considered adding a GOTCHA for "prose differential test substitution maps must enumerate ALL substring variants" but it took ~5 min to spot and fix (the PR section had `using the bash tool` while the git safety section had `each using the bash tool`). Not >15 min material. Leaving GOTCHAS.md as-is.

---
