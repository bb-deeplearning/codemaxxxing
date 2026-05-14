# Wave 13 — Manual smoke test (TUI against legacy session snapshot)

The Wave 13 spec calls for a manual TUI smoke run against a legacy session
directory to confirm:

- Session list shows the legacy session
- Selecting it renders the transcript correctly
- Subagent footer doesn't break for non-subagent sessions
- Existing keybindings work

The automated suite in `test/backward-compat/` covers the schema, service,
and event-bus surfaces around legacy sessions. The TUI render path is
covered separately by:

- `test/perf/baseline/session-render.bench.ts` (Wave 0 — captured baseline)
- `test/perf/process-render.bench.tsx` (Wave 4 — best-of-3 against baseline)
- `test/perf/multi-agent-render.bench.tsx` (Wave 11 — span-in-text strip)
- The TUI subagent-footer + dialog-subagent unit tests (Wave 11) which
  verify the helper / view / mount split keeps the non-subagent code path
  unchanged

Together the automated suite covers everything except a live SSH-style
boot of the TUI against a real session DB. That last verification is a
one-shot manual gate the campaign owner runs before merging.

## Procedure

1. Check out a `dev` snapshot from before the campaign branch:

   ```bash
   git stash
   git checkout dev~50  # or any commit pre-2026-05-13
   bun install
   bun run --cwd packages/opencode build
   ```

2. Use that build to create a real session: open the TUI, send a few user
   messages, run a couple of tools, let it complete a turn. The session
   row writes to `~/.local/share/opencode/storage/storage.db`. Note the
   session id from the URL bar / list.

3. Switch back to the campaign branch:

   ```bash
   git checkout codex-parity
   bun install
   bun run --cwd packages/opencode build
   ```

4. Open the TUI fresh. Confirm:

   - The session list contains the legacy session row, with its title and
     timestamp intact.
   - Opening it renders the full transcript: every text part, every tool
     part, every step boundary. No "unknown part type" warnings; no
     missing assistant turns.
   - The subagent footer is hidden (this is a non-subagent session).
   - All non-subagent keybindings still work: arrow nav, enter to send,
     `?` for help, `:` for command palette, etc.
   - Triggering the legacy `task` tool from within the session works
     (it should still spawn a single child session and return a
     `<task_result>...</task_result>` envelope).

5. Stash the running session, rebuild a multi-agent session via the new
   `spawn_agent` tool. Confirm the subagent footer renders and that
   switching back to the legacy session still hides the footer (no
   leftover state from the multi-agent rendering).

## Result

Run by the campaign owner before final wave merge. Results recorded as a
single line in this file once the run completes:

> **2026-XX-XX:** Smoke run by `<user>`. PASS / FAIL with notes.

(Empty until the wave-15 manual gate is exercised. Wave 13's automated
coverage is the gating signal for proceeding to Wave 14.)
