# Multi-agent delivery findings

**Date**: 2026-05-19
**Session diagnosed**: `ses_1c2e8d84affeZ7t5g5LKveGDTo` ("Cidoo ABM066 firmware availability")
**Status**: Investigation only. No code/prompt changes made.

A subagent did a long research run, emitted a thorough markdown report as its final assistant text, called `close_agent` in the SAME message, and the parent received none of the report. Parent had to respawn a second agent with explicit `CRITICAL: use send_message` instructions to recover. Root cause is a contract mismatch between the subagent prompts (which imply "your text response is the deliverable") and the auto-extractor in `control.ts` (which silently skips any assistant message ending in a tool call). The user's diagnosis: prompts were written before the Wave-12 multi-agent v2 work landed and never updated to reflect how delivery actually happens now.

This file is a self-contained handoff for a fresh chat to fix it without re-deriving discovery.

---

## 1. The agent paradigm (what's actually wired up right now)

We have two surfaces working together: the v2 multi-agent tool set and the per-spawn lifecycle in `AgentControl`. They were ported from `openai/codex-cli`'s `multi_agent_v2` in May 2026 (see `PROMPT_ITERATIONS/2026-05-13-multi-agent-and-tool-overhaul.md` for the full history).

### Roles

- **Root agent** — the user-facing session. `mode !== "subagent"`. Sees `multi-agent-root.txt` capability hint if `spawn_agent` is permitted.
- **Subagent** — spawned via `spawn_agent`. `mode: "subagent"`. Lives at a canonical path like `/root/<task_name>` (up to depth 4: `/root/a/b/c/d`). Sees `multi-agent-subagent.txt` capability hint if `send_message` or `wait_agent` is permitted.

### Six-tool API (all in `src/tool/agent-*/`)

| Tool | Effect | Wakes recipient? |
|---|---|---|
| `spawn_agent` | Fork a child, return immediately with `task_name` + nickname | n/a |
| `send_message` | Queue mail to a peer (FYI / status / context) | No |
| `followup_task` | Queue mail to a peer (next assignment) | Yes |
| `wait_agent` | Block until ANY mailbox update arrives (or timeout) | n/a |
| `list_agents` | Snapshot of every live agent | n/a |
| `close_agent` | Release a slot. Cascades to descendants. | n/a |

All six share a single permission key: `task` (post-Wave-3 collapse; legacy `permission.spawn_agent: ...` rules silently stop matching — see `src/tool/agent-spawn/agent-spawn.ts:20-26`).

### Mailbox semantics

- Each agent has a per-session mailbox in `src/agent/mailbox.ts`.
- Mail is drained automatically at the START of every turn (in `src/session/prompt.ts:1451-1502`). Drained items become `synthetic: true` text parts on the next user message, prefixed `[from <author>]:`.
- `wait_agent` returns a SUMMARY string (`"Wait completed."` / `"Wait timed out."`) — NOT the mail body. The mail body shows up on the NEXT turn.
- `trigger_turn: true` (followup_task) wakes the recipient; `trigger_turn: false` (send_message) just queues.

### Spawn completion notification (the bug surface)

When a subagent's status flips to a terminal value (`completed` / `errored` / `shutdown`), a watcher fiber in `src/agent/control.ts:695-762` posts a synthetic mail to the parent that looks like:

```
Agent /root/<child_path> reached status: <label>
<auto-extracted body>
```

The body comes from `sessions.findMessage(child.id, predicate)` walking newest-first, with this predicate at `control.ts:712-716`:

```ts
(m) =>
  m.info.role === "assistant" &&
  typeof m.info.finish === "string" &&
  m.info.finish !== "tool-calls"
```

Then the matching message's text parts are joined: `msg.parts.filter(p => p.type === "text").map(p => p.text).join("\n").trim()`.

**This is where the bug lives.** Any final assistant message that ALSO contains a tool call gets `finish: "tool-calls"` and is silently skipped. The extractor then walks back to an older or newer message that has `finish: "stop"`, which is usually the model's "wrap up" / cleanup line, not the deliverable.

---

## 2. The session that demonstrated it

Parent session: `ses_1c2e8d84affeZ7t5g5LKveGDTo` — "Cidoo ABM066 firmware availability"

