# Changes: Compaction hardening — the summary stops being a single point of failure

**Date**: 2026-08-21

One drop (`b01f937a1a`): five pieces ported in judgment from xai-org/grok-build's compaction stack onto this fork's anchored-summary design, after a full read of their implementation (two-pass prefire, degenerate rejection, suppression scoping, recovery surfaces). The shared thesis: a compaction summary is a lossy bottleneck, so guard what goes in, hide the latency, and give the model structural paths back to what was dropped.

## Degenerate-summary floor (`b01f937a1a`)

A summary is validated before it becomes load-bearing. Empty is always degenerate; under 500 chars or missing the template's `## Goal` heading is degenerate when the summarized head is substantial (>= 6 messages) and the built-in prompt ran (custom `experimental.session.compacting` prompts skip the template check). One fresh retry; a second failure errors the attempt WITHOUT splicing.

- **`src/session/compaction.ts`.** `isDegenerateSummary` + the attempt-loop restructure of `processCompaction` (assistant-message creation + processor run extracted into `attempt()`, summary re-read via `readSummary`, failed attempts marked `{name: "UnknownError"}` + `finish: "error"` so `filterCompacted`/`completedCompactions` never treat them as boundaries).
- Why it matters here specifically: this fork anchors summaries — every later compaction "updates" the previous one via `<previous-summary>`, so one degenerate splice would poison the session permanently.

## Sticky failure suppression (`b01f937a1a`)

"Too large to compact even stripped" and double-degenerate set a per-session suppress flag; auto-compaction stops re-attempting a deterministic failure every turn (previously every subsequent prompt on a wedged session re-ran and re-failed the same compaction). Cleared by a model switch, a manual compact, or a later success. Manual `/compact` bypasses it.

- **`src/session/compaction.ts`.** Module-scoped `suppressed` map + `suppression()` — module scope is deliberate: the server routes, the run loop, and the module-level exports run in **different Effect runtimes**, so a layer-closure map would split state per runtime (session IDs are host-globally unique, so process scope is correct). Gates: `isOverflow` (new optional `sessionID` param, existing call sites unchanged) and `create` (auto only; manual clears).
- **`src/session/prompt.ts`.** The loop's proactive trigger passes `sessionID`.

## Prefire two-pass (`b01f937a1a`)

Compaction was a synchronous full-history summarize at full-model speed — minutes of dead air exactly on the longest autonomous runs. Now: once usage crosses 90% of the usable window, the loop forks a background pass-1 (`Effect.ignore` + `forkIn(scope)`, same shape as title generation) that summarizes the current head into a cached note — no session messages, no events. When compaction fires, pass-2 anchors the note as `<previous-summary>` and summarizes only the delta, so the blocking call prefills a few turns instead of the whole history.

- **`src/session/compaction.ts`.** `prefire` (self-gating: config, suppression, in-flight guard, threshold band, cache validity), `prefireStamp` (identity + mutation stamp: message ids, part counts, newest prune timestamp — completed turns are immutable except pruning), `prefireCut` (prefix validation), `buildInputs(useCache)` in `processCompaction` (a degenerate pass-2 drops the cache and retries from the full head). Entries are prefix-validated, not equality-validated — one prefire serves a whole compaction cycle instead of re-firing every turn in the band. Stale (revert / prune / model switch) falls back to single-pass silently. In-flight-at-compact skips rather than joins (v1 simplification; the `prefire cached` / `prefire hit` / `prefire stale` log lines are the observables for whether a join is worth adding).
- **`src/session/prompt.ts`.** The per-turn trigger after the auto-compact check.
- **`src/config/config.ts`.** `compaction.prefire` (boolean, default on) — the off-switch for the speculative spend.
- New layer dep: `LLM.Service` on `SessionCompaction` (pass-1 calls `llm.stream` directly with `tools: {}`).

## recall tool (`b01f937a1a`)

Pruned tool outputs render as `[Old tool result content cleared]` and compacted history vanishes from the model's view — but the text never leaves the sqlite rows (pruning only stamps `state.time.compacted`; rendering clears). `recall` is the pull-based escape hatch: session-scoped, case-insensitive AND-term search over the full stored history including compacted-away messages and pruned outputs (marked `[recovered from pruned tool output]`), ranked by term-hit density, ~700-char excerpts.

- **`src/tool/recall/recall.ts` + `recall.txt` (NEW, fork-only).**
- **`src/tool/registry.ts`.** Registered across the four registry surfaces; `test/integration/tool-surface-replacement.test.ts` allowlist entry per the `tool-list-snapshot-needs-post-baseline-allowlist-entry` gotcha.
- Permission shape mirrors grep (`permission: "recall"`, default allow — a `permission.recall` config lever exists but never prompts by default).

## Structural live-state on the auto-continue turn (`b01f937a1a`)

The summary template's "Live State" bullet was the only carrier of running-subagent handles and open todos across a compaction — LLM prose, best-effort. Now the auto-continue user turn opens with a `<post-compaction-state>` block built from the runtime, not the summary: live subagents from `AgentControl`'s in-memory tree, open todos from the todo table. The recall pointer always rides the block.

- **`src/session/prompt.ts`.** `compactionLiveState` — gathered by the loop (which already holds `agentControl`) and passed into `compaction.process` as plain input, deliberately avoiding a new `AgentControl` layer edge on `SessionCompaction`. New `Todo.Service` dep on `SessionPrompt` (folded into the trailing `Layer.mergeAll` — the 21st `.pipe` arg collapses the layer type to `unknown`, see the new gotcha).
- **`src/session/compaction.ts`.** `liveState?: string[]` on `process`; block assembly in the auto-continue path.

## session.compacted enrichment (`b01f937a1a`)

Payload grows `trigger` ("auto" | "manual"), `overflow`, `tokensBefore` (last real assistant usage before the compaction), `durationMs` (covers retries), `summaryChars`, `tailStartID`. All optional on the wire; pre-drop clients and serves interop cleanly. SDK regenerated (`packages/sdk/js/src/v2/gen/types.gen.ts`). boxbox consumes this (event union, pit-seam numbers, `fleet.compaction` telemetry, fuel-gauge threshold tick — boxbox-web `b904224`).

## Tests + verification

- `test/session/compaction.test.ts`: 13 new tests (degenerate retry/suppression/model-switch clear/manual clear, prefire cache-anchors-delta / band gating / degenerate-note refusal / prune-invalidation, live-state block, enriched event assertions). The fake processor now writes a healthy template summary so fake-runtime tests exercise the accept path. 56/56.
- Full suite 4011 pass; all 11 failures attributed pre-existing or load-flake via clean-tree bisection.
- Live drive against a real serve from this checkout: real turn → real compaction (accepted) → the model called `recall` unprompted-by-tooling and recovered a compacted-away instruction.
- The 19-package turbo typecheck ran green as the pre-push hook.
- GOTCHAS: `layer-pipe-20-arg-cap-collapses-types-to-unknown`, `dev-serve-event-sse-closes-after-first-frame`.

## Deliberately not ported from grok-build

Input degradation ladder (exists there for engine-cache-aligned verbatim input; this fork already strips for the compaction call), segments mode (recall covers it), compaction checkpoints (storage here never deletes), the 5-state suppression machine (auth/credit flows differ; 2 states cover the real failures), and the memory subsystem (declined for now — the GOTCHAS/CONTEXT curation culture is the memory).
