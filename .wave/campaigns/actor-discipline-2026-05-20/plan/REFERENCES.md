# References

External and internal source paths every wave may need.

## Diagnostic sessions (regression sources)

Located in SQLite at `~/.local/share/opencode/opencode.db`. Query template:

```bash
sqlite3 ~/.local/share/opencode/opencode.db <<'EOF'
.headers on
.mode column
SELECT id, parent_id, agent, title, time_created FROM session
WHERE id = 'ses_xxx' OR parent_id = 'ses_xxx' ORDER BY time_created;
EOF
```

| Session | Title | Why it matters | Regression test |
|---|---|---|---|
| `ses_1c2e8d84affeZ7t5g5LKveGDTo` | Cidoo ABM066 firmware availability | The multi-agent delivery failure. Subagent emitted text + close_agent same turn → finish: tool-calls → extractor skipped → parent received cleanup as deliverable. | Wave 2 reproduces as INV-D-01. |
| `ses_1d84f236bffeEWmrmOhp6SoLma` | Demo: Agent Spawning Another Agent / The People v. Frankfurter | Demo 1 = coordinator+grandchildren success pattern (lock in via INV-D-08). Demo 2 = prosecutor/defense sibling deadlock; both filed openings to /root, idled waiting for opposing message that never arrived. | Wave 2 reproduces Demo 2 as INV-D-06. Demo 1 locked in as INV-D-08. |
| `ses_1ce9356abffep1L0TvDbD80uUO` | (post-campaign fix b3c32594e) | Grandchild self-close stranded parent's wait_agent; completion-watcher's skip rule assumed close was parent-driven. Fix already shipped. | Existing test `agent-close.test.ts` covers; this campaign extends as INV-D-02. |

## ADR-009 thread

This campaign was decomposed from a conversation thread. The thread covered:

- MULTI_AGENT_DELIVERY_FINDINGS.md — the original diagnostic write-up.
- PROMPT_ITERATIONS history (iterations 1-8) — house style + prior decisions.
- Anthropic Opus 4.7 migration guide ([platform.claude.com/docs/en/about-claude/models/migration-guide](https://platform.claude.com/docs/en/about-claude/models/migration-guide)) — six behavior changes informing D4 literalism adaptation.
- Cursor's "Continually improving our agent harness" post ([cursor.com/blog/continually-improving-agent-harness](https://cursor.com/blog/continually-improving-agent-harness)) — per-model customization, surface-errors-don't-swallow principle.
- Anthropic AI Engineer talk on long-running agents (Ash + Andrew) — orchestrator pattern; see ANTHROPIC_HARNESS_LEARNINGS.md.

The thread itself is the de-facto plan source. ADR-009 is not yet committed as a standalone file; this campaign's artefacts (OVERVIEW.md, INTEGRATION_INVARIANTS.md, ORCHESTRATOR_PROTOCOL.md, ANTHROPIC_HARNESS_LEARNINGS.md, per-wave WAVE.md) are the executable version of it.

## Prior campaigns (read-only reference)

`.wave/campaigns/codex-parity-2026-05-13/`:

- `plan/OVERVIEW.md` — original multi-agent v2 port overview. Tool-by-tool background.
- `plan/MESSAGE_SHAPES.md` — message and event shapes. Cross-agent message contract (D10 correlation_id is an additive extension).
- `plan/PROMPT_ENGINEERING.md` — voice guidelines for tool descriptions.
- `plan/CONSTANTS.md` — numeric constants (mailbox cap base, depth limit, etc.).

`.wave/campaigns/codex-parity-hardening-2026-05-14/`:

- `plan/INTEGRATION_INVARIANTS.md` — authoritative for multi-root scoping, child-completion-wakes-parent, cross-root-send-rejection, session-deletion-cleanup, parent-close-cascades-to-children. This campaign EXTENDS; does not replace.
- `plan/TDD.md` — integration-first rule. Still applies.

`.wave/campaigns/replace-bash-task-2026-05-15/`:

- `plan/PERMISSION_MAPPING.md` — `EDIT_TOOLS` / `SHELL_TOOLS` / `MULTI_AGENT_TOOLS` permission key collapse pattern. New tools in this campaign (spawn_pool) follow the same precedent — consult `task` key.
- `plan/BACKWARD_COMPAT.md` — BC matrix this campaign must not break. Saved `permission.task: { ... }` rules continue to gate spawn_agent AND spawn_pool.

## Repo files this campaign reads or modifies

### Multi-agent service surface

- `packages/opencode/src/agent/control.ts:695-762` — completion-watcher + auto-extractor. D5 modifies extractor predicate + body; D6 adds in-flight-mail hold logic.
- `packages/opencode/src/agent/control.ts` (other surfaces) — spawnAgent, closeAgent, sendInterAgentCommunication, registerRunLoop. D11 adds ABORT recognition; D12 adds on_failure/pool_strategy; D14 adds link/unlink; D16 adds behavior validation hook.
- `packages/opencode/src/agent/mailbox.ts` — per-session queue + seq watch. D15 adds bounded-queue + backpressure.
- `packages/opencode/src/agent/inter-agent-communication.ts` — `InterAgentCommunication` schema. D10 adds optional `correlation_id`; D11 adds optional `abort_reason` structured payload.
- `packages/opencode/src/agent/agent-path.ts` — `/root/<task_name>` paths. Reference.
- `packages/opencode/src/agent/agent.ts` — registry of agents + per-agent permissions. D16 adds declared behavior contracts per agent_type.
- `packages/opencode/src/agent/status.ts` — `AgentStatus.isFinal`. Reference.

### Subagent prompts

- `packages/opencode/src/agent/prompt/multi-agent-root.txt` — D7 + D8.
- `packages/opencode/src/agent/prompt/multi-agent-subagent.txt` — D1.
- `packages/opencode/src/agent/prompt/general/anthropic.txt` — D4 defer-edits.
- `packages/opencode/src/agent/prompt/general/gemini.txt` — D4 defer-edits.
- `packages/opencode/src/agent/prompt/explore.txt` — D4 defer-edits.
- `packages/opencode/src/agent/prompt/persistent-processes.txt` — unchanged.

### Session integration

- `packages/opencode/src/session/system.ts:101-116` — `capabilityHints` dispatcher. D2 adds per-spawn path templating.
- `packages/opencode/src/session/llm.ts:103-116` — final prompt assembly. Reference (no changes).
- `packages/opencode/src/session/prompt.ts:1451-1502` — mailbox drain at turn start. D6 ensures root-side drain happens before turn-end.
- `packages/opencode/src/session/prompt.ts:1766-1779` — system prompt build pipeline. Reference.

### Six tools

- `packages/opencode/src/tool/agent-spawn/agent-spawn.ts` — D12 adds on_failure + pool_strategy params.
- `packages/opencode/src/tool/agent-send/agent-send.ts` — D10 adds correlation_id.
- `packages/opencode/src/tool/agent-followup/agent-followup.ts` — D10 adds correlation_id.
- `packages/opencode/src/tool/agent-wait/agent-wait.ts` — D10 adds wait_for_reply variant; D11 enforces timeout doctrine.
- `packages/opencode/src/tool/agent-list/agent-list.ts` — reference.
- `packages/opencode/src/tool/agent-close/agent-close.ts:60-68` — D9 splits error metadata; D3 makes target optional.
- `packages/opencode/src/tool/agent-pool/agent-pool.ts` — D13 NEW. The spawn_pool primitive.
- `packages/opencode/src/tool/agent-link/agent-link.ts` — D14 NEW. Link/unlink primitive.

### Tests

- `packages/opencode/test/integration/multi-agent-invariants.test.ts` (944 lines) — Iteration 8 harness. INV-D-01..26 append here.
- `packages/opencode/test/AGENTS.md` — testEffect / it.instance / tmpdir / provideTmpdirInstance patterns. Required reading for any wave that adds an integration test.
- `packages/opencode/test/prose/subagent-prompts.test.ts` — NEW in Wave 1. Asserts forbidden-prose and required-phrases on the five subagent prompt files.
- `packages/opencode/src/tool/agent-close/agent-close.test.ts` — extend for D3 (self-close-by-omission) and D9 (error metadata split).
- `packages/opencode/src/agent/control.test.ts` — extend for D5 (extractor narrowing + safety net) and D11 (ABORT recognition).
- `packages/opencode/src/agent/mailbox.test.ts` — extend for D15 (bounded queue + backpressure).

### GOTCHAS to consult

Load via `Read GOTCHAS.md offset=<L> limit=30` per the file's index:

- `agentcontrol-providerref-must-live-in-layer-not-instancestate` — per-root scoping invariant; relevant to every new AgentControl method.
- `bun-coverage-aggregation-flake` — single-file coverage runs are the source of truth.
- `do-not-run-tests-from-root` — NOT a GOTCHA slug; the guard lives in repo-root `package.json` (`"test"` script errors) and is referenced in repo-root `AGENTS.md`. Run tests from `packages/opencode/`.
- `permission-key-collapse-needs-dual-write-evaluate-vs-disabled` — new tools (spawn_pool) consulting `task` key need the dual write.
- `bus-subscriber-needs-instance-state-fork-and-instance-ref` — if any wave wires a new bus subscriber.
- `tool-define-execute-r-must-be-never-capture-services-in-closure` — for any new tool we add.
- `effect-v4-either-renamed-to-result` / `effect-v4-catchall-renamed-to-catch` — for any new Effect.gen code.
- `eventv2-and-bus-dual-emission-with-parallel-type-prefixes` — if any wave adds a new domain event (D11 might).

## Test fixture helpers

`packages/opencode/test/fixture/fixture.ts` provides:
- `tmpdir(options)` — scoped temp directories.
- `provideTmpdirInstance(fn, options)` — bind a temp directory as the active instance for an Effect.
- `disposeAllInstances()` — afterEach hook.

`packages/opencode/test/lib/effect.ts` provides:
- `testEffect(layer)` — returns `{ effect, live, instance }` test variants.

See `packages/opencode/test/AGENTS.md` for full patterns and `multi-agent-invariants.test.ts:35-80` for a working example.

## Repo conventions

- Repo-root `AGENTS.md` — high-level rules + persistent-processes guide.
- `packages/opencode/AGENTS.md` — Effect v4 rules, module shape, Drizzle conventions.
- `packages/opencode/test/AGENTS.md` — test fixtures guide.
- `GOTCHAS.md` (repo root) — progressive-disclosure knowledge base. Indexes at top; entries by slug.
- `PROMPT_ITERATIONS/*.md` — historical prompt-iteration decisions. Background context.