Two children spawned, both `agent_type: general`:
- `ses_1c2c9038bffeqepmLF6BTZfnFV` — `/root/abm066_qk61_diff` (nickname: euler)
- `ses_1c2c5e13cffeFWcdHguk55XPos` — `/root/abm066_hw_diff` (nickname: plato)

### Euler's failure

1. Did 8 turns of websearch/webfetch research.
2. Turn 9 (msg `msg_e3d387ca9001jyyCvYHiaFgjlg`, `finish: "tool-calls"`): emitted the full ~5 KB markdown report as text, then called `close_agent target="/root/general"` in the same step.
3. `close_agent` failed: `Cannot resolve agent reference '/root/general': live agent path '/root/general' not found`. The model used its `agent_type` value (`general`) where it should have used its canonical path (`/root/abm066_qk61_diff`).
4. Turn 10 (msg `msg_e3d394da6001qsMGgYfOT4ISqR`, `finish: "stop"`): just text — `"Report delivered to parent. No close needed — parent will manage."` The model rationalised the close failure as success.
5. Auto-extractor walked newest-first, skipped turn 9 (`finish: "tool-calls"`), grabbed turn 10's text.
6. Parent's mailbox received:
   ```
   [from /root/abm066_qk61_diff]: Agent /root/abm066_qk61_diff reached status: completed

   Report delivered to parent. No close needed — parent will manage.
   ```
   The actual 5 KB report was never transmitted.

### Parent's reaction

The parent (root) recognised the failure in reasoning at `msg_e3d397288001LJF6BEI3wRymYw`:
> "the agent only sent a status notification rather than its actual findings. The message says 'Report delivered to parent' but there's no actual research content included… clear failure. I need to close it out and respawn with more explicit instructions to send_message the actual findings before completing."

Then spawned plato with explicit `CRITICAL: You MUST deliver your findings by calling send_message to your parent BEFORE you finish your turn.` Plato called `send_message` correctly at `1779143736697` — but the parent session ended ~6 seconds before that, so even the workaround report didn't make it through.

### Re-derive this trace yourself

Sessions live in SQLite, not on disk:
```bash
sqlite3 ~/.local/share/opencode/opencode.db
```

Useful tables: `session`, `message`, `part`. Tool calls are stored as parts where `json_extract(data, '$.type') = 'tool'` with the tool name at `'$.tool'` and the call status at `'$.state.status'`. Synthetic drained mail shows up on user messages with `json_extract(data, '$.synthetic') = 1`.

Key queries used during diagnosis:

```sql
-- parent and its children
SELECT id, parent_id, path, agent, title FROM session
WHERE id = 'ses_1c2e8d84affeZ7t5g5LKveGDTo'
   OR parent_id = 'ses_1c2e8d84affeZ7t5g5LKveGDTo';

-- multi-agent tool calls on the parent
SELECT message_id, json_extract(data, '$.tool') FROM part
WHERE session_id = 'ses_1c2e8d84affeZ7t5g5LKveGDTo'
  AND json_extract(data, '$.tool') IN (
    'spawn_agent','send_message','followup_task',
    'wait_agent','list_agents','close_agent'
  )
ORDER BY time_created;

-- finish reasons across the child's messages
SELECT id, json_extract(data, '$.role'), json_extract(data, '$.finish'), time_created
FROM message WHERE session_id = '<child_id>' ORDER BY time_created;

-- synthetic mail the parent drained
SELECT message_id, substr(json_extract(p.data, '$.text'), 1, 400)
FROM part p
WHERE session_id = '<parent_id>'
  AND json_extract(p.data, '$.synthetic') = 1
ORDER BY time_created;
```

Schema reference: `packages/opencode/src/**/*.sql.ts` (Drizzle). Migration command: `bun run db generate --name <slug>` from `packages/opencode/`.

---

## 3. How the subagent's system prompt is composed (right now)

### Assembly order

The composed system prompt that goes to the model is built in two places, in this order:

**(a)** `src/session/llm.ts:103-116` — adds `system[0]`:
```ts
const agentPrompt = Agent.resolvePrompt(input.agent, input.model)
system.push(
  [
    ...(agentPrompt ? [agentPrompt] : SystemPrompt.provider(input.model)),
    ...input.system,                     // ← from prompt.ts below
    ...(input.user.system ? [input.user.system] : []),
  ].filter(x => x).join("\n"),
)
```

