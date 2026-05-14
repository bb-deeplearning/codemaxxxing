# codex parity

> **Status (as of 2026-05-14):** shipped on the `codex-parity` branch in
> 16 waves. All baseline metrics within budget. Pre-existing test suite
> passes. Old sessions load. The legacy `task` tool still works.
> Campaign archive: `.wave/campaigns/codex-parity-2026-05-13/`.

## Summary

Two capabilities ported from `openai/codex-cli` and shipped permanently
in codemaxxxing. Semantics match codex 1:1 (param names, defaults, return
shapes, numeric constants); prose is rewritten in codemaxxxing voice;
no Drizzle migrations; no removed surfaces.

1. **unified_exec** — model-facing persistent PTY tool surface. Two
   tools (`exec_command`, `write_stdin`) over a 64-process pool with
   head/tail-buffered output. Replaces nothing; sits alongside the
   one-shot `shell` tool.
2. **multi_agents_v2** — concurrent interactive subagents with
   cross-agent messaging. Six tools (`spawn_agent`, `send_message`,
   `followup_task`, `wait_agent`, `list_agents`, `close_agent`) backed
   by a new `AgentControl` service with per-parent registry and
   per-session mailbox. Coexists with the legacy `task` tool (which
   remains the single-shot fan-and-forget surface).

## unified_exec

### Tool surface

| Tool | File | Description text |
|---|---|---|
| `exec_command` | `packages/opencode/src/tool/process/exec-command.ts` | `packages/opencode/src/tool/process/exec-command.txt` |
| `write_stdin` | `packages/opencode/src/tool/process/write-stdin.ts` | `packages/opencode/src/tool/process/write-stdin.txt` |

Schemas, parameter semantics, and the operational manual the model
reads are specified in
[`.wave/campaigns/codex-parity-2026-05-13/plan/TOOL_SCHEMAS.md`](../.wave/campaigns/codex-parity-2026-05-13/plan/TOOL_SCHEMAS.md).
Numeric constants (yield-time clamps, byte caps, slot caps, env overlay)
are in
[`.wave/campaigns/codex-parity-2026-05-13/plan/CONSTANTS.md`](../.wave/campaigns/codex-parity-2026-05-13/plan/CONSTANTS.md).
Every constant the campaign pulled across is exported from its owning
module — see `packages/opencode/src/pty/index.ts:27-36` (pool caps),
`packages/opencode/src/tool/process/constants.ts` (clamps + env).

### Backing services

- `Pty.Service` extended in wave 2 with `read` (race between
  output/exit/timeout), `terminateAll`, an LRU pruner gated on
  `MAX_UNIFIED_EXEC_PROCESSES`, and an `origin: "tui" | "model"` field
  that controls the legacy auto-remove-on-exit path. See
  `packages/opencode/src/pty/index.ts`.
- `HeadTailBuffer` ported verbatim from
  `codex-rs/core/src/unified_exec/head_tail_buffer.rs`. Symmetric 50/50
  head + tail bytes inside a 1 MiB cap. See
  `packages/opencode/src/pty/head-tail-buffer.ts`.
- `ProcessSessions` per-instance map of model-spawned PTYs (separate
  from the desktop terminal-pane registry) at
  `packages/opencode/src/tool/process/sessions.ts`.

### Behavior notes

- The `tty` flag controls whether `write_stdin` can later send
  non-empty input. Without `tty: true`, the connection is one-way
  (model can poll output, cannot push input).
- Output is head/tail truncated when over `UNIFIED_EXEC_OUTPUT_MAX_BYTES`
  — model sees both prologue and tail.
- Yield-time clamps are codex-verbatim: empty-poll floor 5s
  (`MIN_EMPTY_YIELD_TIME_MS`), non-empty floor 250ms
  (`MIN_YIELD_TIME_MS`), ceiling 30s (`MAX_YIELD_TIME_MS`).
- Model-spawned PTYs persist past process exit so the model can drain
  final output via a follow-up `write_stdin` poll. See gotcha
  `[pty-onexit-auto-remove-tui-only]` in
  [`GOTCHAS.md`](../.wave/campaigns/codex-parity-2026-05-13/plan/GOTCHAS.md).
- `UNIFIED_EXEC_ENV` overlay applied to model-spawned PTYs only
  (`NO_COLOR=1`, `TERM=dumb`, `OPENCODE_CI=1`, etc.). TUI-spawned PTYs
  keep the legacy `TERM=xterm-256color` overlay. See gotcha
  `[pty-create-term-override-tui-only]`.

### Backward compatibility

- `Pty.Service.list/get/create/update/remove/resize/write/connect`
  signatures unchanged. Desktop / electron clients consuming the
  WebSocket protocol see no schema break.
