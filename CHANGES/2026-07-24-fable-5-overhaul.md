# Changes: Fable 5 era overhaul — routing matrix, prompt slimming, delivery hardening

**Date**: 2026-07-24

Iteration 10 ([PROMPT_ITERATIONS/2026-07-24-fable-5-overhaul.md](../PROMPT_ITERATIONS/2026-07-24-fable-5-overhaul.md)). First prompt iteration of the fable-5 era: re-baselines the prompt surfaces against Anthropic's official fable-5/opus-4.8 prompting guides, Claude Code 2.1.x, Codex CLI's two-register architecture, gemini-cli/Google guidance, and the pi ecosystem's minimalism findings. Introduces per-agent-type model routing with a delegation gate, retires always-on caveman subagent output rules, and adds machine awareness.

## Prompt surfaces

- `session/prompt/anthropic.txt` — rewritten. Task-tool prose purged (taught a tool removed in Wave 4); new "Acting and stopping" (act-when-ready, end-turn last-paragraph check, evidence-grounded progress claims, no context-limit stops) and "Communicating results" (outcome-first, selectivity over compression) sections; delegation-restraint tests (adapted from Claude Code 2.1.215); model-routing pointer to the instructions-file matrix; spawn-brief requirements incl. reason-behind-the-task; untrusted-external-content mandate; boundaries sentence in "Responding to requests"; one TodoWrite example dropped.
- `agent/prompt/general/anthropic.txt` — rewritten as lean worker register. Caveman rules replaced with selectivity-based "Response format" + end-turn check; spawn/explore idioms; concurrent-tree never-revert rule. Prose-test pins (delivery-contract pointer, ABORT reference, forbidden phrases) preserved.
- `agent/prompt/general/gemini.txt` — Tool Delegation + Notes re-idiomed from Task tool to spawn_agent.
- `agent/prompt/explore.txt` — caveman section → "Reporting style" (path+line first, complete sentences, verbatim evidence, explicit negatives).
- `agent/prompt/multi-agent-root.txt` — ten-tool surface named; parallel-writer worktree bullet; brief requirements (reason + delivery reminder); new "## Model routing" section (pins are defaults; escalate one tier up without asking).
- `agent/prompt/multi-agent-subagent.txt` — delivery contract gains the end-turn check (mitigation for the triple silent-delivery incident, sessions `ses_06dd00e78ffe` / `ses_06dcff0d3ffe` / `ses_06dcfcf76ffe`).
- `tool/agent-spawn/agent-spawn.txt` — "Leave both unset unless the user explicitly asks" → routing-first model-selection prose.
- `session/prompt/max-steps.txt` — calm register; grounded summary requirement.
- `session/prompt/plan.txt` — audited, unchanged (already current).

## Code

- `session/system.ts` — `Hostname: ${os.hostname()}` line in the `<env>` block.
- `test/session/system.test.ts` — Hostname assertion in the environment test.

## Per-machine config (`~/.config/opencode/`, boxbox; iris mirror pending)

- `AGENTS.md` (new) — routing matrix (fable / opus-4.8 `general` / sonnet-5 `worker` / gemini-3-6-flash `mule`), delegation gate, escalation ratchet + `routing-log.md`, parallelization rules, boxbox machine section (Tailscale dev-server handoff; never restart cmx serves).
- `opencode.jsonc` — `agent.general.model: anthropic/claude-opus-4-8`.
- `agent/worker.md` (new) — sonnet-5 line worker, worktree isolation, ticket-executor register.
- `agent/mule.md` (new) — gemini-3-6-flash read-only context mule, edit denied, explicit-facts register.

## Docs

- `README.md` — iteration table row 10; spawn model-inheritance semantics corrected (children inherit the spawner's model when the agent type has no pin, per e09fdc0); explore default-setup paragraph (sonnet-5); fork-identity file list (`qwen.txt` → `default.txt`); caveman section scoped to the opt-in primary agent.
- `CHANGES/INDEX.md` — prompt rows updated; stale `qwen.txt` row corrected.

## Tests

`bun typecheck` clean. `test/prose/subagent-prompts.test.ts` + `test/differential/prompt-prose.diff.test.ts` + `test/session/system.test.ts` + `test/backward-compat/system-prompt-regression.test.ts`: 100 pass / 0 fail. No stray `Task tool` / `subagent_type=` references remain in the rewritten prompt files.
