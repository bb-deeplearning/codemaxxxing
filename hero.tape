# codemaxxxing home-screen hero — captures the figlet wordmark + prompt
#
# Run: vhs hero.tape
# Output: hero.png next to this file
#
# Resolution: 2400x1350 (2.18x previous 1100x620). Font + padding scaled
# proportionally so the wordmark fills the same fraction of frame as
# before, just rendered at higher pixel density. GitHub will scale this
# down for display; higher source res → sharper README banner.
#
# IMPORTANT: rebuild the codemaxxxing binary before running so the gif
# captures the latest UI. From repo root:
#
#   ./packages/opencode/script/build.ts --single
#   chmod +x ./packages/opencode/dist/opencode-darwin-arm64/bin/opencode

Output hero.gif

# Vercel terminal palette, extracted from the in-tree vercel.json theme
Set Theme '{ "name": "Vercel", "background": "#0A0A0A", "foreground": "#EDEDED", "cursor": "#EDEDED", "selection": "#292929", "black": "#1A1A1A", "red": "#E5484D", "green": "#46A758", "yellow": "#FFB224", "blue": "#0070F3", "magenta": "#8E4EC6", "cyan": "#12A594", "white": "#EDEDED", "brightBlack": "#454545", "brightRed": "#FF6166", "brightGreen": "#63C46D", "brightYellow": "#F2A700", "brightBlue": "#52A8FF", "brightMagenta": "#BF7AF0", "brightCyan": "#0AC7AC", "brightWhite": "#FFFFFF" }'

Set FontFamily "MonoLisa Nerd Font Mono"
Set FontSize 35
Set Width 2400
Set Height 1350
Set Padding 60
Set TypingSpeed 40ms
Set Shell zsh

# ── Setup, hidden from the recording ─────────────────────────────────
Hide

# Boot the installed codemaxxxing binary (not the source dev server).
Type "codemaxxxing"
Enter
Sleep 8s

# Switch chat theme to vercel via the /themes dialog
Type "/themes"
Sleep 300ms
Enter
Sleep 1500ms
Type "vercel"
Sleep 500ms
Enter
Sleep 1500ms

# ── Recording starts here: clean home screen with the figlet wordmark ─
Show

# Settle on the home screen — the figlet wordmark animates ignition→idle
# in ~1.7s; wait long enough that the idle breathing on `xxx` is visible.
Sleep 4s

Screenshot hero.png
