# codemaxxxing screenshot tape — captures home + caveman agent quick exchange
#
# Run: vhs screenshot.tape
# Output: screenshot.png next to this file

# vhs treats .png Output as frame-dump-into-directory; use .gif for the
# Output sink (we ignore the gif) and Screenshot <path> for the still we want
Output screenshot.gif

# Custom Vercel terminal palette, extracted from
# packages/opencode/src/cli/cmd/tui/context/theme/vercel.json
# (vhs doesn't ship a built-in Vercel theme)
Set Theme '{ "name": "Vercel", "background": "#0A0A0A", "foreground": "#EDEDED", "cursor": "#EDEDED", "selection": "#292929", "black": "#1A1A1A", "red": "#E5484D", "green": "#46A758", "yellow": "#FFB224", "blue": "#0070F3", "magenta": "#8E4EC6", "cyan": "#12A594", "white": "#EDEDED", "brightBlack": "#454545", "brightRed": "#FF6166", "brightGreen": "#63C46D", "brightYellow": "#F2A700", "brightBlue": "#52A8FF", "brightMagenta": "#BF7AF0", "brightCyan": "#0AC7AC", "brightWhite": "#FFFFFF" }'

Set FontFamily "MonoLisa Nerd Font Mono"
Set FontSize 14
Set Width 1600
Set Height 1000
Set Padding 24
Set TypingSpeed 40ms
Set Shell zsh

# Boot codemaxxxing from source (latest visual overhaul lives in source,
# not in the compiled dist binary — that one is a few hours old)
Type "bun dev"
Enter
Sleep 12s

# Switch chat theme to vercel via the /themes dialog
Type "/themes"
Sleep 300ms
Enter
Sleep 1500ms
Type "vercel"
Sleep 500ms
Enter
Sleep 1500ms

# Switch agent to caveman via the /agents dialog
Type "/agents"
Sleep 300ms
Enter
Sleep 1500ms
Type "caveman"
Sleep 500ms
Enter
Sleep 1500ms

# Quick exchange to populate the conversation surface
Type "what is caveman"
Sleep 300ms
Enter

# Wait for the model response to land + animations to settle
Sleep 14s

# The actual still we want, taken at the final frame
Screenshot screenshot.png