**(b)** `src/session/prompt.ts:1766-1779` — builds `input.system`:
```ts
const [skills, env, instructions, modelMsgs, hints] = yield* Effect.all([
  sys.skills(agent),
  sys.environment(model),
  instruction.system().pipe(Effect.orDie),
  MessageV2.toModelMessagesEffect(msgs, model),
  sys.capabilityHints(agent),
])
const system = [...env, ...instructions, ...(skills ? [skills] : []), ...hints]
```

So the final concatenated prompt order is:

```
1. agent.prompt           ← agent-specific role voice (explore.txt, general/anthropic.txt, or user-defined)
2. environment            ← cwd, model id, platform, today's date, git status
3. instructions           ← aggregated AGENTS.md from project tree
4. skills (if any)        ← Skill.fmt(list, { verbose: true })
5. capability hints       ← appended LAST, gated on effective permissions
6. user.system (if any)   ← per-call addendum
```

### Capability hint dispatcher

`src/session/system.ts:101-116`. Three hints, three gating rules:

| File | Injected when |
|---|---|
| `src/agent/prompt/persistent-processes.txt` (34 lines) | `permitted(agent, "exec_command")` |
| `src/agent/prompt/multi-agent-root.txt` (72 lines) | `agent.mode !== "subagent"` AND `permitted(agent, "spawn_agent")` |
| `src/agent/prompt/multi-agent-subagent.txt` (37 lines) | `agent.mode === "subagent"` AND (`permitted(agent, "send_message")` OR `permitted(agent, "wait_agent")`) |

`permitted` here means `Permission.evaluate(key, "*", agent.permission).action !== "deny"` — so `ask` still injects the fragment.

The root and subagent hints are mutually exclusive: a root never sees subagent guidance, a subagent never sees root guidance (even if it has `spawn_agent` itself — depth-2+ subagents that can spawn still operate under subagent rules).

### Agent-specific prompts (the bottom layer)

Resolved by `Agent.resolvePrompt(agent, model)` in `src/agent/agent.ts:519-530`:

```ts
export function resolvePrompt(agent: Info, model: { api: { id: string } }) {
  if (agent.prompt) return agent.prompt
  if (agent.name === "general" && agent.native) {
    if (model.api.id.includes("claude")) return PROMPT_GENERAL_ANTHROPIC
    return PROMPT_GENERAL_GEMINI
  }
  return undefined  // falls back to SystemPrompt.provider(model)
}
```

Native agents and their prompts (registered in `src/agent/agent.ts:155-329`):

| Agent | `mode` | `prompt` source |
|---|---|---|
| `build` | primary | undefined → provider prompt (e.g. `session/prompt/anthropic.txt`) |
| `plan` | primary | undefined → provider prompt + plan-reminder |
| `general` | subagent | `agent/prompt/general/anthropic.txt` (119 lines) OR `agent/prompt/general/gemini.txt` (130 lines) |
| `explore` | subagent | `agent/prompt/explore.txt` (106 lines) — fixed, not model-routed |
| `compaction` / `title` / `summary` | primary, hidden | dedicated short prompts |

User-defined custom agents are loaded by `Agent.Service.list()` from config — they set their own `prompt` and `mode`.

Provider prompts (the fallback) are in `src/session/prompt/` and selected by `SystemPrompt.provider(model)` at `src/session/system.ts:24-38` via substring match on the model id: `gpt-4`/`o1`/`o3` → beast.txt, `gpt` → gpt.txt (or codex.txt if id contains `codex`), `gemini-` → gemini.txt, `claude` → anthropic.txt, `trinity` → trinity.txt, `kimi` → kimi.txt, else default.txt.

### What an explore subagent actually sees

For a `claude-*` model with default permissions, the final system prompt is:

1. `src/agent/prompt/explore.txt` — read-only research voice, caveman output rules, "ALL file paths must be absolute… Your response is consumed by another agent, not a human."
2. Environment block.
3. AGENTS.md aggregation.
4. Skills list.
5. NOT `persistent-processes.txt` (explore has `exec_command` denied via `*: deny`).
6. `src/agent/prompt/multi-agent-subagent.txt` — operational manual for the six-tool surface.

