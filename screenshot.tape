# codemaxxxing screenshot tape — captures a real session as a static still.
#
# What it captures (screenshot.png, the README's tui image):
#   - mid-session view of ses_08ea04259ffevYZshiVDlutplR
#     ("Understanding codemaxxxing itself")
#   - caveman agent active, toybox-noir theme
#   - a recap question fired live: bold human line with its dissolving
#     rule, the landed response, and the afterglow bottom edge (fade rule,
#     cursor, status whisper / return glance)
#
# The gif recording is a vhs requirement, not an artifact — it renders to
# cmx-screenshot-discard.gif; delete it after the run. Only the
# final-frame Screenshot ships.
#
# Everything before the question (binary launch, agent setup) runs under
# Hide — commands still execute, just not recorded.
#
# Run: vhs screenshot.tape
# Output: screenshot.png — final-frame still (what README embeds)
#
# IMPORTANT: rebuild the codemaxxxing binary before running so the still
# captures the latest UI. From repo root:
#
#   ./packages/opencode/script/build.ts --single
#   chmod +x ./packages/opencode/dist/opencode-darwin-arm64/bin/opencode
#
# (Your ~/.local/bin/codemaxxxing symlink should already point at the
# dist binary; rebuilding refreshes it in place.)

Output cmx-screenshot-discard.gif

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
Type "codemaxxxing --session ses_08ea04259ffevYZshiVDlutplR"
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

# ── Visible portion starts here ──────────────────────────────────────
Show

# Brief beat so the first frame isn't mid-action.
Sleep 800ms

# Fire a follow-up that needs the model to look back through the
# conversation. A recap keeps the kinetic busy sentence on screen for a
# few seconds, then lands a terse caveman answer.
Type "give me a brief recap of what we covered here"
Sleep 300ms
Enter

# Busy state: the kinetic gradient sentence + elapsed whisper.
Sleep 6s

# Wait for the response to land and the return glance to settle.
Sleep 14s

# Final still — populated conversation, afterglow bottom edge.
Screenshot screenshot.png
