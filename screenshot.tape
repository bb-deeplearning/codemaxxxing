# codemaxxxing screenshot tape — captures a real session, no terminal noise.
#
# What it captures (visible portion of the gif):
#   - mid-session view of ses_2037c15efffe0oDsxc1175yfNh
#     ("Codemaxxxing logo color & spacing fix")
#   - caveman agent already active
#   - toybox-noir theme
#   - typing a recap question, the turbo-spool spinner mid-response, and
#     the final landed response
#
# Everything before the question (binary launch, theme/agent setup) runs
# under Hide — commands still execute, just not recorded.
#
# Run: vhs screenshot.tape
# Output:
#   - screenshot.gif — the recording (what README links to)
#   - screenshot.png — final-frame still
#
# IMPORTANT: rebuild the codemaxxxing binary before running so the gif
# captures the latest UI. From repo root:
#
#   ./packages/opencode/script/build.ts --single
#   chmod +x ./packages/opencode/dist/opencode-darwin-arm64/bin/opencode
#
# (Your ~/.local/bin/codemaxxxing symlink should already point at the
# dist binary; rebuilding refreshes it in place.)

Output screenshot.gif

# Toybox-noir palette (dark mode), derived from
# ~/.config/opencode/themes/toybox-noir.json. vhs takes a standard ANSI
# terminal palette via Set Theme, so we map the UI tokens to ANSI slots.
Set Theme '{ "name": "Toybox Noir", "background": "#000000", "foreground": "#ECECEE", "cursor": "#ECECEE", "selection": "#1C1C1F", "black": "#000000", "red": "#FF3B30", "green": "#34D158", "yellow": "#FFD60A", "blue": "#3D9CFF", "magenta": "#FF2D8F", "cyan": "#00E5C7", "white": "#ECECEE", "brightBlack": "#6E6E78", "brightRed": "#FF6A00", "brightGreen": "#5DE876", "brightYellow": "#FFE13B", "brightBlue": "#52A8FF", "brightMagenta": "#B47AFF", "brightCyan": "#0AC7AC", "brightWhite": "#FFFFFF" }'

Set FontFamily "MonoLisa Nerd Font Mono"
Set FontSize 14
Set Width 1600
Set Height 1000
Set Padding 24
Set TypingSpeed 30ms
Set Shell zsh

# ── Setup, hidden from the recording ────────────────────────────────
Hide

# Boot codemaxxxing attached to the target session. Uses the installed
# binary (~/.local/bin/codemaxxxing), not the source dev server. The
# --session flag (tui/attach.ts) opens the TUI directly into that
# session's chat.
Type "codemaxxxing --session ses_2037c15efffe0oDsxc1175yfNh"
Enter
Sleep 8s

# Switch agent to caveman so the response is terse + on-brand. If the
# session was last used with caveman this is a no-op; doing it explicitly
# to make the tape deterministic.
Type "/agents"
Sleep 300ms
Enter
Sleep 1500ms
Type "caveman"
Sleep 500ms
Enter
Sleep 1500ms

# ── Recording starts here: the gif begins on a clean session view ────
Show

# Brief beat so the first frame isn't mid-action.
Sleep 800ms

# Fire a follow-up that needs the model to look back through the
# conversation. The session is about logo color/spacing fixes; ask for
# a recap so the spinner runs for several seconds.
Type "give me a brief recap of what we fixed and what's still pending"
Sleep 300ms
Enter

# Hold on the spinner long enough to capture multiple spinner frames
# before the response starts streaming.
Sleep 6s

# Wait for the response to land + animations to settle.
Sleep 10s

# Final still — the conversation surface populated, response complete.
Screenshot screenshot.png