`explore.txt` is fully intact. The capability hint just appends.

### What a general subagent (like euler) actually saw

For `claude-opus-4-7`:

1. `src/agent/prompt/general/anthropic.txt` (119 lines) — "You receive tasks from a parent agent, execute them, and report results back. The parent agent — not the user — reads your output. […] Your response goes to the parent agent, not the user. Provide a terse report…"
2. Environment block.
3. AGENTS.md aggregation.
4. Skills.
5. `src/agent/prompt/persistent-processes.txt` (general has `exec_command: allow`).
6. `src/agent/prompt/multi-agent-subagent.txt`.

---

## 4. The contradiction

Three prompt surfaces all reinforce the same broken mental model: "your text response IS the deliverable."

**`src/agent/prompt/general/anthropic.txt:1`**
> "You receive tasks from a parent agent, execute them, and report results back. The parent agent — not the user — reads your output."

**`src/agent/prompt/general/anthropic.txt:46-53`** ("Response format")
> "Your response goes to the parent agent, not the user. Provide a terse report of what was done or found. […] Include relevant code snippets — the parent may not re-read the files."

**`src/agent/prompt/explore.txt:1, 47-56`**
> "You search, read, and analyze codebases, websites, and documentation. You report findings to a parent agent, not directly to a user. […] Your response is consumed by another agent, not a human. […] Text only: Communicate findings in your response text."

**`src/agent/prompt/multi-agent-subagent.txt:37`** ("Final answer")
> "Your last assistant message before close (or before going idle) is what the spawner sees as your 'result'. Make it self-contained: state the deliverable, link the artifacts (file paths with line numbers, function names, exact values), and flag anything that blocked or surprised you."

None of these say:
- "Call `send_message` (or `followup_task`) to deliver your result. Do not rely on your final text being read."
- "If your final assistant message also contains a tool call (any tool — including `close_agent`), its `finish` reason becomes `tool-calls` and the auto-extractor will SKIP that message and surface an older or newer one instead."
- "Your canonical path is `/root/<task_name>`. Use that, not your `agent_type`, when calling `close_agent` on yourself."

The auto-extractor at `src/agent/control.ts:709-728` was added (Wave 12) as a convenience so subagents that forget to `send_message` still deliver something. It works for the simple shape "write report, stop". It silently breaks the natural shape "write report, close myself" because emitting any tool call sets `finish: "tool-calls"` on that message.

The prompts predate the auto-extractor and were never updated to teach the model about the actual extraction predicate.

---

## 5. Failure modes observed in this session

In severity order:

1. **(Critical) Extractor / prompt contract mismatch.** Model bundles "final text + close_agent" in one assistant step → message gets `finish: "tool-calls"` → extractor skips it → trivial cleanup message in the next step becomes the deliverable. See `src/agent/control.ts:709-728`.

2. **(High) `close_agent` self-target is path-fragile.** Subagent used `/root/general` (its `agent_type`) instead of `/root/abm066_qk61_diff` (its canonical path). There is no first-class "close self" form and nothing in the system prompt or `close_agent` description tells the child what its own canonical path is. The path appears only in the result of `list_agents` or in `[from /root/...]:` mail headers.

3. **(High) Tool error → false success rationalisation.** When `close_agent /root/general` failed with `Cannot resolve agent reference 'X': live agent path 'X' not found`, the model wrote `"Report delivered to parent. No close needed — parent will manage."` That sentence then became the only deliverable. The error message doesn't make it obvious that the close didn't happen and the model treated the failure as confirmation.

4. **(Medium) No "empty deliverable" guard.** Nothing checks whether the auto-extracted body looks plausibly like a real deliverable vs. a status string. The parent had to manually notice and respawn.

5. **(Medium) Wave-12 hints conflict with pre-Wave-12 base prompts.** Capability hints are appended LAST, so they should be authoritative on coordination. But neither hint contradicts the older base prompts' framing that "your text response is the deliverable." Both layers agree on the broken model. The user's diagnosis is that base prompts predate v2 multi-agent and were never updated.

6. **(Low) Race between completion notification and pending sends.** Plato's `send_message` arrived ~6 s after the parent's final action. Plato had been spawned, completed its work, and posted its mail — but the parent session ended before the mail was drained. The session lifecycle doesn't wait for in-flight mail from in-flight children to land before allowing root to finish.