- `Pty.Info` gains `origin?: "tui" | "model"` as an optional field.
  Old rows deserialize cleanly (default treated as `"tui"`).
- The desktop terminal-pane list still auto-removes on process exit
  (gated on `origin === "tui"`).

## multi_agents_v2

### Tool surface

| Tool | File |
|---|---|
| `spawn_agent` | `packages/opencode/src/tool/agent-spawn/agent-spawn.ts` |
| `send_message` | `packages/opencode/src/tool/agent-send/agent-send.ts` |
| `followup_task` | `packages/opencode/src/tool/agent-followup/agent-followup.ts` |
| `wait_agent` | `packages/opencode/src/tool/agent-wait/agent-wait.ts` |
| `list_agents` | `packages/opencode/src/tool/agent-list/agent-list.ts` |
| `close_agent` | `packages/opencode/src/tool/agent-close/agent-close.ts` |

Description text lives in the sibling `*.txt` files. Tool semantics +
the operational manual are in
[`TOOL_SCHEMAS.md`](../.wave/campaigns/codex-parity-2026-05-13/plan/TOOL_SCHEMAS.md);
constants in
[`CONSTANTS.md`](../.wave/campaigns/codex-parity-2026-05-13/plan/CONSTANTS.md).

### Backing services

- `AgentControl.Service` orchestrates spawn / send / wait / close /
  list across the per-parent agent tree. Single layer-scope
  `providerRef` holds the runLoop closure; per-instance state holds
  registry + mailboxes + statuses + fibers. See
  `packages/opencode/src/agent/control.ts`. Layout decision recorded in
  gotcha `[agentcontrol-providerref-must-live-in-layer-not-instancestate]`.
- `Mailbox` primitive: append-only `InterAgentCommunication` queue per
  session with a monotonic seq watch for `wait_agent` wakeups. See
  `packages/opencode/src/agent/mailbox.ts`,
  `packages/opencode/src/agent/inter-agent-communication.ts`.
- `AgentRegistry` + `AgentPath`: per-parent registry, depth-limited
  spawn reservations, canonical `/root/...` path strings. See
  `packages/opencode/src/agent/registry.ts`,
  `packages/opencode/src/agent/agent-path.ts`. `AGENT_MAX_DEPTH = 4`
  matches codex.
- `LiveAgent` + `AgentStatus` + `AgentMetadata`: status snapshot exposed
  to `list_agents`. Status derived from `Step.Started` / `Step.Ended`
  events on the bus. See `packages/opencode/src/agent/live-agent.ts`,
  `packages/opencode/src/agent/status.ts`,
  `packages/opencode/src/agent/metadata.ts`.

### runLoop integration

`packages/opencode/src/session/prompt.ts:1526` drains the recipient's
mailbox at the top of every iteration. Drained
`InterAgentCommunication` entries are injected as synthetic
`MessageV2.UserPart`s with `metadata.from = <author AgentPath>` and
`metadata.trigger_turn = <bool>`. Shape rationale and the
backward-compat impact in
[`MESSAGE_SHAPES.md`](../.wave/campaigns/codex-parity-2026-05-13/plan/MESSAGE_SHAPES.md).

`SubtaskPart` gains an optional `protocol?: "v2"` field
(`packages/opencode/src/session/message-v2.ts:243`). Absent / any other
value continues through the legacy synchronous `task` dispatch path.
`"v2"` routes through `AgentControl.spawnAgent` for concurrent
execution. Branch at `prompt.ts:1596`.

`AgentControl.registerRunLoop` (called once at
`prompt.ts:1846`) hands the per-session loop closure to the layer-scope
`providerRef` so spawn calls can re-enter the runLoop without a
service-graph cycle.

### Lifecycle events

Two-channel emission per
[gotcha](../.wave/campaigns/codex-parity-2026-05-13/plan/GOTCHAS.md)
`[eventv2-and-bus-dual-emission-with-parallel-type-prefixes]`:

- **Sourced log** — `SessionEvent.Agent.*.Sync` under
  `session.next.agent.*` types. Persisted to the event log; replay
  rebuilds in-memory state. See
  `packages/opencode/src/v2/session-event.ts:357-497`.
- **In-process bus** — `Event.*` (`SpawnStarted`, `SpawnEnded`,
  `Closed`, `WaitStarted`, `WaitEnded`, `MessageSent`) under `agent.*`
  types. TUI / plugins subscribe via `Bus.subscribe(Event.SpawnStarted)`
  etc. Defined at `packages/opencode/src/agent/control.ts:95-155`.

### Cancellation

A user-initiated parent cancel cascades through `AgentControl.cancelChildrenOf`
and tears down every concurrent sibling fiber. Verified in
`packages/opencode/test/session/prompt.test.ts` "cancel propagates"
scenario.

