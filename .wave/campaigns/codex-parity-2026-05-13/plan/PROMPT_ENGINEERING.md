# Prompt engineering — what the model needs to know, and where

Opencode was built with a smaller tool surface and a sequential subagent model. This campaign adds:

- a persistent-process tool family (`exec_command`, `write_stdin`)
- a six-tool concurrent multi-agent surface (`spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `list_agents`, `close_agent`)
- a mailbox-based cross-agent messaging primitive
- new agent roles (`explorer`, `worker`) with operational rules

None of opencode's existing prompts mention any of this. Models prompted with the existing system prompt would see the new tools and have no idea how to wield them well. **This is a real risk to product quality and is the bulk of the prompt-engineering work in this campaign.**

This doc covers two things:

1. **Tool descriptions** — the prose attached to each tool definition, surfaced to the model in the function-calling schema
2. **System prompt fragments** — separate developer-role messages injected into agent system prompts that give cross-cutting operational guidance

## Tool descriptions — discipline

Each tool description is a mini-manual. The model reads it once per tool, every turn. It must:

### Cover the operational decision

The hardest decisions are *when* to use a tool and *when not to*. A description that says "this spawns an agent" without addressing the decision boundary is failure. Codex's `spawn_agent_tool_description_v2` (`multi_agents_spec.rs:659-697`) is the model. It teaches:
- planning before delegating (decide what's blocking vs sidecar)
- when to keep work local (immediate-blocking critical path)
- how to scope delegated tasks (concrete, bounded, well-defined)
- after-delegation conduct (don't sit on `wait_agent`; do parallel local work)
- parallel patterns (independent info-seeking, disjoint code slices, verification in parallel)

Every tool in this campaign needs the equivalent operational layer. Sketches in `TOOL_SCHEMAS.md`; final prose is yours.

### Cover failure and ambiguity modes

The description must tell the model what to do when:
- the tool errors (param invalid, target not found, depth exceeded, etc.)
- the result is ambiguous (e.g. `wait_agent` returned `timed_out: true` — keep working or try again?)
- the tool's preconditions fail (e.g. `write_stdin` to a non-tty session — re-spawn)

### Cover the cost model

Every tool has a cost. Models don't budget unless told to. Mention:
- `spawn_agent`: each spawned agent makes its own LLM calls — cost multiplies
- `wait_agent`: blocks productive work — only when you're actually blocked
- `exec_command`: persistent processes hold a slot in a 64-cap pool — close what you don't need
- `followup_task`: keeps a child's context warm — preferred over fresh spawn for related work

### Avoid hedging and marketing

- ❌ "Optional but highly recommended for best performance"
- ❌ "This powerful tool enables the agent to..."
- ❌ "May be useful when..."
- ✅ "Use when N parallel research questions are independent. Don't use when you need the answer for your immediate next step."

### Keep length proportional to complexity

- `exec_command`: ~30-50 lines of prose. Big surface, many decisions.
- `write_stdin`: ~20-30 lines. Smaller surface, fewer decisions.
- `spawn_agent`: ~60-90 lines. Largest decision surface in the campaign.
- `send_message` / `followup_task`: ~15-25 lines each. Small surface, sharp distinction needed between them.
- `wait_agent`: ~15-25 lines. Important to teach when NOT to call.
- `list_agents`: ~10-15 lines. Mostly self-evident; cover when to filter.
- `close_agent`: ~10-15 lines. Cover the "close descendants too" semantics.

If your description is under the floor, you're under-teaching. If it's over the ceiling, you're over-talking. Tune.

### Param descriptions matter too

Each parameter in the JSON schema gets a `description` field. These are read by the model when it builds the call. Don't leave them as one-word labels.

```json
"task_name": {
  "type": "string",
  "description": "Lowercase letters, digits, and underscores only. Becomes the leaf component of the canonical path: if your path is /root/explorers, task_name=worker_a yields /root/explorers/worker_a. Pick names that mean something — they show up in list_agents and you'll reference them later."
}
```

vs:

```json
"task_name": {
  "type": "string",
  "description": "Task name."
}
```

The first teaches; the second labels. Always teach.

## Agent system prompts — making the agents themselves aware

Tool descriptions cover individual tools. Cross-cutting operational guidance (how to think about coordination, when to spawn vs do-it-yourself at the agent-mode level, the nature of concurrent work) belongs in the agent system prompt itself.

### Where these fragments go

`packages/opencode/src/session/system.ts` (read this in Wave 12) provides `sys.environment(model)` and `sys.skills(agent)`. The runLoop assembles the system message at `prompt.ts:1591-1597`:

```ts
const system = [...env, ...instructions, ...(skills ? [skills] : [])]
```

`instruction.system()` provides the user's `AGENTS.md` content. We add new fragments at the env or instructions layer, gated on whether the agent has the relevant tools enabled.

### Required new system fragments

Three fragments, each a separate developer-role string injected into the system messages of agents that have the corresponding tools available:

**Fragment 1: "Persistent processes guidance"** (injected when the agent has `exec_command` permission)
- Distinction between `shell` (one-shot) and `exec_command` / `write_stdin` (persistent)
- When to reach for persistent processes (REPLs, dev servers, file watchers, interactive db shells, ssh)
- When to stick with `shell` (single commands, scripts, things that exit)
- Hygiene: pure-poll discipline (5s floor, don't spam), session_id tracking across turns, expectation that processes die when opencode restarts

**Fragment 2: "Multi-agent root-agent guidance"** (injected when the agent is a primary mode AND has multi-agent v2 tools)
- Mental model: you're the root; spawned agents are concurrent siblings working in parallel
- Decision protocol BEFORE spawning (what's blocking vs sidecar)
- Don't delegate the immediate critical path
- Common patterns (parallel research, disjoint codebase slices, debate, observer/worker)
- Mailbox semantics (you receive messages from siblings; they appear in your next turn's context)
- Don't sit on `wait_agent` — do useful local work
- The role system (when to pick `default` vs `explorer` vs `worker`)

**Fragment 3: "Multi-agent subagent guidance"** (injected into spawned subagents when multi-agent v2 is enabled)
- You're a subagent — your task is bounded
- The path you live at (`/root/...`) and your role
- You can spawn your own subagents but recursion has a depth limit
- You can message peers via `send_message` / `followup_task`
- You can `close_agent` yourself if your work is done — don't hold the slot
- Your final assistant message goes to your spawner

These mirror codex's `multi_agent_v2.root_agent_usage_hint_text` and `multi_agent_v2.subagent_usage_hint_text` (from `session/multi_agents.rs`). Codex makes these user-configurable; ours can ship with strong defaults and accept config overrides if user demands.

### Wave coverage

- Wave 3 produces the unified_exec tools — its tool descriptions cover Fragment 1's tool-level material
- Wave 8 produces the multi-agent tools — their tool descriptions cover the per-tool decisions
- Wave 12 produces the cross-cutting system fragments and wires them into agent prompt assembly
- Wave 12 also updates each built-in agent's `prompt` field where appropriate (e.g. `general`, `build` get the multi-agent guidance; `explore` gets a subagent-flavored variant)

## Built-in agent prompts

Each built-in agent in `agent/agent.ts:113-238` may already have a `prompt` field (e.g. `explore` uses `PROMPT_EXPLORE` from `agent/prompt/explore.txt`). Wave 12 extends these:

- `build`: gains awareness that it can spawn workers, message them, close them when done; learns when to use unified_exec
- `general`: same multi-agent awareness; remains the parallel-fan-out specialist
- `explore`: gains awareness that it can be spawned by other agents and that it has `send_message`/`wait_agent` for coordination, but should not spawn agents itself (read-only-ish role)
- `plan`: gains awareness that it can spawn explorers + general agents during phase 1/2 (already does via `task` — the prompt mentions it; needs updating to use `spawn_agent` instead, as a v2 path)

Each modified prompt is a *strict superset* of the existing prompt — backward compatible, no removed guidance.

## What "expert-level prompt engineering" means here

Three tests for the work:

1. **A model with no codex training transfer should still use the tools well.** If the description only works because the model has prior codex exposure, the description is under-engineered.

2. **A reader who has never used codemaxxxing can read your description and predict the behavior.** If the prose is full of references to internal concepts the user can't see ("`AgentControl`", "`InstanceState`"), it's leaking implementation details.

3. **The descriptions teach the operational discipline, not just the surface.** The model should know when NOT to use a tool, not just when it can. A description that only covers "what" is a label. A description that covers "what + when + when-not + how-to-recover" is a manual.

## Cross-reference: existing prompt assets

Read these before writing any new prompt prose to match house tone:

- `packages/opencode/src/agent/prompt/explore.txt` — explore subagent operational rules (parallel pattern teaching)
- `packages/opencode/src/agent/prompt/general/anthropic.txt` — Anthropic-flavor general agent prompt
- `packages/opencode/src/agent/prompt/general/gemini.txt` — Gemini-flavor general agent prompt
- `packages/opencode/src/agent/prompt/compaction.txt`, `summary.txt`, `title.txt`
- `packages/opencode/src/session/prompt/plan.txt` — plan-mode multi-phase workflow (good model for structured prompt prose)
- `packages/opencode/src/tool/shell.ts` (parameters defined via `ShellPrompt.render` — see `packages/opencode/src/tool/shell/prompt.ts`)
- Codex tool descriptions you're matching the *quality bar* of, not the prose: `multi_agents_spec.rs:599-657` (v1 spawn_agent), `:659-697` (v2 spawn_agent)

## What to ship — the deliverable per tool

For every tool created in this campaign, the deliverable includes:

1. The tool's parameter JSON schema (CONSTANTS.md + TOOL_SCHEMAS.md spec the shape; you write the JSON)
2. The tool's description string (your prose, codex-quality, codemaxxxing voice)
3. Per-parameter description strings (your prose, teaching not labeling)
4. The tool's output schema (verbatim shape from codex; descriptions written by you)
5. Tests verifying the schema's structure (Wave for that tool covers this)
6. Tests verifying the description hits the operational points (snapshot test of key phrases or structural assertions)

For every system prompt fragment created in Wave 12:

1. The fragment text itself (your prose, fits codemaxxxing voice)
2. The injection logic (when it fires — gated on agent permission set)
3. Tests verifying it gets injected for the right agent modes and not for others
4. Tests verifying it's a strict superset of pre-existing prompts (no behavior removal)
