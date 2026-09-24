# Changes: Claude Opus 5.5 support

**Date**: 2026-09-24

`claude-opus-5-5` (GA 2026-09-22) replaces `claude-opus-5` as the fork's `general` seat. Two things had to happen: teach the runtime the parts of Opus 5.5's contract that differ from Opus 5, and make the proxy route it. This entry covers the codemaxxxing half; the proxy half is one commit in `rust-vertex-ai-proxy` (see [the proxy section](#proxy-counterpart)).

Everything below was driven end to end against a real `cmx serve` (`bun run dev serve` on 4831, `OPENCODE_CONFIG` overlay pointing the anthropic route at a fresh proxy binary on 6970, production 6969 untouched) and against Vertex directly with the proxy's service account. Reproduced 400s and passing turns are cited where they happened.

## What is different about Opus 5.5

Measured on Vertex (`bhaiyabotv1` @ `global`), 2026-09-24, not taken from the docs:

| request shape | opus 5 | opus 5.5 |
|---|---|---|
| `tool_choice: {type: "any"}` / `{type: "tool"}` | accepted | **400** `tool_choice: type "tool" and "any" are not supported for this model.` |
| `thinking: {type: "disabled"}` | accepted at high or below | **400** `"thinking.type.disabled" is not supported for this model.` |
| `thinking: {type: "enabled", budget_tokens}` | 400 (already adaptive-only) | 400 |
| `temperature: 0.3` | 400 (already rejected since 4.7) | 400 `` `temperature` is deprecated for this model. `` |
| `temperature: 1.0` (the default) | accepted | accepted |
| `speed: "fast"` + `fast-mode-2026-02-01` beta | 400 on Vertex | 400 on Vertex (`Unexpected value(s) fast-mode-2026-02-01 for the anthropic-beta header`). Claude API only. |
| `thinking.block_binding.prefix_mismatch_behavior` | 400 without the `thinking-binding-controls-2026-08-01` beta, 200 with | same |
| `output_config.format: json_schema` (native structured output) | accepted | accepted |
| `tool_choice: auto` + `strict: true` on the tool | accepted | accepted |
| text between tool calls | `text` blocks | `thinking` blocks (empty at `display: "omitted"`) |
| default effort | `high` | **`medium`** |
| pricing (in / out / cache read / cache write, $/MTok) | 5 / 25 / 0.5 / 6.25 | 4 / 20 / 0.2 / 5 |
| refusal categories | `cyber` | `cyber`, `bio`, `reasoning_extraction` |

Unchanged from Opus 5: 1M context (native, no beta), 128k output, five effort levels (`low` … `max`), adaptive thinking that runs whether or not you ask for it, thinking blocks bound to the prompt prefix (the [fable 5.1 fix](../packages/opencode/src/provider/transform.ts) already covers it).

The pinned `@ai-sdk/anthropic@3.0.71` knows none of this. Its `getModelCapabilities` table stops at Opus 4.7, so for any Claude 5 it falls into the "unknown model" branch: `supportsStructuredOutput: false`, which means `generateObject` is emulated with a **forced `json` tool** (`tool_choice: {type: "tool", name: "json"}`). That is exactly the request Opus 5.5 rejects. Upstream's `@ai-sdk/anthropic@4.0.61` has a full row for `claude-opus-5-5` (`rejectsForcedToolUse: true`, downgrades `required` to `auto` with a warning) but we pin 3.0.71 for the block-binding port and moving major versions is its own project, so the gates live in `transform.ts`.

## What landed

### `packages/opencode/src/provider/transform.ts`

- `anthropicRejectsForcedToolUse(apiId)`: version gate, true for Opus ≥ 5.5 and Fable ≥ 5.1 (both spellings, vendor prefixes, `@default` suffixes). The minor is capped at two digits so `claude-opus-5-20260724` reads as 5.0 and stays on the permissive side. Sonnet / Haiku 5.5 are deliberately not gated until Anthropic documents their contract.
- `toolChoice(model, choice)`: the one place the session passes `toolChoice` through. `required` becomes `auto` on gated models; `auto` / `none` / `undefined` pass through; nothing else is touched. The structured-output path is the only caller that asks for `required`; its system prompt already tells the model to call `StructuredOutput`, and the tool's schema validation catches a wrong-shaped call, so the downgrade costs nothing in practice (leg 3 of the e2e: `tool_choice: {type: "auto"}` on the wire, `StructuredOutput({answer: "4"})` called first try).
- `anthropicStructuredOutputMode`: for gated models on `@ai-sdk/anthropic` / `@ai-sdk/google-vertex/anthropic`, pins `structuredOutputMode: "outputFormat"` into providerOptions unless the caller chose one. The sdk then emits native `output_config.format` instead of the forced `json` tool. Leg 2 of the e2e (`generateObject` with the agent-generation schema): `tools: null`, `tool_choice: null`, `output_config.format.type: json_schema`, valid object back.
- `anthropicBlockBinding`: when a Claude 5 request arrives with no thinking option (the sdk-default path, which is how `generateObject` and any unpinned caller reaches the model), the synthesized adaptive config now also carries `display: "summarized"` on `anthropicOmitsThinking` models. Without it every thinking block came back empty, and on Opus 5.5 / Fable 5.1 the text the model writes between tool calls (which now travels in thinking blocks) went silent too. An explicit thinking config is passed through untouched apart from the binding.
- `refusal(providerMetadata)`: reads Anthropic's `stop_details` (`{type: "refusal", category, explanation}`) off the finish step, scanning every provider slug since the key is whatever name the sdk was addressed by.

### `patches/@ai-sdk%2Fanthropic@3.0.71.patch` (extended, all four bundles)

The pinned sdk parsed `stop_reason` but dropped `stop_details` on the floor, so a refusal reached the session as a bare `content-filter` finish with no way to tell cyber from bio. Ported upstream 4.x's plumbing: `stop_details` in the non-stream response schema and the stream `message_delta` schema, `mapAnthropicStopDetails` (camel-cases `recommended_model`), captured on `message_delta`, surfaced as `providerMetadata.<slug>.stopDetails` on both paths. Applied via `bun patch` on top of the existing block-binding patch; the lockfile records only the patch path, so no lock churn. `bun patch --commit` bumped an unrelated `ghostty-web` pin in `bun.lock` as a side effect; that was reverted.

### `packages/opencode/src/session/processor.ts` + `message-v2.ts`

A refused step produced no text, no tool call and no error, so the turn went idle looking like a silent non-answer (the TUI had a banner for it; the event bus, boxbox, and a spawner's completion notification saw nothing). `finish-step` with `content-filter` now raises `MessageV2.ContentFilterError { message, category?, explanation? }` on the assistant message and publishes `Session.Event.Error`, with the classifier named in the copy when the provider supplies one: `refused by the model's cyber safety classifier. nothing was generated past this point and the input was still billed. rephrase, or retry on another model.` Same error name as upstream's so a future sync lands on it; upstream's has only `message`. The TUI's existing banner now fires only for messages persisted before this change (finish is `content-filter` and there is no error), so a refusal renders once, through the error slot.

Caught live: the harness prompt "probe the services auth and billing-gateway … tell me which is slower" trips Opus 5.5's cyber classifier roughly one turn in four (3 of 11 runs, all on the second step of the tool loop, `stop_details.category: "cyber"`). Same prompt through `bun run dev serve` four more times came back clean, so the reproduction is stochastic; the unit test pins the exact metadata object the sdk emitted for the refusal that was caught.

### `packages/opencode/src/session/llm.ts`, `packages/opencode/src/agent/agent.ts`

`llm.ts` routes `toolChoice` through `ProviderTransform.toolChoice`. `agent.ts`'s `generateObject` (the `/agent/generate` path) now passes `ProviderTransform.providerOptions(resolved, {})` so it gets the structured-output pin and block binding, and its hard-coded `temperature: 0.3` is gated on `capabilities.temperature` (models.dev marks every Claude ≥ 4.7 `temperature: false`; sending it is a 400 on all of them, this path just had not been exercised on one).

### `packages/sdk/js/src/v2/gen/types.gen.ts`

Regenerated (`bun run script/build.ts` in `packages/sdk/js`): `ContentFilterError` added to the `AssistantMessage.error` union. Only additive.

### Config (`~/.config/opencode/opencode.jsonc`, `~/.config/opencode/AGENTS.md`)

- `agent.general.model` → `anthropic/claude-opus-5-5`, `variant: "high"`. Opus 5.5's API default is `medium` where Opus 5's was `high`; an unpinned seat would have silently dropped one rung. A spawn's `reasoning_effort` still overrides. The routing matrix row says the same.
- `provider.anthropic.blacklist: ["claude-opus-5-5-fast", "claude-opus-5-fast", "claude-opus-4-8-fast"]`. models.dev derives a `-fast` picker entry from each model's `experimental.modes.fast` (`speed: "fast"` + the fast-mode beta header). Vertex rejects the header outright, so through the proxy those entries can only 400. Confirmed against the harness serve: `/provider` no longer lists them.

The anthropic `baseURL` (`http://localhost:6969/v1`) was not part of this change. During the first pass it was edited in place along with the blacklist addition and Rohan had to restore it by hand; see the GOTCHAS entry `global-config-baseurl-is-the-live-session-lifeline`.

## Proxy counterpart

`rust-vertex-ai-proxy` (one commit, `feat: add Claude Opus 5.5`):

- `vertex-proxy/src/config.rs`: `claude-opus-5-5` → `claude-opus-5-5`, no beta (native 1M). Comment records that Vertex does not serve fast mode.
- `anthropic-translator/src/translate/model_spec.rs`: `ModelFamily::Opus55` (adaptive-only, five efforts, 128k) and a new `allows_forced_tool_choice` field on `ModelSpec`, false for Opus 5.5, Fable 5.1 and the unknown fallback, true everywhere else. `translate_tool_choice` collapses Codex's `required` to `auto` when the spec says so instead of shipping the `any` the model will reject.
- `anthropic-translator/data/models.json`: `GET /v1/models` advertises `claude-opus-5-5` at priority 3 (between Fable 5 and Opus 5); existing entries byte-identical apart from renumbered priorities.
- Tests: spec pin for Opus 5.5, `allows_forced_tool_choice` asserted on every existing pin, `required` → `any` on Opus 5 and → `auto` on Opus 5.5 / Fable 5.1. `cargo fmt`, `cargo clippy --workspace --all-targets` and 275 tests clean.
- Not deployed. The live `Anthroproxy.app` (pid 1567, port 6969) still runs the old binary and does not know `claude-opus-5-5`: an unknown alias falls back to `claude-haiku-4-5`, so any `general` spawn before the proxy is swapped would silently run on Haiku. Ship order is proxy first, then the config; the config edit is already in place so the proxy swap is the gating step. `./package.sh` + `cp -r Anthroproxy.app /Applications/` + relaunch from the menu bar.

## Tests

`packages/opencode/test/provider/transform.test.ts` (+~220 lines): `claude-opus-5-5` in the anthropic variants table (three spellings, pins the Opus regex against reading `5-5` as a dated snapshot), `toolChoice` across sdk paths / gated vs. permissive models / passthrough values / non-anthropic, `anthropicRejectsForcedToolUse` boundary table, structured-output pin (anthropic + vertex, sdk default preserved for permissive models, explicit user choice wins), synthesized-default display, `refusal` on the captured metadata plus junk. 192 pass. `bun run typecheck` clean in `packages/opencode` and `packages/sdk/js`. `test/session/message-v2.test.ts`, `test/session/retry.test.ts`, `test/agent` green. The two failures in `test/provider/models.test.ts` (`ModelsDev … fetch disabled`) fail identically on a stashed tree; not this change.

## File inventory

### Modified

- `packages/opencode/src/provider/transform.ts`
- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/src/agent/agent.ts`
- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
- `packages/opencode/test/provider/transform.test.ts`
- `packages/sdk/js/src/v2/gen/types.gen.ts` (regenerated)
- `patches/@ai-sdk%2Fanthropic@3.0.71.patch`
- `GOTCHAS.md` (three entries)
- `CHANGES/INDEX.md`