---

## 6. File index for fixes

### Prompts to revise

```
src/agent/prompt/multi-agent-subagent.txt        ← rewrite "Final answer" section (line 35-37)
src/agent/prompt/multi-agent-root.txt            ← update "Mailbox semantics" + "After you delegate"
src/agent/prompt/general/anthropic.txt           ← lines 1, 46-53 ("Response format")
src/agent/prompt/general/gemini.txt              ← same shape as anthropic.txt
src/agent/prompt/explore.txt                     ← lines 1, 47-56 ("Response Format")
src/agent/prompt/persistent-processes.txt        ← not directly affected
```

### Tool descriptions to revise

```
src/tool/agent-spawn/agent-spawn.txt             ← description embedded as .txt file
src/tool/agent-send/agent-send.ts                ← description inline
src/tool/agent-followup/agent-followup.ts        ← description inline
src/tool/agent-wait/agent-wait.ts                ← description inline
src/tool/agent-list/agent-list.ts                ← description inline
src/tool/agent-close/agent-close.ts              ← description inline (self-close rule)
```

### Code surfaces to consider changing

```
src/agent/control.ts:695-762                     ← spawn completion watcher + auto-extractor
src/agent/control.ts:709-728                     ← the predicate that skips finish="tool-calls"
src/session/system.ts:101-116                    ← capabilityHints dispatcher
src/session/llm.ts:103-116                       ← agent prompt vs provider prompt routing
src/session/prompt.ts:1766-1779                  ← final system prompt assembly
src/session/session.ts:772-780                   ← findMessage (newest-first)
src/session/message-v2.ts:1090-1102              ← stream (newest-first paging)
```

### Tests that exercise current behaviour

```
src/tool/agent-spawn/agent-spawn.test.ts
src/tool/agent-send/agent-send.test.ts
src/tool/agent-followup/agent-followup.test.ts
src/tool/agent-wait/agent-wait.test.ts
src/tool/agent-list/agent-list.test.ts
src/tool/agent-close/agent-close.test.ts
src/agent/control.test.ts                        ← end-to-end completion notification tests
src/agent/mailbox.test.ts                        ← mailbox seq + drain semantics
src/agent/inter-agent-communication.test.ts     ← message schema
test/session/system-backward-compat.test.ts      ← system prompt assembly invariants
```

### Related historical / spec docs

```
PROMPT_ITERATIONS/2026-05-13-multi-agent-and-tool-overhaul.md   ← origin story
specs/codex-parity.md                                            ← upstream parity surface
specs/replace-bash-task.md                                       ← Wave-3 permission collapse
WAVES.md                                                         ← campaign tracker
GOTCHAS.md                                                       ← surface-by-surface gotchas index
AGENTS.md                                                        ← repo conventions
packages/opencode/AGENTS.md                                      ← Drizzle / Effect / module rules
```

---

## 7. Fix design space (do NOT implement without discussion)

Three orthogonal levers, any combination of which would address the failure:

### A. Change the extractor to match the prompts

Make `control.ts:709-728` find the most recent assistant message that has ANY non-trivial text, regardless of `finish` reason. Filter out tool parts when extracting the body. Fallback: walk older messages if the newest has no text or only contains text that looks like a status line.

- Pro: model's natural pattern ("write report, then close") just works.
- Con: now the extractor may pick up text from a message that ALSO included tool calls, mixing intermediate reasoning with the deliverable. Harder to predict for the model.
- Risk: silently changes the contract for every existing subagent.

### B. Change the prompts to match the extractor

Rewrite `multi-agent-subagent.txt` "Final answer" section + the base prompts to be explicit:
- "Deliver your result via `send_message` or `followup_task` to your spawner. Your text alone may not reach them."
- Or: "Your final assistant message must NOT contain any tool calls. Emit your deliverable as text, then in a separate next step call `close_agent` if you want to free the slot."

- Pro: keeps the extractor's invariants simple. Doesn't change behaviour for working agents.
- Con: requires the model to remember to do an extra round-trip (deliver, then close). Easy to forget under context pressure.

### C. Add a safety net

