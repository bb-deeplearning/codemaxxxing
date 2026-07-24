# Iteration 10: Fable 5 era — routing matrix, prompt slimming, delivery hardening

**Date**: 2026-07-24

Fable 5 became the fork's primary model on June 10 (iteration-less — [fable-5-support](../CHANGES/2026-06-10-fable-5-support.md) was transforms only). Since iteration 9 (May 20, written for Opus 4.7) the runtime gained spawn model/effort overrides, worktree isolation, spawn pools, request_review, and child-model inheritance — none of which the prompts knew about, and some of which they contradicted. This iteration re-baselines every prompt surface for the fable-5 / opus-4.8 / sonnet-5 / gemini-3.6 generation, introduces a model-routing matrix with a delegation gate, retires the always-on caveman subagent output rules, and adds machine awareness (hostname in the env block + per-machine global AGENTS.md).

## Discovery

Live misbehavior and drift, collected 2026-07-24:

1. **Triple silent-delivery failure** (`ses_06dd00e78ffe`, `ses_06dcff0d3ffe`, `ses_06dcfcf76ffe`). Three `general` research children completed with NO final text and NO `send_message` — safety-net warnings fired, deliverables lost. Matches Anthropic's documented fable-5 failure mode ("can occasionally end a turn with a text-only statement of intent without issuing the corresponding tool call" — or no text at all deep into a run). The delivery contract prose predates the official end-turn-check mitigation.
2. **Prompts teaching a tool that doesn't exist.** `session/prompt/anthropic.txt` and `agent/prompt/general/anthropic.txt` both instructed "use the Task tool with subagent_type=explore" — the legacy `task` tool was removed from the model-visible surface in the replace-bash-task campaign (Wave 4, May 2026). Two months of every session being taught a phantom tool.
3. **Silent 3× fable fan-out.** With no agent-type pin, `general` children inherit the spawner's model (e09dfc0, 2026-07-24) — a research fan-out ran three fable-5 sessions for flash-tier work. Compounding it, `agent-spawn.txt:38` actively instructed "Leave both unset unless the user explicitly asks" — routing was prompt-suppressed exactly where fable-5 is documented to excel at it.
4. **Doc/reality drift.** README:70 said spawn model resolution "never the parent's" (contradicting e09dfc0 the same day); README:310 documented explore on `gemini-3.1-pro-preview` while config pins `anthropic/claude-sonnet-5`; README:382 + INDEX.md:12 referenced `session/prompt/qwen.txt`, deleted upstream (content lives in `default.txt`).
5. **Caveman contradiction.** The always-on subagent caveman rules (iteration 6) mandate fragments, aggressive abbreviations, and arrow chains — the exact style Anthropic's fable-5 guide names as the wrong way to be concise ("not to compress the writing into fragments, abbreviations, arrow chains like A → B → fails").

## Research

Full digest in the session that produced this iteration; sources and the load-bearing findings:

