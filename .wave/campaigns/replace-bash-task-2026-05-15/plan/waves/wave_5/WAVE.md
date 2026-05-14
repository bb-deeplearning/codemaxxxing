# Wave 5 — Migrate `shell.txt` and `task.txt` prose into new tool descriptions

<!--
Previous waves: 0, 1, 2, 3, 4.
Also read:
- ../../OVERVIEW.md
- ../../STYLE.md, ../../TDD.md, ../../PERF.md
- ../../INTEGRATION_INVARIANTS.md (focus: prose-migration-preserves-git-safety-protocol, prose-migration-preserves-pr-creation-flow, prose-migration-preserves-spawn-agent-eligible-list, prompt-token-count-within-budget)
- ../../BACKWARD_COMPAT.md § "Snapshot diffs"
- ../../FIXTURES.md
- .wave/campaigns/codex-parity-2026-05-13/plan/PROMPT_ENGINEERING.md (the voice/quality bar — read in full)
- .wave/campaigns/replace-bash-task-2026-05-15/artifacts/snapshots/prompt-prose/* (Wave 0 captures)
- packages/opencode/src/tool/shell/shell.txt
- packages/opencode/src/tool/task.txt
- packages/opencode/src/tool/process/exec-command.txt
- packages/opencode/src/tool/agent-spawn/agent-spawn.txt (or wherever spawn_agent's prose lives)
- packages/opencode/src/tool/shell/prompt.ts (current ShellPrompt template renderer)
- packages/opencode/src/tool/process/prompt.ts (exec_command's renderer)
-->

## Goal

Migrate the substantive prose from `shell.txt` (git safety protocol, PR creation flow, file-op restriction guidance, common-operations cheat sheet) into `exec_command.txt` so the model — which now sees only `exec_command`, not `bash` — receives the same operational guidance. Same for `task.txt` content into `spawn_agent`'s description where applicable.

Token budget: per `PERF.md` § "Prompt token budget", post-migration `exec_command` token count must be within ±5% of (`bash` baseline + `exec_command` baseline) per `prompt.render.exec_command.tokens` baseline.

Quality bar: per `PROMPT_ENGINEERING.md`. The migrated prose is operational manual, not boilerplate. Junior-tier copy-paste fails the wave.

## Tasks

Two sub-agents in parallel — A and B are independent file pairs.

### Sub-agent A — exec_command prose migration

Files:
- READ: `packages/opencode/src/tool/shell/shell.txt`, `packages/opencode/src/tool/process/exec-command.txt`, `packages/opencode/src/tool/shell/prompt.ts`, `packages/opencode/src/tool/process/prompt.ts`
- WRITE: `packages/opencode/src/tool/process/exec-command.txt` (extended), possibly `packages/opencode/src/tool/shared/shell-prose.ts` (shared template fragment if both keep using it).

Sections to migrate from `shell.txt` into `exec_command.txt`:

1. **Git Safety Protocol** (lines 13-51 of current `shell.txt`) — full block. Includes: never update git config; destructive command policy; force-push warning; `--no-verify`/`--no-gpg-sign` rule; `commit --amend` rules; commit-message guidelines; secret-file caution; commit-message style guidance; pre-commit-hook handling; "never push" rule; "never use -i flag" rule; empty-commit rule.

2. **PR Creation Flow** (lines 53-71 of current `shell.txt`) — full block. Includes: gh command usage; PR-state-investigation parallel commands; PR summary drafting; create-PR commands.

3. **Other common operations** (lines 76-77 of current `shell.txt`) — short reference.

4. **The IMPORTANT block at line 9** (`This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations`) — already implicit in current exec_command.txt's "Use bash instead for ..." advice but invert: now exec_command IS the only shell-flavored tool, so the file-op restriction belongs here.

Approach options (pick A1; document choice in NOTES):

- **A1 (preferred): direct concatenation.** Append the migrated sections to `exec_command.txt`. Adapt the template variable references (the current `shell.txt` uses `${toolName}` placeholders rendered via `ShellPrompt.render`; `exec_command.txt` is a static string with no template). Either (a) inline the current-process tool name as `exec_command`, or (b) introduce templating in `exec_command.txt` if not already present.
- **A2: shared module.** Extract the migrated sections into `tool/shared/shell-prose.ts` exporting `GIT_SAFETY_PROTOCOL`, `PR_CREATION_FLOW`, etc. Both `shell.ts`'s prompt renderer and `exec_command.ts`'s prompt renderer import. Higher upfront cost; future maintenance is one place. Take this if `exec_command.txt` already uses templating and the substitution is clean.

Adapt the prose to `exec_command`'s shape:
- References to `bash` tool name → `exec_command`
- "the bash tool" → "this tool" or `exec_command` (mostly the latter, codex-style)
- The `${toolName}` placeholder gets resolved to `exec_command` literal when this file is rendered (not at runtime)

Validate the result: read it end-to-end, confirm the model receives complete operational guidance about git safety, PR flow, and file-op restrictions. The voice should match codex-parity's `PROMPT_ENGINEERING.md` — terse, second-person, no marketing prose.

Write differential test `test/differential/prompt-prose.diff.test.ts`:

```ts
it("exec_command.txt contains the git safety protocol fragment from shell.txt", () => {
  const shellText = Bun.file("src/tool/shell/shell.txt").text()
  const execText = Bun.file("src/tool/process/exec-command.txt").text()
  // Extract the git safety protocol block from shell.txt (between known markers)
  const gitSafetyMarkers = ["# Committing changes with git", "# Creating pull requests"]
  const startIdx = shellText.indexOf(gitSafetyMarkers[0])
  const endIdx = shellText.indexOf(gitSafetyMarkers[1])
  const block = shellText.slice(startIdx, endIdx).trim()
  expect(execText).toContain(block.replaceAll("${toolName}", "exec_command"))
})

it("exec_command.txt contains the PR creation flow fragment", () => { ... })
it("exec_command.txt contains the file-op restriction warning", () => { ... })
```

These differential tests prove the migration is verbatim where it should be — surgical adaptations only for tool name references.

### Sub-agent B — spawn_agent prose migration (lighter touch)

Files:
- READ: `packages/opencode/src/tool/task.txt`, `packages/opencode/src/tool/agent-spawn/agent-spawn.txt` (or wherever the v2 spawn_agent's text lives), `packages/opencode/src/tool/registry.ts:322-339` (describeSpawnAgent)
- WRITE: `packages/opencode/src/tool/agent-spawn/agent-spawn.txt` (extended) if substantive content needs migrating

Most of `task.txt`'s value is the per-subagent-type listing rendered by `describeSpawnAgent`, which already happens at runtime per `registry.ts:322-339`. So the migration is largely structural:

1. Verify `describeSpawnAgent` still produces the eligible-subagent list correctly (Wave 3 changed its filter from `spawn_agent` to `task` permission key).
2. Check `task.txt`'s static prose for any operational guidance NOT covered by `spawn_agent.txt`. Likely candidates: when-to-use guidance, multi-agent decision rules, return-shape narrative.
3. Migrate any such content into `spawn_agent.txt` directly.

If `task.txt` has no migratable content beyond the per-subagent listing (which is already templated at runtime), this sub-agent's work is just verification + a stub differential test asserting `spawn_agent`'s description still includes the per-subagent-type listing.

Differential test:

```ts
it("spawn_agent description includes per-subagent-type eligible listing", () =>
  Effect.gen(function* () {
    const desc = yield* renderSpawnAgentDescription(buildAgent)
    // Per FIXTURES.md, build agent has both explore and general available
    expect(desc).toContain("explore")
    expect(desc).toContain("general")
    expect(desc).toContain("Available agent types")
  }),
)
```

### Step (both sub-agents) — Token count budget verification

After both prose migrations land, run:

```bash
cd packages/opencode
bun test ./test/perf/prompt-render.bench.ts   # or extend existing
```

The bench captures `prompt.render.exec_command.tokens`, `prompt.render.spawn_agent.tokens`. Compare against the baseline at `artifacts/baseline-perf.json`:

- `exec_command.tokens` must be within ±5% of (`bash`'s baseline tokens + `exec_command`'s baseline tokens). The migration absorbs `shell.txt` content into `exec_command.txt`; the budget allows for that absorption while bounding redundancy.
- `spawn_agent.tokens` must be within ±5% of (`task`'s baseline tokens + `spawn_agent`'s baseline tokens) IF substantive content was migrated; otherwise within ±5% of `spawn_agent`'s baseline alone.

If over budget: trim redundant phrasing. The migrated prose may have duplicated guidance that was already in the destination file. Identify and dedupe; do NOT cut substantive operational content.

### Integration invariants — unskip

`test/integration/tool-surface-replacement.test.ts` unskips:

- `prose-migration-preserves-git-safety-protocol` — the differential test from Sub-agent A.
- `prose-migration-preserves-pr-creation-flow` — the differential test from Sub-agent A.
- `prose-migration-preserves-spawn-agent-eligible-list` — the differential test from Sub-agent B.
- `prompt-token-count-within-budget` — assertion that the bench's metrics are within budget (read the latest `artifacts/perf/wave_5.json`, compare to baseline).

### Mutation probe

After tests green:
1. In `exec_command.txt`, delete the line containing "NEVER update the git config".
2. Run `bun test test/differential/prompt-prose.diff.test.ts`.
3. Assert the differential test goes RED.
4. Restore. Re-run; all green.
5. Document in NOTES.md.

### Bench

`test/perf/prompt-render.bench.ts` (extend or create). Re-measures token counts and prompt rendering time for `exec_command` and `spawn_agent`. Output to `artifacts/perf/wave_5.json`.

## Test pyramid quota for Wave 5

- Unit: 0 (no production code logic changes).
- Integration: 4 invariants unskipped.
- Differential: 1 file with 3-5 fragment-presence assertions.
- Property: 0.
- Concurrent stress: 0.
- Plugin contract: 0 (already covered Wave 4).
- Fixtures: 0 (no new fixtures; existing fixtures rerun).
- Bench: 2 metrics (exec_command tokens, spawn_agent tokens).

## Gotchas

1. **Don't reword the git safety protocol.** It's been hand-tuned over many iterations and the wording matters (e.g., "NEVER" vs "Don't" vs "Avoid" — each used deliberately). Migrate verbatim. If you find a phrasing nit you can't resist, fix it in a SEPARATE commit AFTER this wave ships, not as part of the migration.

2. **`${toolName}` template variable.** Current `shell.txt` uses `${toolName}` because it's rendered for both `bash` (legacy) and powershell variants via `ShellPrompt.render`. If you migrate via concatenation (option A1), substitute `${toolName}` → `exec_command` before saving. If you take the shared-module route (A2), the template variable can stay; both renderers substitute their own value.

3. **Token-count proxy.** Wave 0 may have used `description.length` as a byte proxy if no real tokenizer was wired (per Wave 0's NOTES). Stay consistent — use the same proxy in Wave 5's bench. The campaign's budget is computed against the proxy, not against ground-truth tokens.

4. **`describeSpawnAgent` output is appended to the static description.** Per `registry.ts:368-373`, the rendered description is `[output.description, describeSpawnAgent(...) if applicable, ...].join("\n")`. The static `agent-spawn.txt` content + the runtime per-subagent listing combine. When measuring tokens, bench against the COMBINED rendered output (what the model actually sees), not the static file.

5. **Plugin bridge interaction.** Wave 4's plugin bridge means `tool.definition` hooks for legacy `bash` ID still fire. If a plugin's hook appends content, that content lands in the rendered `exec_command` description AFTER the `task.txt` migration content. Order: static `exec_command.txt` → bridge `bash` hook → primary `exec_command` hook. Bench against the FULL rendered output to avoid surprises.

6. **The "Use bash instead for one-shot commands" line in current `exec_command.txt:11` is now WRONG.** After Wave 4 the model has no `bash` tool to use as alternative. Update this line: drop it, or rephrase as guidance about persistence vs one-shot semantics ("for one-shot commands without persistence, set `yield_time_ms` long enough for the process to exit").

7. **Don't rewrite the entire `exec_command.txt`.** The file already has a well-tuned operational manual for the persistent-PTY semantics. Migration ADDS sections; it does not replace existing content. If the current file is missing a topic the migration brings in, ADD; if it already covers it, the migration may be redundant — drop the redundant migration in favor of the existing prose.

8. **Don't touch `task.txt`.** It stays as-is for any internal callers that might still reference it (tests, plugin shims). Wave 5 only adds to `agent-spawn.txt` if substantive content needs to migrate.

9. **`shell.txt` is heavily templated; `exec-command.txt` is static.** `shell.txt` uses ~10 placeholders (`${intro}`, `${os}`, `${shell}`, `${tmp}`, `${workdirSection}`, `${commandSection}`, `${gitCommands}`, `${toolName}`, `${gitCommandRestriction}`, `${createPrInstruction}`, `${createPrExample}`) substituted by `ShellPrompt.render(name, platform, limits)` in `tool/shell/prompt.ts:275-293`. The substitution profile differs per shell kind (bash/pwsh/cmd) — see `profile()` at `prompt.ts:226-273`. The git-safety / PR-creation blocks the migration targets (lines 13-77) reference SEVERAL of these placeholders, not just `${toolName}`. Option A1 (direct concatenation) requires substituting EVERY placeholder before saving the migrated text into `exec-command.txt`. Pick a single profile (bash on the host platform) and substitute against it — `exec_command` doesn't have the per-shell rendering machinery and isn't going to grow it for this campaign. Document the chosen profile in NOTES.md so Wave 6's snapshot-diff knows which baseline to compare against. Option A2 (shared module) sidesteps this by extracting the migrated blocks BEFORE substitution into `tool/shared/shell-prose.ts` exporting raw template strings; both renderers (one bash-only for `exec_command`, the existing per-shell for `shell`) can then substitute as they need. A2 is the cleaner long-term shape but adds a new module; pick A1 for surgical change, A2 if the file proliferation is worth it.

## Verification

```bash
cd packages/opencode

bun typecheck
bun lint

# differential
bun test test/differential/prompt-prose.diff.test.ts

# integration invariants
bun test test/integration/tool-surface-replacement.test.ts

# perf + token budget
bun test ./test/perf/prompt-render.bench.ts
test -f ../../.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf/wave_5.json

# coverage 100% on touched (likely no source files modified — text only)
# Skip coverage if no .ts file changed in src/
```

All exit 0.

## Files

New:
- `packages/opencode/test/differential/prompt-prose.diff.test.ts`
- `packages/opencode/test/perf/prompt-render.bench.ts` (if not extending)
- `.wave/campaigns/replace-bash-task-2026-05-15/artifacts/perf/wave_5.json`
- (optional) `packages/opencode/src/tool/shared/shell-prose.ts` if Sub-agent A picks option A2

Modified:
- `packages/opencode/src/tool/process/exec-command.txt` (substantive content addition)
- (possibly) `packages/opencode/src/tool/agent-spawn/agent-spawn.txt`
- (possibly) `packages/opencode/src/tool/process/prompt.ts` (template wiring)
- `packages/opencode/test/integration/tool-surface-replacement.test.ts` (4 invariants unskipped)