When a subagent reaches a terminal status, check whether (a) it ever called `send_message`/`followup_task` to its spawner AND (b) the auto-extracted body is non-trivial. If neither, prepend a warning to the parent's mail:
```
⚠️ Child terminated without calling send_message/followup_task and auto-extracted body is suspiciously short. Last assistant text follows:
```

- Pro: degrades gracefully, alerts the parent, no behaviour change for working agents.
- Con: doesn't fix the underlying contract — just makes failures visible.

### Additional independent fixes

1. **Inject canonical path into the subagent's system prompt.** Add a line in `capabilityHints` or `llm.ts` like `"You are operating as /root/<task_name>. To close yourself: close_agent target='/root/<task_name>'."` Eliminates the `agent_type` ↔ canonical-path confusion.

2. **Allow `close_agent target="self"` or `close_agent` with no target.** First-class self-close form so the model doesn't need to remember its own path.

3. **Improve `close_agent` error message.** When the target doesn't resolve, suggest the most-likely intended path (the caller's own canonical path, or the nearest alive sibling). Right now it just says `live agent path 'X' not found`.

4. **Hold root session open for in-flight child mail.** When root is about to end its turn and a child has pending state changes / un-drained mail, drain first.

---

## 8. Cross-reference: where I learned each thing

| What | Where I saw it |
|---|---|
| Session storage moved to SQLite | `~/.local/share/opencode/opencode.db` (file-based `session_diff/*.json` is empty stub) |
| Schema | `sqlite3 opencode.db ".schema session"` → see Section 2 |
| Tool calls stored as `part` rows | `select json_extract(data, '$.tool') from part where ...` |
| Auto-extractor logic | `src/agent/control.ts:695-762` |
| `findMessage` is newest-first | `src/session/session.ts:771-780` + `src/session/message-v2.ts:1090-1102` |
| Capability hint dispatcher | `src/session/system.ts:101-116` |
| Agent registry and per-agent permissions | `src/agent/agent.ts:155-329` |
| Final system prompt assembly | `src/session/llm.ts:103-116` + `src/session/prompt.ts:1766-1779` |
| Wave-3 permission collapse onto `task` key | `src/tool/agent-spawn/agent-spawn.ts:20-26` |
| Plato actually called send_message correctly | `select * from part where session_id='ses_1c2c5e13cffeFWcdHguk55XPos' and json_extract(data,'$.tool')='send_message'` |
| Euler's failed self-close used wrong path | `select * from part where id='prt_e3d394992001h8C0tXVHBzd7ed'` |
| Parent's recovery reasoning | `select * from part where message_id in ('msg_e3d397288001LJF6BEI3wRymYw','msg_e3d39ce2d001KK4UuE9tbxHQP3') and json_extract(data,'$.type')='reasoning'` |

---

## 9. Quick start for a fresh chat

```bash
# Re-read the diagnostic session
sqlite3 ~/.local/share/opencode/opencode.db <<EOF
.headers on
.mode column
SELECT id, parent_id, agent, title FROM session
WHERE id = 'ses_1c2e8d84affeZ7t5g5LKveGDTo'
   OR parent_id = 'ses_1c2e8d84affeZ7t5g5LKveGDTo';
EOF

# Open the prompts that need revising
$EDITOR packages/opencode/src/agent/prompt/multi-agent-subagent.txt \
        packages/opencode/src/agent/prompt/general/anthropic.txt \
        packages/opencode/src/agent/prompt/general/gemini.txt \
        packages/opencode/src/agent/prompt/explore.txt

# Open the extractor + assembly code
$EDITOR packages/opencode/src/agent/control.ts \
        packages/opencode/src/session/system.ts \
        packages/opencode/src/session/llm.ts \
        packages/opencode/src/session/prompt.ts

# Tests to run after changes (from packages/opencode/, not repo root)
cd packages/opencode
bun test src/agent/control.test.ts
bun test src/tool/agent-spawn src/tool/agent-send src/tool/agent-followup \
         src/tool/agent-wait src/tool/agent-list src/tool/agent-close
bun typecheck
```

The user's framing: "this was a failure to prompt correctly." Base prompts (`explore.txt`, `general/anthropic.txt`, plus the parent base prompts) and even `multi-agent-subagent.txt` were written before the auto-extractor + v2 multi-agent surface stabilised. They never got reconciled. Fix-up should align all surfaces on a single delivery contract before any extractor changes.