- **Anthropic official** ([Prompting Claude Fable 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5), [Prompting Claude Opus 4.8](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-4-8), migration guide): fable blocks for act-when-ready, evidence-grounded progress claims, pause-only-when-genuinely-blocked + end-turn check, no context-limit excuses, outcome-first summaries via selectivity not compression; "skills developed for prior models are often too prescriptive for Fable 5 and can degrade output quality"; effort ladders (fable: high default, xhigh capability-sensitive; opus: xhigh for coding, max prone to overthinking; sonnet-5 economically valid at low/medium); opus spawns fewer subagents by default, fable more — delegation prose must push in opposite directions per model.
- **Claude Code v2.1.x** (Piebald extraction, latest v2.1.218): "Subagent delegation restraint" (2.1.215) anti-pattern tests adopted nearly verbatim; "Act when ready" (2.1.173) matches the official fable block; communication-style prescribes when to speak, complete sentences readable cold; model/effort selection is declarative per agent type ("Do not set the model parameter" for workers).
- **Codex CLI** (openai/codex): two prompt registers — verbose behavioral scaffold for general models, ~7KB lean prompt for agent-tuned models (persistence/planning prose deleted; trained-in). Register-by-model-class adopted for our seat design. Their entire multi-agent prompt is 5 bullets trusting tool schemas.
- **gemini-cli + Google official**: benchmark-guarded "Context Efficiency" mandate (borrowed for mule/worker registers); Gemini 3 "may over-analyze verbose prompt engineering"; flash-tier models get MORE explicit environmental facts (current date, knowledge cutoff, scope-of-truth), not dumber prompts; `thinking_level` is the cost lever, not prompt verbosity.
- **pi ecosystem** (Mario Zechner; senpi fork): <1000-token prompts are Terminal-Bench-competitive — "frontier models have been RL-trained up the wazoo, they inherently understand what a coding agent is"; senpi ships a claude-fable-5 preset whose tuning block independently converges on the official fable blocks (act-when-ready, grounded claims, end-turn check, anti-arrow-chain, no context-limit excuses). Three-way convergence (official + CC + community) is what qualified those blocks for adoption.
- **Community orchestration** (HN, Jun–Jul 2026): fable-plans/cheap-executes patterns work when the mechanical slice is truly specced (Theo's Codex routing, sermakarevich's fleet); Sonnet 5 contested outside low/medium effort; for genuinely hard problems, one big model beats orchestration (fractorial's Fable-Max one-shot).
- **Upstream anomalyco/opencode** (fetched, diffed): their anthropic.txt is thinner and still task-tool-era — nothing to harvest there; harvested instead: meta.txt's evidence-before-synthesis posture, gpt.txt's concurrent-agents-in-dirty-worktree rules, plan-mode's end-turn contract (ours already had it). Prompt ownership confirmed: upstream sync is manual selective harvest.

## Solution

Prompt surfaces (all in `packages/opencode/src/`):

- **`session/prompt/anthropic.txt`** — rewritten. Purged all Task-tool prose; tool policy now speaks spawn_agent/explore idioms with CC-2.1.215-style delegation-restraint tests, a model-routing pointer (matrix lives in instructions files, prompt carries only the mechanism), spawn-brief requirements (deliverable + owned files + format + reason), and an untrusted-external-content mandate. New sections: "Acting and stopping" (act-when-ready, pause-only-when-needed, end-turn last-paragraph check, evidence-grounded progress claims, no context-limit stops) and "Communicating results" (outcome-first; selectivity over compression). "Responding to requests" gained the official boundaries sentence (assessment is the deliverable; report and stop). Dropped the second TodoWrite example and the duplicate trailing TodoWrite reminder.
- **`agent/prompt/general/anthropic.txt`** — rewritten as the lean worker register. Caveman output rules replaced by "Response format" selectivity rules (outcome-first, exact identifiers verbatim, grounded claims) + "Completing the task" end-turn check. Task-tool section replaced with spawn/explore + untrusted-content bullets. Added concurrent-tree rule (never revert changes you didn't make). Delivery-contract pointer and ABORT reference preserved (prose-test pins).
- **`agent/prompt/general/gemini.txt`** — Tool Delegation section re-idiomed to spawn_agent; Notes Task-tool reference fixed. (Already carried Context Efficiency and no caveman rules.)
- **`agent/prompt/explore.txt`** — caveman section replaced with "Reporting style" (path+line first, group by area, complete sentences, verbatim evidence, explicit negatives; anti-arrow-chain).
- **`agent/prompt/multi-agent-root.txt`** — tool list corrected six→ten; worktree-isolation bullet for parallel writers + never-revert-others'-work; scoping section now requires reason-behind-the-task and a delivery reminder in every brief; new "## Model routing" section (agent-type pins are the defaults; override per matrix; escalate one tier up without asking).
- **`agent/prompt/multi-agent-subagent.txt`** — delivery contract gains the end-turn last-paragraph check ("the delivery contract is only satisfied by the send_message actually happening") — the direct mitigation for Discovery #1.
- **`tool/agent-spawn/agent-spawn.txt`** — "Leave both unset unless the user explicitly asks" replaced with routing-first prose: agent-type pins are the matrix defaults, overrides route judgment up / mechanical down.
- **`session/prompt/max-steps.txt`** — re-registered calm (current-gen models don't need scolding caps-lock); summary must be grounded in tool results.
- **`session/prompt/plan.txt`** — audited, no change needed (already carries the end-turn contract and current explore idioms).

Code:

- **`session/system.ts`** — env block gains `Hostname: ${os.hostname()}` (machine awareness; Tailscale specifics live in per-machine global AGENTS.md, not code).
- **`test/session/system.test.ts`** — environment test asserts the Hostname line.

Config (per-machine, `~/.config/opencode/` — boxbox now; iris mirror pending):

- **`AGENTS.md`** (new) — the routing matrix (fable orchestrator / opus-4.8 `general` / sonnet-5 `worker` / gemini-3-6-flash `mule`), the three-condition delegation gate, escalation ratchet with `routing-log.md`, parallelization rules (≤3 writers, worktree isolation, verification on a different seat), and the boxbox machine section (0.0.0.0 + detach + `http://boxbox:<port>` Tailscale handoff; never restart cmx serves).
- **`opencode.jsonc`** — `agent.general.model: anthropic/claude-opus-4-8` (stops silent fable inheritance on fan-outs).
- **`agent/worker.md`** (new) — sonnet-5 line worker, worktree isolation, executes-the-ticket-exactly register, ABORT(spec_wrong) on open design questions.
- **`agent/mule.md`** (new) — gemini-3-6-flash read-only mule, edit-denied, explicit-facts + scope-of-truth + context-efficiency register.

Docs: README (iteration table, spawn-model semantics at :70, explore pairing, fork-identity file list, caveman scope), CHANGES/INDEX.md rows, this file, and [CHANGES/2026-07-24-fable-5-overhaul.md](../CHANGES/2026-07-24-fable-5-overhaul.md).

Deliberately NOT done: no new prompt sections teaching agentic basics (the research says current models have them trained in — this iteration deletes more teaching prose than it adds); caveman remains available as the opt-in `caveman` primary agent (only the always-on subagent rules were retired); gemini.txt/default.txt session prompts left for a follow-up pass (secondary drivers; gemini worker register now lives in mule.md).

## Observe

- `agent.metric.safety_net_firing_rate` → should drop to ~0 (was the Discovery #1 signal). `deliverable_arrival_rate` → ~1.
- `~/.config/opencode/routing-log.md` accumulates escalation lines: a lane with repeated escalations gets promoted permanently; ~10 clean deliverables qualifies a lane to trial one tier down. Two weeks of this calibrates the matrix on real work.
- Watch for: fable over-delegating small tasks (restraint prose should hold it); opus generals under-delegating (official asymmetry); sonnet-5 workers inventing design (should ABORT(spec_wrong) instead); mule denying current-gen models exist (facts block should prevent).
- Prose pins: `test/prose/subagent-prompts.test.ts`, `test/differential/prompt-prose.diff.test.ts`, `test/session/system.test.ts`, `test/backward-compat/system-prompt-regression.test.ts` — all green at landing (100 pass).
