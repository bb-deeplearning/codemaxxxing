# Prompt Surfaces

Single source of truth for which prompt file owns which guidance. Prose waves consult this BEFORE editing to avoid duplicating or contradicting content across surfaces.

## File map

```
packages/opencode/src/agent/prompt/
├── multi-agent-root.txt        # Root agent guidance for multi-agent coordination
├── multi-agent-subagent.txt    # Subagent guidance + delivery contract
├── persistent-processes.txt    # PTY tools (exec_command / write_stdin) capability hint
├── general/
│   ├── anthropic.txt           # Claude general subagent base prompt
│   └── gemini.txt              # Gemini general subagent base prompt
├── explore.txt                 # Explore (read-only research) subagent base prompt
└── (other agent prompts as plan, build, etc. — out of scope)
```

## Assembly order (read this before editing)

Final system prompt for a subagent session, in order (from `session/llm.ts:103-116` + `session/prompt.ts:1766-1779`):

1. `agent.prompt` — agent base prompt (e.g. `general/anthropic.txt` for a Claude general agent).
2. `environment` — cwd, model id, platform, today's date, git status.
3. `instructions` — aggregated AGENTS.md from project tree.
4. `skills` (if any) — `Skill.fmt(list, { verbose: true })`.
5. `capability hints` — injected LAST, gated on effective permissions. The dispatcher at `session/system.ts:101-116` adds:
   - `persistent-processes.txt` if `exec_command` permitted.
   - `multi-agent-root.txt` if NOT subagent AND `spawn_agent` permitted.
   - `multi-agent-subagent.txt` if subagent AND (`send_message` OR `wait_agent` permitted).
6. `user.system` (if any) — per-call addendum.

**Implications for this campaign:**

- The delivery contract (D1) lives in `multi-agent-subagent.txt` — the LAST layer the subagent sees. Authoritative.
- The base prompts (`general/anthropic.txt`, `general/gemini.txt`, `explore.txt`) MUST NOT contradict the delivery contract. D4 defer-edits these so they remove the implicit "your text response IS the deliverable" framing and reference the contract by pointing to the hint.
- The canonical-path injection (D2) appends to `multi-agent-subagent.txt` per-spawn — done at the `capabilityHints` dispatcher, not in the .txt file itself.
- Mutual exclusion: `multi-agent-root.txt` and `multi-agent-subagent.txt` are never both rendered for a single session. Root never sees subagent guidance; subagent never sees root guidance (even if depth-2+ subagent has spawn permission, it still operates under subagent rules).

## Who owns what — content map

### `multi-agent-root.txt` (orchestrator-facing)

Owns:
- Mental model: "you are root; spawn returns immediately; siblings make parallel progress"
- "Decide BEFORE spawning" thinking discipline
- When to delegate / when NOT to delegate
- Scoping a delegated task
- After-you-delegate discipline (don't reflexively wait_agent)
- Mailbox semantics summary
- **(D7) Sibling coordination patterns** — unicast doctrine, three working patterns (CC / coordinator / followup_task), anti-pattern (wait-on-message-routed-elsewhere)
- **(D8) Limits of the actor model** — no broadcast, no sibling introspection, no deadlock detection, idle ≠ alive
- (D10 post-Wave-3) Mandatory-timeout doctrine for wait_agent
- Cost discipline

Does NOT own:
- Subagent delivery contract (lives in multi-agent-subagent.txt)
- Per-tool how-to (lives in tool descriptions)

### `multi-agent-subagent.txt` (subagent-facing)

Owns:
- Subagent context: "you live at a canonical path under /root; your spawner is your audience"
- Cross-agent messaging primitives summary (send_message / followup_task / wait_agent)
- "You can spawn too" (depth limit 4, same discipline applies)
- "Closing yourself" — when to close
- **(D1) Delivery contract** — literal tool-call sequence, "your text alone may not reach them", separate-step close
- **(D2 per-spawn injection) Your canonical path** — added by `capabilityHints` at render time, not in the .txt
- (D7-mirror) One sentence on unicast (longer treatment in root file)
- (D11 post-Wave-4) ABORT reasons catalog

Does NOT own:
- Orchestrator discipline (lives in multi-agent-root.txt)
- Tool-specific gotchas (lives in tool descriptions)

### `persistent-processes.txt`

Unchanged by this campaign. Reference only.

### `general/anthropic.txt` (Claude general subagent base)

Currently lines 1, 46-53 carry "the parent agent — not the user — reads your output" + "Provide a terse report... your response goes to the parent agent" framing. This IMPLIES text-is-deliverable; the capability hint then CONTRADICTS by saying "deliver via send_message."

D4 defer-edit:
- Line 1: change to neutral framing — "You receive tasks from a parent agent, execute them, and report results back per the delivery contract (see multi-agent coordination guidance in your capability hints)."
- Lines 46-53 (Response format section): replace with pointer to the delivery contract. Keep caveman output rules, absolute paths rule, code references, snippet inclusion rules — those don't conflict.

### `general/gemini.txt` (Gemini general subagent base)

Same shape as anthropic.txt. Same defer-edit pattern. Gemini may need slightly more prescriptive framing per iteration 3 LEARNINGS Observation 27, but the delivery contract content is identical.

### `explore.txt` (explore subagent base)

Lines 1, 47-56 carry similar "your response is consumed by another agent" framing. Same defer-edit pattern — point to delivery contract via hint, preserve the read-only enforcement section and caveman rules.

## Forbidden phrases (post-Wave-1)

After Wave 1 lands, NO subagent base prompt may contain these substrings (a `forbidden-prose` test in Wave 1 grep-asserts):

- "your text response IS the deliverable"
- "your response goes to the parent agent" (without "via send_message" qualifier)
- "the parent agent reads your output" (without "via send_message" qualifier)
- Any framing that implies the final assistant message text is the primary delivery mechanism

The delivery contract is the only authoritative source for delivery; base prompts MUST defer.

## Required phrases (post-Wave-1)

After Wave 1 lands, every subagent base prompt MUST contain a reference to the delivery contract:

- "See the delivery contract in your multi-agent coordination guidance." (or equivalent)

The capability hint provides the contract; the base prompt acknowledges its existence so the agent doesn't ignore the later layer.

## Editing discipline

When you edit any of these files:

1. Re-read PROMPT_SURFACES.md (this file) FIRST.
2. Confirm the edit belongs in the file you're editing per the ownership map.
3. If your edit duplicates content from another file, STOP — refactor instead.
4. If your edit contradicts another file's ownership, STOP — fix the conflict in the owning file, point to it from this one.
5. Run the `forbidden-prose` and `required-phrases` grep tests before committing.
6. If your edit changes the assembly behaviour (e.g. adds a new fragment to capabilityHints), update the "Assembly order" section above.

## Cross-reference

- D2 (canonical-path injection): `session/system.ts:101-116`. The dispatcher templates `/root/<task_name>` per-spawn.
- D7 (sibling coordination): the unicast invariant is also tested by `INV-D-06` in INTEGRATION_INVARIANTS.md.
- D8 (actor-model limits): no runtime enforcement; prose-only. Validated by reading-the-prose test in Wave 1.
- Forbidden-prose / required-phrases assertions: `packages/opencode/test/prose/subagent-prompts.test.ts` (new file in Wave 1).
