# Changes: Explore agent delegation

**Date**: 2026-02-22
**Iteration**: [PROMPT_ITERATIONS/2026-02-22-explore-delegation.md](../PROMPT_ITERATIONS/2026-02-22-explore-delegation.md)

Prompt changes to fix how the main agent delegates to the explore subagent. See the iteration log for full discovery, research, and rationale.

## Task tool prompt (`packages/opencode/src/tool/task.txt`)

- Added "Explore agent delegation" section with rules: ask questions not code dumps, split broad exploration into multiple parallel agents, expect findings not raw code, always specify thoroughness, give starting points
- Replaced single-agent "Good" example (which demonstrated the anti-pattern of one agent covering JWT + sessions + permissions) with a focused single-agent example and a parallel split example showing 3 agents
- Added a "Bad" example showing an overly broad single-agent prompt

## Main system prompt (`packages/opencode/src/session/prompt/anthropic.txt`)

- Updated explore guidance in tool usage policy: "prefer multiple focused agents in parallel over one broad agent"
- Added: "do not use explore to read files you already know the path to — use Read directly"
- Replaced generic "codebase structure" example with a parallel auth exploration example showing 3 agents

## Explore agent config (`packages/opencode/src/agent/agent.ts`)

- Appended to explore description: "Works best with focused scope — for broad questions, prefer spawning multiple explore agents in parallel, each targeting a specific area. Do not use as a file reader — if you know the paths, use Read directly."

## Explore agent prompt (`packages/opencode/src/agent/prompt/explore.txt`)

- Changed response format from "Include relevant code from files you read" to "Include only the relevant code — key function signatures, critical logic blocks, configuration values. NEVER reproduce entire file contents. The parent agent can Read specific files if it needs more."
