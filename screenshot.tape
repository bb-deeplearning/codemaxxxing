# codemaxxxing screenshot tape — replaces the caveman demo with a real session.
#
# What it captures:
#   - session ses_2037c15efffe0oDsxc1175yfNh ("Codemaxxxing logo color & spacing fix")
#   - caveman agent
#   - toybox-noir theme (custom — palette inlined below)
#   - asks a follow-up so the GIF captures the spinner mid-response
#
# Run: vhs screenshot.tape
# Output:
#   - screenshot.gif — the animated recording (this is what README links to)
#   - screenshot.png — final-frame still (kept for the static-image fallback)

Output screenshot.gif

# Toybox-noir palette (dark mode), derived from
# ~/.config/opencode/themes/toybox-noir.json. vhs takes a standard ANSI
# terminal palette via Set Theme, so we map the UI tokens to the closest
# ANSI slots: bg/fg/cursor/selection plus 8 + 8 bright.
Set Theme '{ "name": "Toybox Noir", "background": "#000000", "foreground": "#ECECEE", "cursor": "#ECECEE", "selection": "#1C1C1F", "black": "#000000", "red": "#FF3B30", "green": "#34D158", "yellow": "#FFD60A", "blue": "#3D9CFF", "magenta": "#FF2D8F", "cyan": "#00E5C7", "white": "#ECECEE", "brightBlack": "#6E6E78", "brightRed": "#FF6A00", "brightGreen": "#5DE876", "brightYellow": "#FFE13B", "brightBlue": "#52A8FF", "brightMagenta": "#B47AFF", "brightCyan": "#0AC7AC", "brightWhite": "#FFFFFF" }'

Set FontFamily "MonoLisa Nerd Font Mono"
Set FontSize 14
Set Width 1600
Set Height 1000
Set Padding 24
Set TypingSpeed 30ms
Set Shell zsh

# Boot codemaxxxing from source, attached to the target session.
# `bun dev` forwards args after the script name; --session opens the TUI
# directly into that session's chat instead of the home screen.
Type "bun dev --session ses_2037c15efffe0oDsxc1175yfNh"
Enter
Sleep 14s

# Switch agent to caveman via the /agents dialog so the next response uses
# the ultra-terse output style.
Type "/agents"
Sleep 300ms
Enter
Sleep 1500ms
Type "caveman"
Sleep 500ms
Enter
Sleep 1500ms

# Fire a follow-up that requires the model to actually look at conversation
# history (so the spinner runs for several seconds — the whole point of the
# gif). The session is about logo color/spacing fixes; ask for a recap.
Type "give me a brief recap of what we fixed and what's still pending"
Sleep 300ms
Enter

# Hold on the spinner long enough for the gif to capture multiple spinner
# frames before the response completes. Tune up if your network is slow.
Sleep 6s

# Final still — the conversation surface populated, response landed.
Sleep 10s
Screenshot screenshot.png
