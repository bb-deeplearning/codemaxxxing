# Why waves instead of plan-and-build

The standard agentic workflow is: plan in one session, build in the same session (or the next one). This works for small tasks. For anything that takes more than 20-30 minutes of agent time, it falls apart.

## The context window problem

Two things go wrong as a session grows, and they compound each other.

**The window is not a notebook.** It's a sliding window. As a session grows, early details get compacted or evicted entirely. The agent loses the precise context it needs — file paths blur, constraints disappear, earlier decisions get contradicted.

- **Early details rot.** The agent read a file at the start. By the time it matters, the agent's memory of it is shallow or wrong.
- **Compaction makes knowledge lossy.** The model's internal summary of what happened 50 tool calls ago is not the same as actually knowing what happened.
- **Late-stage errors compound.** When something breaks at step 40, the agent doesn't have the context from step 5 that would explain why. It guesses. It guesses wrong.

**The model itself gets worse as context fills up** — even before anything gets evicted. Transformers attend over the full sequence for every token they generate. As that sequence grows, attention becomes diluted. The model is less precise about which details matter, less reliable at following constraints stated earlier, more likely to hallucinate or contradict itself. Research on long-context retrieval consistently shows accuracy drops in the middle of long contexts ("lost in the middle"), and instruction-following quality declines as the prompt-to-completion ratio shifts. A model at 30k tokens is genuinely a better reasoner than the same model at 150k tokens — not because it forgot something, but because it's spread thinner.

These aren't separate problems. A long session both evicts old context and degrades the model's ability to use whatever context remains. Bigger context windows don't fix this — they just delay the eviction while the attention dilution continues to build from the start.

## What waves do differently

The wave executor keeps every session small. Instead of one session that does everything, you get N sessions that each do one thing well.

**Session budget.** Each wave session loads STATE.md + OVERVIEW.md + WAVE.md + any supplementary docs. That's the fixed overhead. The rest of the context window — ideally the majority of it — is available for actual work: reading source files, writing code, debugging. The goal is to never occupy more than ~100k tokens total, including the work itself.

**No carried context.** Each session starts fresh. There's no degraded memory from the previous wave. The agent reads the state file, loads exactly what it needs for the current wave, and works with full context clarity.

**Progress on disk, not in memory.** The wave executor is a finite state machine. The current state — which wave is active, which waves are complete, what failed — lives in `STATE.md` on disk, not in any agent's memory. A fresh session reads the state file and knows exactly where to pick up. It doesn't need to know what happened in prior sessions, how many sessions there were, or whether the last one crashed halfway through.

This is what makes the system fault-tolerant. A degraded session, a crashed session, a session you just want to abandon and restart — none of these lose progress. The state file is the single source of truth, and it only advances when verification passes. If a session fails to complete its wave, the next session retries the same wave with fresh context.

The codebase itself is the other half of inter-wave state. Previous waves produce code, configuration, and files on disk. Subsequent waves read those actual files to understand what exists — not a summary of what was done, not a handoff document, the real files. This means inter-wave communication is zero-cost and perfectly accurate. There's nothing to serialize, nothing to summarize, nothing that can drift from reality.

## Subagent parallelism

Within each wave, independent tasks run as parallel subagents. This has two effects:

**Lower context consumption.** In OpenCode (and this fork), each subagent runs in a fully isolated context window. When a subagent creates files, runs commands, and debugs issues, all of that execution trace lives in the subagent's own context — it never enters the parent's. The parent agent — the wave orchestrator — only sees the result summary. A wave with three parallel subagents might do 60 tool calls of real work, but the orchestrator's context only grows by three result messages.

**The orchestrator stays sharp.** The wave session itself acts as an orchestrator, not a worker. It reads the wave file, launches subagents, collects results, runs verification, and updates state. Its context stays small and clean throughout — exactly the conditions where models perform best.

**Subagents can parallelise too.** A subagent has access to the same tools and subagents the parent does. It can launch its own parallel subagents to explore, implement, or verify independently. The pattern is recursive — the wave orchestrator stays clean by delegating to subagents, and subagents stay clean by delegating to their own subagents. At every level, execution traces stay contained and the calling agent only sees results.

This is the same principle applied at every level: waves keep inter-session context clean, subagents keep intra-session context clean, and sub-subagents keep individual task context clean.

## Cost

API pricing is `input_tokens * x + output_tokens * y`. Every API request in a conversation — whether it's the model responding to the user, calling a tool, or processing a tool result — sends the entire conversation history as input. The first request sends the system prompt plus one message. The 50th request sends the system prompt plus every message, tool call, and tool result that came before it. Input cost per request grows linearly with conversation length.

This means a long session doesn't just cost more at the end — it costs more on every single exchange after the first. The 80th request is paying for 79 messages of accumulated context. Across the full session, total input token spend grows quadratically with the number of exchanges.

Waves and subagent parallelism both cut this by resetting the accumulation. Four sessions of 20 exchanges each have far lower total input cost than one session of 80 exchanges, even though the same amount of work gets done. Each session starts with a small, fixed context (the wave files) instead of inheriting the full history of everything before it. And within each session, subagents run in isolated context windows — their exchanges never accumulate in the parent's history. A wave orchestrator that launches three subagents each doing 20 exchanges only pays for its own short conversation, not the 60 exchanges happening inside the subagents.

## When not to use waves

If the task fits in one session — roughly, if you can plan and build it in under 20 minutes of agent time without the agent losing track of things — just do it directly. Waves add overhead (the decomposition session, the file structure, the per-session startup). That overhead only pays off when the alternative is a degraded long session that produces broken output you have to fix anyway.