### Backward compatibility

- The legacy `task` tool stays in the registry and produces
  `SubtaskPart` entries with no `protocol` field. Existing assistant
  messages with `SubtaskPart`s deserialize and render unchanged.
- No new `MessageV2.Part` variant. Cross-agent messages reuse the
  existing `UserPart` (with `synthetic: true`) and a metadata field
  the renderer keys on.
- `Session.Service` interface unchanged; `Session.create({ parentID })`
  works the same way for both legacy and v2 spawn paths.

## TUI changes

New surfaces in `packages/opencode/src/cli/cmd/tui/routes/session/`:

- `process-tool.tsx` — renders `Process` and `ProcessWriteStdin`
  message parts emitted by unified_exec tool calls.
- `subagent-status.ts` + `subagent-footer.tsx` (+ `subagent-footer-mount.tsx`)
  — derives a per-session subagent status string and renders the
  4-field status strip in the session footer when concurrent siblings
  are live.
- `mailbox-message.tsx` — renders synthetic UserParts whose
  `metadata.from` is set with the cross-agent visual treatment
  (distinct from regular user input).
- `dialog-subagent.tsx` (+ `dialog-subagent-mount.tsx`) — adds a
  `close` action to the subagent quick-action dialog.

Helper / view components are split into a no-hooks file (testable via
`testRender` against pure props) plus a wrapper file that calls hooks
and is excluded from coverage. Rationale recorded in gotcha
`[tui-component-coverage-needs-mount-split]`.

### Render perf characteristics

- Single-session render: 48.3µs p50 (8.7% under wave-0 baseline). See
  `session.render.steady` in
  [`perf-final-report.md`](../.wave/campaigns/codex-parity-2026-05-13/artifacts/perf-final-report.md).
- 4-sibling render: 60.8µs p50, 1.30× single-session (cap 1.5×). See
  `session.render.steady.4_siblings`.
- Multi-field status strips use `<text><span/>...</text>` rather than
  N sibling `<text>` nodes — see gotcha
  `[opentui-multi-text-node-vs-single-baseline-1.5x-cap]`.

The tui-render-freeze antipatterns continue to be enforced. New
components reviewed against the audit checklist in
[`tui-render-freeze.md`](./tui-render-freeze.md) § "Audit checklist".

## System prompts

`SystemPrompt.capabilityHints(agent)` at
`packages/opencode/src/session/system.ts:101` injects up to three
fragments based on the agent's effective permission set:

| Fragment file | When injected |
|---|---|
| `packages/opencode/src/agent/prompt/persistent-processes.txt` | agent has `exec_command` permission ≠ deny |
| `packages/opencode/src/agent/prompt/multi-agent-root.txt` | `agent.mode !== "subagent"` AND `spawn_agent` permission ≠ deny |
| `packages/opencode/src/agent/prompt/multi-agent-subagent.txt` | `agent.mode === "subagent"` AND (`send_message` OR `wait_agent`) permission ≠ deny |

Hints injected at the env-or-instructions layer post-skills. Compaction,
title, and summary agents (which deny everything wildcard-wise) get an
empty hint list — their existing system prompts are unchanged.

Mirror of codex's `multi_agent_v2.{root_agent,subagent}_usage_hint_text`
injection in `core/src/session/multi_agents.rs`. Defaults are strong;
overridable via the `permission` config block.

## Permissions

New permission keys, one per tool name:

```
exec_command, spawn_agent, send_message, followup_task,
wait_agent, list_agents, close_agent
```

`write_stdin` shares the `exec_command` key — first-spawn approval
registers an `always` pattern of `pid:<process_id>`, and subsequent
`write_stdin` calls evaluate the same key per-process. Convention
recorded in
[`MESSAGE_SHAPES.md`](../.wave/campaigns/codex-parity-2026-05-13/plan/MESSAGE_SHAPES.md)
§ "Permission keys".

Per-built-in defaults (`packages/opencode/src/agent/agent.ts:107-301`):

| Agent | unified_exec | multi-agent v2 keys |
|---|---|---|
| `build` | allow | allow (all six) |
| `general` | allow | allow (all six) |
| `explore` | deny | `send_message`/`followup_task`/`wait_agent`/`list_agents` allow; `spawn_agent`/`close_agent` deny |
| `plan` | deny | deny (all six) |
| `compaction`/`title`/`summary` | deny (`*` wildcard) | deny (`*` wildcard) |

Wildcard `deny` removes the tool from the model's active toolset
entirely (model gets back `invalid` if it tries to call). Specific
patterns deny only the matched arg. Documented in gotcha
`[permission-disabled-removes-tool-from-active-set]`.

## Performance

Final audit: [`artifacts/perf-final-report.md`](../.wave/campaigns/codex-parity-2026-05-13/artifacts/perf-final-report.md).

