# Changes: Afterglow TUI redesign + model semantics fixes

**Date**: 2026-07-18

Same-day follow-on to [truthful-tools](2026-07-18-truthful-tools.md). Two independent tracks: a full visual redesign of the TUI ("afterglow") driven by an offline design deck, and a pair of model-semantics fixes (adaptive-thinking display gating generalized beyond Opus, spawn_agent model overrides actually reaching the child).

## Afterglow TUI redesign (`83bc42074c`)

Port of the glow deck across every major TUI surface. ~4650 insertions / ~2200 deletions over 51 files.

- **`design/deck/` (NEW, repo root).** Offline design pipeline: per-surface frame definitions (`frames/{agents,asks,bricks,glow,home,page,palette,session,waves}.ts`), `theme.ts` (the afterglow palette), `paint.ts` + `ui.ts` (frame renderer), `render-html.ts` + `verify.ts`, output contact sheet at `out/sheet.{html,png}`. The deck is the design source of truth the TUI port was verified against.
- **`ui/glow.tsx` (NEW primitive) + `glow.test.tsx` + `test/cli/cmd/tui/glow-gauntlet.test.tsx`.** The shared glow rendering primitive; the gauntlet test exercises it across surface permutations.
- **Ported surfaces.** Session route (`routes/session/index.tsx`, heaviest single diff), prompt (`component/prompt/index.tsx`, rebuilt), home route + home footer, all five dialogs (`ui/dialog{,-alert,-confirm,-help,-prompt,-select}.tsx`), command dialog, sidebar (`routes/session/sidebar.tsx` + all sidebar feature-plugins: context/files/footer/lsp/mcp/todo + new `component/sidebar-section.tsx`), permission + question views, subagent footer, process tool, mailbox message, todo item.
- **`routes/session/footer.tsx` DELETED** — folded into the session route.
- **`specs/tui-redesign.md` (NEW).** 125-line design/port reference.

## Content-filter blocked turns surfaced (`c18713eaeb`)

`routes/session/index.tsx`: a turn blocked by the provider's content filter used to render as nothing at all — the session just looked stalled. Now renders an explicit blocked-turn notice.

## `anthropicOmitsThinking` generalization (`3e739d6bff`)

`src/provider/transform.ts`: the adaptive-thinking display gate was named and scoped as an Opus 4.7+ check with fable-5 spliced into it ([fable-5-support](2026-06-10-fable-5-support.md)). Reality: ALL newer adaptive-only models (Opus 4.7+, Sonnet 5+, Fable 5) default thinking `display` to `"omitted"`, which returns empty thinking blocks.

- New `anthropicSonnet5OrLater` matcher; `anthropicOpus47OrLater` extended to SAP-AI-Core-inverted ids (`claude-4.7-opus`) and `@`-suffixed ids; fable-5 detection moved out of the Opus matcher.
- New exported `anthropicOmitsThinking(apiId)` = Opus 4.7+ ∪ Sonnet 5+ ∪ Fable 5; the three `display: "summarized"` force-sites in `variants()` now key on it.
- `plugin/github-copilot/models.ts` effort clamp keys on the same predicate.
- 97 new test lines in `test/provider/transform.test.ts`.

## spawn_agent model override actually reaches the child (`b13c69c3e7`)

`model` / `reasoning_effort` params on `spawn_agent` were accepted but not forwarded — the child ran on its agent-type default regardless. Now:

- Validated at spawn time: unknown `provider/model` fails the call; `reasoning_effort` requires `model` and must be one of that model's variants (error lists the valid ones).
- `agent/control.ts` carries the override on the child slot; `session/prompt.ts` threads it into the child's runLoop.
- `agent-spawn.txt` documents the contract; coverage in `agent-spawn.test.ts` (+167 lines), differential `spawn-permission.diff.test.ts`, and the tool-surface snapshot.

## Docs + chores

- **README + stills reconcile (`174d748ca4`).** README updated for afterglow + spawn model semantics; `hero.png` / `screenshot.png` re-shot via updated tapes; stale `screenshot.gif` deleted.
- **`custom_agents/wave_plan.md` (`9ebb28d61b`).** Bash permission matrix collapsed to allow-all (57 lines of per-command rules deleted).
- **GOTCHAS (`8dc177ede2`).** Six entries from the truthful-tools session (+82 lines).
