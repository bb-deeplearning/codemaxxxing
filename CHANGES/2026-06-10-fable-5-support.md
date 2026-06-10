# Changes: Claude Fable 5 support (Opus 4.7+ custom-support parity)

**Date**: 2026-06-10

`claude-fable-5` becomes the fork's new primary model (see the [explore-agent setup in the README](../README.md#explore-agent): Fable 5 primary + Gemini 3.1 Pro Preview on explore). For it to behave correctly it needs every model-gated transform the Anthropic Opus 4.7 / 4.8 models receive — adaptive reasoning efforts (`xhigh`/`max`) and the `display: "summarized"` thinking config. Fable isn't named "opus", so the version-gated code paths skip it by default. This change wires it in.

## Where Opus 4.7/4.8 get custom treatment

Two model-id gates in `packages/opencode/src/provider/transform.ts`, plus one consumer:

1. `anthropicOpus47OrLater(apiId)` — the single version gate. A regex (`opus-(\d+)[.-](\d+)`) decides whether a model is Opus 4.7-or-later. The return value drives:
   - `anthropicAdaptiveEfforts()` → `["low","medium","high","xhigh","max"]` (vs the 4.6 set without `xhigh`).
   - `adaptiveOpus` → injects `display: "summarized"` into the adaptive thinking config across the gateway, anthropic, bedrock, and SAP branches of `variants()`.
2. `variants()` github-copilot branch — a hardcoded `model.api.id.includes("opus-4.7")` that clamps copilot efforts to `["medium"]`.
3. `packages/opencode/src/plugin/github-copilot/models.ts:129` — imports `anthropicOpus47OrLater` to gate `display: "summarized"` on copilot-sourced models.

Everything else Opus-flavored is actually generic `claude`/`anthropic` gating: system-prompt selection (`session/system.ts`, `agent/agent.ts`), prompt-cache control + tool-call id scrubbing + temperature suppression (`transform.ts`), and Bedrock region prefixing (`provider.ts`). `claude-fable-5` already satisfies all of those by name — no change needed. `model.family` (`"claude-opus"`) is never used as a conditional; it is only copied as data. There is no Opus gating in the TUI/Go, plugin, or SDK packages.

## What landed

- `anthropicOpus47OrLater` now short-circuits to `true` for `fable-5` ids before the Opus regex. Match is `/fable-5(?:[.-]|$)/i` so it catches `claude-fable-5`, `anthropic/claude-fable-5`, `anthropic.claude-fable-5`, and date-suffixed `claude-fable-5-20260201`, but not a hypothetical `fable-50`. Because this is the single gate, Fable 5 inherits the adaptive efforts + summarized display across every provider branch (anthropic, gateway, bedrock, SAP) and the copilot plugin automatically.
- The github-copilot literal gate now matches `fable-5` as well as `opus-4.7`, clamping copilot Fable 5 to `["medium"]`. This mirrors 4.7 (4.8 has no such clamp; "every place possible" was read as the union of 4.7 and 4.8 treatment).
- The Opus regex is untouched — Opus 4.7/4.8/4.9+ still gate exactly as before; the Fable check is purely additive.

No models-snapshot entry is needed: Opus 4.7/4.8 aren't in the local snapshot either (they arrive from live models.dev), so Fable 5 is sourced the same way.

## Tests

`packages/opencode/test/provider/transform.test.ts` (+70 lines):

- Fable 5 added to the parametrized `@ai-sdk/anthropic` effort table (`["claude-fable-5", "claude-fable-5-20260201"]`), asserting the `xhigh`/`max` effort set and `{ thinking: { type: "adaptive", display: "summarized" }, effort: "high" }`. The date-suffixed id exercises the regex's `[.-]` branch.
- Focused Fable 5 tests for the github-copilot (`medium`-only), `@ai-sdk/gateway` (xhigh, no `display`), and `@ai-sdk/amazon-bedrock` (`display: "summarized"`) branches, each mirroring the existing Opus 4.7/4.8 cases.

154 transform tests pass; `github-copilot-models.test.ts` (the copilot plugin consumer) passes; `bun typecheck` clean.

## README

`README.md` explore-agent section updated: the documented default setup is now Claude Fable 5 primary + Gemini 3.1 Pro Preview on explore (was Opus 4.7).

## File inventory

### Modified

- `packages/opencode/src/provider/transform.ts` (Fable 5 short-circuit in `anthropicOpus47OrLater`; `||` clause in the copilot gate)
- `packages/opencode/test/provider/transform.test.ts` (Fable 5 coverage)
- `README.md` (default-setup line)