- Baseline metrics tracked: 2 (the surfaces that waves directly
  re-measured against wave-0 capture).
- Within budget: 2.
- Over budget: 0.
- Wave-introduced metrics (no baseline; informational): 26.

Hot-path summary:

| Metric | Wave | Δp50 vs baseline | Status |
|---|---|---|---|
| `session.render.steady` | wave_11 | -8.7% | OK |
| `pty.push.4kb` | wave_2 | -71.1% | OK |

Concurrent-session invariants (wave_14, e2e):

- 4-sibling LLM stream / single-session ratio: 0.6-1.0× (cap 1.6×) —
  median-of-5 to suppress test-suite noise per gotcha
  `[e2e-perf-sibling-fanout-needs-median-of-n]`.
- Mailbox seq-watch wakeup p99: ~1.36ms (cap 5ms).
- 16 agents × 4 turns memory-load test: RSS delta well under the 160
  MiB soft cap.

Budget per
[`PERF.md`](../.wave/campaigns/codex-parity-2026-05-13/plan/PERF.md):
5% on p50, 10% on p95, 15% on p99 against the wave-0 baseline at
`.wave/campaigns/codex-parity-2026-05-13/artifacts/baseline-perf.json`.
A flake-detection methodology evolved during the campaign — best-of-N
for opentui render benches, median-of-N for e2e ratios — both recorded
in `GOTCHAS.md`.

## Backward compatibility

Verified end-to-end in wave_13. Test files in
`packages/opencode/test/backward-compat/`:

- `legacy-session.test.ts` — synthetic pre-campaign session JSON
  fixture exercises every `MessageV2.Part` variant (Text, Subtask,
  Reasoning, File, Tool, StepStart, StepFinish, Snapshot, Patch, Agent,
  Retry, Compaction). All deserialize cleanly.
- `legacy-task-tool.test.ts` — `task` tool input/output envelope
  unchanged from pre-campaign.
- `pty-existing-consumers.test.ts` — desktop WebSocket schema for
  Pty.Service is backward-compatible.
- `system-prompt-regression.test.ts` — compaction / title / summary
  receive zero capability hints; build / general / explore / plan
  prompts gain only what their effective permissions allow.
- `plugin-hooks.test.ts` — `tool.execute.before` / `tool.execute.after`
  hooks fire as before.
- `event-replay.test.ts` — sourced events replay through the projector
  chain to produce identical state.

Manual smoke procedure:
`packages/opencode/test/backward-compat/manual-smoke.md`.

Non-removal list and schema-compat guarantees enumerated in
[`BACKWARD_COMPAT.md`](../.wave/campaigns/codex-parity-2026-05-13/plan/BACKWARD_COMPAT.md).
No Drizzle migrations produced by this campaign.

## Testing

- TDD throughout. Tests-first, run red, implement, run green,
  commit. Discipline in
  [`TDD.md`](../.wave/campaigns/codex-parity-2026-05-13/plan/TDD.md).
- 100% line coverage on every file added or modified by the campaign,
  verified per-wave with `bun test --coverage`. Coverage-counter
  quirks recorded in `GOTCHAS.md` (`[bun-coverage-line1-quirk]`,
  `[bun-coverage-line1-schema-class-only]`,
  `[bun-coverage-aggregation-flake]`,
  `[tool-define-inner-effect-gen-closing-brace]`,
  `[tui-component-coverage-needs-mount-split]`,
  `[bun-test-coverage-source-file-arg-runs-zero-tests]`).
- Perf benches use the `stubProvider()` helper in
  `packages/opencode/test/lib/stub-provider.ts`. No live LLM calls
  anywhere in the perf surface.
- E2E suite (10 scenarios) in `packages/opencode/test/e2e/`:
  `parallel-explorers`, `worker-pipeline`, `debate`, `observer`,
  `persistent-repl`, `long-running-server`, `cancellation-cascade`,
  `permission-denial`, `concurrent-perf-invariants`, `memory-load`.

To run from the package directory:

```sh
cd packages/opencode
bun typecheck
bun lint
bun test
```

## Campaign archive

Full per-wave plans, NOTES, decisions, perf artifacts, and the
`GOTCHAS.md` knowledge base live at
`.wave/campaigns/codex-parity-2026-05-13/`. Each of the 16 waves
(`wave_0` through `wave_15`) has its own commit on the `codex-parity`
branch tracing exactly what landed and why. Wave specs:
`.wave/campaigns/codex-parity-2026-05-13/plan/waves/wave_<N>/WAVE.md`.

Branch base is `codemaxxxing`; this campaign deliberately diverges
from upstream OpenCode after these waves land. The default branch
(`dev`) does NOT carry these changes — merge is a separate decision.
