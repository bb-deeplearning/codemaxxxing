# wave footer pill check — captures home with the wave pill in the footer

Output wave-pill.png

Set Theme '{ "name": "Vercel", "background": "#0A0A0A", "foreground": "#EDEDED", "cursor": "#EDEDED", "selection": "#292929", "black": "#1A1A1A", "red": "#E5484D", "green": "#46A758", "yellow": "#FFB224", "blue": "#0070F3", "magenta": "#8E4EC6", "cyan": "#12A594", "white": "#EDEDED", "brightBlack": "#454545", "brightRed": "#FF6166", "brightGreen": "#63C46D", "brightYellow": "#F2A700", "brightBlue": "#52A8FF", "brightMagenta": "#BF7AF0", "brightCyan": "#0AC7AC", "brightWhite": "#FFFFFF" }'

Set FontFamily "MonoLisa Nerd Font Mono"
Set FontSize 14
Set Width 1400
Set Height 720
Set Padding 24
Set TypingSpeed 30ms
Set Shell zsh

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

Type "bun dev /tmp/codemaxxxing-wave-demo"
Enter
Sleep 14s

Screenshot wave-pill.png
Sleep 500ms
