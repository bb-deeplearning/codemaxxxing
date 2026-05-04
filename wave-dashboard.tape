# codemaxxxing wave dashboard — captures the /wave route on a populated demo
#
# Run from repo root: vhs wave-dashboard.tape
# Output: wave-dashboard.gif + wave-dashboard.png

Output wave-dashboard.gif

Set Theme '{ "name": "Vercel", "background": "#0A0A0A", "foreground": "#EDEDED", "cursor": "#EDEDED", "selection": "#292929", "black": "#1A1A1A", "red": "#E5484D", "green": "#46A758", "yellow": "#FFB224", "blue": "#0070F3", "magenta": "#8E4EC6", "cyan": "#12A594", "white": "#EDEDED", "brightBlack": "#454545", "brightRed": "#FF6166", "brightGreen": "#63C46D", "brightYellow": "#F2A700", "brightBlue": "#52A8FF", "brightMagenta": "#BF7AF0", "brightCyan": "#0AC7AC", "brightWhite": "#FFFFFF" }'

Set FontFamily "MonoLisa Nerd Font Mono"
Set FontSize 14
Set Width 1400
Set Height 720
Set Padding 24
Set TypingSpeed 30ms
Set Shell zsh

# Build a populated wave campaign in /tmp so the dashboard has rows to render
Hide
Type "rm -rf /tmp/codemaxxxing-wave-demo && mkdir -p /tmp/codemaxxxing-wave-demo"
Enter
Sleep 200ms
Type "bun script/wave-demo-fixture.ts /tmp/codemaxxxing-wave-demo"
Enter
Sleep 1500ms
Type "clear"
Enter
Show

# Boot codemaxxxing pointing at the fixture
Type "bun dev /tmp/codemaxxxing-wave-demo"
Enter
Sleep 12s

# Open the wave dashboard
Type "/wave"
Sleep 400ms
Enter
Sleep 2s

# Move the cursor a couple rows so the highlight is visible mid-table
Down
Sleep 200ms
Down
Sleep 200ms
Down
Sleep 200ms
Down
Sleep 200ms
Down
Sleep 200ms
Down
Sleep 800ms

Screenshot wave-dashboard.png

# Hold a beat for the gif tail
Sleep 1500ms
